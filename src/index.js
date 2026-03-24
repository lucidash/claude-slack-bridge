import 'dotenv/config';
import express from 'express';

import { slack, fetchThreadHistory } from './slack.js';
import { verifySlackRequest, isUserAllowed } from './security.js';
import { handleCommand } from './commands.js';
import {
  getSession, saveThread, isActiveThread, getThreadWorkdir, appendInbox,
  getWorkdir, getInbox, clearInbox, getAllSessions,
  saveSttResult, popSttResult,
  getPausedThread, markPauseNotified,
  readSessionSummary, saveSyncPoint,
  isArchivedThread,
  getWatches,
  setThreadSilent, isThreadSilent,
} from './store.js';
import { runClaudeCode } from './claude.js';
import { findMediaFile, transcribe } from './stt.js';
import { initCrons } from './cron.js';
import { triageMessage, matchesSender, getActiveWatch } from './watch.js';

const app = express();
const PORT = process.env.PORT || 3005;

// 세션별 lock/queue: 동일 세션에 대한 동시 resume 방지
const sessionLocks = new Map();

// Slack 이벤트 중복 처리 방지 (event_id → timestamp)
const seenEvents = new Map();
const EVENT_DEDUP_TTL = 60_000; // 60초

function isDuplicateEvent(eventId) {
  if (!eventId) return false;
  if (seenEvents.has(eventId)) return true;
  seenEvents.set(eventId, Date.now());
  // TTL 지난 항목 정리 (100개 이상 쌓였을 때만)
  if (seenEvents.size > 100) {
    const cutoff = Date.now() - EVENT_DEDUP_TTL;
    for (const [id, ts] of seenEvents) {
      if (ts < cutoff) seenEvents.delete(id);
    }
  }
  return false;
}

// AskUserQuestion 대기 중인 질문 (sessionKey → { resolve, reject, questions, timeoutId })
const pendingQuestions = new Map();

// Raw body 저장 (서명 검증용)
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString();
  },
}));

// Slack Events API 엔드포인트
app.post('/slack/events', (req, res) => {
  if (!verifySlackRequest(req)) {
    console.warn('[Security] 유효하지 않은 Slack 서명');
    return res.status(401).send('Unauthorized');
  }

  const { type, challenge, event } = req.body;

  if (type === 'url_verification') {
    console.log('[Slack] URL verification received');
    return res.json({ challenge });
  }

  if (type === 'event_callback' && event) {
    const eventId = req.body.event_id;
    if (isDuplicateEvent(eventId)) {
      console.log(`[Dedup] Duplicate event ignored: ${eventId}`);
      return res.status(200).send('OK');
    }
    handleSlackEvent(event);
  }

  // Slack에게 즉시 200 응답 (3초 내 응답 필요)
  res.status(200).send('OK');
});

// ── 이벤트 핸들러 ──────────────────────────────────────────────

async function handleSlackEvent(event) {
  const isBotMessage = event.bot_id || event.subtype === 'bot_message';

  // Channel Watch: 봇 메시지여도 watched channel + sender 매칭이면 처리
  if (isBotMessage) {
    // top-level 메시지만 triage (스레드 답장은 무시)
    if (!event.thread_ts) {
      const watch = getActiveWatch(event.channel);
      if (watch && matchesSender(event, watch.senders)) {
        handleWatchedMessage(event, watch).catch(err =>
          console.error('[Watch] Error:', err.message)
        );
      }
    }
    return;
  }

  // 사용자 화이트리스트 검증
  if (!isUserAllowed(event.user)) {
    console.warn(`[Security] 허용되지 않은 사용자: ${event.user}`);
    return;
  }

  // DM, 멘션, 또는 활성 스레드 메시지 처리
  const isDM = event.type === 'message' && event.channel_type === 'im';
  const isMention = event.type === 'app_mention';
  const threadKey = event.thread_ts ? `${event.channel}-${event.thread_ts}` : null;
  const isThreadReply = threadKey && isActiveThread(threadKey);

  if (!isDM && !isMention && !isThreadReply) return;

  // 멘션에서 봇 ID 제거
  let userMessage = (event.text || '').replace(/<@[A-Z0-9]+>\s*/g, '').trim();
  const userId = event.user;
  const channel = event.channel;
  const replyThreadTs = event.thread_ts || event.ts;
  const sessionKey = `${userId}-${replyThreadTs}`;

  console.log(`[Slack] Message from ${userId} (session: ${sessionKey}): ${userMessage.substring(0, 50)}...`);

  // 특수 명령어 처리
  const handled = await handleCommand(userMessage, { channel, replyThreadTs, sessionKey, userId, threadKey, sessionLocks });
  if (handled) {
    // resume이면 놓친 메시지 컨텍스트와 함께 Claude 실행 진행
    if (handled.resumed && handled.missedContext) {
      userMessage = handled.missedContext;
      // → 아래 Claude 실행 로직으로 계속 진행
    } else {
      return;
    }
  }

  // AskUserQuestion 대기 중인 질문이 있으면 답변으로 처리
  const pending = pendingQuestions.get(sessionKey);
  if (pending) {
    const answers = parseUserAnswer(userMessage, pending.questions);
    clearTimeout(pending.timeoutId);
    pending.resolve(answers);
    pendingQuestions.delete(sessionKey);
    console.log(`[AskUser] Answer received for ${sessionKey}: ${userMessage.substring(0, 50)}`);
    try {
      await slack.reactions.add({ channel, name: 'white_check_mark', timestamp: event.ts });
    } catch { /* ignore */ }
    return;
  }

  // pause 상태 체크
  const effectiveThreadKey = threadKey || `${channel}-${replyThreadTs}`;
  const pauseInfo = getPausedThread(effectiveThreadKey);
  if (pauseInfo) {
    if (!pauseInfo.notified) {
      await slack.chat.postMessage({
        channel,
        text: '⏸️ 이 스레드는 일시정지 상태입니다. `!resume`으로 재개하세요.',
        thread_ts: replyThreadTs,
      });
      markPauseNotified(effectiveThreadKey);
    }
    return;
  }

  // archived 스레드 체크 (!split으로 분할된 스레드)
  const archiveInfo = isArchivedThread(effectiveThreadKey);
  if (archiveInfo) {
    try {
      const [newChannel, newTs] = archiveInfo.splitTo.split('-');
      const newPermalink = await slack.chat.getPermalink({ channel: newChannel, message_ts: newTs });
      await slack.chat.postMessage({
        channel,
        text: `✂️ 이 스레드는 분할되었습니다. 새 스레드에서 계속해주세요 → ${newPermalink.permalink}`,
        thread_ts: replyThreadTs,
      });
    } catch {
      await slack.chat.postMessage({
        channel,
        text: '✂️ 이 스레드는 분할되었습니다. 새 스레드에서 계속해주세요.',
        thread_ts: replyThreadTs,
      });
    }
    return;
  }

  // 멘션으로 시작된 스레드 저장 (톱레벨 멘션 + 스레드 내 멘션 모두)
  if (isMention) {
    const mentionThreadKey = `${channel}-${replyThreadTs}`;
    if (!isActiveThread(mentionThreadKey)) {
      saveThread(mentionThreadKey, userId);
      console.log(`[Slack] New thread started: ${mentionThreadKey}`);
    }
  }

  // 텍스트 없이 음성/동영상 파일만 온 경우 → STT 처리
  const mediaFile = !userMessage && findMediaFile(event.files);
  if (mediaFile) {
    console.log(`[STT] Media file detected: ${mediaFile.name} (${mediaFile.mimetype})`);
    await handleStt(mediaFile, { channel, replyThreadTs });
    return;
  }

  // STT 결과가 있는 스레드에서 답장이 온 경우 → STT 컨텍스트 전달
  const sttThreadKey = `${channel}-${replyThreadTs}`;
  const pendingStt = popSttResult(sttThreadKey);
  if (pendingStt) {
    const isShortConfirm = /^(ㅇㅇ|ㅇ|응|수행|해줘|실행|고|넹|네|yes|ok|go|ㄱ|ㄱㄱ)$/i.test(userMessage);
    if (isShortConfirm) {
      userMessage = pendingStt;
      console.log(`[STT] Executing voice command: ${userMessage.substring(0, 50)}...`);
    } else {
      userMessage = `[음성 인식 결과 참고]\n${pendingStt}\n\n[사용자 답장]\n${userMessage}`;
      console.log(`[STT] Appending voice context to user message`);
    }
  }

  // !silent 프리픽스 처리 또는 스레드 silent 상태 상속
  const effectiveTk = threadKey || `${channel}-${replyThreadTs}`;
  let silent = false;
  if (/^!silent\s+/i.test(userMessage)) {
    silent = true;
    userMessage = userMessage.replace(/^!silent\s+/i, '');
    setThreadSilent(effectiveTk, true);
  } else if (isThreadSilent(effectiveTk)) {
    silent = true;
  }

  // inbox에 메시지 추가
  appendInbox({
    id: `${channel}-${event.ts}`,
    type: 'dm',
    channel,
    user: userId,
    text: userMessage,
    ts: event.ts,
    receivedAt: new Date().toISOString(),
  });

  await processMessage({
    userMessage, channel, replyThreadTs, userId,
    eventTs: event.ts, threadTs: event.thread_ts, silent,
  });
}

/**
 * 메시지를 세션 큐에 넣고 Claude 실행. Cron에서도 재사용.
 */
async function processMessage({ userMessage, channel, replyThreadTs, userId, eventTs, threadTs, silent = false }) {
  const sessionKey = `${userId}-${replyThreadTs}`;

  const lock = sessionLocks.get(sessionKey) || { processing: false, queue: [] };
  if (!sessionLocks.has(sessionKey)) sessionLocks.set(sessionKey, lock);

  // 동일 텍스트 중복 큐잉 방지 (더블 클릭, 네트워크 재전송 등)
  const isDuplicate = lock.queue.some(item => item.userMessage === userMessage);
  if (isDuplicate) {
    console.log(`[Queue] Duplicate message ignored for ${sessionKey}: ${userMessage.substring(0, 40)}...`);
    return;
  }

  lock.queue.push({ userMessage, channel, replyThreadTs, userId, eventTs: eventTs || null, threadTs: threadTs || null, silent });

  if (lock.processing) {
    console.log(`[Queue] Queued for busy session ${sessionKey} (${lock.queue.length} pending)`);
    if (eventTs) {
      try {
        await slack.reactions.add({ channel, name: 'inbox_tray', timestamp: eventTs });
      } catch { /* ignore */ }
    }
    return;
  }

  lock.processing = true;
  lock.aborted = false;
  try {
    while (lock.queue.length > 0 && !lock.aborted) {
      const item = lock.queue.shift();
      await executeClaudeRequest(sessionKey, item);
    }
  } finally {
    lock.processing = false;
    lock.aborted = false;
    sessionLocks.delete(sessionKey);
  }
}

// ── Claude 실행 ──────────────────────────────────────────────────

const SLACK_MSG_LIMIT = 3900;

function splitMessage(text) {
  if (text.length <= SLACK_MSG_LIMIT) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MSG_LIMIT) {
      chunks.push(remaining);
      break;
    }
    // 줄바꿈 기준으로 자르기
    let cut = remaining.lastIndexOf('\n', SLACK_MSG_LIMIT);
    if (cut < SLACK_MSG_LIMIT * 0.3) cut = SLACK_MSG_LIMIT;
    chunks.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut).replace(/^\n/, '');
  }
  return chunks;
}

function formatElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function formatCtx(usage) {
  if (!usage || !usage.inputTokens) return '';
  const ctx = formatTokens(usage.inputTokens);
  if (usage.contextWindow) {
    return ` | ctx: ${ctx}/${formatTokens(usage.contextWindow)}`;
  }
  return ` | ctx: ${ctx}`;
}

async function executeClaudeRequest(sessionKey, { userMessage, channel, replyThreadTs, userId, eventTs, threadTs, silent = false }) {
  const effectiveThreadKey = `${channel}-${replyThreadTs}`;
  const workdir = getThreadWorkdir(effectiveThreadKey) || getWorkdir(userId);

  // ── Silent DM shadow 설정 ──
  // silent 모드: 원본 채널은 깨끗하게, 과정은 userId에게 DM으로 shadow logging
  let dmChannel = null;
  let dmThreadTs = null;
  if (silent) {
    try {
      const dm = await slack.conversations.open({ users: userId });
      dmChannel = dm.channel.id;
      const permalink = await slack.chat.getPermalink({ channel, message_ts: replyThreadTs }).catch(() => null);
      const link = permalink?.permalink || `${channel}/${replyThreadTs}`;
      const dmMsg = await slack.chat.postMessage({
        channel: dmChannel,
        text: `🔕 *Silent 세션 시작*\n스레드: ${link}\n요청: ${userMessage.substring(0, 200)}${userMessage.length > 200 ? '…' : ''}`,
      });
      dmThreadTs = dmMsg.ts;
    } catch (err) {
      console.error('[Silent] Failed to open DM:', err.message, err.data?.error || '');
    }
  }

  // silent에서 로그를 보낼 채널/스레드 (DM이 없으면 로그 생략)
  const logChannel = silent ? dmChannel : channel;
  const logThreadTs = silent ? dmThreadTs : replyThreadTs;

  // "처리 중" 메시지 전송
  let processingTs = null;
  if (logChannel) {
    try {
      const processingMsg = await slack.chat.postMessage({
        channel: logChannel,
        text: `⏳ 처리 중...`,
        thread_ts: logThreadTs,
      });
      processingTs = processingMsg.ts;
    } catch (err) {
      console.error('[Slack] Failed to send processing message:', err.message);
    }
  }

  const startTime = Date.now();
  let updateTimer = null;
  let lastUsage = null;

  // lock에 진행 상태 기록 (!status 명령어용)
  const lock = sessionLocks.get(sessionKey);
  if (lock) {
    lock.startTime = startTime;
    lock.lastActivities = [];
    lock.lastUsage = null;
    lock.currentMessage = userMessage.length > 80 ? userMessage.substring(0, 80) + '…' : userMessage;
  }

  try {
    let lastActivities = [];
    let nextUpdateDelay = 5000;
    const MAX_UPDATE_DELAY = 60000;
    const BACKOFF_MULTIPLIER = 1.5;

    // 프로그레스 업데이트 (logChannel로 전송 — silent이면 DM, 아니면 원본 스레드)
    if (processingTs && logChannel) {
      (function scheduleUpdate() {
        updateTimer = setTimeout(async () => {
          if (!processingTs || lock?.aborted) return;
          const elapsed = formatElapsed(Date.now() - startTime);
          const ctxInfo = formatCtx(lastUsage);
          const recentActivities = lastActivities.slice(-5).join('\n  ');
          const statusText = recentActivities
            ? `⏳ 처리 중... (${elapsed}${ctxInfo})\n  ${recentActivities}`
            : `⏳ 처리 중... (${elapsed}${ctxInfo})`;
          try {
            await slack.chat.update({ channel: logChannel, ts: processingTs, text: statusText });
          } catch { /* ignore update errors */ }
          nextUpdateDelay = Math.min(nextUpdateDelay * BACKOFF_MULTIPLIER, MAX_UPDATE_DELAY);
          scheduleUpdate();
        }, nextUpdateDelay);
      })();
    }

    const onProgress = (activities, usage) => {
      lastActivities = [...activities];
      if (usage) lastUsage = usage;
      if (lock) {
        lock.lastActivities = lastActivities;
        lock.lastUsage = lastUsage;
      }
    };

    // 새 세션의 첫 메시지에만 스레드 히스토리를 컨텍스트로 포함
    let fullPrompt = userMessage;
    const isNewSession = !getSession(sessionKey);
    if (isNewSession && threadTs) {
      console.log(`[Context] Fetching thread history for ${threadTs}`);
      const threadHistory = await fetchThreadHistory(channel, threadTs);
      if (threadHistory) {
        console.log(`[Context] Thread history: ${threadHistory.length} chars`);
        fullPrompt = `아래는 이 슬랙 스레드의 이전 대화 내용입니다:\n---\n${threadHistory}\n---\n\n위 대화 맥락을 참고하여 다음 요청에 답해주세요:\n${userMessage}`;
      }
    }

    // AskUserQuestion 콜백 (silent 모드에서는 비활성 — DM으로 질문받을 수 없으므로)
    const onAskUser = silent ? undefined : async (questions, signal, pendingText) => {
      if (pendingText) {
        const maxLen = 3900;
        const contextText = pendingText.length > maxLen
          ? pendingText.substring(0, maxLen) + '\n\n... (truncated)'
          : pendingText;
        await slack.chat.postMessage({ channel, text: contextText, thread_ts: replyThreadTs });
        console.log(`[AskUser] Flushed ${pendingText.length} chars of pending text`);
      }
      const text = formatAskUserQuestion(questions);
      await slack.chat.postMessage({ channel, text, thread_ts: replyThreadTs });
      console.log(`[AskUser] Question posted to ${channel}, waiting for answer...`);

      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendingQuestions.delete(sessionKey);
          reject(new Error('AskUserQuestion 응답 시간 초과 (5분)'));
        }, 5 * 60 * 1000);

        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timeoutId);
            pendingQuestions.delete(sessionKey);
            reject(new Error('중단됨'));
          }, { once: true });
        }

        pendingQuestions.set(sessionKey, { resolve, reject, questions, timeoutId });
      });
    };

    // 새 세션이면 세션 ID를 게시 (silent이면 DM에, DM 실패 시 생략)
    const onSessionReady = isNewSession ? (sid) => {
      if (silent && !logChannel) return; // DM 실패 시 원본 채널에 노출하지 않음
      const target = silent ? logChannel : channel;
      const targetTs = silent ? logThreadTs : replyThreadTs;
      slack.chat.postMessage({
        channel: target,
        text: `🔗 Session: \`${sid}\`\n\`\`\`cd ${workdir || '~'} && claude --resume ${sid}\`\`\``,
        thread_ts: targetTs,
      }).catch(err => console.error('[Slack] Failed to post session ID:', err.message));
    } : undefined;

    const { result, usage } = await runClaudeCode(sessionKey, fullPrompt, workdir, { onProgress, onAskUser, onSessionReady });
    clearTimeout(updateTimer);

    const elapsed = formatElapsed(Date.now() - startTime);
    const ctxInfo = formatCtx(usage || lastUsage);

    // "처리 중" → "처리완료"로 업데이트 (logChannel — silent이면 DM)
    if (processingTs && logChannel) {
      await slack.chat.update({ channel: logChannel, ts: processingTs, text: `✅ 처리완료 (${elapsed}${ctxInfo})` }).catch(() => {});
    }

    // 응답 텍스트 정리 (silent 모드에서는 도구 마커 라인 제거)
    let cleanResult = result || '(빈 응답)';
    if (silent) {
      cleanResult = cleanResult
        .split('\n')
        .filter(line => !/^.{1,3}\s+(?:Read|Edit|Write|Bash|Grep|Glob|WebFetch|WebSearch|ToolSearch|Task)[:\s]/.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim() || '(빈 응답)';
    }

    // 응답을 원본 스레드에 게시 (항상 — silent이든 아니든)
    const chunks = splitMessage(cleanResult);
    for (const chunk of chunks) {
      await slack.chat.postMessage({ channel, text: chunk, thread_ts: replyThreadTs });
    }
    console.log(`[Slack] Response sent to ${channel} (${chunks.length} message(s), ${cleanResult.length} chars${silent ? ', silent' : ''})`);

    // sync point 저장 (로컬 터미널에서 이어서 작업 후 !sync 시 사용)
    try {
      const sid = getSession(sessionKey);
      if (sid) {
        const summary = readSessionSummary(sid);
        if (summary) saveSyncPoint(sid, summary.turns.length);
      }
    } catch { /* ignore */ }

  } catch (err) {
    console.error('[Claude] Error:', err.message);
    clearTimeout(updateTimer);

    // 대기 중인 AskUserQuestion 정리
    const pending = pendingQuestions.get(sessionKey);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingQuestions.delete(sessionKey);
    }

    const elapsed = formatElapsed(Date.now() - startTime);
    const ctxInfo = formatCtx(lastUsage);
    // "처리 중" → 에러로 업데이트 (logChannel — silent이면 DM)
    if (processingTs && logChannel) {
      await slack.chat.update({ channel: logChannel, ts: processingTs, text: `❌ 오류 (${elapsed}${ctxInfo}): ${err.message}` }).catch(() => {});
    }

    if (!silent) {
      const errorText = `❌ 오류 발생: ${err.message}`;
      await slack.chat.postMessage({ channel, text: errorText, thread_ts: replyThreadTs }).catch(() => {});
    }
  }
}

// ── AskUserQuestion 헬퍼 ──────────────────────────────────────────

const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

function formatAskUserQuestion(questions) {
  const parts = [];
  for (const q of questions) {
    const multiLabel = q.multiSelect ? ' (복수 선택 가능)' : '';
    parts.push(`🔔 Claude가 질문합니다${multiLabel}:\n\n*${q.question}*`);
    q.options.forEach((opt, i) => {
      const emoji = NUMBER_EMOJI[i] || `${i + 1}.`;
      parts.push(`${emoji} ${opt.label} — ${opt.description}`);
      // markdown 프리뷰 (코멘트 내용 등)를 표시
      if (opt.markdown) {
        parts.push(`\`\`\`\n${opt.markdown}\n\`\`\``);
      }
    });
    if (q.multiSelect) {
      parts.push('\n콤마로 구분하여 답해주세요 (예: 1,3)');
    } else {
      parts.push('\n숫자 또는 옵션명으로 답해주세요.');
    }
  }
  return parts.join('\n');
}

function parseUserAnswer(userMessage, questions) {
  const answers = {};
  const lines = userMessage.trim().split('\n').map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = lines[i] || lines[0] || userMessage.trim();

    if (q.multiSelect) {
      const selections = answer.split(/[,，]/).map(s => s.trim());
      const labels = selections.map(s => {
        const num = parseInt(s);
        if (!isNaN(num) && num >= 1 && num <= q.options.length) {
          return q.options[num - 1].label;
        }
        const match = q.options.find(o => o.label.toLowerCase() === s.toLowerCase());
        return match ? match.label : s;
      });
      answers[q.question] = labels.join(', ');
    } else {
      const num = parseInt(answer);
      if (!isNaN(num) && num >= 1 && num <= q.options.length) {
        answers[q.question] = q.options[num - 1].label;
      } else {
        const match = q.options.find(o => o.label.toLowerCase() === answer.toLowerCase());
        answers[q.question] = match ? match.label : answer;
      }
    }
  }
  return answers;
}

// ── STT 핸들러 ──────────────────────────────────────────────────

async function handleStt(file, { channel, replyThreadTs }) {
  let statusTs = null;
  try {
    const statusMsg = await slack.chat.postMessage({
      channel,
      text: `🎙️ 음성 인식 중... (\`${file.name}\`)`,
      thread_ts: replyThreadTs,
    });
    statusTs = statusMsg.ts;
  } catch { /* ignore */ }

  try {
    const { text, engine } = await transcribe(file.url_private_download, process.env.SLACK_BOT_TOKEN);

    if (statusTs) {
      await slack.chat.update({
        channel,
        ts: statusTs,
        text: `🎙️ 음성 인식 결과 (${engine}):\n\n> ${text}\n\n👉 이 지시를 수행하려면 답장해주세요.`,
      }).catch(() => {});
    }

    // STT 결과를 스레드에 저장 (답장으로 수행할 수 있도록)
    const sttThreadKey = `${channel}-${replyThreadTs}`;
    saveSttResult(sttThreadKey, text);
    console.log(`[STT] Transcribed (${engine}): ${text.substring(0, 80)}...`);
  } catch (err) {
    console.error('[STT] Error:', err.message);
    const errText = `❌ 음성 인식 실패: ${err.message}`;
    if (statusTs) {
      await slack.chat.update({ channel, ts: statusTs, text: errText }).catch(() => {});
    } else {
      await slack.chat.postMessage({ channel, text: errText, thread_ts: replyThreadTs }).catch(() => {});
    }
  }
}

// ── Channel Watch 핸들러 ──────────────────────────────────────

async function handleWatchedMessage(event, watch) {
  const channel = event.channel;
  const messageTs = event.ts;
  const messageText = event.text || '';

  console.log(`[Watch] Triaging message in ${channel}: ${messageText.substring(0, 80)}...`);

  // Haiku로 triage
  const triage = await triageMessage(messageText, watch);
  if (!triage.shouldRespond) {
    console.log(`[Watch] Skipped: ${triage.reason}`);
    return;
  }

  console.log(`[Watch] Triggered: ${triage.reason}`);

  // Action 프롬프트 구성
  const actionPrompt = `[Channel Watch 알림]
채널: ${watch.channelName ? `#${watch.channelName}` : channel}
감지 이유: ${triage.reason}

원본 메시지:
---
${messageText}
---

위 메시지에 대해 다음 행동을 수행하세요:
${watch.action}

참고:
- 응답은 해당 메시지의 Slack 스레드에 게시됩니다.
- Slack 멘션 형식: <@USER_ID>
- 필요하면 코드베이스를 분석하세요.`;

  // silent 모드로 실행 (스레드를 활성 등록하지 않음 — 이후 사용자 메시지에 자동 반응 방지)
  const watchThreadKey = `${channel}-${messageTs}`;
  setThreadSilent(watchThreadKey, true);

  // processMessage를 통해 Claude 실행 (silent 모드 — 결과 텍스트만 게시)
  const userId = watch.addedBy;
  await processMessage({
    userMessage: actionPrompt,
    channel,
    replyThreadTs: messageTs,
    userId,
    eventTs: null,
    threadTs: null,
    silent: true,
  });
}

// ── 디버그 엔드포인트 ──────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/inbox', (_req, res) => res.json(getInbox()));
app.delete('/inbox', (_req, res) => { clearInbox(); res.json({ status: 'cleared' }); });
app.get('/sessions', (_req, res) => res.json(getAllSessions()));

// ── 서버 시작 ──────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Server] Claude Slack Bridge running on port ${PORT}`);
  initCrons(processMessage);
  console.log(`[Server] Endpoints:`);
  console.log(`         POST   /slack/events  - Slack webhook`);
  console.log(`         GET    /health        - Health check`);
  console.log(`         GET    /inbox         - View inbox`);
  console.log(`         DELETE /inbox         - Clear inbox`);
  console.log(`         GET    /sessions      - View sessions`);
  console.log(`[Server] Commands:`);
  console.log(`         !new, !reset          - Start new session`);
  console.log(`         !wd <path>            - Set thread working directory`);
  console.log(`         !pwd                  - Show working directory`);
  console.log(`         !session              - Show current session`);
  console.log(`         !session <id>         - Switch to session`);
  console.log(`         !pause               - Pause thread`);
  console.log(`         !resume              - Resume thread`);
  console.log(`         !status              - Show current task status`);
  console.log(`         !stop                - Stop running task & clear queue`);
  console.log(`         !queue               - Show queued messages`);
  console.log(`         !split              - Split thread (continue in new thread)`);
  console.log(`         !cron                - Manage cron jobs`);
  console.log(`         !watch              - Channel watch management`);
  // Watch 상태 로그
  const watches = getWatches();
  const activeWatches = Object.entries(watches).filter(([, w]) => w.enabled && w.trigger && w.action && w.senders?.length);
  if (activeWatches.length > 0) {
    console.log(`[Watch] Active watches: ${activeWatches.length}`);
    for (const [chId, w] of activeWatches) {
      console.log(`         ${chId}${w.channelName ? ` (#${w.channelName})` : ''} — ${w.trigger.substring(0, 50)}`);
    }
  }
});
