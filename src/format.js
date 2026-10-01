// 진행 표시·턴 푸터 공통 포맷

export function formatElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

export function formatCtx(usage) {
  if (!usage || !usage.inputTokens) return '';
  const ctx = formatTokens(usage.inputTokens);
  if (usage.contextWindow) {
    return ` | ctx: ${ctx}/${formatTokens(usage.contextWindow)}`;
  }
  return ` | ctx: ${ctx}`;
}

export function formatRateLimit(rl) {
  if (!rl || rl.pct == null) return '';
  let reset = '';
  if (rl.resetsAt) {
    const remaining = Math.max(0, rl.resetsAt - Math.floor(Date.now() / 1000));
    if (remaining > 0) {
      const h = Math.floor(remaining / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      reset = h > 0 ? ` ${h}h${m}m` : ` ${m}m`;
    }
  }
  return ` | 5h: ${rl.pct}%${reset}`;
}

// HH:MM:SS (서버 로컬 시간)
export function formatClock(date = new Date()) {
  return date.toTimeString().slice(0, 8);
}

export function truncate(s, len = 50) {
  return s && s.length > len ? s.substring(0, len) + '…' : s;
}

function basename(p) {
  return p ? p.replace(/^.*\//, '') : '';
}

// 도구별 아이콘과 기본 라벨 — 병렬 호출을 묶을 때는 라벨 뒤에 건수를 붙인다
const TOOL_STYLE = {
  Bash: ['💻', '명령 실행'],
  Read: ['📖', '파일 읽기'],
  Write: ['📝', '파일 작성'],
  Edit: ['✏️', '파일 수정'],
  MultiEdit: ['✏️', '파일 수정'],
  NotebookEdit: ['📓', '노트북 수정'],
  Grep: ['🔍', '코드 검색'],
  Glob: ['📁', '파일 찾기'],
  WebSearch: ['🔎', '웹 검색'],
  WebFetch: ['🌐', '웹 페이지'],
  Agent: ['🤖', '서브에이전트'],
  Task: ['🤖', '서브에이전트'],
  Skill: ['🧩', '스킬'],
  TodoWrite: ['📋', '할 일 정리'],
  ToolSearch: ['🧰', '도구 불러오기'],
  Monitor: ['👀', '모니터'],
};

/**
 * 도구 호출을 사람이 읽을 수 있는 한 줄로 바꾼다
 * @returns {{ emoji: string, base: string, label: string, detail: string|null }}
 *   base: 병렬 호출을 묶을 때 쓰는 라벨, label: 단건 표시용 라벨, detail: 명령·경로 등 세부
 */
export function describeTool(name, input = {}) {
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    const base = `${server} · ${tool}`;
    return { emoji: '🔌', base, label: base, detail: null };
  }
  const [emoji, base] = TOOL_STYLE[name] || ['⚙️', name];
  const withTarget = (target, detail = null) => ({ emoji, base, label: target ? `${base} · ${target}` : base, detail });
  switch (name) {
    case 'Bash':
      return { emoji, base, label: input.description || truncate(input.command, 60) || base, detail: input.command || null };
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit':
      return withTarget(basename(input.file_path), input.file_path);
    case 'NotebookEdit':
      return withTarget(basename(input.notebook_path), input.notebook_path);
    case 'Grep': case 'Glob':
      return withTarget(truncate(input.pattern, 60), input.path || null);
    case 'WebSearch':
      return withTarget(truncate(input.query, 60), input.query);
    case 'WebFetch':
      return withTarget(truncate((input.url || '').replace(/^https?:\/\//, ''), 60), input.url);
    case 'Agent': case 'Task':
      return { emoji, base, label: input.description || base, detail: input.subagent_type || null };
    case 'Skill':
      return withTarget(input.skill || input.command, input.args || null);
    default:
      return { emoji, base, label: base, detail: null };
  }
}

const TASK_TYPE_LABEL = { local_bash: '💻 셸', local_agent: '🤖 agent', local_workflow: '🧭 workflow', monitor_mcp: '👀 모니터', monitor_ws: '👀 모니터' };

/** 백그라운드 작업 한 건의 세부 (종류 · 경과 · 진행 요약) */
export function formatBackgroundDetail(task, now = Date.now()) {
  const parts = [TASK_TYPE_LABEL[task.type] || '⚙️ 작업'];
  if (task.startedAt) parts.push(formatElapsed((task.endedAt || now) - task.startedAt));
  if (task.status === 'failed') parts.push('실패');
  if (task.status === 'stopped') parts.push('중단됨');
  if (task.summary) parts.push(task.summary);
  if (task.toolUses) parts.push(`도구 ${task.toolUses}회`);
  if (task.lastTool && task.status === 'running') parts.push(`최근: ${task.lastTool}`);
  return parts.join(' · ');
}

/**
 * 실행 중인 백그라운드 작업 목록을 진행 표시용 줄로 변환 (없으면 빈 배열)
 * @param {Array<{description: string, status?: string}>|undefined} tasks
 */
export function formatBackgroundTasks(tasks, max = 3) {
  const running = (tasks || []).filter(t => !t.status || t.status === 'running');
  if (!running.length) return [];
  const lines = [`🔄 백그라운드 작업 ${running.length}개 진행 중`];
  for (const t of running.slice(0, max)) {
    lines.push(`  · ${truncate(t.description, 60)} (${formatBackgroundDetail(t)})`);
  }
  if (running.length > max) lines.push(`  · 외 ${running.length - max}개`);
  return lines;
}
