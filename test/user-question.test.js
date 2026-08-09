import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForUserAnswer } from '../src/user-question.js';

test('이미 abort된 질문은 Slack waiter로 등록하지 않는다', async () => {
  const pendingQuestions = new Map();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    waitForUserAnswer({
      pendingQuestions,
      sessionKey: 'session-late-abort',
      questions: [{ question: '계속할까요?' }],
      signal: controller.signal,
      timeoutMs: 100,
    }),
    /중단됨/,
  );
  assert.equal(pendingQuestions.has('session-late-abort'), false);
});

test('등록 뒤 abort된 질문도 Slack waiter에서 제거한다', async () => {
  const pendingQuestions = new Map();
  const controller = new AbortController();
  const waiting = waitForUserAnswer({
    pendingQuestions,
    sessionKey: 'session-active-abort',
    questions: [{ question: '계속할까요?' }],
    signal: controller.signal,
    timeoutMs: 100,
  });

  assert.equal(pendingQuestions.has('session-active-abort'), true);
  controller.abort();
  await assert.rejects(waiting, /중단됨/);
  assert.equal(pendingQuestions.has('session-active-abort'), false);
});
