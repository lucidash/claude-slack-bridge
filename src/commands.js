import { statSync } from 'fs';
import { homedir } from 'os';
import { slack, fetchThreadHistorySince } from './slack.js';
import { clearSession, getSession, getWorkdir, saveSession, saveThread, isActiveThread, getThreadWorkdir, pauseThread, resumeThread, findSessionWorkdir, readSessionSummary, getSyncPoint, saveSyncPoint, getAllSessions, getAllThreads, findSessionFile, archiveThread, getWatches, getWatch, saveWatch, removeWatch, getSessionPrUrl, getThreadModel, setThreadModel, getThreadEffort, setThreadEffort, getAccounts, addAccount, removeAccount, setCurrentAccount, getThreadEngine, setThreadEngine } from './store.js';
import { stopClaudeQuery } from './claude.js';
import { stopCodexQuery } from './codex.js';
import { addCronJob, removeCronJob, pauseCronJob, resumeCronJob, runCronJobNow, listCronJobs, getCronHistory } from './cron.js';

function formatElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function formatCtx(usage) {
  if (!usage?.inputTokens) return '';
  const fmt = n => n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
  return usage.contextWindow
    ? ` | ctx: ${fmt(usage.inputTokens)}/${fmt(usage.contextWindow)}`
    : ` | ctx: ${fmt(usage.inputTokens)}`;
}

/**
 * 특수 명령어 처리. 처리했으면 true (또는 resume 객체), 아니면 false 반환.
 */
const HELP_TEXT = `*Claude Slack Bridge — 명령어 안내*

*세션 관리*
\`!new\` / \`!reset\` — 새 세션 시작 (기존 세션 초기화)
\`!session\` — 현재 세션 ID 확인
\`!session <id>\` — 다른 세션으로 전환 (작업 디렉토리 자동 감지)
\`!sync <id>\` — 로컬 세션 대화를 슬랙에 동기화 후 이어서 작업
\`!sync-all\` — 최근 24h 내 변경된 모든 세션 일괄 동기화
\`!sync-all <duration>\` — 지정 기간 내 변경 세션 동기화 (예: \`6h\`, \`30m\`)

*작업 디렉토리*
\`!wd <path>\` — 이 스레드의 작업 디렉토리 지정
\`!pwd\` — 현재 작업 디렉토리 확인

*모델*
\`!model\` — 현재 사용 중인 모델 확인
\`!model <sonnet|opus|haiku>\` — 이 스레드의 모델 변경
\`!model reset\` — 기본값으로 초기화

*Effort*
\`!effort\` — 현재 effort 수준 확인
\`!effort <low|medium|high|max>\` — 이 스레드의 effort 변경
\`!effort reset\` — 기본값으로 초기화

*엔진*
\`!engine\` — 현재 AI 엔진 확인
\`!engine <claude|codex>\` — 이 스레드의 엔진 변경
\`!engine reset\` — 기본값(claude)으로 초기화

*실행 제어*
\`!status\` — 진행 중인 작업 상태 확인 (경과 시간, 도구 사용, 컨텍스트)
\`!stop\` — 현재 작업 중단 (대기열은 이어서 처리)
\`!stop all\` — 현재 작업 중단 + 대기열 비우기
\`!queue\` — 대기열 확인
\`!queue clear\` — 대기열 비우기 (실행 중 작업은 유지)
\`!queue remove <N>\` — 대기열에서 N번째 항목 제거

*스레드 제어*
\`!pause\` — 스레드 일시정지 (메시지 무시)
\`!resume\` — 스레드 재개 (놓친 메시지 자동 처리)

*Cron*
\`!cron\` — 등록된 cron 목록
\`!cron add "schedule" message -- 설명\` — cron 등록
\`!cron remove <id>\` — cron 삭제
\`!cron pause <id>\` / \`!cron resume <id>\` — 일시정지/재개
\`!cron run <id>\` — 즉시 실행
\`!cron history <id>\` — 실행 이력

*Channel Watch*
\`!watch <channel_id>\` — 채널 watching 등록 (멀티라인으로 sender/trigger/action 설정)
\`!watch-set <channel_id> <field> <value>\` — watch 설정 개별 수정
\`!unwatch <channel_id>\` — watching 해제
\`!watches\` — 전체 watch 목록

*Claude 계정 (OAuth 토큰)*
\`!account\` / \`!account list\` — 등록된 계정 목록 + 현재 활성 계정
\`!account current\` — 현재 활성 계정 확인
\`!account add <name> <token>\` — 계정 등록 (DM에서만, token은 \`claude setup-token\`으로 생성)
\`!account switch <name>\` — 활성 계정 전환 (다음 요청부터 적용)
\`!account remove <name>\` — 계정 삭제

*기타*
\`!silent <메시지>\` — 조용히 실행 (처리 과정 표시 없이 결과만 게시)
\`!help\` — 이 도움말 표시`;

export async function handleCommand(userMessage, { channel, replyThreadTs, sessionKey, userId, threadKey, sessionLocks }) {
  const msg = userMessage.toLowerCase();

  // help
  if (['!help', '/help', '!h', 'help'].includes(msg)) {
    await slack.chat.postMessage({ channel, text: HELP_TEXT, thread_ts: replyThreadTs });
    return true;
  }

  // new / reset
  if (['!new', '!reset', '/new', '/reset', 'new', 'reset'].includes(msg)) {
    clearSession(sessionKey);
    await slack.chat.postMessage({
      channel,
      text: '🔄 새 세션이 시작되었습니다.',
      thread_ts: replyThreadTs,
    });
    return true;
  }

  // session <id>
  const sessionMatch = userMessage.match(/^[!\/]session\s+(.+)$/i);
  if (sessionMatch) {
    const newSessionId = sessionMatch[1].trim().replace(/`/g, '');
    saveSession(sessionKey, newSessionId);

    // 세션 파일에서 원래 작업 디렉토리 자동 감지 → 스레드에 바인딩
    const detectedDir = findSessionWorkdir(newSessionId);
    const lines = [`🔗 세션이 전환되었습니다: \`${newSessionId}\``];
    if (detectedDir) {
      const effectiveThreadKey = threadKey || `${channel}-${replyThreadTs}`;
      saveThread(effectiveThreadKey, userId, detectedDir);
      lines.push(`📂 작업 디렉토리 자동 설정: \`${detectedDir}\``);
      lines.push(`\`\`\`cd ${detectedDir} && claude --resume ${newSessionId}\`\`\``);
    } else {
      lines.push(`⚠️ 세션 파일을 찾을 수 없습니다. resume 실패 시 \`!wd\`로 디렉토리를 맞춰주세요.`);
    }

    await slack.chat.postMessage({
      channel,
      text: lines.join('\n'),
      thread_ts: replyThreadTs,
    });
    return true;
  }

  // session (현재 확인)
  if (['!session', '!sessions', '/session', '/sessions'].includes(msg)) {
    const currentSession = getSession(sessionKey);
    await slack.chat.postMessage({
      channel,
      text: currentSession
        ? `📍 현재 세션: \`${currentSession}\``
        : '❌ 활성 세션이 없습니다.',
      thread_ts: replyThreadTs,
    });
    return true;
  }

  // wd <path> — 스레드별 작업 디렉토리 지정 (스레드 시작 시에만)
  const wdMatch = userMessage.match(/^[!\/]wd\s+(.+)$/i);
  if (wdMatch) {
    const dir = wdMatch[1].trim().replace(/^~/, homedir());
    try {
      if (!statSync(dir).isDirectory()) throw new Error('Not a directory');
      const effectiveThreadKey = threadKey || `${channel}-${replyThreadTs}`;
      saveThread(effectiveThreadKey, userId, dir);
      clearSession(sessionKey);
      await slack.chat.postMessage({
        channel,
        text: `📂 이 스레드의 작업 디렉토리: \`${dir}\``,
        thread_ts: replyThreadTs,
      });
    } catch {
      await slack.chat.postMessage({
        channel,
        text: `❌ 디렉토리를 찾을 수 없습니다: \`${dir}\``,
        thread_ts: replyThreadTs,
      });
    }
    return true;
  }

  // pwd
  if (['!pwd', '/pwd', 'pwd'].includes(msg)) {
    const effectiveThreadKey = threadKey || `${channel}-${replyThreadTs}`;
    const threadWd = getThreadWorkdir(effectiveThreadKey);
    const globalWd = getWorkdir(userId);
    const workdir = threadWd || globalWd;
    const source = threadWd ? '(스레드)' : '(기본)';
    await slack.chat.postMessage({
      channel,
      text: workdir
        ? `📂 현재 작업 디렉토리 ${source}: \`${workdir}\``
        : '📂 작업 디렉토리 미설정 (기본 디렉토리 사용)',
      thread_ts: replyThreadTs,
    });
    return true;
  }

  // model — 이 스레드에서 사용할 Claude 모델 지정
  const modelMatch = userMessage.match(/^[!\/]model(?:\s+(.+))?$/i);
  if (modelMatch) {
    const effectiveThreadKey = threadKey || `${channel}-${replyThreadTs}`;
    const VALID_MODELS = ['sonnet', 'opus', 'haiku',
      'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'];
    const arg = modelMatch[1]?.trim().toLowerCase();

    if (!arg || arg === 'current') {
      const threadModel = getThreadModel(effectiveThreadKey);
      const defaultModel = process.env.CLAUDE_MODEL || 'sonnet';
      const text = threadModel
        ? `🤖 현재 모델: \`${threadModel}\` (스레드 지정)\n기본값: \`${defaultModel}\``
        : `🤖 현재 모델: \`${defaultModel}\` (기본값)\n변경: \`!model <sonnet|opus|haiku>\``;
      await slack.chat.postMessage({ channel, text, thread_ts: replyThreadTs });
      return true;
    }

    if (arg === 'reset' || arg === 'default') {
      setThreadModel(effectiveThreadKey, null);
      const defaultModel = process.env.CLAUDE_MODEL || 'sonnet';
      await slack.chat.postMessage({
        channel,
        text: `🔄 모델을 기본값으로 초기화했습니다: \`${defaultModel}\``,
        thread_ts: replyThreadTs,
      });
      return true;
    }

    if (!VALID_MODELS.includes(arg)) {
      await slack.chat.postMessage({
        channel,
        text: `❌ 알 수 없는 모델: \`${arg}\`\n사용 가능: \`sonnet\`, \`opus\`, \`haiku\``,
        thread_ts: replyThreadTs,
      });
      return true;
    }

    setThreadModel(effectiveThreadKey, arg);
    await slack.chat.postMessage({
      channel,
      text: `🤖 이 스레드의 모델을 \`${arg}\`로 변경했습니다.`,
      thread_ts: replyThreadTs,
    });
    return true;
  }

  // effort — 이 스레드에서 사용할 thinking effort 수준 지정
  const effortMatch = userMessage.match(/^[!\/]effort(?:\s+(.+))?$/i);
  if (effortMatch) {
    const effectiveThreadKey = threadKey || `${channel}-${replyThreadTs}`;
    const VALID_EFFORTS = ['low', 'medium', 'high', 'max'];
    const arg = effortMatch[1]?.trim().toLowerCase();

    if (!arg || arg === 'current') {
      const threadEffort = getThreadEffort(effectiveThreadKey);
      const defaultEffort = 'max';
      const text = threadEffort
        ? `⚡ 현재 effort: \`${threadEffort}\` (스레드 지정)\n기본값: \`${defaultEffort}\``
        : `⚡ 현재 effort: \`${defaultEffort}\` (기본값)\n변경: \`!effort <low|medium|high|max>\``;
      await slack.chat.postMessage({ channel, text, thread_ts: replyThreadTs });
      return true;
    }

    if (arg === 'reset' || arg === 'default') {
      setThreadEffort(effectiveThreadKey, null);
      await slack.chat.postMessage({
        channel,
        text: `🔄 effort를 기본값으로 초기화했습니다: \`max\``,
        thread_ts: replyThreadTs,
      });
      return true;
    }

    if (!VALID_EFFORTS.includes(arg)) {
      await slack.chat.postMessage({
        channel,
        text: `❌ 알 수 없는 effort: \`${arg}\`\n사용 가능: \`low\`, \`medium\`, \`high\`, \`max\``,
        thread_ts: replyThreadTs,
      });
      return true;
    }

    setThreadEffort(effectiveThreadKey, arg);
    await slack.chat.postMessage({
      channel,
      text: `⚡ 이 스레드의 effort를 \`${arg}\`로 변경했습니다.`,
      thread_ts: replyThreadTs,
    });
    return true;
  }

  // engine — 이 스레드에서 사용할 AI 엔진 지정 (claude / codex)
  const engineMatch = userMessage.match(/^[!\/]engine(?:\s+(.+))?$/i);
  if (engineMatch) {
    const effectiveThreadKey = threadKey || `${channel}-${replyThreadTs}`;
    const VALID_ENGINES = ['claude', 'codex'];
    const arg = engineMatch[1]?.trim().toLowerCase();

    if (!arg || arg === 'current') {
      const threadEngine = getThreadEngine(effectiveThreadKey) || 'claude';
      const text = `🔧 현재 엔진: \`${threadEngine}\`\n변경: \`!engine <claude|codex>\``;
      await slack.chat.postMessage({ channel, text, thread_ts: replyThreadTs });
      return true;
    }

    if (arg === 'reset' || arg === 'default') {
      setThreadEngine(effectiveThreadKey, null);
      clearSession(sessionKey);
      await slack.chat.postMessage({
        channel,
        text: '🔄 엔진을 기본값으로 초기화했습니다: `claude`\n세션이 초기화되었습니다.',
        thread_ts: replyThreadTs,
      });
      return true;
    }

    if (!VALID_ENGINES.includes(arg)) {
      await slack.chat.postMessage({
        channel,
        text: `❌ 알 수 없는 엔진: \`${arg}\`\n사용 가능: \`claude\`, \`codex\``,
        thread_ts: replyThreadTs,
      });
      return true;
    }

    const prevEngine = getThreadEngine(effectiveThreadKey) || 'claude';
    setThreadEngine(effectiveThreadKey, arg);
    // 엔진 변경 시 세션 초기화 (Claude 세션을 Codex로 resume 불가)
    if (prevEngine !== arg) {
      clearSession(sessionKey);
    }
    const modelHint = arg === 'codex'
      ? `\n모델 기본값: \`${process.env.CODEX_MODEL || 'o3'}\` (변경: \`!model <model>\`)`
      : '';
    await slack.chat.postMessage({
      channel,
      text: `🔧 이 스레드의 엔진을 \`${arg}\`로 변경했습니다.${prevEngine !== arg ? '\n세션이 초기화되었습니다.' : ''}${modelHint}`,
      thread_ts: replyThreadTs,
    });
    return true;
  }

  // pause
  if (['!pause', '/pause'].includes(msg)) {
    if (!threadKey) {
      await slack.chat.postMessage({
        channel,
        text: '❌ 스레드에서만 사용할 수 있습니다.',
        thread_ts: replyThreadTs,
      });
      return true;
    }
    pauseThread(threadKey, userId);
    await slack.chat.postMessage({
      channel,
      text: '⏸️ 스레드가 일시정지되었습니다. `!resume`으로 재개하세요.',
      thread_ts: replyThreadTs,
    });
    return true;
  }

  // resume
  if (['!resume', '/resume'].includes(msg)) {
    if (!threadKey) {
      await slack.chat.postMessage({
        channel,
        text: '❌ 스레드에서만 사용할 수 있습니다.',
        thread_ts: replyThreadTs,
      });
      return true;
    }
    const pauseInfo = resumeThread(threadKey);
    if (!pauseInfo) {
      await slack.chat.postMessage({
        channel,
        text: '▶️ 이 스레드는 일시정지 상태가 아닙니다.',
        thread_ts: replyThreadTs,
      });
      return true;
    }
    const missedMessages = await fetchThreadHistorySince(channel, replyThreadTs, pauseInfo.pausedAt);
    if (missedMessages) {
      const missedContext = `[일시정지 해제] 아래는 pause 동안 놓친 대화입니다:\n---\n${missedMessages}\n---\n위 대화를 이해한 뒤, 필요한 후속 작업이 있으면 수행해주세요.`;
      await slack.chat.postMessage({
        channel,
        text: `▶️ 재개되었습니다. 놓친 메시지 ${missedMessages.split('\n').length}건을 처리합니다.`,
        thread_ts: replyThreadTs,
      });
      return { resumed: true, missedContext };
    }
    await slack.chat.postMessage({
      channel,
      text: '▶️ 재개되었습니다. 놓친 메시지가 없습니다.',
      thread_ts: replyThreadTs,
    });
    return true;
  }

  // status (현재 진행 중인 작업 상태 확인)
  if (['!status', '/status'].includes(msg)) {
    const lock = sessionLocks?.get(sessionKey);
    if (!lock || !lock.processing) {
      await slack.chat.postMessage({
        channel,
        text: '📭 현재 실행 중인 작업이 없습니다.',
        thread_ts: replyThreadTs,
      });
      return true;
    }
    const elapsed = lock.startTime ? formatElapsed(Date.now() - lock.startTime) : '?';
    const ctxInfo = lock.lastUsage ? formatCtx(lock.lastUsage) : '';
    const rl = lock.lastRateLimit;
    const rlInfo = rl?.pct != null ? ` | 5h: ${rl.pct}%` : '';
    const sid = getSession(sessionKey);
    const prUrl = sid ? getSessionPrUrl(sid) : null;
    const prInfo = prUrl ? ` | <${prUrl}|PR>` : '';
    const lines = [`▶️ 작업 진행 중 (${elapsed}${ctxInfo}${rlInfo}${prInfo})`];
    if (lock.currentMessage) {
      lines.push(`📝 요청: ${lock.currentMessage}`);
    }
    const activities = lock.lastActivities?.slice(-5);
    if (activities?.length > 0) {
      lines.push(`🔧 최근 활동:`);
      activities.forEach(a => lines.push(`  ${a}`));
    }
    if (lock.queue.length > 0) {
      lines.push(`📥 대기열: ${lock.queue.length}건`);
    }
    await slack.chat.postMessage({ channel, text: lines.join('\n'), thread_ts: replyThreadTs });
    return true;
  }

  // stop (실행 중인 작업 중단, 큐에 남은 메시지는 계속 처리)
  // !stop all — 작업 중단 + 큐 비우기
  if (['!stop', '/stop', '!kill', '/kill', '!stop all', '/stop all'].includes(msg)) {
    const clearQueue = msg.endsWith(' all');
    const effectiveTk = threadKey || `${channel}-${replyThreadTs}`;
    const engine = getThreadEngine(effectiveTk) || 'claude';
    const killed = engine === 'codex' ? stopCodexQuery(sessionKey) : stopClaudeQuery(sessionKey);
    let queueCleared = 0;
    let queueRemaining = 0;
    if (sessionLocks) {
      const lock = sessionLocks.get(sessionKey);
      if (lock) {
        if (clearQueue) {
          queueCleared = lock.queue.length;
          lock.queue.length = 0;
          lock.aborted = true;
        } else {
          queueRemaining = lock.queue.length;
        }
      }
    }
    const parts = [];
    if (killed) parts.push('실행 중인 작업을 중단했습니다');
    if (queueCleared > 0) parts.push(`대기열 ${queueCleared}건을 비웠습니다`);
    if (queueRemaining > 0) parts.push(`대기열 ${queueRemaining}건은 이어서 처리됩니다`);
    const text = parts.length > 0
      ? `🛑 ${parts.join(', ')}.`
      : '🛑 현재 실행 중인 작업이 없습니다.';
    await slack.chat.postMessage({ channel, text, thread_ts: replyThreadTs });
    return true;
  }

  // queue remove N (대기열에서 특정 항목 제거)
  const queueRemoveMatch = userMessage.match(/^[!\/]queue\s+(?:remove|rm|del)\s+(\d+)$/i);
  if (queueRemoveMatch) {
    const index = parseInt(queueRemoveMatch[1], 10);
    const lock = sessionLocks?.get(sessionKey);
    if (!lock || lock.queue.length === 0) {
      await slack.chat.postMessage({
        channel,
        text: '📭 대기열이 비어있습니다.',
        thread_ts: replyThreadTs,
      });
      return true;
    }
    if (index < 1 || index > lock.queue.length) {
      await slack.chat.postMessage({
        channel,
        text: `❌ 유효하지 않은 번호입니다. 1~${lock.queue.length} 사이의 번호를 입력하세요.`,
        thread_ts: replyThreadTs,
      });
      return true;
    }
    const [removed] = lock.queue.splice(index - 1, 1);
    const preview = removed.userMessage.length > 40
      ? removed.userMessage.substring(0, 40) + '…'
      : removed.userMessage;
    await slack.chat.postMessage({
      channel,
      text: `🗑️ 대기열 ${index}번 항목을 제거했습니다: ${preview}${lock.queue.length > 0 ? `\n📥 남은 대기열: ${lock.queue.length}건` : ''}`,
      thread_ts: replyThreadTs,
    });
    return true;
  }

  // queue clear (대기열만 비우기, 실행 중 작업은 유지)
  if (['!queue clear', '/queue clear'].includes(msg)) {
    const lock = sessionLocks?.get(sessionKey);
    if (!lock || lock.queue.length === 0) {
      await slack.chat.postMessage({
        channel,
        text: '📭 대기열이 이미 비어있습니다.',
        thread_ts: replyThreadTs,
      });
      return true;
    }
    const cleared = lock.queue.length;
    lock.queue.length = 0;
    await slack.chat.postMessage({
      channel,
      text: `🗑️ 대기열 ${cleared}건을 비웠습니다.${lock.processing ? ' 실행 중인 작업은 계속 진행됩니다.' : ''}`,
      thread_ts: replyThreadTs,
    });
    return true;
  }

  // queue (대기열 확인)
  if (['!queue', '/queue'].includes(msg)) {
    const lock = sessionLocks?.get(sessionKey);
    if (!lock || (lock.queue.length === 0 && !lock.processing)) {
      await slack.chat.postMessage({
        channel,
        text: '📭 대기열이 비어있고, 실행 중인 작업도 없습니다.',
        thread_ts: replyThreadTs,
      });
      return true;
    }
    const lines = [];
    if (lock.processing) lines.push('▶️ 현재 작업 처리 중');
    if (lock.queue.length > 0) {
      lines.push(`📥 대기 중: ${lock.queue.length}건`);
      lock.queue.forEach((item, i) => {
        const preview = item.userMessage.length > 40
          ? item.userMessage.substring(0, 40) + '…'
          : item.userMessage;
        lines.push(`  ${i + 1}. ${preview}`);
      });
    } else {
      lines.push('📭 대기열 비어있음');
    }
    await slack.chat.postMessage({ channel, text: lines.join('\n'), thread_ts: replyThreadTs });
    return true;
  }

  // split — 새 스레드로 세션 이동 (긴 스레드 분할)
  if (['!split', '/split'].includes(msg)) {
    const currentSession = getSession(sessionKey);
    const effectiveThreadKey = threadKey || `${channel}-${replyThreadTs}`;
    const workdir = getThreadWorkdir(effectiveThreadKey) || getWorkdir(userId);

    if (!currentSession) {
      await slack.chat.postMessage({
        channel,
        text: '❌ 활성 세션이 없어 분할할 수 없습니다.',
        thread_ts: replyThreadTs,
      });
      return true;
    }

    // 실행 중인 작업이 있으면 거부
    const lock = sessionLocks?.get(sessionKey);
    if (lock?.processing) {
      await slack.chat.postMessage({
        channel,
        text: '❌ 작업 진행 중에는 분할할 수 없습니다. `!stop` 후 다시 시도하세요.',
        thread_ts: replyThreadTs,
      });
      return true;
    }

    try {
      // Thread A의 permalink 가져오기
      const oldPermalink = await slack.chat.getPermalink({ channel, message_ts: replyThreadTs });

      // 채널에 새 top-level 메시지를 보내서 Thread B 생성
      const newThread = await slack.chat.postMessage({
        channel,
        text: `✂️ 스레드 분할 — 이전 스레드에서 계속\n🔗 이전: ${oldPermalink.permalink}\n📍 세션: \`${currentSession}\`${workdir ? `\n📂 작업 디렉토리: \`${workdir}\`` : ''}`,
      });
      const newThreadTs = newThread.ts;
      const newThreadKey = `${channel}-${newThreadTs}`;
      const newSessionKey = `${userId}-${newThreadTs}`;

      // Thread B에 세션/스레드 데이터 복사
      saveThread(newThreadKey, userId, workdir);
      saveSession(newSessionKey, currentSession);

      // Thread A 세션 해제 + 아카이브
      clearSession(sessionKey);
      archiveThread(effectiveThreadKey, newThreadKey);

      // Thread B의 permalink 가져오기
      const newPermalink = await slack.chat.getPermalink({ channel, message_ts: newThreadTs });

      // Thread A에 이동 안내
      await slack.chat.postMessage({
        channel,
        text: `✂️ 새 스레드로 이동했습니다 → ${newPermalink.permalink}`,
        thread_ts: replyThreadTs,
      });

      return true;
    } catch (err) {
      console.error('[Split] Error:', err.message);
      await slack.chat.postMessage({
        channel,
        text: `❌ 스레드 분할 실패: ${err.message}`,
        thread_ts: replyThreadTs,
      });
      return true;
    }
  }

  // sync-all [duration] — 모든 활성 세션 일괄 동기화
  const syncAllMatch = userMessage.match(/^[!\/]sync-all(?:\s+(\d+[hm]?))?$/i);
  if (syncAllMatch) {
    const durationStr = syncAllMatch[1] || '24h';
    const durMatch = durationStr.match(/^(\d+)([hm])?$/);
    const num = parseInt(durMatch[1]);
    const unit = durMatch[2] || 'h';
    const durationMs = unit === 'm' ? num * 60 * 1000 : num * 3600 * 1000;
    const cutoff = Date.now() - durationMs;

    const allSessions = getAllSessions();
    const allThreads = getAllThreads();

    // threads.json 순회 → sessionKey 역매핑으로 변경된 세션 탐색
    const synced = [];
    const unchanged = [];

    for (const [threadKey, threadData] of Object.entries(allThreads)) {
      const dashIdx = threadKey.indexOf('-');
      if (dashIdx < 0) continue;
      const threadChannel = threadKey.substring(0, dashIdx);
      const threadTs = threadKey.substring(dashIdx + 1);
      const sessionKey = `${threadData.userId}-${threadTs}`;
      const sessionId = allSessions[sessionKey];
      if (!sessionId) continue;

      const file = findSessionFile(sessionId);
      if (!file) continue;

      const mtime = statSync(file).mtimeMs;
      if (mtime < cutoff) continue;

      const syncPoint = getSyncPoint(sessionId);
      const summary = readSessionSummary(sessionId);
      if (!summary) continue;

      const newTurnCount = summary.turns.length - syncPoint;
      if (newTurnCount <= 0) {
        unchanged.push({ sessionId, cwd: summary.cwd });
        continue;
      }

      // 해당 스레드에 간단한 동기화 알림 전송
      const newTurns = summary.turns.slice(syncPoint);
      const lastUser = [...newTurns].reverse().find(t => t.role === 'user');
      const lastAssistant = [...newTurns].reverse().find(t => t.role === 'assistant');

      const lines = [`🔄 자동 동기화: 로컬에서 +${newTurnCount}턴 추가됨 (전체 ${summary.turns.length}턴)`];
      if (lastUser) {
        const preview = lastUser.text.length > 100 ? lastUser.text.substring(0, 100) + '…' : lastUser.text;
        lines.push(`👤 마지막 요청: ${preview}`);
      }
      if (lastAssistant?.text) {
        const preview = lastAssistant.text.length > 200 ? lastAssistant.text.substring(0, 200) + '…' : lastAssistant.text;
        lines.push(`🤖 마지막 응답: ${preview}`);
      }

      await slack.chat.postMessage({ channel: threadChannel, text: lines.join('\n'), thread_ts: threadTs });
      saveSyncPoint(sessionId, summary.turns.length);

      synced.push({ sessionId, cwd: summary.cwd, newTurnCount, totalTurns: summary.turns.length });
    }

    // 명령어가 실행된 스레드에 결과 요약 전송
    const reportLines = [`📊 일괄 동기화 완료 (최근 ${durationStr})`];
    if (synced.length > 0) {
      reportLines.push(`\n✅ 동기화: ${synced.length}건`);
      for (const s of synced) {
        const sid = s.sessionId.substring(0, 8);
        const dir = s.cwd ? s.cwd.replace(homedir(), '~') : '?';
        reportLines.push(`  \`${sid}…\` +${s.newTurnCount}턴 — ${dir}`);
      }
    }
    if (unchanged.length > 0) {
      reportLines.push(`\n📭 변경 없음: ${unchanged.length}건`);
    }
    if (synced.length === 0 && unchanged.length === 0) {
      reportLines.push('\n📭 대상 세션 없음');
    }

    await slack.chat.postMessage({ channel, text: reportLines.join('\n'), thread_ts: replyThreadTs });
    return true;
  }

  // sync <sessionId> — 세션 대화 내역을 슬랙에 동기화 후 이어서 작업
  const syncMatch = userMessage.match(/^[!\/]sync\s+`?([a-f0-9-]+)`?$/i);
  if (syncMatch) {
    const sessionId = syncMatch[1];
    const summary = readSessionSummary(sessionId);
    if (!summary) {
      await slack.chat.postMessage({
        channel,
        text: `❌ 세션 파일을 찾을 수 없습니다: \`${sessionId}\``,
        thread_ts: replyThreadTs,
      });
      return true;
    }

    // 세션 설정 + 작업 디렉토리 자동 감지 → 스레드에 바인딩
    saveSession(sessionKey, sessionId);
    const lines = [`🔗 세션 동기화: \`${sessionId}\``];
    if (summary.cwd) {
      const effectiveThreadKey = threadKey || `${channel}-${replyThreadTs}`;
      saveThread(effectiveThreadKey, userId, summary.cwd);
      lines.push(`📂 작업 디렉토리: \`${summary.cwd}\``);
    }

    // sync point 이후 턴만 추출 (로컬에서 작업한 부분)
    const syncPoint = getSyncPoint(sessionId);
    const newTurns = summary.turns.slice(syncPoint);
    const totalTurns = summary.turns.length;

    if (syncPoint > 0 && newTurns.length > 0) {
      lines.push(`📨 놓친 메시지: ${newTurns.length}턴 (전체 ${totalTurns}턴 중 ${syncPoint + 1}~${totalTurns})`);
    } else if (syncPoint > 0 && newTurns.length === 0) {
      lines.push(`📭 로컬에서 추가 작업 없음 (마지막 sync point 이후 변경 없음)`);
    } else {
      lines.push(`📨 전체 대화: ${totalTurns}턴`);
    }

    // 대화 요약 포맷팅
    const TOOL_EMOJI = {
      Read: '📖', Edit: '✏️', Write: '📝', Bash: '💻',
      Grep: '🔍', Glob: '📁', WebFetch: '🌐', WebSearch: '🔎',
    };
    const turnsToShow = newTurns.length > 0 ? newTurns : summary.turns;
    const msgLines = [];
    for (const turn of turnsToShow) {
      if (turn.role === 'user') {
        const preview = turn.text.length > 200 ? turn.text.substring(0, 200) + '…' : turn.text;
        msgLines.push(`👤 ${preview}`);
      } else {
        const toolStr = (turn.tools || [])
          .map(t => `${TOOL_EMOJI[t] || '⚙️'} ${t}`)
          .join(', ');
        if (toolStr) msgLines.push(`🔧 ${toolStr}`);
        if (turn.text) {
          const preview = turn.text.length > 500 ? turn.text.substring(0, 500) + '…' : turn.text;
          msgLines.push(`🤖 ${preview}`);
        }
      }
    }

    // 세션 헤더 전송
    await slack.chat.postMessage({ channel, text: lines.join('\n'), thread_ts: replyThreadTs });

    // 대화 내역 전송 (Slack 메시지 제한에 맞춰 분할)
    if (msgLines.length > 0) {
      const LIMIT = 3800;
      let chunk = '';
      for (const line of msgLines) {
        if (chunk.length + line.length + 1 > LIMIT) {
          await slack.chat.postMessage({ channel, text: chunk, thread_ts: replyThreadTs });
          chunk = '';
        }
        chunk += (chunk ? '\n' : '') + line;
      }
      if (chunk) {
        await slack.chat.postMessage({ channel, text: chunk, thread_ts: replyThreadTs });
      }
    }

    // sync point 업데이트 (현재 시점까지 동기화 완료)
    saveSyncPoint(sessionId, totalTurns);

    await slack.chat.postMessage({
      channel,
      text: '✅ 동기화 완료. 이제 이 스레드에서 이어서 작업할 수 있습니다.',
      thread_ts: replyThreadTs,
    });
    return true;
  }

  // cron
  const cronMatch = userMessage.match(/^[!\/]cron(?:\s+(.*))?$/i);
  if (cronMatch) {
    const args = (cronMatch[1] || '').trim();
    const sub = args.split(/\s+/)[0]?.toLowerCase();

    // !cron add "schedule" message [-- description]
    if (sub === 'add') {
      const addMatch = args.match(/^add\s+"([^"]+)"\s+(.+)$/i);
      if (!addMatch) {
        await slack.chat.postMessage({
          channel,
          text: '사용법: `!cron add "0 9 * * 1-5" /scrum -- 매일 아침 스크럼`',
          thread_ts: replyThreadTs,
        });
        return true;
      }
      const schedule = addMatch[1];
      let message = addMatch[2];
      let description = null;
      const descSplit = message.match(/^(.+?)\s+--\s+(.+)$/);
      if (descSplit) {
        message = descSplit[1].trim();
        description = descSplit[2].trim();
      }
      try {
        const job = addCronJob({ schedule, message, channel, userId, description });
        await slack.chat.postMessage({
          channel,
          text: `✅ Cron 등록 완료\nID: \`${job.id}\`\n스케줄: \`${job.schedule}\`\n명령: \`${job.message}\`\n설명: ${job.description}`,
          thread_ts: replyThreadTs,
        });
      } catch (err) {
        await slack.chat.postMessage({
          channel,
          text: `❌ ${err.message}`,
          thread_ts: replyThreadTs,
        });
      }
      return true;
    }

    // !cron remove <id>
    if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      const id = args.split(/\s+/)[1];
      if (!id) {
        await slack.chat.postMessage({ channel, text: '사용법: `!cron remove <id>`', thread_ts: replyThreadTs });
        return true;
      }
      const removed = removeCronJob(id);
      await slack.chat.postMessage({
        channel,
        text: removed ? `🗑️ Cron 삭제: \`${removed.description}\`` : `❌ ID \`${id}\`를 찾을 수 없습니다.`,
        thread_ts: replyThreadTs,
      });
      return true;
    }

    // !cron pause <id>
    if (sub === 'pause') {
      const id = args.split(/\s+/)[1];
      if (!id) {
        await slack.chat.postMessage({ channel, text: '사용법: `!cron pause <id>`', thread_ts: replyThreadTs });
        return true;
      }
      const job = pauseCronJob(id);
      await slack.chat.postMessage({
        channel,
        text: job ? `⏸️ Cron 일시정지: \`${job.description}\`` : `❌ ID \`${id}\`를 찾을 수 없습니다.`,
        thread_ts: replyThreadTs,
      });
      return true;
    }

    // !cron resume <id>
    if (sub === 'resume') {
      const id = args.split(/\s+/)[1];
      if (!id) {
        await slack.chat.postMessage({ channel, text: '사용법: `!cron resume <id>`', thread_ts: replyThreadTs });
        return true;
      }
      const job = resumeCronJob(id);
      await slack.chat.postMessage({
        channel,
        text: job ? `▶️ Cron 재개: \`${job.description}\`` : `❌ ID \`${id}\`를 찾을 수 없습니다.`,
        thread_ts: replyThreadTs,
      });
      return true;
    }

    // !cron run <id>
    if (sub === 'run') {
      const id = args.split(/\s+/)[1];
      if (!id) {
        await slack.chat.postMessage({ channel, text: '사용법: `!cron run <id>`', thread_ts: replyThreadTs });
        return true;
      }
      const job = runCronJobNow(id, {
        onStart: ({ sessionId }) => {
          const effectiveTk = threadKey || `${channel}-${replyThreadTs}`;
          const workdir = getThreadWorkdir(effectiveTk) || getWorkdir(userId) || '~';
          slack.chat.postMessage({
            channel,
            text: `🔗 Session: \`${sessionId}\`\n\`\`\`cd ${workdir} && claude --resume ${sessionId}\`\`\``,
            thread_ts: replyThreadTs,
          }).catch(() => {});
        },
        onComplete: ({ sessionId }) => {
          const sid = sessionId ? `\`${sessionId}\`` : '(없음)';
          slack.chat.postMessage({
            channel,
            text: `✅ Cron 실행 완료: \`${job.description}\`\nSession: ${sid}`,
            thread_ts: replyThreadTs,
          }).catch(() => {});
        },
      });
      await slack.chat.postMessage({
        channel,
        text: job ? `🚀 Cron 즉시 실행 중: \`${job.description}\`` : `❌ ID \`${id}\`를 찾을 수 없습니다.`,
        thread_ts: replyThreadTs,
      });
      return true;
    }

    // !cron history <id>
    if (sub === 'history' || sub === 'log' || sub === 'logs') {
      const id = args.split(/\s+/)[1];
      if (!id) {
        await slack.chat.postMessage({ channel, text: '사용법: `!cron history <id>`', thread_ts: replyThreadTs });
        return true;
      }
      const result = getCronHistory(id);
      if (!result) {
        await slack.chat.postMessage({ channel, text: `❌ ID \`${id}\`를 찾을 수 없습니다.`, thread_ts: replyThreadTs });
        return true;
      }
      const { job, runs } = result;
      if (runs.length === 0) {
        await slack.chat.postMessage({
          channel,
          text: `📋 \`${job.description}\` — 실행 이력 없음`,
          thread_ts: replyThreadTs,
        });
        return true;
      }
      const lines = [`📋 \`${job.description}\` 실행 이력 (최근 ${runs.length}건):`];
      for (const run of runs.slice().reverse()) {
        const time = new Date(run.at).toLocaleString('ko-KR');
        const sid = run.sessionId ? `\`${run.sessionId.substring(0, 8)}…\`` : '-';
        lines.push(`  ${time} | session: ${sid}`);
      }
      await slack.chat.postMessage({ channel, text: lines.join('\n'), thread_ts: replyThreadTs });
      return true;
    }

    // !cron list (기본)
    {
      const jobs = listCronJobs();
      if (jobs.length === 0) {
        await slack.chat.postMessage({
          channel,
          text: '📭 등록된 Cron이 없습니다.\n`!cron add "0 9 * * 1-5" /scrum -- 매일 아침 스크럼`',
          thread_ts: replyThreadTs,
        });
        return true;
      }
      const lines = [`📋 Cron 목록 (${jobs.length}건):`];
      for (const j of jobs) {
        const status = j.enabled ? '✅' : '⏸️';
        const lastRun = j.lastRun ? new Date(j.lastRun).toLocaleString('ko-KR') : '-';
        lines.push(`${status} \`${j.id}\` | \`${j.schedule}\` | ${j.description}`);
        lines.push(`    명령: \`${j.message}\` | 마지막 실행: ${lastRun}`);
      }
      await slack.chat.postMessage({ channel, text: lines.join('\n'), thread_ts: replyThreadTs });
      return true;
    }
  }

  // watches (목록)
  if (['!watches', '/watches', '!watch list', '/watch list'].includes(msg)) {
    const watches = getWatches();
    const entries = Object.entries(watches);
    if (entries.length === 0) {
      await slack.chat.postMessage({
        channel,
        text: '📭 등록된 watch가 없습니다.\n`!watch <channel_id>` + sender/trigger/action으로 등록하세요.',
        thread_ts: replyThreadTs,
      });
      return true;
    }
    const lines = [`👀 Channel Watch 목록 (${entries.length}건):`];
    for (const [chId, w] of entries) {
      const status = w.enabled ? '✅' : '⏸️';
      lines.push(`${status} \`${chId}\`${w.channelName ? ` (#${w.channelName})` : ''}`);
      lines.push(`    sender: \`${(w.senders || []).join(', ')}\``);
      lines.push(`    trigger: ${w.trigger || '(미설정)'}`);
      lines.push(`    action: ${w.action || '(미설정)'}`);
      if (w.anchorChannel) lines.push(`    anchor: \`${w.anchorChannel}\``);
    }
    await slack.chat.postMessage({ channel, text: lines.join('\n'), thread_ts: replyThreadTs });
    return true;
  }

  // unwatch <channel_id>
  const unwatchMatch = userMessage.match(/^[!\/]unwatch\s+(\S+)$/i);
  if (unwatchMatch) {
    const chId = unwatchMatch[1];
    const removed = removeWatch(chId);
    await slack.chat.postMessage({
      channel,
      text: removed
        ? `🗑️ Watch 해제: \`${chId}\`${removed.channelName ? ` (#${removed.channelName})` : ''}`
        : `❌ \`${chId}\` watch를 찾을 수 없습니다.`,
      thread_ts: replyThreadTs,
    });
    return true;
  }

  // watch-set <channel_id> <field> <value>
  const watchSetMatch = userMessage.match(/^[!\/]watch-set\s+(\S+)\s+(sender|trigger|action|enabled|channelName|anchorChannel)\s+([\s\S]+)$/i);
  if (watchSetMatch) {
    const [, chId, field, rawValue] = watchSetMatch;
    const existing = getWatch(chId);
    if (!existing) {
      await slack.chat.postMessage({
        channel,
        text: `❌ \`${chId}\` watch를 먼저 등록하세요: \`!watch ${chId}\``,
        thread_ts: replyThreadTs,
      });
      return true;
    }

    let value = rawValue.trim();
    const update = {};
    if (field === 'sender') {
      // 콤마 구분 또는 단일 값
      const senders = value.split(/[,，]\s*/).map(s => s.trim()).filter(Boolean);
      update.senders = [...new Set([...(existing.senders || []), ...senders])];
    } else if (field === 'enabled') {
      update.enabled = value === 'true' || value === '1';
    } else {
      update[field] = value;
    }

    saveWatch(chId, update);
    await slack.chat.postMessage({
      channel,
      text: `✅ Watch 설정 업데이트: \`${chId}\` ${field} → ${JSON.stringify(update[field] ?? update.senders)}`,
      thread_ts: replyThreadTs,
    });
    return true;
  }

  // watch <channel_id> (멀티라인으로 sender/trigger/action 설정)
  const watchMatch = userMessage.match(/^[!\/]watch\s+(\S+)([\s\S]*)$/i);
  if (watchMatch) {
    const chId = watchMatch[1];
    const body = watchMatch[2] || '';

    // 멀티라인 파싱: "key: value" 형태
    const config = { enabled: true, addedBy: userId, createdAt: new Date().toISOString() };
    const lines = body.split('\n');
    for (const line of lines) {
      const kv = line.match(/^\s*(sender|trigger|action|channelName|anchorChannel)\s*:\s*(.+)$/i);
      if (kv) {
        const [, key, val] = kv;
        const k = key.toLowerCase();
        if (k === 'sender') {
          const senders = val.trim().split(/[,，]\s*/).map(s => s.trim()).filter(Boolean);
          config.senders = [...new Set([...(config.senders || []), ...senders])];
        } else if (k === 'channelname') {
          config.channelName = val.trim();
        } else if (k === 'anchorchannel') {
          config.anchorChannel = val.trim();
        } else {
          config[k] = val.trim();
        }
      }
    }

    // 기존 설정이 있으면 머지
    const existing = getWatch(chId);
    if (existing) {
      if (config.senders && existing.senders) {
        config.senders = [...new Set([...existing.senders, ...config.senders])];
      }
    }

    saveWatch(chId, config);
    const saved = getWatch(chId);

    const report = [`👀 Watch ${existing ? '업데이트' : '등록'}: \`${chId}\``];
    if (saved.channelName) report.push(`채널: #${saved.channelName}`);
    report.push(`sender: \`${(saved.senders || []).join(', ') || '(미설정)'}\``);
    report.push(`trigger: ${saved.trigger || '(미설정)'}`);
    report.push(`action: ${saved.action || '(미설정)'}`);
    if (saved.anchorChannel) report.push(`anchor: \`${saved.anchorChannel}\``);

    const missing = [];
    if (!saved.senders?.length) missing.push('sender');
    if (!saved.trigger) missing.push('trigger');
    if (!saved.action) missing.push('action');
    if (missing.length > 0) {
      report.push(`\n⚠️ 필수 설정 누락: ${missing.join(', ')}`);
      report.push('`!watch-set` 으로 추가 설정하세요.');
    } else {
      report.push(`\n✅ 활성 상태 — 메시지 감지를 시작합니다.`);
    }

    await slack.chat.postMessage({ channel, text: report.join('\n'), thread_ts: replyThreadTs });
    return true;
  }

  // account — Claude OAuth 토큰 계정 전환
  const accountMatch = userMessage.match(/^[!\/]account(?:\s+(.*))?$/i);
  if (accountMatch) {
    const args = (accountMatch[1] || '').trim();
    const sub = args.split(/\s+/)[0]?.toLowerCase() || 'list';
    const isDm = typeof channel === 'string' && channel.startsWith('D');
    const maskToken = (t) => t ? `${t.slice(0, 8)}…${t.slice(-4)}` : '';

    if (sub === 'list' || sub === '' || sub === 'ls') {
      const data = getAccounts();
      const names = Object.keys(data.accounts);
      if (names.length === 0) {
        await slack.chat.postMessage({
          channel,
          text: '📭 등록된 계정이 없습니다.\n1) 터미널에서 `claude setup-token` 실행\n2) DM에서 `!account add <name> <token>`',
          thread_ts: replyThreadTs,
        });
        return true;
      }
      const lines = [`👤 Claude 계정 (${names.length}개):`];
      for (const name of names) {
        const marker = data.current === name ? '▶' : '  ';
        const info = data.accounts[name];
        lines.push(`${marker} \`${name}\` — \`${maskToken(info.token)}\` (added ${info.addedAt?.split('T')[0] || '?'})`);
      }
      lines.push(`\n현재 활성: \`${data.current || '(없음 — 머신 기본 로그인 사용)'}\``);
      await slack.chat.postMessage({ channel, text: lines.join('\n'), thread_ts: replyThreadTs });
      return true;
    }

    if (sub === 'current') {
      const data = getAccounts();
      const text = data.current
        ? `👤 현재 활성 계정: \`${data.current}\` (\`${maskToken(data.accounts[data.current]?.token)}\`)`
        : '👤 활성 계정 없음 — 머신 기본 로그인 사용 중';
      await slack.chat.postMessage({ channel, text, thread_ts: replyThreadTs });
      return true;
    }

    if (sub === 'add') {
      if (!isDm) {
        await slack.chat.postMessage({
          channel,
          text: '🔒 보안상 `!account add`는 DM에서만 사용할 수 있습니다.',
          thread_ts: replyThreadTs,
        });
        return true;
      }
      const addMatch = args.match(/^add\s+(\S+)\s+(\S+)$/i);
      if (!addMatch) {
        await slack.chat.postMessage({
          channel,
          text: '사용법: `!account add <name> <token>`\ntoken은 터미널에서 `claude setup-token` 으로 생성하세요.',
          thread_ts: replyThreadTs,
        });
        return true;
      }
      const [, name, token] = addMatch;
      addAccount(name, token);
      await slack.chat.postMessage({
        channel,
        text: `✅ 계정 \`${name}\` 등록 완료. 토큰이 DM 메시지에 남아있으므로 **원본 메시지를 삭제**하세요.`,
        thread_ts: replyThreadTs,
      });
      return true;
    }

    if (sub === 'switch' || sub === 'use') {
      const name = args.split(/\s+/)[1];
      if (!name) {
        await slack.chat.postMessage({ channel, text: '사용법: `!account switch <name>`', thread_ts: replyThreadTs });
        return true;
      }
      const ok = setCurrentAccount(name);
      await slack.chat.postMessage({
        channel,
        text: ok
          ? `✅ 활성 계정을 \`${name}\`으로 전환했습니다. 다음 요청부터 적용됩니다.`
          : `❌ \`${name}\` 계정을 찾을 수 없습니다. \`!account list\`로 확인하세요.`,
        thread_ts: replyThreadTs,
      });
      return true;
    }

    if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      const name = args.split(/\s+/)[1];
      if (!name) {
        await slack.chat.postMessage({ channel, text: '사용법: `!account remove <name>`', thread_ts: replyThreadTs });
        return true;
      }
      const ok = removeAccount(name);
      await slack.chat.postMessage({
        channel,
        text: ok ? `🗑️ 계정 \`${name}\` 삭제 완료.` : `❌ \`${name}\` 계정을 찾을 수 없습니다.`,
        thread_ts: replyThreadTs,
      });
      return true;
    }

    await slack.chat.postMessage({
      channel,
      text: '사용법: `!account` / `!account current` / `!account add <name> <token>` / `!account switch <name>` / `!account remove <name>`',
      thread_ts: replyThreadTs,
    });
    return true;
  }

  return false;
}
