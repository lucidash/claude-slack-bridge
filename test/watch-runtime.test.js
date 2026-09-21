import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'watch-runtime-test-'));
process.env.BRIDGE_DATA_DIR = dir;
const store = await import('../src/store.js');
const watch = await import('../src/watch.js');
after(() => rmSync(dir, { recursive: true, force: true }));
// 구버전 RED 실행에서 실제 SDK를 호출하지 않는다.
assert.equal(typeof watch.applyWatchActionConfig, 'function');
const calls = [];
const queryFn = params => {
  calls.push(params);
  return (async function* () { yield { type: 'result', subtype: 'success', result: '{"shouldRespond":true,"reason":"match"}' }; })();
};

test('미설정 감지는 수행 엔진/모델과 무관하게 Claude Haiku를 사용한다', async () => {
  const result = await watch.triageMessage('message', { trigger: 'match', engine: 'codex', model: 'gpt-action' }, { queryFn });
  assert.equal(result.shouldRespond, true);
  assert.equal(calls.at(-1).options.model, 'haiku');
  assert.deepEqual(calls.at(-1).options.tools, []);
  assert.equal(calls.at(-1).options.persistSession, false);
});

test('감지 모델만 재정의할 수 있고 작업 모델을 가져오지 않는다', async () => {
  await watch.triageMessage('message', { trigger: 'match', triageModel: 'sonnet', model: 'opus' }, { queryFn });
  assert.equal(calls.at(-1).options.model, 'sonnet');
});

test('Codex 감지는 독립 ephemeral 실행과 감지 모델을 사용한다', async () => {
  const runs = [];
  const runCodexFn = async (...args) => { runs.push(args); return { result: '{"shouldRespond":false,"reason":"no match"}' }; };
  for (let i = 0; i < 2; i++) {
    const result = await watch.triageMessage('message', { trigger: 'match', triageEngine: 'codex', triageModel: 'gpt-triage', engine: 'claude', model: 'opus' }, { runCodexFn });
    assert.equal(result.shouldRespond, false);
    assert.equal(runs[i][3].model, 'gpt-triage');
    assert.equal(runs[i][3].triage, true);
  }
  assert.notEqual(runs[0][0], runs[1][0]);
  assert.deepEqual(store.getAllSessions(), {});
});

test('잘못된 감지 응답/실패/엔진은 실행하지 않는다', async () => {
  for (const resultText of ['{"shouldRespond":"false","reason":"bad"}', '{"reason":"missing"}', 'not json']) {
    const runCodexFn = async () => ({ result: resultText });
    const result = await watch.triageMessage('message', { triageEngine: 'codex' }, { runCodexFn });
    assert.equal(result.shouldRespond, false);
  }
  const runCodexFn = async () => { throw new Error('offline'); };
  assert.equal((await watch.triageMessage('message', { triageEngine: 'codex' }, { runCodexFn })).shouldRespond, false);
  assert.equal((await watch.triageMessage('message', { triageEngine: 'invalid' }, { queryFn })).shouldRespond, false);
});

test('수행 엔진/모델만 새 스레드에 반영하고 기존 스레드 설정은 보존한다', () => {
  watch.applyWatchActionConfig('C-1', { engine: 'codex', model: 'gpt-action', triageEngine: 'claude', triageModel: 'haiku' });
  assert.equal(store.getThreadEngine('C-1'), 'codex');
  assert.equal(store.getThreadModel('C-1'), 'gpt-action');
  watch.applyWatchActionConfig('C-1', { engine: 'claude', model: 'opus' });
  assert.equal(store.getThreadEngine('C-1'), 'codex');
  assert.equal(store.getThreadModel('C-1'), 'gpt-action');
  watch.applyWatchActionConfig('C-2', { triageEngine: 'codex', triageModel: 'gpt-triage' });
  assert.equal(store.getThread('C-2'), null);
  watch.applyWatchActionConfig('C-3', { model: 'opus' });
  assert.equal(store.getThreadEngine('C-3'), null);
  assert.equal(store.getThreadModel('C-3'), 'opus');
});
