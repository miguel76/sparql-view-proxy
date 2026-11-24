import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jqTransform, splitDirectives } from '../src/jq.js';

const pool = fileURLToPath(new URL('fixtures/pool/', import.meta.url));

test('splitDirectives separates module directives from the program', () => {
  assert.deepEqual(splitDirectives('.a'), ['', '.a']);
  assert.deepEqual(
    splitDirectives('module {name: "x;y"};\n# c ; import "z";\nimport "a/b" as B {search: ["./;"]};\ninclude "c"; important | B::f'),
    ['module {name: "x;y"};\n# c ; import "z";\nimport "a/b" as B {search: ["./;"]};\ninclude "c";', ' important | B::f'],
  );
  assert.deepEqual(splitDirectives('import "d" as $d; $d[0]'), ['import "d" as $d;', ' $d[0]']);
  assert.deepEqual(splitDirectives('# only a comment\n'), ['', '# only a comment\n']);
  assert.throws(() => splitDirectives('import "a" as A'), /unterminated import/);
});

test('one pool of jq processes serves all the queries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'svp-'));
  process.env.JQ_COUNT_FILE = join(dir, 'count');
  try {
    const transform = jqTransform({ filter: `${pool}double.jq`, jq: `${pool}counting-jq.sh`, processes: 2 });
    const inputs = Array.from({ length: 200 }, (_, n) => ({ n }));
    // Concurrent queries get their own results back, whichever process handles them.
    assert.deepEqual(await Promise.all(inputs.map(transform)), inputs.map(({ n }) => ({ n: n * 2 })));
    for (const input of inputs.slice(0, 20)) assert.deepEqual(await transform(input), { n: input.n * 2 });
    transform.close();
    // One run to check the filter at startup, then the two processes of the pool.
    assert.equal(readFileSync(process.env.JQ_COUNT_FILE, 'utf8').trim().split('\n').length, 1 + 2);
  } finally {
    delete process.env.JQ_COUNT_FILE;
    rmSync(dir, { recursive: true });
  }
});

test('filters must output exactly one value per query, and the pool keeps working', async () => {
  const transform = jqTransform({ filter: `${pool}outputs.jq`, processes: 1 });
  await assert.rejects(transform({ n: 0 }), { status: 500, message: /exactly one value, got 0/ });
  await assert.rejects(transform({ n: 2 }), { status: 500, message: /exactly one value, got 2/ });
  assert.deepEqual(await transform({ n: 1 }), { n: 1 });
  transform.close();
});

test('builtins that would break the pool are errors, and the pool keeps working', async () => {
  const transform = jqTransform({ filter: `${pool}guards.jq`, processes: 1 });
  const results = await Promise.allSettled(['input', 'halt', 'halt_error', 'error', 'none'].map((op) => transform({ op })));
  assert.deepEqual(results.map((r) => r.status === 'fulfilled' ? r.value : r.reason.message), [
    'input is not available in a view filter',
    'halt is not available in a view filter',
    'halt_error is not available in a view filter',
    '{"code":1}',
    { op: 'none' },
  ]);
  assert.equal(results[3].reason.status, 400);
  transform.close();
});

test('a filter that runs too long is stopped and its process replaced', async () => {
  const transform = jqTransform({ filter: `${pool}guards.jq`, processes: 1, timeout: 300 });
  await assert.rejects(transform({ op: 'loop' }), { status: 500, message: /took longer than 300 ms/ });
  assert.deepEqual(await transform({ op: 'none' }), { op: 'none' });
  transform.close();
});

test('a closed transform refuses queries', async () => {
  const transform = jqTransform({ filter: `${pool}double.jq` });
  transform.close();
  await assert.rejects(transform({ n: 1 }), { status: 503 });
});
