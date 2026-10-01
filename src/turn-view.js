// 턴 진행은 Slack 스트리밍 메시지(작업 타임라인)로, 백그라운드 작업은 제자리에서 갱신하는 현황 카드로 보여준다
import { slack } from './slack.js';
import { saveProcessing, clearProcessing } from './store.js';
import { describeTool, formatBackgroundDetail, formatClock, truncate } from './format.js';

const FLUSH_DELAY_MS = 700; // 청크를 모아 보내는 간격 (appendStream 호출 수 절약)
const MAX_CHUNKS_PER_CALL = 20;
const SEGMENT_TEXT_LIMIT = 3500; // 이보다 길면 새 메시지로 이어 쓴다 (긴 rich text 는 앞부분이 잘려 보이는 문제)
const SEGMENT_CARD_LIMIT = 30; // 메시지당 블록 수 제한 대비
const MAX_DETAIL_LINES = 5; // 병렬 호출 묶음은 5건까지만 세부를 적고 나머지는 제목의 건수로 보여준다
const MAX_DETAIL_LINE_LEN = 200;
const FALLBACK_PIECE_LEN = 11000; // markdown 블록 합계 12,000자 제한
const HIDDEN_TOOLS = new Set(['AskUserQuestion']); // 질문은 별도 메시지로 보여준다
const BACKGROUND_LAUNCH = /^(Command running in background|Async agent launched)/;

const contextBlock = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
const richText = (text) => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }] });
const firstLine = (s) => (s || '').trim().split('\n')[0];

let teamIdPromise = null;
function getTeamId() {
  teamIdPromise ??= slack.auth.test()
    .then(r => r.team_id)
    .catch((err) => {
      teamIdPromise = null;
      console.warn('[TurnView] auth.test failed:', err.data?.error || err.message);
      return null;
    });
  return teamIdPromise;
}

/**
 * DM 이 아닌 채널에서 스트리밍하려면 받는 사람(사용자·팀)을 지정해야 한다
 * @returns {Promise<{recipient_user_id: string, recipient_team_id: string}|null>}
 */
export async function resolveRecipient(channel, userId) {
  if (!channel || channel.startsWith('D') || !userId) return null;
  const teamId = await getTeamId();
  return teamId ? { recipient_user_id: userId, recipient_team_id: teamId } : null;
}

/**
 * 긴 마크다운을 줄 단위로 나눈다. 코드 블록 중간에서 잘리면 닫고 다음 조각에서 다시 연다
 */
export function splitMarkdown(text, limit = SEGMENT_TEXT_LIMIT) {
  if (text.length <= limit) return [text];
  const pieces = [];
  let lines = [];
  let size = 0;
  let fence = null; // 열린 코드 블록의 여는 줄
  const flush = () => {
    if (!lines.length || (lines.length === 1 && lines[0] === fence)) return;
    pieces.push(lines.join('\n') + (fence ? '\n```' : ''));
    lines = fence ? [fence] : [];
    size = fence ? fence.length + 1 : 0;
  };
  for (let line of text.split('\n')) {
    while (line.length > limit) {
      flush();
      lines.push(line.slice(0, limit));
      size += limit;
      flush();
      line = line.slice(limit);
    }
    if (size + line.length + 1 > limit) flush();
    lines.push(line);
    size += line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) fence = fence ? null : line.trim();
  }
  if (lines.length && !(lines.length === 1 && lines[0] === fence)) pieces.push(lines.join('\n'));
  return pieces;
}

/**
 * 턴 하나를 스트리밍 메시지로 보여준다. 모델의 글은 그대로, 도구 호출은 작업 카드(진행 중 → 완료/실패)로 쌓는다.
 * 내용이 처음 들어올 때 메시지를 만들고(빈 메시지 방지), 길어지면 새 메시지로 이어 쓴다.
 *
 * task_update 는 같은 id 로 다시 보내면 title·status 는 교체되지만 details·output 은 이어 붙는다.
 * 그래서 카드는 보낼 때 최신 title·status 와 아직 안 보낸 details·output 만 담는다
 */
export class TurnView {
  constructor({ channel, threadTs, recipient = null, processingKey = null }) {
    this.channel = channel;
    this.threadTs = threadTs;
    this.recipient = recipient;
    this.processingKey = processingKey;
    this.started = false; // 내용이 하나라도 들어왔는지
    this.finished = false;
    this.ops = []; // 보낼 작업 { chunk } | { card } | { cut } | { stop, footer }
    this.segment = null; // 지금 스트리밍 중인 메시지 { ts }
    this.segText = 0; // 현재 메시지에 들어갈 글자 수
    this.segCards = new Set(); // 현재 메시지에 들어갈 카드
    this.cards = new Map(); // cardId → 카드
    this.toolToCard = new Map(); // tool_use_id → cardId
    this.lastGroup = null; // 병렬 호출 묶음 { messageId, name, cardId }
    this.flushTimer = null;
    this.chain = Promise.resolve();
    this.fallback = null; // 스트리밍을 못 쓰면 글만 모아 일반 메시지로 보낸다 { text }
  }

  /** 턴 머리말 — 내용이 들어오기 전이면 맨 앞에 바로 띄운다 (턴이 시작됐다는 표시도 겸한다) */
  setHeader(markdown) {
    if (!this.started) this.text(markdown);
  }

  text(markdown) {
    if (this.finished || !markdown?.trim()) return;
    this.started = true;
    this.lastGroup = null;
    const body = markdown.endsWith('\n\n') ? markdown : markdown.replace(/\n?$/, '\n\n');
    for (const piece of splitMarkdown(body)) {
      if (this.segText && this.segText + piece.length > SEGMENT_TEXT_LIMIT) this.#cut();
      this.#enqueue({ chunk: { type: 'markdown_text', text: piece } });
      this.segText += piece.length;
    }
  }

  toolStart({ id, name, input, messageId }) {
    if (this.finished || HIDDEN_TOOLS.has(name)) return;
    this.started = true;
    const { emoji, base, label, detail } = describeTool(name, input);
    // 한 응답에서 같은 도구를 연달아 부르면(병렬 호출) 카드 하나로 묶는다
    const group = this.lastGroup;
    const groupCard = group && group.messageId === messageId && group.name === name ? this.cards.get(group.cardId) : null;
    if (groupCard?.status === 'in_progress') {
      groupCard.members.add(id);
      this.#appendDetail(groupCard, detail);
      groupCard.title = `${emoji} ${base} ${groupCard.members.size}건`;
      this.toolToCard.set(id, groupCard.id);
      this.#queueCard(groupCard);
      return;
    }
    if (this.segCards.size >= SEGMENT_CARD_LIMIT) this.#cut();
    const card = {
      id, title: `${emoji} ${label}`, status: 'in_progress', progress: '',
      detailText: '', detailLines: 0, sentDetail: 0, outputText: '', sentOutput: 0,
      summary: null, toolUses: null, lastTool: null,
      members: new Set([id]), done: new Set(), failed: false,
    };
    this.#appendDetail(card, detail);
    this.cards.set(id, card);
    this.toolToCard.set(id, id);
    this.segCards.add(id);
    this.lastGroup = { messageId, name, cardId: id };
    this.#queueCard(card);
  }

  toolResult({ id, isError, text }) {
    const card = this.cards.get(this.toolToCard.get(id));
    if (!card || card.status !== 'in_progress' || card.done.has(id)) return;
    card.done.add(id);
    if (isError) {
      card.failed = true;
      if (!card.outputText) card.outputText = truncate(firstLine(text), 200);
    } else if (BACKGROUND_LAUNCH.test(text || '') && !card.outputText) {
      card.outputText = '백그라운드에서 계속 실행 — 현황 카드에서 확인';
    }
    if (card.done.size >= card.members.size) {
      card.status = card.failed ? 'error' : 'complete';
      // 끝난 카드에 "~하는 중" 요약이 남지 않도록 도구 횟수만 남긴다
      card.progress = card.toolUses ? `도구 ${card.toolUses}회` : '';
    }
    this.#queueCard(card);
  }

  /** 서브에이전트(Agent 도구) 진행 — 바뀌는 정보라 교체되는 제목 뒤에 요약·도구 횟수를 붙인다 */
  toolProgress({ toolUseId, lastTool, toolUses, summary }) {
    const card = this.cards.get(this.toolToCard.get(toolUseId));
    if (!card || card.status !== 'in_progress') return;
    if (summary) card.summary = summary;
    if (toolUses) card.toolUses = toolUses;
    if (lastTool) card.lastTool = lastTool;
    card.progress = [card.summary || (card.lastTool && `최근: ${card.lastTool}`), card.toolUses && `도구 ${card.toolUses}회`]
      .filter(Boolean).join(' · ');
    this.#queueCard(card);
  }

  /** AskUserQuestion 등으로 턴이 멈출 때 지금까지 내용을 확정한다 — 이후 내용은 새 메시지로 이어진다 */
  async pause() {
    if (this.finished || !this.started) return;
    this.#cut({ force: true });
    await this.#flush();
  }

  /**
   * 턴을 마무리한다. 진행 중으로 남은 카드는 정리하고(stopStream 은 진행 중 카드를 error 로 바꾼다) 푸터를 단다
   * @param {object} opts
   * @param {string|null} opts.footer - 메시지 아래 한 줄 (mrkdwn)
   * @param {boolean} opts.error - 오류·중단으로 끝났는지 (남은 카드를 error 로)
   * @param {string|null} opts.fallbackText - 스트리밍한 내용이 없을 때 대신 보여줄 글 (예: 슬래시 명령 결과)
   */
  async finish({ footer = null, error = false, fallbackText = null } = {}) {
    if (this.finished) return;
    if (!this.started && fallbackText?.trim()) this.text(fallbackText);
    this.finished = true;
    for (const card of this.cards.values()) {
      if (card.status === 'in_progress') {
        card.status = error ? 'error' : 'complete';
        this.#queueCard(card);
      }
    }
    this.#enqueue({ stop: true, footer });
    await this.#flush();
  }

  #appendDetail(card, detail) {
    if (!detail || card.detailLines >= MAX_DETAIL_LINES) return;
    card.detailText += (card.detailText ? '\n' : '') + truncate(String(detail).replace(/\s+/g, ' ').trim(), MAX_DETAIL_LINE_LEN);
    card.detailLines++;
  }

  // 보내는 시점의 최신 title·status 와 아직 안 보낸 details·output (full 이면 처음부터 — 새 메시지에 다시 띄울 때)
  #cardChunk(card, { full = false } = {}) {
    const chunk = {
      type: 'task_update', id: card.id, status: card.status,
      title: truncate(card.progress ? `${card.title} — ${card.progress}` : card.title, 150),
    };
    const details = card.detailText.slice(full ? 0 : card.sentDetail);
    const output = card.outputText.slice(full ? 0 : card.sentOutput);
    if (details) chunk.details = details;
    if (output) chunk.output = output;
    card.sentDetail = card.detailText.length;
    card.sentOutput = card.outputText.length;
    return chunk;
  }

  // 아직 안 보낸 같은 카드 갱신이 있으면 새로 넣지 않는다 — 보낼 때 최신 상태로 만든다 (메시지 경계는 넘지 않는다)
  #queueCard(card) {
    for (let i = this.ops.length - 1; i >= 0 && (this.ops[i].chunk || this.ops[i].card); i--) {
      if (this.ops[i].card === card) return;
    }
    this.#enqueue({ card });
  }

  // 새 메시지로 넘긴다. 진행 중 카드가 있으면 넘기지 않는다 (넘기면 이전 메시지에서 error 로 바뀜)
  #cut({ force = false } = {}) {
    if (!force && [...this.segCards].some(id => this.cards.get(id)?.status === 'in_progress')) return;
    this.#enqueue({ cut: true });
    this.segText = 0;
    this.segCards = new Set();
  }

  #enqueue(op) {
    this.ops.push(op);
    if ((op.chunk || op.card) && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.#flush();
      }, FLUSH_DELAY_MS);
    }
  }

  #flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.chain = this.chain
      .then(() => this.#drain())
      .catch(err => console.error('[TurnView] flush failed:', err.data?.error || err.message));
    return this.chain;
  }

  async #drain() {
    while (this.ops.length) {
      if (this.ops[0].chunk || this.ops[0].card) {
        const chunks = [];
        while (this.ops.length && (this.ops[0].chunk || this.ops[0].card) && chunks.length < MAX_CHUNKS_PER_CALL) {
          const op = this.ops.shift();
          chunks.push(op.chunk || this.#cardChunk(op.card));
        }
        await this.#send(chunks);
      } else {
        const op = this.ops.shift();
        await this.#close(op.stop ? op.footer : null, !!op.stop);
      }
    }
  }

  async #send(chunks) {
    if (this.fallback) return this.#absorb(chunks);
    try {
      if (this.segment) {
        await slack.chat.appendStream({ channel: this.channel, ts: this.segment.ts, chunks });
      } else {
        await this.#startSegment(chunks);
      }
      return;
    } catch (err) {
      const code = err.data?.error || err.message;
      if (this.segment) {
        // 스트림이 끊겼으면(만료 등) 새 메시지로 이어 쓴다
        console.warn(`[TurnView] appendStream failed (${code}), continuing in a new message`);
        this.#dropSegment();
        try {
          await this.#startSegment(this.#restartChunks(chunks));
          return;
        } catch (err2) {
          console.warn(`[TurnView] restart stream failed (${err2.data?.error || err2.message})`);
        }
      }
      console.warn(`[TurnView] streaming unavailable (${code}), falling back to plain messages`);
      this.fallback = { text: '' };
      this.#absorb(chunks);
    }
  }

  async #startSegment(chunks) {
    const res = await slack.chat.startStream({
      channel: this.channel,
      thread_ts: this.threadTs,
      task_display_mode: 'timeline',
      chunks,
      ...(this.recipient || {}),
    });
    this.segment = { ts: res.ts };
    if (this.processingKey) saveProcessing(this.processingKey, { channel: this.channel, ts: res.ts, threadTs: this.threadTs, kind: 'stream' });
  }

  #dropSegment() {
    this.segment = null;
    if (this.processingKey) clearProcessing(this.processingKey);
  }

  // 끊긴 메시지 대신 새 메시지를 열 때 보낼 청크 — 진행 중 카드와 이번에 보내던 카드를 처음부터 한 번씩 다시 띄운다
  // (details 는 이어 붙으므로 같은 카드를 두 번 보내면 세부가 중복된다)
  #restartChunks(chunks) {
    const ids = new Set([...this.segCards].filter(id => this.cards.get(id)?.status === 'in_progress'));
    for (const c of chunks) if (c.type === 'task_update') ids.add(c.id);
    const cardChunks = [...ids].map(id => this.#cardChunk(this.cards.get(id), { full: true }));
    return [...cardChunks, ...chunks.filter(c => c.type !== 'task_update')];
  }

  async #close(footer, final) {
    if (this.fallback) {
      if (final) await this.#postFallback(footer);
      return;
    }
    if (!this.segment) {
      // 스트림을 연 적이 없다 (빈 턴·시작 전 오류) — 푸터만 남긴다
      if (final && footer) {
        await slack.chat.postMessage({ channel: this.channel, thread_ts: this.threadTs, text: footer })
          .catch(err => console.warn(`[TurnView] footer post failed: ${err.data?.error || err.message}`));
      }
      return;
    }
    const { ts } = this.segment;
    this.#dropSegment();
    await slack.chat.stopStream({ channel: this.channel, ts, ...(final && footer ? { blocks: [contextBlock(footer)] } : {}) })
      .catch(err => console.warn(`[TurnView] stopStream failed: ${err.data?.error || err.message}`));
  }

  #absorb(chunks) {
    for (const c of chunks) {
      if (c.type === 'markdown_text') this.fallback.text += c.text;
    }
  }

  async #postFallback(footer) {
    const pieces = this.fallback.text.trim() ? splitMarkdown(this.fallback.text.trim(), FALLBACK_PIECE_LEN) : [];
    try {
      for (let i = 0; i < pieces.length; i++) {
        const last = i === pieces.length - 1;
        const blocks = [{ type: 'markdown', text: pieces[i] }, ...(last && footer ? [contextBlock(footer)] : [])];
        await slack.chat.postMessage({ channel: this.channel, thread_ts: this.threadTs, text: truncate(pieces[i], 3000), blocks });
      }
      if (!pieces.length && footer) await slack.chat.postMessage({ channel: this.channel, thread_ts: this.threadTs, text: footer });
    } catch (err) {
      console.warn(`[TurnView] fallback post failed: ${err.data?.error || err.message}`);
    }
  }
}

/** 표시할 곳이 없을 때 (silent 인데 로그 채널을 못 연 경우) */
export class NullView {
  started = false;
  setHeader() {}
  text() {}
  toolStart() {}
  toolResult() {}
  toolProgress() {}
  async pause() {}
  async finish() {}
}

const CARD_PROGRESS_INTERVAL_MS = 10_000; // 진행 요약만 바뀐 갱신의 최소 간격
const CARD_TICK_MS = 30_000; // 경과 시간 갱신 주기
const CARD_MAX_TASKS = 20;
const TASK_ICON = { local_bash: '💻', local_agent: '🤖', local_workflow: '🧭', monitor_mcp: '👀', monitor_ws: '👀' };
const TASK_STATUS = { running: 'in_progress', completed: 'complete', failed: 'error', stopped: 'error' };

/**
 * 백그라운드 작업 현황 카드 — 제자리에서 갱신하므로 알림을 새로 만들지 않는다.
 * 턴 도중에는 응답 사이에 끼어들지 않도록 게시를 미루고, 턴이 끝날 때 응답 아래로 올린다(moveToBottom)
 */
export class BackgroundCard {
  constructor({ channel, threadTs, processingKey = null }) {
    this.channel = channel;
    this.threadTs = threadTs;
    this.processingKey = processingKey;
    this.ts = null;
    this.tasks = [];
    this.finished = false;
    this.note = null;
    this.signature = '';
    this.timer = null;
    this.timerDue = 0;
    this.ticker = null;
    this.lastRender = 0;
    this.chain = Promise.resolve();
  }

  update(tasks) {
    if (this.finished) return;
    this.tasks = tasks;
    if (!this.ts) return; // 아직 게시 전 — 턴이 끝날 때 moveToBottom() 이 게시한다
    const signature = tasks.map(t => `${t.id}:${t.status}`).join(',');
    const structural = signature !== this.signature; // 작업 추가·종료는 바로, 진행 요약만 바뀌면 천천히
    this.signature = signature;
    this.#schedule(structural ? 0 : CARD_PROGRESS_INTERVAL_MS);
  }

  /** 턴 응답 아래로 카드를 다시 올린다 — 스레드 맨 아래에서 현황을 볼 수 있도록 */
  moveToBottom() {
    if (this.finished || !this.#running().length) return this.chain;
    return this.#serial(async () => {
      if (this.finished) return;
      if (this.ts) {
        const old = this.ts;
        this.ts = null;
        await slack.chat.delete({ channel: this.channel, ts: old }).catch(() => {});
      }
      await this.#render();
      this.#startTicker();
    });
  }

  /** 최종 상태로 확정한다 (이후 갱신 없음). note 를 주면 제목으로 쓴다 */
  finish(note = null) {
    if (this.finished) return this.chain;
    this.finished = true;
    this.note = note;
    clearTimeout(this.timer);
    clearInterval(this.ticker);
    return this.#serial(async () => {
      if (!this.ts) return;
      await this.#render();
      if (this.processingKey) clearProcessing(this.processingKey);
    });
  }

  #running() {
    return this.tasks.filter(t => t.status === 'running');
  }

  #schedule(delay) {
    const now = Date.now();
    const due = now + Math.max(delay, this.lastRender + 1000 - now, 0);
    if (this.timer && this.timerDue <= due) return; // 이미 더 이른 갱신이 잡혀 있다
    clearTimeout(this.timer);
    this.timerDue = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#serial(() => this.#render());
    }, due - now);
  }

  #startTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      if (this.finished || !this.#running().length) {
        clearInterval(this.ticker);
        this.ticker = null;
        return;
      }
      this.#schedule(0);
    }, CARD_TICK_MS);
  }

  #serial(fn) {
    this.chain = this.chain.then(fn).catch(err => console.warn('[BackgroundCard] failed:', err.data?.error || err.message));
    return this.chain;
  }

  async #render() {
    const now = Date.now();
    // 끝났는데 결과가 안 온 작업(중단 등)은 중단으로 표시한다
    const tasks = this.finished
      ? this.tasks.map(t => (t.status === 'running' ? { ...t, status: 'stopped', endedAt: now } : t))
      : this.tasks;
    const running = tasks.filter(t => t.status === 'running').length;
    const failed = tasks.filter(t => t.status === 'failed' || t.status === 'stopped').length;
    const title = this.note
      || (running ? `🔄 백그라운드 작업 ${running}개 진행 중`
        : failed ? `⚠️ 백그라운드 작업 ${tasks.length}개 끝남 (실패·중단 ${failed}개)`
          : `✅ 백그라운드 작업 ${tasks.length}개 완료`);
    const blocks = [
      {
        type: 'plan',
        title,
        tasks: tasks.slice(-CARD_MAX_TASKS).map(t => ({
          type: 'task_card',
          task_id: t.id,
          title: truncate(`${TASK_ICON[t.type] || '⚙️'} ${t.description}`, 150),
          status: TASK_STATUS[t.status] || 'pending',
          details: richText(formatBackgroundDetail(t, now)),
        })),
      },
      contextBlock(this.finished ? `${formatClock()} 종료` : `마지막 갱신 ${formatClock()} · \`!status\` 상세 · \`!stop\` 중단`),
    ];
    try {
      if (this.ts) {
        await slack.chat.update({ channel: this.channel, ts: this.ts, text: title, blocks });
      } else {
        const res = await slack.chat.postMessage({ channel: this.channel, thread_ts: this.threadTs, text: title, blocks });
        this.ts = res.ts;
        if (this.processingKey) saveProcessing(this.processingKey, { channel: this.channel, ts: res.ts, threadTs: this.threadTs, kind: 'bgcard' });
      }
      this.lastRender = Date.now();
    } catch (err) {
      console.warn(`[BackgroundCard] render failed: ${err.data?.error || err.message}`);
    }
  }
}

export class NullCard {
  update() {}
  async moveToBottom() {}
  async finish() {}
}
