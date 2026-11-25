const test = require('node:test');
const assert = require('node:assert/strict');
const wait = require('./wait-pages-artifact.cjs');
const artifact = { id: 42, name: 'github-pages', expired: false, size_in_bytes: 100 };
const options = { artifactId: '42', sleep: async () => {}, log: () => {} };

test('recovers when uploaded artifact appears after an empty API result', async () => {
  let calls = 0;
  const result = await wait({ ...options, list: async () => ++calls === 1 ? [] : [artifact] });
  assert.equal(result.id, 42);
  assert.equal(calls, 2);
});

test('does not accept another run artifact or expired content', async () => {
  await assert.rejects(wait({ ...options, attempts: 2,
    list: async () => [{ ...artifact, id: 43 }, { ...artifact, expired: true }]
  }), /wait limit/);
});

test('recovers from a transient service error', async () => {
  let calls = 0;
  await wait({ ...options, list: async () => {
    if (++calls === 1) throw Object.assign(new Error('unavailable'), { status: 503 });
    return [artifact];
  } });
  assert.equal(calls, 2);
});

test('reports permission errors without hiding them', async () => {
  await assert.rejects(wait({ ...options, list: async () => {
    throw Object.assign(new Error('forbidden'), { status: 403 });
  } }), /forbidden/);
});
