import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { waitForUserAnswer } from '../src/user-question.js';

const dir = mkdtempSync(join(tmpdir(), 'bridge-async-input-'));
const tracePath = join(dir, 'trace');
const fake = join(dir, 'codex');
writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const send = msg => process.stdout.write(JSON.stringify(msg) + '\\n');
let seq = 0, turn, prompt, answers = 0;
const timers = [];
const notify = (method, params) => send({ method, params: { threadId: 'async-thread', turnId: turn, ...params } });
const message = (id, text, extra = {}) => notify('item/completed', { item: { type: 'agentMessage', id, text, ...extra } });
const complete = status => { timers.splice(0).forEach(clearTimeout); notify('turn/completed', { turn: { id: turn, status, items: [] } }); };
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(tracePath)}, line + '\\n');
  if (msg.id == null) return;
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    send({ id: msg.id, result: { thread: { id: 'async-thread' } } });
  } else if (msg.method === 'turn/start') {
    turn = 'turn-' + (++seq); answers = 0; prompt = msg.params.input[0].text;
    send({ id: msg.id, result: { turn: { id: turn } } });
    notify('turn/started', { turn: { id: turn } });
    message('before', 'Before question');
    const extra = { delivery: 'async', questions: [{ title: 'Which color?', options: ['Red', 'Blue'] }] };
    message('question-1', 'Which color? Red or Blue', extra);
    message('question-1', 'Which color? Red or Blue', extra); // 중복 completed
    if (prompt === 'MULTIPLE') {
      message('question-2', 'Which size?', { delivery: 'async', questions: [{ title: 'Which size?', options: null }] });
    }
    // 질문을 기다리는 동안 모델이 계속 출력할 수 있다.
    timers.push(setTimeout(() => message('meanwhile', 'Meanwhile'), 30));
    if (prompt === 'COMPLETE') timers.push(setTimeout(() => complete('completed'), 60));
  } else if (msg.method === 'turn/steer') {
    if (prompt === 'STEER_ERROR') {
      send({ id: msg.id, error: { code: -32000, message: 'steer failed' } }); return;
    }
    send({ id: msg.id, result: { turnId: turn } });
    if (++answers === (prompt === 'MULTIPLE' ? 2 : 1)) {
      message('final', 'ANSWER_OK'); complete('completed');
    }
  } else if (msg.method === 'turn/interrupt') {
    send({ id: msg.id, result: {} }); complete('interrupted');
  } else send({ id: msg.id, result: {} });
});
`, { mode: 0o755 });
process.env.BRIDGE_DATA_DIR = join(dir, 'state');
process.env.CODEX_PATH = fake;
process.env.CODEX_REQUEST_TIMEOUT_MS = '2000';
const { runCodex, stopCodexQuery, shutdownCodexAppServer } = await import('../src/codex.js');
after(async () => { await shutdownCodexAppServer(); rmSync(dir, { recursive: true, force: true }); });
function trace() { try { return readFileSync(tracePath, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } }
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'expected question/terminal event');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function start(t, key, prompt, onAskUser) {
  const run = runCodex(key, prompt, dir, { onAskUser });
  run.catch(() => {});
  t.after(async () => { stopCodexQuery(key); await run.catch(() => {}); });
  return run;
}
function questionUI(key) {
  const pending = new Map(), calls = [];
  return { pending, calls, ask(questions, signal, text) {
    calls.push({ questions, text });
    return waitForUserAnswer({ pendingQuestions: pending, sessionKey: key, questions, signal });
  } };
}

test('실제 async 질문 형식을 즉시 중계하고 같은 turn으로 답변을 steer한다', async t => {
  const key = 'async-answer', ui = questionUI(key), traceStart = trace().length;
  const run = start(t, key, 'QUESTION', ui.ask);
  await until(() => ui.pending.has(key));
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].text, 'Before question');
  assert.deepEqual(ui.calls[0].questions[0].options.map(o => o.label), ['Red', 'Blue']);
  await new Promise(resolve => setTimeout(resolve, 70));
  ui.pending.get(key).resolve({ 'Which color?': 'Blue' });
  const result = await run;
  assert.equal(result.result, 'Meanwhile\nANSWER_OK');
  const steers = trace().slice(traceStart).filter(m => m.method === 'turn/steer');
  assert.equal(steers.length, 1);
  assert.match(steers[0].params.input[0].text, /Which color\?.*Blue/s);
  assert.ok(steers[0].params.expectedTurnId);
  assert.equal(ui.pending.size, 0);
});
test('여러 async 질문은 Slack waiter를 덮지 않고 순서대로 처리한다', async t => {
  const key = 'async-multiple', ui = questionUI(key);
  const run = start(t, key, 'MULTIPLE', ui.ask);
  await until(() => ui.pending.has(key));
  assert.equal(ui.calls.length, 1);
  ui.pending.get(key).resolve({ 'Which color?': 'Blue' });
  await until(() => ui.calls.length === 2 && ui.pending.has(key));
  assert.equal(ui.calls[1].questions[0].question, 'Which size?');
  ui.pending.get(key).resolve({ 'Which size?': 'Large, please' });
  assert.match((await run).result, /ANSWER_OK/);
});
test('질문 대기 중 !stop은 waiter를 제거하고 늦은 steer를 보내지 않는다', async t => {
  const key = 'async-stop', ui = questionUI(key), traceStart = trace().length;
  const run = start(t, key, 'QUESTION', ui.ask);
  await until(() => ui.pending.has(key));
  assert.equal(stopCodexQuery(key), true);
  await assert.rejects(run, /중단됨/);
  assert.equal(ui.pending.size, 0);
  assert.equal(trace().slice(traceStart).filter(m => m.method === 'turn/steer').length, 0);
});
test('답변 전 turn 종료도 질문 waiter를 제거한다', async t => {
  const key = 'async-complete', ui = questionUI(key);
  const run = start(t, key, 'COMPLETE', ui.ask);
  await until(() => ui.calls.length === 1);
  await run;
  assert.equal(ui.pending.size, 0);
});
test('질문 UI가 없는 silent 실행은 영구 대기 대신 중단한다', async t => {
  const run = start(t, 'async-silent', 'QUESTION');
  let settled = false;
  const checked = assert.rejects(run, /질문.*지원하지 않습니다/).finally(() => { settled = true; });
  checked.catch(() => {});
  await until(() => settled);
  await checked;
});
test('답변 steer 실패는 원인을 보존하고 terminal까지 중단한다', async t => {
  const run = start(t, 'async-steer-error', 'STEER_ERROR', async () => ({ 'Which color?': 'Blue' }));
  let settled = false;
  const checked = assert.rejects(run, /steer failed/).finally(() => { settled = true; });
  checked.catch(() => {});
  await until(() => settled);
  await checked;
});

test('질문 응답 timeout도 오류를 보존하고 turn을 정리한다', async t => {
  const run = start(t, 'async-question-timeout', 'QUESTION', async () => {
    throw new Error('AskUserQuestion 응답 시간 초과');
  });
  await assert.rejects(run, /응답 시간 초과/);
});
