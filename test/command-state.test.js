import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'bridge-command-state-'));
const trace = join(dir, 'trace');
const fake = join(dir, 'codex');
writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id == null) return;
  if (msg.method === 'thread/read') {
    fs.appendFileSync(${JSON.stringify(trace)}, msg.params.threadId + '\\n');
    const respond = () => send({ id: msg.id, result: { thread: {
      id: msg.params.threadId, cwd: '/tmp', turns: [],
    } } });
    if (msg.params.threadId.startsWith('aaaaaaaa')) {
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(join(dir, 'release'))})) {
          clearInterval(timer); respond();
        }
      }, 5);
    } else respond();
  } else send({ id: msg.id, result: {} });
});
`);
chmodSync(fake, 0o755);
process.env.BRIDGE_DATA_DIR = join(dir, 'state');
process.env.CODEX_PATH = fake;
process.env.CODEX_REQUEST_TIMEOUT_MS = '2000';
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
const store = await import('../src/store.js');
const { slack } = await import('../src/slack.js');
const { handleCommand } = await import('../src/commands.js');
const { shutdownCodexAppServer } = await import('../src/codex.js');
const messages = [];
slack.chat.postMessage = async payload => { messages.push(payload); return { ts: 'reply' }; };
after(async () => { await shutdownCodexAppServer(); rmSync(dir, { recursive: true, force: true }); });
const slow = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const fast = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
let sequence = 0;
function context() {
  const ts = String(++sequence);
  return { channel: 'C', replyThreadTs: ts, sessionKey: `U1-${ts}`, userId: 'U1', threadKey: `C-${ts}`, sessionLocks: new Map() };
}
async function waitingRead() {
  const deadline = Date.now() + 2000;
  while (!existsSync(trace) || !readFileSync(trace, 'utf8').includes(slow)) {
    assert.ok(Date.now() < deadline, 'thread/read should start');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function delayedLookup(command, ctx, during) {
  rmSync(trace, { force: true });
  rmSync(join(dir, 'release'), { force: true });
  const lookup = handleCommand(`${command} ${slow}`, ctx);
  try { await waitingRead(); await during(); }
  finally { writeFileSync(join(dir, 'release'), 'go'); await lookup; }
}

for (const command of ['!session', '!sync']) {
  test(`${command}의 늦은 조회는 후속 !new를 되돌리지 않는다`, async () => {
    const ctx = context();
    await delayedLookup(command, ctx, () => handleCommand('!new', ctx));
    assert.equal(store.getSession(ctx.sessionKey), undefined);
    assert.equal(store.getThreadEngine(ctx.threadKey), null);
  });
  test(`${command}보다 나중에 보낸 세션 전환이 먼저 끝나도 유지한다`, async () => {
    const ctx = context();
    await delayedLookup(command, ctx, () => handleCommand(`!session ${fast}`, ctx));
    assert.equal(store.getSession(ctx.sessionKey), fast);
  });
}
test('세션 조회 중 다른 참여자가 선택한 모델을 덮어쓰지 않는다', async () => {
  const ctx = context();
  await delayedLookup('!session', ctx, () => handleCommand('!model opus', { ...ctx, userId: 'U2', sessionKey: `U2-${ctx.replyThreadTs}` }));
  assert.equal(store.getThreadModel(ctx.threadKey), 'opus');
  assert.equal(store.getSession(ctx.sessionKey), undefined);
});
test('세션 조회 중 새 실행이 저장한 세션을 덮어쓰지 않는다', async () => {
  const ctx = context();
  await delayedLookup('!session', ctx, async () => store.saveSession(ctx.sessionKey, 'new-run'));
  assert.equal(store.getSession(ctx.sessionKey), 'new-run');
});
