import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';

/** Error raised when jq fails. `status` is the HTTP status the proxy reports. */
export class JqError extends Error {
  constructor(message, { exitCode, stderr, status }) {
    super(message);
    this.name = 'JqError';
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.status = status;
  }
}

// Linux caps each command-line argument at 128 KiB (MAX_ARG_STRLEN, terminating NUL included).
const MAX_ARG_BYTES = 128 * 1024;

function readArgFiles(argFiles, cwd, args) {
  const values = {};
  for (const [name, file] of Object.entries(argFiles)) {
    if (Object.hasOwn(args, name)) throw new TypeError(`jq argument $${name} is set in both args and argFiles`);
    const path = resolve(cwd, file);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      throw new TypeError(`cannot read the file of jq argument $${name}: ${e.message}`);
    }
    try {
      values[name] = JSON.parse(text);
    } catch (e) {
      throw new TypeError(`the file of jq argument $${name} (${path}) is not valid JSON: ${e.message}`);
    }
  }
  return values;
}

/**
 * Builds a transform `(json) => Promise<json>` that pipes its input through a
 * jq filter file. It runs the jq executable, so the filter can `import` and
 * `include` modules: from `libraryPaths` (passed to jq as `-L`, by default the
 * `jq_modules` folder jqpm installs into), from the `JQ_LIBRARY_PATH`
 * environment variable (the convention `jqpm exec` sets), and `./`-relative to
 * the filter itself (jq runs in the filter's folder).
 *
 * @param {object} options
 * @param {string} options.filter path of the jq filter file
 * @param {string[]} [options.libraryPaths] module search paths, relative to the filter's folder
 * @param {Record<string, unknown>} [options.args] named arguments, available in the filter as `$name`
 * @param {Record<string, string>} [options.argFiles] named arguments read from JSON files (relative to
 *   the filter's folder), available in the filter as `$name`; the files are read once, now
 * @param {string} [options.jq] jq executable
 */
export function jqTransform({ filter, libraryPaths = ['jq_modules'], args = {}, argFiles = {}, jq = 'jq' }) {
  if (!filter) throw new TypeError('jqTransform: a filter file is required');
  const filterPath = resolve(filter);
  const cwd = dirname(filterPath);
  const envPaths = (process.env.JQ_LIBRARY_PATH ?? '').split(delimiter).filter(Boolean);
  const argv = ['--compact-output'];
  for (const p of [...libraryPaths, ...envPaths]) argv.push('-L', resolve(cwd, p));
  for (const [name, value] of Object.entries({ ...args, ...readArgFiles(argFiles, cwd, args) })) {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) >= MAX_ARG_BYTES) {
      throw new TypeError(`jq argument $${name} is too large to pass on the command line (${Buffer.byteLength(json)} bytes, `
        + `the limit is ${MAX_ARG_BYTES - 1}); load it in the filter instead, e.g. import "./${name}" as $${name}; and use $${name}[0]`);
    }
    argv.push('--argjson', name, json);
  }
  argv.push('--from-file', filterPath);

  return (input) => new Promise((resolvePromise, reject) => {
    const child = spawn(jq, argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.stdin.on('error', () => {}); // jq may exit (e.g. compile error) before reading its input
    child.on('error', (e) => reject(new JqError(`cannot run ${jq}: ${e.message}`, { status: 500 })));
    child.on('close', (exitCode) => {
      const stderr = Buffer.concat(err).toString().trim();
      if (exitCode !== 0) {
        // jq exits with 5 on runtime errors (e.g. `error("...")` raised by the
        // filter to reject a query); anything else is a broken filter or setup.
        const status = exitCode === 5 ? 400 : 500;
        return reject(new JqError(stderr || `jq exited with code ${exitCode}`, { exitCode, stderr, status }));
      }
      const lines = Buffer.concat(out).toString().split('\n').filter(Boolean);
      if (lines.length !== 1) {
        return reject(new JqError(`jq filter must output exactly one value, got ${lines.length}`, { exitCode, stderr, status: 500 }));
      }
      resolvePromise(JSON.parse(lines[0]));
    });
    child.stdin.end(JSON.stringify(input));
  });
}
