export function assertQuestionActive(signal) {
  if (signal?.aborted) throw new Error('중단됨');
}

export function formatUserMessageForLog(userMessage, questions) {
  if (Array.isArray(questions) && questions.some(question => question?.isSecret)) {
    return '[민감한 응답 숨김]';
  }
  return String(userMessage ?? '').substring(0, 50);
}

export function waitForUserAnswer({
  pendingQuestions,
  sessionKey,
  questions,
  signal,
  timeoutMs = 5 * 60 * 1000,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = null;
    let entry;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      if (pendingQuestions.get(sessionKey) === entry) pendingQuestions.delete(sessionKey);
    };
    const resolveAnswer = answers => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(answers);
    };
    const rejectAnswer = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => rejectAnswer(new Error('중단됨'));

    entry = { resolve: resolveAnswer, reject: rejectAnswer, questions, timeoutId: null };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timeoutId = setTimeout(() => {
      rejectAnswer(new Error('AskUserQuestion 응답 시간 초과 (5분)'));
    }, timeoutMs);
    entry.timeoutId = timeoutId;
    pendingQuestions.set(sessionKey, entry);
  });
}
