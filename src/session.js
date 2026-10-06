// claude(SDK) 엔진 실행 흐름 — 턴마다 스트리밍 메시지 하나, 백그라운드 작업은 현황 카드,
// 백그라운드 대기 중 스레드에 온 메시지는 같은 query 의 다음 턴으로 넣는다
import { slack } from './slack.js';
import { runClaudeCode, sendToClaudeQuery, getClaudeQueryState } from './claude.js';
import { TurnView, NullView, BackgroundCard, NullCard, resolveRecipient, splitMarkdown } from './turn-view.js';
import { getSession, getSessionPrUrl, saveProcessing, clearProcessing } from './store.js';
import { formatElapsed, formatCtx, formatRateLimit, truncate } from './format.js';

// 처리 중인 요청 메시지에 다는 리액션 (index.js 의 재시작 정리도 이 이름으로 제거한다)
export const WORKING_REACTION = 'hourglass_flowing_sand';
const QUEUED_REACTION = 'inbox_tray';
const STATUS_LABEL = { completed: '완료', failed: '실패', stopped: '중단' };

function react(target, name, add) {
  if (!target) return;
  const call = add ? slack.reactions.add : slack.reactions.remove;
  call.call(slack.reactions, { channel: target.channel, name, timestamp: target.ts }).catch(() => {});
}

function preview(text) {
  return text.length > 80 ? text.substring(0, 80) + '…' : text;
}

// 백그라운드 완료 알림으로 열린 턴의 머리말
function notificationHeader(notifications) {
  const names = notifications.map(n => `${n.description}${n.status === 'completed' ? '' : ` (${STATUS_LABEL[n.status] || n.status})`}`);
  return `🔔 **백그라운드 작업 끝남** — ${truncate(names.join(', '), 200)}`;
}

function turnFooter({ sessionKey, elapsedMs, usage, rateLimit, liveCount }) {
  const sid = getSession(sessionKey);
  const prUrl = sid ? getSessionPrUrl(sid) : null;
  const prInfo = prUrl ? ` | <${prUrl}|PR>` : '';
  const bg = liveCount ? ` · 🔄 백그라운드 ${liveCount}개 진행 중` : '';
  // 백그라운드 작업이 남아 있으면 요청은 아직 끝나지 않았으므로 "처리완료" 대신 "응답 완료"로 표시한다 (요청 메시지의 ⏳ 도 유지된다)
  const label = liveCount ? '응답 완료' : '처리완료';
  return `✅ ${label} (${formatElapsed(elapsedMs)}${formatCtx(usage)}${formatRateLimit(rateLimit)}${prInfo})${bg}`;
}

async function postMarkdown(channel, threadTs, text) {
  for (const piece of splitMarkdown(text, 11000)) {
    await slack.chat.postMessage({ channel, thread_ts: threadTs, markdown_text: piece });
  }
}

/**
 * claude 엔진으로 스레드 요청을 처리한다. query 는 백그라운드 작업이 끝날 때까지 열려 있고,
 * 그동안 lock.live.inject() 로 들어온 메시지와 lock.queue 에 쌓인 메시지는 같은 query 의 다음 턴이 된다
 *
 * @param {object} opts
 * @param {string} opts.sessionKey
 * @param {object} opts.lock - 세션 lock (queue, aborted, !status 용 진행 상태). 실행 중 lock.live 를 채운다
 * @param {object} opts.item - 첫 메시지 (userMessage, channel, replyThreadTs, userId, eventTs, silent)
 * @param {string} opts.prompt - 첫 턴 프롬프트 (새 세션이면 스레드 히스토리 포함)
 * @param {string|null} opts.logChannel - 진행 표시를 올릴 채널 (silent 면 DM 앵커, 없으면 표시 생략)
 * @param {string|null} opts.logThreadTs
 * @param {function} [opts.onAskUser] - AskUserQuestion 릴레이 (questions, signal) => Promise<answers>
 * @param {function} [opts.onSessionReady]
 * @returns {Promise<{usage: object|null, rateLimit: object|null, backgroundKill: object|null}>}
 *   실패하면 화면을 정리한 뒤 에러를 던진다
 */
export async function runClaudeSession({ sessionKey, lock, item, prompt, workdir, model, effort, logChannel, logThreadTs, onAskUser, onSessionReady }) {
  const { channel, replyThreadTs, silent } = item;
  const recipient = logChannel ? await resolveRecipient(logChannel, item.userId) : null;
  const newView = () => (logChannel
    ? new TurnView({ channel: logChannel, threadTs: logThreadTs, recipient, processingKey: `${sessionKey}#stream` })
    : new NullView());
  const bgCard = logChannel
    ? new BackgroundCard({ channel: logChannel, threadTs: logThreadTs, processingKey: `${sessionKey}#bg` })
    : new NullCard();

  // 사용자 메시지 하나가 여는 턴 — 처리 중에는 메시지에 ⏳ 를 단다 (silent 는 index.js 가 따로 표시)
  const userTurn = (it, { first = false } = {}) => {
    const trigger = silent ? null
      : it.eventTs ? { channel: it.channel, ts: it.eventTs }
        : first ? { channel: it.channel, ts: it.replyThreadTs } // cron 등 트리거 메시지가 없으면 스레드 부모에
          : null;
    react(trigger, WORKING_REACTION, true);
    lock.currentMessage = preview(it.userMessage);
    return { view: newView(), trigger };
  };

  // 턴이 끝나도 백그라운드 작업이 남아 있으면 요청은 아직 끝나지 않았다 — 그동안 요청 메시지 하나에 ⏳ 를 유지한다.
  // 대기 중 보낸 메시지가 쌓여도 ⏳ 가 늘어나지 않도록 가장 먼저 남은 메시지 하나만 유지하고, 나머지는 자기 턴이 끝날 때 제거한다.
  // 재시작으로 중단되면 index.js 가 processing.json 의 'reaction' 항목으로 제거한다
  let held = null;
  const holdKey = `${sessionKey}#hold`;
  const hold = (trigger) => {
    held = trigger;
    saveProcessing(holdKey, { channel: trigger.channel, ts: trigger.ts, kind: 'reaction' });
  };
  const releaseHeld = () => {
    if (!held) return;
    react(held, WORKING_REACTION, false);
    held = null;
    clearProcessing(holdKey);
  };

  let turn = userTurn(item, { first: true }); // 진행 중인 턴
  let nextTurn = null; // 넣었지만 아직 시작되지 않은 사용자 턴
  let turnStartedAt = Date.now();
  lock.startTime = turnStartedAt;

  // 넣은 메시지의 턴이 아직 시작되지 않았으면 대기열로 보낸다 — 메시지와 턴을 하나씩 짝지어야 ⏳ 를 제때 걷는다
  const inject = (it) => {
    if (nextTurn || getClaudeQueryState(sessionKey) !== 'idle') return false;
    const t = userTurn(it);
    if (!sendToClaudeQuery(sessionKey, it.userMessage)) {
      react(t.trigger, WORKING_REACTION, false);
      return false;
    }
    nextTurn = t;
    console.log(`[Session] Injected message into live query ${sessionKey}: ${it.userMessage.substring(0, 40)}...`);
    return true;
  };
  // 대기열에 쌓인 메시지는 턴이 끝날 때 하나씩 다음 턴으로 넣는다
  const injectQueued = () => {
    if (lock.aborted || !lock.queue.length) return;
    const it = lock.queue.shift();
    if (it.eventTs) react({ channel: it.channel, ts: it.eventTs }, QUEUED_REACTION, false);
    if (!inject(it)) lock.queue.unshift(it);
  };
  lock.live = { inject };

  const handlers = {
    model,
    effort,
    onSessionReady,
    onAskUser: onAskUser
      ? async (questions, signal) => {
        await turn.view.pause(); // 질문이 지금까지 내용 아래에 오도록
        return onAskUser(questions, signal);
      }
      : undefined,
    onProgress: (activities, usage, rateLimit) => {
      lock.lastActivities = [...activities];
      if (usage) lock.lastUsage = usage;
      if (rateLimit) lock.lastRateLimit = rateLimit;
    },
    onTurnStart: ({ notifications }) => {
      turn = nextTurn || { view: newView(), trigger: null };
      nextTurn = null;
      if (notifications.length) turn.view.setHeader(notificationHeader(notifications));
      turnStartedAt = Date.now();
      lock.startTime = turnStartedAt;
    },
    onText: (text) => turn.view.text(text),
    onToolUse: (t) => turn.view.toolStart(t),
    onToolResult: (r) => turn.view.toolResult(r),
    onSubagentProgress: (p) => turn.view.toolProgress(p),
    onBackgroundTasks: (tasks) => {
      lock.backgroundTasks = tasks.filter(t => t.status === 'running');
      bgCard.update(tasks);
    },
    onTurnEnd: async ({ text, resultText, usage, rateLimit, background }) => {
      const liveCount = background.filter(t => t.status === 'running').length;
      const { view, trigger } = turn;
      await view.finish({
        footer: turnFooter({ sessionKey, elapsedMs: Date.now() - turnStartedAt, usage, rateLimit, liveCount }),
        fallbackText: text.trim() ? null : resultText,
      });
      if (liveCount && trigger && !held) {
        hold(trigger);
      } else {
        react(trigger, WORKING_REACTION, false);
        // 완료 알림으로 열린 턴은 trigger 가 없으므로, 남은 작업이 없어지는 턴에서 유지하던 ⏳ 를 제거한다
        if (!liveCount) releaseHeld();
      }
      // silent: 원본 스레드에는 응답 글만 남긴다 (과정은 로그 채널에)
      const answer = (text.trim() || resultText || '').trim();
      if (silent && answer) {
        await postMarkdown(channel, replyThreadTs, answer)
          .catch(err => console.error('[Session] Failed to post silent answer:', err.data?.error || err.message));
      }
      if (liveCount) await bgCard.moveToBottom();
      turn = { view: new NullView(), trigger: null };
      injectQueued();
    },
  };

  try {
    const result = await runClaudeCode(sessionKey, prompt, workdir, handlers);
    const kill = result.backgroundKill;
    if (kill) {
      const ceiling = kill.ceilingMs >= 60000 ? `${Math.round(kill.ceilingMs / 60000)}분` : `${Math.round(kill.ceilingMs / 1000)}초`;
      await bgCard.finish(`⚠️ 대기 한도(${ceiling})를 넘겨 백그라운드 작업 ${kill.tasks.length}개를 중단했습니다`);
      if (!silent) {
        const names = kill.tasks.length ? `: ${kill.tasks.join(', ')}` : '';
        await slack.chat.postMessage({
          channel,
          thread_ts: replyThreadTs,
          text: `⚠️ 백그라운드 작업이 대기 한도(${ceiling})를 넘겨 강제 종료됐습니다${names}\n이어서 진행하려면 이 스레드에 메시지를 보내주세요.`,
        }).catch(() => {});
      }
    } else {
      await bgCard.finish();
    }
    return result;
  } catch (err) {
    const aborted = err.message.startsWith('중단됨');
    await turn.view.finish({ error: true, footer: aborted ? '🛑 중단됨' : `❌ 오류: ${truncate(err.message, 300)}` });
    react(turn.trigger, WORKING_REACTION, false);
    if (nextTurn) react(nextTurn.trigger, WORKING_REACTION, false);
    await bgCard.finish(aborted ? '🛑 중단됨 — 백그라운드 작업도 함께 종료' : '❌ 오류로 중단됨');
    throw err;
  } finally {
    // 정상 종료·대기 한도 초과·오류·!stop 모두 여기서 유지하던 ⏳ 를 제거한다
    releaseHeld();
    lock.live = null;
  }
}
