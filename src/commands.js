import { statSync } from 'fs';
import { homedir } from 'os';
import { slack, fetchThreadHistorySince } from './slack.js';
import { clearSession, getSession, getWorkdir, saveSession, saveThread, isActiveThread, getThreadWorkdir, pauseThread, resumeThread, findSessionWorkdir, readSessionSummary, getSyncPoint, saveSyncPoint } from './store.js';
import { stopClaudeQuery } from './claude.js';
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
export async function handleCommand(userMessage, { channel, replyThreadTs, sessionKey, userId, threadKey, sessionLocks }) {
  const msg = userMessage.toLowerCase();

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
    const lines = [`▶️ 작업 진행 중 (${elapsed}${ctxInfo})`];
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

  // stop (실행 중인 작업 중단 + 큐 비우기)
  if (['!stop', '/stop', '!kill', '/kill'].includes(msg)) {
    const killed = stopClaudeQuery(sessionKey);
    let queueCleared = 0;
    if (sessionLocks) {
      const lock = sessionLocks.get(sessionKey);
      if (lock) {
        queueCleared = lock.queue.length;
        lock.queue.length = 0;
        lock.aborted = true;
      }
    }
    const parts = [];
    if (killed) parts.push('실행 중인 작업을 중단했습니다');
    if (queueCleared > 0) parts.push(`대기열 ${queueCleared}건을 비웠습니다`);
    const text = parts.length > 0
      ? `🛑 ${parts.join(', ')}.`
      : '🛑 현재 실행 중인 작업이 없습니다.';
    await slack.chat.postMessage({ channel, text, thread_ts: replyThreadTs });
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

  return false;
}
