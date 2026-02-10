import cron from 'node-cron';
import { randomUUID } from 'crypto';
import { getCrons, saveCrons, getSession } from './store.js';
import { slack } from './slack.js';

const scheduledJobs = new Map(); // id → cron.ScheduledTask
let processMessageFn = null;

/**
 * 서버 시작 시 저장된 cron jobs 복원
 * @param {function} processMessage - index.js에서 전달받는 메시지 처리 함수
 */
export function initCrons(processMessage) {
  processMessageFn = processMessage;
  const jobs = getCrons();
  let enabled = 0;
  for (const job of jobs) {
    if (job.enabled) {
      scheduleJob(job);
      enabled++;
    }
  }
  if (jobs.length > 0) {
    console.log(`[Cron] Loaded ${jobs.length} jobs (${enabled} active)`);
  }
}

function scheduleJob(job) {
  if (scheduledJobs.has(job.id)) {
    scheduledJobs.get(job.id).stop();
  }

  const task = cron.schedule(job.schedule, () => {
    executeCronJob(job);
  });

  scheduledJobs.set(job.id, task);
}

async function executeCronJob(job, callbacks = {}) {
  console.log(`[Cron] Executing job ${job.id}: ${job.message}`);

  try {
    // 알림 메시지를 DM으로 전송 (새 스레드 생성)
    const msg = await slack.chat.postMessage({
      channel: job.channel,
      text: `⏰ Cron: \`${job.description || job.message}\``,
    });

    const sessionKey = `${job.userId}-${msg.ts}`;

    // 세션 ID가 생성되면 콜백 호출 (실행 초기에 감지)
    if (callbacks.onStart) {
      const pollSession = (attempts) => {
        const sid = getSession(sessionKey);
        if (sid) {
          callbacks.onStart({ sessionId: sid, sessionKey, threadTs: msg.ts });
        } else if (attempts < 15) {
          setTimeout(() => pollSession(attempts + 1), 2000);
        }
      };
      setTimeout(() => pollSession(0), 1000);
    }

    // 메시지 처리 파이프라인 실행
    await processMessageFn({
      userMessage: job.message,
      channel: job.channel,
      userId: job.userId,
      replyThreadTs: msg.ts,
      threadTs: null,
    });

    // 실행 이력 기록 (최대 20건)
    const sessionId = getSession(sessionKey) || null;
    const jobs = getCrons();
    const j = jobs.find(j => j.id === job.id);
    if (j) {
      j.lastRun = new Date().toISOString();
      if (!j.runs) j.runs = [];
      j.runs.push({
        at: j.lastRun,
        sessionId,
        threadTs: msg.ts,
      });
      if (j.runs.length > 20) j.runs = j.runs.slice(-20);
      saveCrons(jobs);
    }
    if (callbacks.onComplete) {
      callbacks.onComplete({ sessionId, threadTs: msg.ts });
    }
  } catch (err) {
    console.error(`[Cron] Error executing job ${job.id}:`, err.message);
    try {
      await slack.chat.postMessage({
        channel: job.channel,
        text: `❌ Cron 실행 실패 (\`${job.description || job.id}\`): ${err.message}`,
      });
    } catch { /* ignore */ }
  }
}

export function addCronJob({ schedule, message, channel, userId, description }) {
  if (!cron.validate(schedule)) {
    throw new Error(`유효하지 않은 cron 표현식: \`${schedule}\``);
  }

  const job = {
    id: randomUUID().split('-')[0],
    schedule,
    message,
    channel,
    userId,
    description: description || message,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRun: null,
  };

  const jobs = getCrons();
  jobs.push(job);
  saveCrons(jobs);
  scheduleJob(job);

  return job;
}

export function removeCronJob(id) {
  const jobs = getCrons();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return null;

  const [removed] = jobs.splice(idx, 1);
  saveCrons(jobs);

  if (scheduledJobs.has(id)) {
    scheduledJobs.get(id).stop();
    scheduledJobs.delete(id);
  }

  return removed;
}

export function pauseCronJob(id) {
  const jobs = getCrons();
  const job = jobs.find(j => j.id === id);
  if (!job) return null;

  job.enabled = false;
  saveCrons(jobs);

  if (scheduledJobs.has(id)) {
    scheduledJobs.get(id).stop();
    scheduledJobs.delete(id);
  }

  return job;
}

export function resumeCronJob(id) {
  const jobs = getCrons();
  const job = jobs.find(j => j.id === id);
  if (!job) return null;

  job.enabled = true;
  saveCrons(jobs);
  scheduleJob(job);

  return job;
}

export function runCronJobNow(id, callbacks = {}) {
  const jobs = getCrons();
  const job = jobs.find(j => j.id === id);
  if (!job) return null;

  executeCronJob(job, callbacks).catch(() => {});
  return job;
}

export function listCronJobs() {
  return getCrons();
}

export function getCronHistory(id) {
  const jobs = getCrons();
  const job = jobs.find(j => j.id === id);
  if (!job) return null;
  return { job, runs: job.runs || [] };
}
