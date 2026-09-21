import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'watch-config-test-'));
process.env.BRIDGE_DATA_DIR = dir;
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
const store = await import('../src/store.js');
const { slack } = await import('../src/slack.js');
const { handleCommand } = await import('../src/commands.js');
const messages = [];
slack.chat.postMessage = async payload => { messages.push(payload.text); return { ts: 'reply' }; };
const ctx = { channel: 'D', replyThreadTs: '1', userId: 'U', sessionKey: 'U-1', threadKey: 'D-1', sessionLocks: new Map() };
const command = text => handleCommand(text, ctx);
after(() => rmSync(dir, { recursive: true, force: true }));

test('watch 등록 시 두 단계 엔진/모델을 순서와 무관하게 저장한다', async () => {
  await command('!watch C1\nsender: B1\ntrigger: 에러\naction: 분석\ntriageModel: gpt-test\ntriageEngine: codex\nmodel: opus\nengine: claude');
  const config = store.getWatch('C1');
  assert.equal(config.triageEngine, 'codex');
  assert.equal(config.triageModel, 'gpt-test');
  assert.equal(config.engine, 'claude');
  assert.equal(config.model, 'opus');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'watches.json'), 'utf8')).C1, config);
});

test('채널별 설정은 독립이고 action 별칭 및 대소문자를 처리한다', async () => {
  await command('!watch C2\nsender: B2\ntrigger: 요청\naction: 수행');
  await command('!watch-set C2 ACTIONENGINE codex');
  await command('!watch-set C2 actionModel gpt-action');
  await command('!watch-set C2 TRIAGEMODEL haiku');
  assert.equal(store.getWatch('C2').engine, 'codex');
  assert.equal(store.getWatch('C2').model, 'gpt-action');
  assert.equal(store.getWatch('C2').triageModel, 'haiku');
  assert.equal(store.getWatch('C1').model, 'opus');
});

test('엔진 변경은 같은 단계 모델만 초기화하고 reset은 기본값으로 복귀한다', async () => {
  store.saveWatch('C3', { engine: 'codex', model: 'gpt-action', triageEngine: 'codex', triageModel: 'gpt-triage' });
  await command('!watch-set C3 triageEngine reset');
  assert.equal(store.getWatch('C3').triageEngine, null);
  assert.equal(store.getWatch('C3').triageModel, null);
  assert.equal(store.getWatch('C3').model, 'gpt-action');
  await command('!watch-set C3 engine claude');
  assert.equal(store.getWatch('C3').model, null);
  await command('!watch-set C3 model opus');
  await command('!watch-set C3 model reset');
  assert.equal(store.getWatch('C3').model, null);
});

test('잘못된 엔진/모델 및 등록은 일부 설정도 저장하지 않는다', async () => {
  const before = store.getWatch('C1');
  await command('!watch-set C1 triageEngine unknown');
  assert.deepEqual(store.getWatch('C1'), before);
  await command('!watch-set C1 model gpt-invalid-for-claude');
  assert.deepEqual(store.getWatch('C1'), before);
  await command('!watch CBAD\nsender: B\ntrigger: x\naction: y\nengine: invalid');
  assert.equal(store.getWatch('CBAD'), null);
});

test('기존 watch는 유지하고 목록에는 두 단계의 기본값을 구별해 표시한다', async () => {
  store.saveWatch('CLEGACY', { engine: 'pty-claude', action: 'legacy' });
  await command('!watch-set CLEGACY trigger 새조건');
  assert.equal(store.getWatch('CLEGACY').engine, 'pty-claude');
  assert.equal(store.getWatch('CLEGACY').model, undefined);
  await command('!watches');
  assert.match(messages.at(-1), /감지:.*claude.*haiku/);
  assert.match(messages.at(-1), /수행:.*pty-claude/);
});
