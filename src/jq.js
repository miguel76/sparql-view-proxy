import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

/** Error raised when jq fails. `status` is the HTTP status the proxy reports. */
export class JqError extends Error {
  constructor(message, { stderr, status }) {
    super(message);
    this.name = 'JqError';
    this.stderr = stderr;
    this.status = status;
  }
}

// Linux caps each command-line argument at 128 KiB (MAX_ARG_STRLEN, terminating NUL included).
const MAX_ARG_BYTES = 128 * 1024;

// --- Wrapping the filter ---------------------------------------------------
//
// A jq process applies its program to each input it reads, so one process can
// serve many queries. To match results to queries, every input must give
// exactly one line of output: the filter is wrapped as
//   try {ok: [FILTER]} catch {error: .}
// jq requires the module directives (module, import, include) to come first,
// so they are split off the filter's text and kept in front of the wrapper.

function skipComment(text, i) { // text[i] === '#'
  for (;;) {
    const nl = text.indexOf('\n', i);
    if (nl < 0) return text.length;
    // An odd number of backslashes before the newline continues the comment (jq 1.7.1+).
    let k = nl - 1;
    if (text[k] === '\r') k--;
    let backslashes = 0;
    while (k >= i && text[k] === '\\') { backslashes++; k--; }
    if (backslashes % 2 === 0) return nl + 1;
    i = nl + 1;
  }
}

function skipBlank(text, i) {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '#') return i;
    i = skipComment(text, i);
  }
}

function skipString(text, i) { // text[i] === '"'
  for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
  return i + 1;
}

/** Splits a jq program into its module directives and the rest. */
export function splitDirectives(text) {
  let end = 0;
  for (;;) {
    const start = skipBlank(text, end);
    const keyword = /^(?:module|import|include)(?![\w:])/.exec(text.slice(start, start + 8));
    if (!keyword) return [text.slice(0, end), text.slice(end)];
    // A directive ends at the first `;` outside strings, comments and brackets (metadata objects).
    let i = start + keyword[0].length;
    for (let depth = 0; ; i++) {
      if (i >= text.length) throw new SyntaxError(`unterminated ${keyword[0]} directive`);
      const c = text[i];
      if (c === '"') i = skipString(text, i) - 1;
      else if (c === '#') i = skipComment(text, i) - 1;
      else if ('{[('.includes(c)) depth++;
      else if ('}])'.includes(c)) depth--;
      else if (c === ';' && depth === 0) break;
    }
    end = i + 1;
  }
}

// Builtins that would break the one-output-per-input protocol: reading other
// inputs (the next queries) or stopping the shared process.
const GUARDS = ['input', 'inputs', 'halt', 'halt_error', 'halt_error($code)']
  .map((f) => `def ${f}: error("${f.replace(/\(.*/, '')} is not available in a view filter");`).join('\n');

function wrapFilter(text) {
  const [directives, body] = splitDirectives(text);
  const main = skipBlank(body, 0) === body.length ? '.' : body;
  return `${directives}\n${GUARDS}\ndef __view:\n${main}\n;\ntry {ok: [__view]} catch {error: .}\n`;
}

// --- The process pool ------------------------------------------------------

class JqProcess {
  constructor(jq, argv, cwd) {
    this.pending = [];
    this.stderr = '';
    this.child = spawn(jq, argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {}); // reported by 'exit'
    this.child.stderr.setEncoding('utf8').on('data', (d) => { this.stderr = (this.stderr + d).slice(-4096); });
    this.child.on('error', (e) => this.fail(`cannot run ${jq}: ${e.message}`));
    this.child.on('exit', (code, signal) => this.fail(`jq exited (${signal ?? `code ${code}`})${this.stderr ? `: ${this.stderr.trim()}` : ''}`));
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', (line) => this.receive(line));
    this.keepAlive(false);
  }

  // While idle, the process must not keep Node.js running.
  keepAlive(on) {
    for (const handle of [this.child, this.child.stdin, this.child.stdout, this.child.stderr]) {
      if (on) handle.ref?.(); else handle.unref?.();
    }
  }

  run(input, timeout) {
    return new Promise((resolvePromise, reject) => {
      if (this.dead) return reject(new JqError('jq is not running', { status: 500 }));
      const job = { resolve: resolvePromise, reject };
      if (timeout) job.timer = setTimeout(() => this.kill(`jq filter took longer than ${timeout} ms`), timeout);
      if (this.pending.push(job) === 1) this.keepAlive(true);
      this.child.stdin.write(`${JSON.stringify(input)}\n`);
    });
  }

  receive(line) {
    const job = this.pending.shift();
    if (!job) return;
    clearTimeout(job.timer);
    if (this.pending.length === 0) this.keepAlive(false);
    const { ok, error } = JSON.parse(line);
    if (!ok) {
      // An error raised by the filter, e.g. `error("...")` to reject a query.
      job.reject(new JqError(typeof error === 'string' ? error : JSON.stringify(error), { stderr: this.stderr, status: 400 }));
    } else if (ok.length !== 1) {
      job.reject(new JqError(`jq filter must output exactly one value, got ${ok.length}`, { status: 500 }));
    } else {
      job.resolve(ok[0]);
    }
  }

  fail(message) {
    this.dead = true;
    for (const job of this.pending.splice(0)) {
      clearTimeout(job.timer);
      job.reject(new JqError(message, { stderr: this.stderr, status: 500 }));
    }
    this.keepAlive(false);
  }

  kill(message) {
    this.fail(message);
    this.child.kill('SIGKILL');
  }
}

/**
 * Builds a transform `(json) => Promise<json>` that pipes its input through a
 * jq filter file, run by a pool of long-running jq processes, each applying
 * the filter to one input after another. The filter is checked (compiled)
 * now, so errors in it, or in its modules and argument files, are thrown here.
 *
 * It runs the jq executable, so the filter can `import` and `include` modules:
 * from `libraryPaths` (passed to jq as `-L`, by default the `jq_modules`
 * folder jqpm installs into), from the `JQ_LIBRARY_PATH` environment variable
 * (the convention `jqpm exec` sets), and `./`-relative to the filter itself
 * (jq runs in the filter's folder). The filter is read once, as are its
 * modules and argument files when the processes start.
 *
 * The returned function has a `close()` method that stops the processes.
 *
 * @param {object} options
 * @param {string} options.filter path of the jq filter file
 * @param {string[]} [options.libraryPaths] module search paths, relative to the filter's folder
 * @param {Record<string, unknown>} [options.args] named arguments, available in the filter as `$name`
 *   (passed on jq's command line, so each is limited to 128 KiB on Linux)
 * @param {Record<string, string>} [options.argFiles] named arguments read by jq from JSON files (paths
 *   relative to the filter's folder), as with jq's `--slurpfile`: `$name` is the array of the file's
 *   JSON values, so `$name[0]` for a file holding one value
 * @param {string} [options.jq] jq executable
 * @param {number} [options.processes] number of jq processes (default: up to 4, one per CPU)
 * @param {number} [options.timeout] milliseconds a filter may take on one input before its process is
 *   killed, failing the queries it was handling (default 10000; 0 for none)
 */
export function jqTransform({
  filter, libraryPaths = ['jq_modules'], args = {}, argFiles = {}, jq = 'jq',
  processes = Math.min(4, availableParallelism()), timeout = 10000,
}) {
  if (!filter) throw new TypeError('jqTransform: a filter file is required');
  if (!(processes >= 1)) throw new TypeError('jqTransform: processes must be at least 1');
  const filterPath = resolve(filter);
  const cwd = dirname(filterPath);
  const envPaths = (process.env.JQ_LIBRARY_PATH ?? '').split(delimiter).filter(Boolean);
  const options = [];
  for (const p of [...libraryPaths, ...envPaths]) options.push('-L', resolve(cwd, p));
  for (const [name, value] of Object.entries(args)) {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) >= MAX_ARG_BYTES) {
      throw new TypeError(`jq argument $${name} is too large to pass on the command line (${Buffer.byteLength(json)} bytes, `
        + `the limit is ${MAX_ARG_BYTES - 1}); put it in a JSON file and load it with argFiles instead`);
    }
    options.push('--argjson', name, json);
  }
  for (const [name, file] of Object.entries(argFiles)) {
    if (Object.hasOwn(args, name)) throw new TypeError(`jq argument $${name} is set in both args and argFiles`);
    options.push('--slurpfile', name, resolve(cwd, file));
  }

  // The wrapped program is given as text, not as a file, so that `./` imports
  // resolve against jq's working directory, the filter's folder.
  let program;
  try {
    program = wrapFilter(readFileSync(filterPath, 'utf8'));
  } catch (e) {
    throw new TypeError(`cannot read jq filter ${filterPath}: ${e.message}`);
  }
  if (Buffer.byteLength(program) >= MAX_ARG_BYTES) {
    throw new TypeError(`jq filter ${filterPath} is too large (the limit is about 128 KiB); move part of it to modules`);
  }
  const argv = ['--compact-output', '--unbuffered', ...options, program];

  // Check the filter now: given no input, jq compiles the program (and loads
  // its modules and argument files) without running it.
  const check = (args) => spawnSync(jq, args, { cwd, input: '', encoding: 'utf8' });
  const checked = check(argv);
  if (checked.error) throw new TypeError(`cannot run ${jq}: ${checked.error.message}`);
  if (checked.status !== 0) {
    // Report errors against the filter as written, not as wrapped.
    const original = check([...options, '--from-file', filterPath]);
    throw new TypeError(original.status !== 0
      ? `jq filter ${filterPath} cannot be used: ${original.stderr.trim()}`
      : `jq filter ${filterPath} cannot be run by the proxy: ${checked.stderr.trim()}`);
  }

  const pool = Array.from({ length: processes }, () => new JqProcess(jq, argv, cwd));
  let closed = false;
  const transform = (input) => {
    if (closed) return Promise.reject(new JqError('jq transform is closed', { status: 503 }));
    // Replace processes that stopped, then pick the least busy one.
    for (let i = 0; i < pool.length; i++) if (pool[i].dead) pool[i] = new JqProcess(jq, argv, cwd);
    const proc = pool.reduce((a, b) => (b.pending.length < a.pending.length ? b : a));
    return proc.run(input, timeout);
  };
  transform.close = () => {
    closed = true;
    for (const proc of pool) proc.kill('jq transform is closed');
  };
  return transform;
}
