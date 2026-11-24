import { spawn, spawnSync } from 'node:child_process';
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
 *   (passed on jq's command line, so each is limited to 128 KiB on Linux)
 * @param {Record<string, string>} [options.argFiles] named arguments read by jq from JSON files (paths
 *   relative to the filter's folder), as with jq's `--slurpfile`: `$name` is the array of the file's
 *   JSON values, so `$name[0]` for a file holding one value. The files are checked now.
 * @param {string} [options.jq] jq executable
 */
export function jqTransform({ filter, libraryPaths = ['jq_modules'], args = {}, argFiles = {}, jq = 'jq' }) {
  if (!filter) throw new TypeError('jqTransform: a filter file is required');
  const filterPath = resolve(filter);
  const cwd = dirname(filterPath);
  const envPaths = (process.env.JQ_LIBRARY_PATH ?? '').split(delimiter).filter(Boolean);
  const argv = ['--compact-output'];
  for (const p of [...libraryPaths, ...envPaths]) argv.push('-L', resolve(cwd, p));
  for (const [name, value] of Object.entries(args)) {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) >= MAX_ARG_BYTES) {
      throw new TypeError(`jq argument $${name} is too large to pass on the command line (${Buffer.byteLength(json)} bytes, `
        + `the limit is ${MAX_ARG_BYTES - 1}); put it in a JSON file and load it with argFiles instead`);
    }
    argv.push('--argjson', name, json);
  }
  const slurp = [];
  for (const [name, file] of Object.entries(argFiles)) {
    if (Object.hasOwn(args, name)) throw new TypeError(`jq argument $${name} is set in both args and argFiles`);
    slurp.push('--slurpfile', name, resolve(cwd, file));
  }
  if (slurp.length) {
    // Check the files now, so that a missing or invalid one fails at startup rather than on each query.
    const check = spawnSync(jq, ['--null-input', ...slurp, 'empty'], { encoding: 'utf8' });
    if (check.error) throw new TypeError(`cannot run ${jq}: ${check.error.message}`);
    if (check.status !== 0) throw new TypeError(`cannot load argFiles: ${check.stderr.trim()}`);
    argv.push(...slurp);
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
