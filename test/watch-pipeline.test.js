import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import test, { after } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'watch-pipeline-test-'));
process.env.BRIDGE_DATA_DIR = dir;
const store = await import('../src/store.js');
const { applyWatchActionConfig } = await import('../src/watch.js');
after(() => rmSync(dir, { recursive: true, force: true }));

// 서버 시작/실제 Slack·엔진 호출 없이 index의 실제 watch→queue→adapter 흐름을 실행한다.
const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const pipeline = source.slice(source.indexOf('async function processMessage('), source.indexOf('// ── STT 핸들러'));
const handler = source.slice(source.indexOf('function extractFullText('), source.indexOf('// ── 디버그 엔드포인트'));
assert.ok(pipeline.startsWith('async function processMessage('));
assert.ok(handler.startsWith('function extractFullText('));
const calls = [];
let sequence = 0;
const runner = engine => async (sessionKey, prompt, cwd, options) => {
  calls.push({ engine, sessionKey, model: options.model, onAskUser: options.onAskUser });
  return { result: 'ok' };
};
const context = vm.createContext({
  ...store, applyWatchActionConfig, console, setTimeout, clearTimeout,
  sessionLocks: new Map(), pendingQuestions: new Map(),
  triageMessage: async (_text, watch) => ({ shouldRespond: watch.trigger !== 'no', reason: 'test' }),
  runCodex: runner('codex'), runClaudeViaPty: runner('pty-claude'), runClaudeCode: runner('claude'),
  fetchThreadHistory: async () => '',
  slack: {
    chat: { postMessage: async () => ({ ts: String(++sequence) }), update: async () => {}, getPermalink: async () => ({ permalink: 'https://example.invalid' }) },
    conversations: { open: async () => ({ channel: { id: 'D' } }) },
    reactions: { add: async () => {}, remove: async () => {} },
  },
});
vm.runInContext(`${pipeline}\n${handler}\nthis.runWatch = handleWatchedMessage;`, context);

for (const [engine, model] of [['claude', 'opus'], ['pty-claude', 'sonnet'], ['codex', 'gpt-action'], [undefined, undefined]]) {
  test(`watch 수행 ${engine || '기본값'} / ${model || '기본값'}는 실제 adapter에 전달된다`, async () => {
    const ts = `watch-${engine || 'default'}`;
    await context.runWatch({ channel: 'C', ts, text: 'message' }, {
      addedBy: 'U', trigger: 'yes', action: 'work', engine, model,
      triageEngine: 'codex', triageModel: 'different-triage-model',
    });
    const call = calls.at(-1);
    assert.equal(call.engine, engine || 'claude');
    assert.equal(call.model, model);
    assert.equal(call.onAskUser, undefined);
  });
}

test('감지 false는 작업을 실행하지 않고 기존 실행 스레드는 새 설정으로 바꾸지 않는다', async () => {
  const count = calls.length;
  await context.runWatch({ channel: 'C', ts: 'ignored', text: 'message' }, { addedBy: 'U', trigger: 'no', action: 'work' });
  assert.equal(calls.length, count);
  store.setThreadEngine('C-existing', 'codex');
  store.setThreadModel('C-existing', 'gpt-existing');
  await context.runWatch({ channel: 'C', ts: 'existing', text: 'message' }, { addedBy: 'U', trigger: 'yes', action: 'work', engine: 'claude', model: 'opus' });
  assert.equal(calls.at(-1).engine, 'codex');
  assert.equal(calls.at(-1).model, 'gpt-existing');
});
