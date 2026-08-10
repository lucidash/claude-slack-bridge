import assert from 'node:assert/strict';
import test from 'node:test';
import { formatUserMessageForLog, waitForUserAnswer } from '../src/user-question.js';

test('비밀 질문 답변은 로그에 원문을 노출하지 않는다', () => {
  const preview = formatUserMessageForLog(
    'sk-secret-token-value',
    [{ question: '설명' }, { question: '토큰', isSecret: true }],
  );

  assert.equal(preview, '[민감한 응답 숨김]');
  assert.equal(preview.includes('sk-secret-token-value'), false);
});

test('일반 메시지 로그는 기존처럼 50자까지만 표시한다', () => {
  const message = '가'.repeat(60);
  assert.equal(
    formatUserMessageForLog(message, [{ question: '설명', isSecret: false }]),
    '가'.repeat(50),
  );
});

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
