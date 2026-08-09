import { spawn } from 'child_process';
import readline from 'readline';
import { homedir } from 'os';
import { isAbsolute, resolve } from 'path';
import {
  clearSessionIfRevision,
  getSession,
  getSessionRevision,
  saveSessionIfRevision,
} from './store.js';

const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_REQUEST_TIMEOUT_MS) || 30_000;
const CLIENT_INFO = { name: 'claude-slack-bridge', title: 'Claude Slack Bridge', version: '1.0.0' };
const VALID_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const VALID_APPROVAL_POLICIES = new Set(['never']);

const runningQueries = new Map();
let sharedServer = null;
let sharedStarting = null;

const ITEM_EMOJI = {
  commandExecution: '💻',
  fileChange: '✏️',
  webSearch: '🔎',
  mcpToolCall: '⚙️',
  dynamicToolCall: '⚙️',
  collabAgentToolCall: '🤝',
  subAgentActivity: '🤖',
  reasoning: '🧠',
  plan: '📋',
  imageView: '🖼️',
  imageGeneration: '🎨',
  contextCompaction: '🗜️',
};

function getCodexPath() {
  return process.env.CODEX_PATH || 'codex';
}

function truncate(value, len = 70) {
  const text = value == null ? '' : String(value);
  return text.length > len ? `${text.substring(0, len)}…` : text;
}

function expandPath(value) {
  const expanded = value.replace(/^~(?=\/|$)/, homedir());
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function runtimeRoots(workdir) {
  const configured = (process.env.CODEX_ALLOWED_DIRS || process.env.CLAUDE_ALLOWED_DIRS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(expandPath);
  const roots = workdir ? [expandPath(workdir), ...configured] : configured;
  return [...new Set(roots)];
}

function validatedChoice(name, fallback, validValues) {
  const configured = process.env[name];
  if (configured == null || configured.trim() === '') return fallback;
  const value = configured.trim().toLowerCase();
  if (!validValues.has(value)) {
    throw new Error(`${name} 값이 올바르지 않습니다: ${configured}. 허용값: ${[...validValues].join(', ')}`);
  }
  return value;
}

function validatedBoolean(name, fallback) {
  const configured = process.env[name];
  if (configured == null || configured.trim() === '') return fallback;
  const value = configured.trim().toLowerCase();
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${name} 값이 올바르지 않습니다: ${configured}. 허용값: true, false`);
  }
  return value === 'true';
}

function codexSettings(workdir, modelOverride, effortOverride) {
  const sandbox = validatedChoice('CODEX_SANDBOX', 'danger-full-access', VALID_SANDBOXES);
  const approvalPolicy = validatedChoice('CODEX_APPROVAL_POLICY', 'never', VALID_APPROVAL_POLICIES);
  const networkAccess = validatedBoolean('CODEX_NETWORK_ACCESS', true);
  const cwd = workdir ? expandPath(workdir) : process.cwd();
  const roots = runtimeRoots(cwd);
  const model = modelOverride || process.env.CODEX_MODEL || null;
  const requestedEffort = effortOverride || process.env.CODEX_EFFORT || null;
  const effort = requestedEffort === 'max' ? 'xhigh' : requestedEffort;

  let sandboxPolicy;
  if (sandbox === 'read-only') {
    sandboxPolicy = { type: 'readOnly', networkAccess };
  } else if (sandbox === 'workspace-write') {
    sandboxPolicy = {
      type: 'workspaceWrite',
      writableRoots: roots.length > 0 ? roots : [cwd],
      networkAccess,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  } else {
    sandboxPolicy = { type: 'dangerFullAccess' };
  }

  return { cwd, roots, model, effort, sandbox, sandboxPolicy, approvalPolicy };
}

function extractItemDetail(item) {
  try {
    switch (item?.type) {
      case 'commandExecution':
        return truncate(item.command, 80);
      case 'fileChange':
        return (item.changes || [])
          .map(change => `${change.kind || '수정'} ${(change.path || '').replace(/^.*\//, '')}`)
          .join(', ');
      case 'webSearch':
        return truncate(item.query, 60);
      case 'mcpToolCall':
        return truncate(`${item.server || 'mcp'}/${item.tool || 'tool'}`, 60);
      case 'dynamicToolCall':
        return truncate(`${item.namespace ? `${item.namespace}/` : ''}${item.tool || 'tool'}`, 60);
      case 'collabAgentToolCall':
        return truncate(item.tool || item.prompt, 60);
      case 'subAgentActivity':
        return truncate(`${item.kind || 'activity'} ${item.agentPath || item.agentThreadId || ''}`, 60);
      case 'reasoning':
        return '추론 중';
      case 'plan':
        return '계획 작성 중';
      case 'imageView':
        return truncate(item.path, 60);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function activityMarker(item) {
  const emoji = ITEM_EMOJI[item?.type] || '⚙️';
  const detail = extractItemDetail(item);
  return detail ? `${emoji} ${item.type}: ${detail}` : `${emoji} ${item?.type || '작업'}`;
}

function updateActivity(context, item) {
  if (!item?.id || item.type === 'agentMessage' || item.type === 'userMessage') return;
  const marker = activityMarker(item);
  if (!context.activityIndexes.has(item.id)) {
    context.activityIndexes.set(item.id, context.activities.length);
    context.activities.push(marker);
  } else {
    context.activities[context.activityIndexes.get(item.id)] = marker;
  }
  context.onProgress?.(context.activities, context.lastUsage, context.lastRateLimit);
}

function normalizeUsage(tokenUsage) {
  const current = tokenUsage?.last;
  if (!current) return null;
  return {
    inputTokens: current.inputTokens || 0,
    outputTokens: current.outputTokens || 0,
    cachedInputTokens: current.cachedInputTokens || 0,
    reasoningOutputTokens: current.reasoningOutputTokens || 0,
    contextWindow: tokenUsage.modelContextWindow || 0,
  };
}

function normalizeRateLimit(snapshot) {
  const window = snapshot?.primary;
  if (!window || window.usedPercent == null) return null;
  return {
    pct: Math.round(window.usedPercent),
    resetsAt: window.resetsAt || null,
    windowDurationMins: window.windowDurationMins || null,
    type: snapshot.limitName || snapshot.limitId || null,
  };
}

function mergeRateLimit(current, snapshot) {
  const next = normalizeRateLimit(snapshot);
  if (!next) return current;
  return {
    pct: next.pct,
    resetsAt: next.resetsAt ?? current?.resetsAt ?? null,
    windowDurationMins: next.windowDurationMins ?? current?.windowDurationMins ?? null,
    type: next.type ?? current?.type ?? null,
  };
}

function resultText(context) {
  return [...context.messages.values()]
    .map(message => message.text)
    .filter(Boolean)
    .join('\n')
    .trim();
}

function setAgentDelta(context, params) {
  if (!params.itemId || !params.delta) return;
  const current = context.messages.get(params.itemId) || { text: '', streamed: true };
  current.text += params.delta;
  current.streamed = true;
  context.messages.set(params.itemId, current);
}

function setCompletedAgentMessage(context, item) {
  if (!item?.id || !item.text) return;
  const current = context.messages.get(item.id);
  if (!current || !current.streamed) {
    context.messages.set(item.id, { text: item.text, streamed: false });
  } else if (item.text !== current.text && item.text.startsWith(current.text)) {
    current.text = item.text;
  }
}

function contextForMessage(server, params) {
  const threadId = params?.threadId || params?.conversationId;
  const context = threadId ? server.contextsByThread.get(threadId) : null;
  const turnId = params?.turnId || params?.turn?.id;
  if (context?.turnId && turnId && context.turnId !== turnId) return null;
  return context;
}

function sendServerResponse(server, id, payload) {
  server.write({ jsonrpc: '2.0', id, ...payload });
}

function approvalResponse(method, approve) {
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return { result: { decision: approve ? 'approved' : 'denied' } };
  }
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    return { result: { decision: approve ? 'accept' : 'decline' } };
  }
  return null;
}

function normalizeQuestions(questions) {
  return (questions || []).map(question => ({
    question: question.question,
    header: question.header,
    options: question.options || [],
    multiSelect: false,
    isSecret: Boolean(question.isSecret),
    provider: 'Codex',
    codexId: question.id,
  }));
}

async function handleUserInputRequest(server, msg, context) {
  const original = msg.params?.questions || [];
  if (!context?.onAskUser) {
    const answers = Object.fromEntries(original.map(question => [question.id, { answers: [] }]));
    sendServerResponse(server, msg.id, { result: { answers } });
    return;
  }

  const requestId = String(msg.id);
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort(context.abortController.signal.reason);
  if (context.abortController.signal.aborted) abortRequest();
  else context.abortController.signal.addEventListener('abort', abortRequest, { once: true });
  context.pendingServerRequests.set(requestId, requestController);

  try {
    if (requestController.signal.aborted) return;
    const questions = normalizeQuestions(original);
    const answerMap = await context.onAskUser(
      questions,
      requestController.signal,
      resultText(context),
    );
    if (requestController.signal.aborted) return;
    // 질문 전에 Slack으로 내보낸 텍스트가 최종 응답에 중복되지 않도록 비운다.
    context.messages.clear();
    const answers = {};
    for (const question of questions) {
      const answer = answerMap?.[question.question];
      answers[question.codexId] = {
        answers: answer == null || answer === ''
          ? []
          : question.options.length > 0
            ? String(answer).split(/[,，]/).map(value => value.trim()).filter(Boolean)
            : [String(answer).trim()],
      };
    }
    sendServerResponse(server, msg.id, { result: { answers } });
  } catch (error) {
    if (requestController.signal.aborted) return;
    sendServerResponse(server, msg.id, {
      error: { code: -32000, message: error?.message || '사용자 응답을 받지 못했습니다.' },
    });
  } finally {
    context.abortController.signal.removeEventListener('abort', abortRequest);
    if (context.pendingServerRequests.get(requestId) === requestController) {
      context.pendingServerRequests.delete(requestId);
    }
  }
}

function handleServerRequest(server, msg) {
  const context = contextForMessage(server, msg.params);
  if (msg.method === 'item/tool/requestUserInput') {
    handleUserInputRequest(server, msg, context);
    return;
  }

  const approve = context?.approvalPolicy === 'never';
  const approval = approvalResponse(msg.method, approve);
  if (approval) {
    sendServerResponse(server, msg.id, approval);
    if (!approve && context) {
      context.activities.push(`🚫 승인 거절: ${truncate(msg.params?.command || msg.method, 100)}`);
      context.onProgress?.(context.activities, context.lastUsage, context.lastRateLimit);
    }
    return;
  }

  sendServerResponse(server, msg.id, {
    error: { code: -32601, message: `${msg.method} 요청은 Slack 브리지에서 지원하지 않습니다.` },
  });
}

function finishContext(context, turn) {
  context.markTerminal();
  if (context.settled) return;
  const status = turn?.status || 'completed';
  if (status === 'failed') {
    context.reject(context.lastError || new Error(turn?.error?.message || 'Codex turn 실패'));
  } else if (status === 'interrupted' || context.aborted) {
    context.reject(new Error('중단됨 (사용자 요청)'));
  } else {
    context.resolve();
  }
}

function handleNotification(server, msg) {
  const params = msg.params || {};

  if (msg.method === 'account/rateLimits/updated') {
    server.lastRateLimit = mergeRateLimit(server.lastRateLimit, params.rateLimits);
    for (const context of server.contextsByThread.values()) {
      context.lastRateLimit = mergeRateLimit(context.lastRateLimit, params.rateLimits);
      context.onProgress?.(context.activities, context.lastUsage, context.lastRateLimit);
    }
    return;
  }

  const context = contextForMessage(server, params);
  if (!context) return;

  switch (msg.method) {
    case 'serverRequest/resolved': {
      const requestId = String(params.requestId);
      context.pendingServerRequests.get(requestId)?.abort();
      context.pendingServerRequests.delete(requestId);
      break;
    }
    case 'turn/started':
      context.turnId = params.turn?.id || context.turnId;
      break;
    case 'item/agentMessage/delta':
      setAgentDelta(context, params);
      break;
    case 'item/started':
      updateActivity(context, params.item);
      break;
    case 'item/completed':
      if (params.item?.type === 'agentMessage') setCompletedAgentMessage(context, params.item);
      else updateActivity(context, params.item);
      break;
    case 'item/reasoning/delta':
    case 'item/reasoningSummary/delta':
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
      updateActivity(context, { id: '__reasoning__', type: 'reasoning' });
      break;
    case 'item/plan/delta':
      updateActivity(context, { id: '__plan__', type: 'plan' });
      break;
    case 'thread/tokenUsage/updated':
      context.lastUsage = normalizeUsage(params.tokenUsage);
      context.onProgress?.(context.activities, context.lastUsage, context.lastRateLimit);
      break;
    case 'error':
      if (!params.willRetry) context.lastError = new Error(params.error?.message || 'Codex 오류');
      break;
    case 'turn/failed':
      context.markTerminal();
      context.reject(new Error(params.error?.message || params.turn?.error?.message || 'Codex turn 실패'));
      break;
    case 'turn/completed':
      finishContext(context, params.turn);
      break;
  }
}

function createDeferredContext(callbacks, approvalPolicy) {
  let resolvePromise;
  let rejectPromise;
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    resolvePromise = resolveCompletion;
    rejectPromise = rejectCompletion;
  });
  completion.catch(() => {});

  const context = {
    ...callbacks,
    approvalPolicy,
    activities: [],
    activityIndexes: new Map(),
    messages: new Map(),
    pendingServerRequests: new Map(),
    lastUsage: null,
    lastRateLimit: null,
    lastError: null,
    abortController: new AbortController(),
    threadId: null,
    turnId: null,
    startingTurn: false,
    interruptRequested: false,
    interruptTimeoutId: null,
    aborted: false,
    settled: false,
    terminalObserved: false,
    deferCleanupUntilTerminal: false,
    terminalCleanup: null,
    terminalCleanupTimeoutId: null,
    completion,
    markTerminal() {
      if (context.terminalObserved) return;
      context.terminalObserved = true;
      if (context.terminalCleanupTimeoutId) clearTimeout(context.terminalCleanupTimeoutId);
      context.terminalCleanupTimeoutId = null;
      const cleanup = context.terminalCleanup;
      context.terminalCleanup = null;
      cleanup?.();
    },
    cleanupAfterTerminal(cleanup) {
      if (context.terminalObserved) {
        cleanup();
        return;
      }
      context.terminalCleanup = cleanup;
      context.terminalCleanupTimeoutId = setTimeout(() => {
        context.markTerminal();
      }, REQUEST_TIMEOUT_MS);
    },
    resolve() {
      if (context.settled) return;
      context.settled = true;
      if (context.interruptTimeoutId) clearTimeout(context.interruptTimeoutId);
      context.abortController.abort();
      context.pendingServerRequests.clear();
      resolvePromise();
    },
    reject(error) {
      if (context.settled) return;
      context.settled = true;
      if (context.interruptTimeoutId) clearTimeout(context.interruptTimeoutId);
      context.abortController.abort();
      context.pendingServerRequests.clear();
      rejectPromise(error);
    },
  };
  return context;
}

function abortError() {
  return new Error('중단됨 (사용자 요청)');
}

function hasOtherServerWork(server, context) {
  for (const candidate of server.contextsByThread.values()) {
    if (candidate !== context && !candidate.settled) return true;
  }
  for (const entry of runningQueries.values()) {
    if (entry.server === server && entry.context !== context && !entry.context.settled) return true;
  }
  return server.pending.size > 0;
}

function rejectWithoutStoppingOtherRuns(server, context, error) {
  if (hasOtherServerWork(server, context)) {
    context.deferCleanupUntilTerminal = Boolean(context.threadId);
    context.reject(error);
    return;
  }
  server.close();
  context.reject(error);
}

function requestInterrupt(server, context) {
  if (context.interruptRequested || !context.threadId || !context.turnId) return;
  context.interruptRequested = true;
  server.request('turn/interrupt', {
    threadId: context.threadId,
    turnId: context.turnId,
  }).then(() => {
    if (!context.settled) {
      context.interruptTimeoutId = setTimeout(() => {
        rejectWithoutStoppingOtherRuns(server, context, abortError());
      }, REQUEST_TIMEOUT_MS);
    }
  }).catch(() => {
    rejectWithoutStoppingOtherRuns(server, context, abortError());
  });
}

async function cleanupTurnStartFailure(server, context, error) {
  if (context.turnId) {
    requestInterrupt(server, context);
    await context.completion.catch(() => {});
    if (server.child.killed && server.exitPromise) await server.exitPromise;
  } else if (error?.name === 'CodexRequestTimeoutError') {
    if (hasOtherServerWork(server, context)) {
      context.deferCleanupUntilTerminal = Boolean(context.threadId);
      context.reject(error);
    } else {
      server.close();
      if (server.exitPromise) await server.exitPromise;
    }
  }
}

async function acquireThreadExecution(server, threadId, context) {
  const previous = server.threadExecutionTails.get(threadId) || Promise.resolve();
  let releaseTail;
  const tail = new Promise(resolveTail => { releaseTail = resolveTail; });
  server.threadExecutionTails.set(threadId, tail);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseTail();
    if (server.threadExecutionTails.get(threadId) === tail) {
      server.threadExecutionTails.delete(threadId);
    }
  };

  try {
    await Promise.race([previous, context.completion]);
    if (context.aborted) throw abortError();
  } catch (error) {
    previous.then(release, release);
    throw error;
  }

  return release;
}

async function startAppServer() {
  const child = spawn(getCodexPath(), ['app-server'], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const contextsByThread = new Map();
  const threadExecutionTails = new Map();
  let nextId = 1;
  let stderr = '';
  let exited = false;
  let spawnError = null;

  const server = {
    child,
    pending,
    contextsByThread,
    threadExecutionTails,
    lastRateLimit: null,
    write(message) {
      if (exited || !child.stdin?.writable) throw new Error('Codex app-server가 종료되었습니다.');
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    request(method, params = {}) {
      return new Promise((resolveRequest, rejectRequest) => {
        const id = nextId++;
        const timeoutId = setTimeout(() => {
          pending.delete(id);
          const error = new Error(`Codex ${method} 요청 시간 초과`);
          error.name = 'CodexRequestTimeoutError';
          error.requestMethod = method;
          rejectRequest(error);
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timeoutId);
            resolveRequest(value);
          },
          reject(error) {
            clearTimeout(timeoutId);
            rejectRequest(error);
          },
        });
        try {
          server.write({ jsonrpc: '2.0', id, method, params });
        } catch (error) {
          pending.delete(id);
          clearTimeout(timeoutId);
          rejectRequest(error);
        }
      });
    },
    close() {
      if (!child.killed) child.kill();
    },
  };

  child.stderr?.on('data', chunk => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_000);
  });
  child.once('error', error => {
    spawnError = error;
  });

  const lineReader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lineReader.on('line', line => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.jsonrpc != null && msg.jsonrpc !== '2.0') return;

    if (msg.id != null && msg.method) {
      handleServerRequest(server, msg);
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const request = pending.get(msg.id);
      pending.delete(msg.id);
      if (Object.hasOwn(msg, 'error')) {
        const error = new Error(msg.error?.message || 'Codex App Server 요청 실패');
        error.code = msg.error?.code;
        request.reject(error);
      } else {
        request.resolve(msg.result);
      }
      return;
    }
    if (msg.method) handleNotification(server, msg);
  });

  const exitPromise = new Promise(resolveExit => {
    child.once('close', (code, signal) => {
      exited = true;
      lineReader.close();
      const detail = spawnError?.code === 'ENOENT'
        ? `Codex CLI를 찾을 수 없습니다 (\`${getCodexPath()}\`).`
        : `Codex app-server가 종료되었습니다 (${signal ? `signal ${signal}` : `code ${code ?? 1}`}).${stderr ? ` ${truncate(stderr.trim(), 300)}` : ''}`;
      const error = new Error(detail);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      for (const context of contextsByThread.values()) {
        context.markTerminal();
        context.reject(error);
      }
      contextsByThread.clear();
      for (const entry of runningQueries.values()) {
        if (entry.server === server) entry.context.reject(error);
      }
      if (sharedServer === server) sharedServer = null;
      resolveExit(error);
    });
  });
  server.exitPromise = exitPromise;

  try {
    await Promise.race([
      server.request('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true, requestAttestation: false },
      }),
      exitPromise.then(error => Promise.reject(error)),
    ]);
    server.write({ jsonrpc: '2.0', method: 'initialized' });
    return server;
  } catch (error) {
    server.close();
    if (spawnError?.code === 'ENOENT') {
      throw new Error(`Codex CLI를 찾을 수 없습니다 (\`${getCodexPath()}\`). 설치 후 로그인하거나 \`CODEX_PATH\`를 지정해주세요.`);
    }
    throw error;
  }
}

async function ensureAppServer() {
  if (sharedServer && sharedServer.child.exitCode == null && !sharedServer.child.killed) return sharedServer;
  if (sharedStarting) return sharedStarting;
  sharedStarting = startAppServer()
    .then(server => {
      sharedServer = server;
      return server;
    })
    .finally(() => {
      sharedStarting = null;
    });
  return sharedStarting;
}

export function stopCodexQuery(sessionKey) {
  const entry = runningQueries.get(sessionKey);
  if (!entry) return false;
  entry.context.aborted = true;
  entry.context.abortController.abort();
  if (entry.server && entry.context.threadId && entry.context.turnId) {
    requestInterrupt(entry.server, entry.context);
  } else if (!entry.context.startingTurn) {
    entry.context.reject(abortError());
  }
  return true;
}

/**
 * Codex App Server에서 한 turn을 실행합니다.
 * Slack 스레드별 Codex thread ID를 저장하고 이후 요청에서 재개합니다.
 */
export async function runCodex(sessionKey, prompt, workdir, {
  onProgress,
  onAskUser,
  onSessionReady,
  model: modelOverride,
  effort: effortOverride,
} = {}) {
  const sessionRevision = getSessionRevision(sessionKey);
  const previousThreadId = getSession(sessionKey);
  const isResume = Boolean(previousThreadId);
  const settings = codexSettings(workdir, modelOverride, effortOverride);
  const context = createDeferredContext({ onProgress, onAskUser }, settings.approvalPolicy);
  const entry = { server: null, context };
  runningQueries.set(sessionKey, entry);
  let server = null;
  let releaseThreadExecution = null;
  let lockedThreadId = null;

  try {
    server = await ensureAppServer();
    entry.server = server;
    context.lastRateLimit = server.lastRateLimit;
    if (context.aborted) throw abortError();

    let threadResponse;
    const threadParams = {
      cwd: settings.cwd,
      runtimeWorkspaceRoots: settings.roots.length > 0 ? settings.roots : null,
      approvalPolicy: settings.approvalPolicy,
      sandbox: settings.sandbox,
      model: settings.model,
    };

    if (isResume) {
      releaseThreadExecution = await acquireThreadExecution(server, previousThreadId, context);
      lockedThreadId = previousThreadId;
      console.log(`[Codex] Resuming thread ${previousThreadId} for ${sessionKey}`);
      try {
        threadResponse = await server.request('thread/resume', {
          threadId: previousThreadId,
          ...threadParams,
          excludeTurns: true,
        });
      } catch (error) {
        if (context.aborted) throw abortError();
        clearSessionIfRevision(sessionKey, previousThreadId, sessionRevision);
        throw new Error(`Codex 세션 재개 실패 (${previousThreadId}): ${error.message}\n새 세션으로 다시 시도해주세요.`);
      }
    } else {
      console.log(`[Codex] New thread for ${sessionKey}`);
      threadResponse = await server.request('thread/start', threadParams);
    }

    if (context.aborted) throw abortError();
    const threadId = threadResponse?.thread?.id || threadResponse?.threadId || previousThreadId;
    if (!threadId) throw new Error('Codex thread 응답에 ID가 없습니다.');
    if (lockedThreadId !== threadId) {
      releaseThreadExecution?.();
      releaseThreadExecution = await acquireThreadExecution(server, threadId, context);
      lockedThreadId = threadId;
    }
    context.threadId = threadId;
    server.contextsByThread.set(threadId, context);

    if (!isResume || threadId !== previousThreadId) {
      const saved = saveSessionIfRevision(sessionKey, threadId, sessionRevision);
      if (saved) onSessionReady?.(threadId);
    }

    server.request('account/rateLimits/read')
      .then(response => {
        const snapshot = response?.rateLimits;
        context.lastRateLimit = normalizeRateLimit(snapshot);
        if (context.lastRateLimit) server.lastRateLimit = context.lastRateLimit;
        context.onProgress?.(context.activities, context.lastUsage, context.lastRateLimit);
      })
      .catch(() => {});

    context.startingTurn = true;
    let turnResponse;
    try {
      turnResponse = await server.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        cwd: settings.cwd,
        runtimeWorkspaceRoots: settings.roots.length > 0 ? settings.roots : null,
        approvalPolicy: settings.approvalPolicy,
        sandboxPolicy: settings.sandboxPolicy,
        model: settings.model,
        effort: settings.effort,
      });
    } catch (error) {
      await cleanupTurnStartFailure(server, context, error);
      throw error;
    } finally {
      context.startingTurn = false;
    }
    context.turnId = turnResponse?.turn?.id || context.turnId;

    if (context.aborted) {
      if (!context.settled) requestInterrupt(server, context);
      await context.completion;
      throw abortError();
    }

    await context.completion;
    return {
      result: resultText(context),
      usage: context.lastUsage,
      rateLimit: context.lastRateLimit,
    };
  } finally {
    if (runningQueries.get(sessionKey)?.context === context) runningQueries.delete(sessionKey);
    const cleanupThreadExecution = () => {
      if (context.threadId && server?.contextsByThread.get(context.threadId) === context) {
        server.contextsByThread.delete(context.threadId);
      }
      releaseThreadExecution?.();
    };
    if (context.deferCleanupUntilTerminal) context.cleanupAfterTerminal(cleanupThreadExecution);
    else cleanupThreadExecution();
  }
}

function toolName(item) {
  switch (item?.type) {
    case 'commandExecution': return 'Bash';
    case 'fileChange': return 'Edit';
    case 'webSearch': return 'WebSearch';
    case 'mcpToolCall': return `mcp_${item.server || 'server'}_${item.tool || 'tool'}`;
    case 'dynamicToolCall': return item.tool || 'DynamicTool';
    case 'collabAgentToolCall': return 'Agent';
    default: return null;
  }
}

function textFromUserContent(content) {
  return (content || [])
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .filter(Boolean)
    .join('\n');
}

function summarizeThread(thread) {
  const turns = [];
  for (const turn of thread?.turns || []) {
    const userTexts = [];
    const assistantTexts = [];
    const tools = [];
    for (const item of turn.items || []) {
      if (item.type === 'userMessage') {
        const text = textFromUserContent(item.content);
        if (text) userTexts.push(text);
      } else if (item.type === 'agentMessage' && item.text) {
        assistantTexts.push(item.text);
      } else {
        const name = toolName(item);
        if (name) tools.push(name);
      }
    }
    if (userTexts.length) turns.push({ role: 'user', text: userTexts.join('\n') });
    if (assistantTexts.length || tools.length) {
      turns.push({ role: 'assistant', text: assistantTexts.join('\n'), tools: [...new Set(tools)] });
    }
  }
  return {
    cwd: thread?.cwd || null,
    turns,
    updatedAt: thread?.updatedAt ? thread.updatedAt * 1000 : null,
  };
}

/** Codex thread의 저장된 대화를 App Server를 통해 읽습니다. */
export async function readCodexSessionSummary(threadId) {
  const server = await ensureAppServer();
  const response = await server.request('thread/read', { threadId, includeTurns: true });
  if (!response?.thread) return null;
  return summarizeThread(response.thread);
}

/** 테스트 및 정상 종료 시 공유 App Server를 정리합니다. */
export async function shutdownCodexAppServer() {
  const server = sharedServer;
  sharedServer = null;
  if (!server) return;
  server.close();
}
