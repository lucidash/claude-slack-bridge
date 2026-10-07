import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, basename, resolve } from 'path';
import { slack, PICKER_BLOCK_PREFIX } from './slack.js';
import { getSkillUsage, recordSkillUsage } from './store.js';

// 레포·스킬 선택창. `!wd` 는 레포 선택창을, `!skills`(`!sk`) 는 스킬 선택창을 스레드에 올린다.
// 버튼이나 선택창을 누르면 같은 메시지를 다음 단계로 바꾼다 (레포 → 스킬 → 인자 입력).
// 스킬을 고르면 그 스레드의 다음 메시지 앞에 `/스킬 ` 을 붙여 실행하므로, 모바일에서도 인자만 붙여넣으면 된다.
// [입력창 열기] 를 누르면 모달에서 인자를 받는다. 모달에서 다른 스킬을 고르면 입력란 끝에 `/스킬 ` 을 추가해
// `/open-pr on /wt 해줘` 처럼 여러 스킬을 이어 쓸 수 있다 (Slack 에는 앱이 사용자의 메시지 입력창에 글을 입력하는 API 가 없다)

const PROJECTS_DIR = join(homedir(), 'projects');
const CLAUDE_DIR = join(homedir(), '.claude');
// 레포 선택창에 버튼으로 보여줄 레포. 나머지는 [다른 레포] 선택창에서 고른다
const FAVORITE_REPOS = ['likey-backend', 'likey-web', 'likey-web-4', 'likey-admin-v2', 'likey-features', 'tpc-agent'];
// 사용 기록이 없을 때의 스킬 버튼 순서 (2026-02 이후 브릿지 메시지의 호출 빈도 순)
const DEFAULT_SKILL_ORDER = ['resolve-review', 'review-pr', 'open-pr', 'wt', 'compose', 'review-draft', 'find-session'];
const SKILL_BUTTON_COUNT = 6;
// Slack 제한: 선택창 옵션 100개, 옵션·버튼 글자 75자, 모달 제목 24자, placeholder 150자
const MAX_OPTIONS = 100;
const MAX_LABEL = 75;
const MAX_TITLE = 24;
const MAX_PLACEHOLDER = 150;
// 고른 스킬을 다음 메시지에 붙이는 시간. 지나면 다음 메시지는 그대로 보낸다
const PICK_TTL_MS = 60 * 60 * 1000;

// 스레드(channel-threadTs) → 고른 스킬 { skill, channel, messageTs, wdBlocks, at }
const picked = new Map();

// ── 스킬·레포 목록 ──────────────────────────────────────────────

function truncate(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text;
}

// mrkdwn 에서 `<`·`>`·`&` 는 링크·멘션 문법이라 이스케이프한다 (인자 힌트 `<PR URL|number>` 등)
function esc(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function displayPath(dir) {
  return resolve(dir).replace(homedir(), '~');
}

function repoName(workdir) {
  return basename(resolve(workdir || process.cwd()));
}

// SKILL.md 의 frontmatter 에서 한 줄짜리 값만 읽는다. 들여쓴 다음 줄(`|`·`>` 블록, 여러 줄 값)은 이어 붙인다
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fields = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const parts = /^[|>][+-]?$/.test(kv[2]) ? [] : [kv[2].replace(/^(["'])(.*)\1$/, '$2')];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
    fields[kv[1]] = parts.join(' ').trim();
  }
  return fields;
}

function readSkills(dir) {
  if (!existsSync(dir)) return [];
  const skills = [];
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry, 'SKILL.md');
    if (!existsSync(file)) continue;
    const fm = parseFrontmatter(readFileSync(file, 'utf-8'));
    if (fm['user-invocable'] === 'false') continue;
    skills.push({ name: fm.name || entry, description: fm.description || '', argumentHint: fm['argument-hint'] || '' });
  }
  return skills;
}

// ~/.claude/commands 의 커맨드는 frontmatter 가 없는 경우가 많아 첫 줄(제목)을 설명으로 쓴다
function readCommands(dir) {
  if (!existsSync(dir)) return [];
  const commands = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const text = readFileSync(join(dir, file), 'utf-8');
    const fm = parseFrontmatter(text);
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    const title = body.split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
    commands.push({ name: file.slice(0, -3), description: fm.description || title, argumentHint: fm['argument-hint'] || '' });
  }
  return commands;
}

/**
 * 작업 디렉토리에서 `/이름` 으로 실행할 수 있는 스킬·커맨드 (프로젝트 + 사용자). 이름이 같으면 프로젝트 것을 보여준다.
 * 플러그인 스킬은 포함하지 않는다
 */
export function listSkills(workdir) {
  const dir = resolve(workdir || process.cwd());
  const sources = [
    readSkills(join(dir, '.claude', 'skills')),
    readCommands(join(dir, '.claude', 'commands')),
    readSkills(join(CLAUDE_DIR, 'skills')),
    readCommands(join(CLAUDE_DIR, 'commands')),
  ];
  const byName = new Map();
  for (const list of sources) {
    for (const skill of list) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// 이 레포에서 많이 쓴 순 → 전체에서 많이 쓴 순 → 기본 순서
function rankSkills(skills, repo) {
  const usage = getSkillUsage();
  const total = {};
  for (const counts of Object.values(usage)) {
    for (const [name, n] of Object.entries(counts)) total[name] = (total[name] || 0) + n;
  }
  const inRepo = usage[repo] || {};
  const defaultRank = (name) => {
    const i = DEFAULT_SKILL_ORDER.indexOf(name);
    return i === -1 ? DEFAULT_SKILL_ORDER.length : i;
  };
  return [...skills].sort((a, b) =>
    (inRepo[b.name] || 0) - (inRepo[a.name] || 0)
    || (total[b.name] || 0) - (total[a.name] || 0)
    || defaultRank(a.name) - defaultRank(b.name));
}

/**
 * 메시지가 `/스킬` 로 시작하면 사용 횟수를 기록한다 (스킬 버튼 순서에 반영)
 */
export function recordSkillRun(workdir, text) {
  const name = text.match(/^\/([^\s/]+)/)?.[1];
  if (!name || !listSkills(workdir).some(s => s.name === name)) return;
  try {
    recordSkillUsage(repoName(workdir), name);
  } catch (err) {
    console.warn('[Picker] Failed to record skill usage:', err.message);
  }
}

// ~/projects 아래 메인 레포. worktree 는 .git 이 파일이라 빠진다
function listRepos() {
  try {
    return readdirSync(PROJECTS_DIR)
      .filter(name => {
        try {
          return statSync(join(PROJECTS_DIR, name, '.git')).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function resolveRepo(name) {
  if (!name || !/^[\w.-]+$/.test(name)) return null;
  const dir = join(PROJECTS_DIR, name);
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

// ── 블록 ────────────────────────────────────────────────────────

const section = (id, text) => ({ type: 'section', block_id: PICKER_BLOCK_PREFIX + id, text: { type: 'mrkdwn', text } });
const actions = (id, elements) => ({ type: 'actions', block_id: PICKER_BLOCK_PREFIX + id, elements });
const button = (actionId, label, value, style) => ({
  type: 'button', action_id: actionId, value, text: { type: 'plain_text', text: truncate(label, MAX_LABEL) }, ...(style && { style }),
});
const select = (actionId, placeholder, options) => ({
  type: 'static_select', action_id: actionId, placeholder: { type: 'plain_text', text: truncate(placeholder, MAX_PLACEHOLDER) },
  options: options.slice(0, MAX_OPTIONS).map(([label, value]) => ({ text: { type: 'plain_text', text: truncate(label, MAX_LABEL) }, value })),
});

/**
 * 작업 디렉토리 안내 줄. 이후 단계에서도 메시지 맨 위에 남긴다
 */
export function workdirBlock(dir, note = '') {
  return section('wd', `📂 이 스레드의 작업 디렉토리: \`${displayPath(dir)}\`${note}`);
}

export function repoPickerBlocks() {
  const repos = listRepos();
  const favorites = FAVORITE_REPOS.filter(name => repos.includes(name));
  const others = repos.filter(name => !favorites.includes(name));
  const blocks = [section('repo-title', '📂 작업할 레포를 고르세요')];
  if (favorites.length) blocks.push(actions('repo-buttons', favorites.map(name => button(`picker_repo:${name}`, name, name))));
  if (others.length) {
    blocks.push(actions('repo-more', [select('picker_repo_select', `다른 레포 (${others.length}개)`, others.map(name => [name, name]))]));
  }
  return blocks;
}

const skillOptions = (skills) => skills.map(s => [s.description ? `${s.name} — ${s.description}` : s.name, s.name]);

export function skillPickerBlocks(workdir) {
  const skills = listSkills(workdir);
  if (skills.length === 0) return [section('skill-title', '🧰 이 작업 디렉토리에서 쓸 수 있는 스킬이 없습니다')];
  if (skills.length > MAX_OPTIONS) console.warn(`[Picker] ${skills.length} skills — showing first ${MAX_OPTIONS}`);
  const top = rankSkills(skills, repoName(workdir)).slice(0, SKILL_BUTTON_COUNT);
  return [
    section('skill-title', `🧰 스킬을 고르세요 (\`${repoName(workdir)}\`)`),
    actions('skill-buttons', top.map(s => button(`picker_skill:${s.name}`, s.name, s.name))),
    actions('skill-all', [select('picker_skill_select', `전체 스킬 (${skills.length}개)`, skillOptions(skills))]),
  ];
}

function pickedBlocks(skill, wdBlocks) {
  const guide = skill.argumentHint
    ? `다음 메시지로 \`${esc(skill.argumentHint)}\` 를 보내세요`
    : '다음 메시지로 요청 내용을 보내거나 [바로 실행] 을 누르세요';
  return [
    ...wdBlocks,
    section('skill-picked', `▶ \`/${skill.name}\` 선택됨\n${guide}`),
    ...(skill.description
      ? [{ type: 'context', block_id: PICKER_BLOCK_PREFIX + 'skill-desc', elements: [{ type: 'mrkdwn', text: esc(truncate(skill.description, 300)) }] }]
      : []),
    actions('skill-picked-actions', [
      button('picker_skill_modal', '입력창 열기', skill.name, 'primary'),
      button('picker_skill_run', '바로 실행', skill.name),
      button('picker_skill_back', '다른 스킬', skill.name),
    ]),
  ];
}

function ranBlocks(label, wdBlocks, note = '') {
  return [...wdBlocks, section('skill-ran', `▶ \`${esc(truncate(label, 200))}\`${note}`)];
}

// 인자 입력란의 block_id. 모달에서 스킬을 추가할 때마다(rev) 새 id 를 지정한다 — block_id 가 같으면 views.update 뒤에도
// Slack 이 사용자가 입력해 둔 값을 유지해서 initial_value 가 적용되지 않는다. rev 0 은 이전 버전 모달과 같은 `args`
const argsBlockId = (rev) => (rev ? `args-${rev}` : 'args');

/**
 * 인자 입력 모달. 아래의 스킬 버튼·선택창으로 다른 스킬을 고르면 입력란 끝에 `/스킬 ` 을 추가한다 (insertSkill)
 * @param {object} meta - private_metadata. `rev` 는 스킬을 추가한 횟수
 * @param {string} [text] - 입력란에 채울 값
 */
function argsModal(skill, workdir, meta, text = '') {
  const others = listSkills(workdir).filter(s => s.name !== skill.name);
  const top = rankSkills(others, repoName(workdir)).slice(0, SKILL_BUTTON_COUNT);
  const rev = meta.rev || 0;
  return {
    type: 'modal',
    callback_id: 'picker_skill_args',
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: truncate(`/${skill.name}`, MAX_TITLE) },
    submit: { type: 'plain_text', text: '실행' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      ...(skill.description ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: esc(truncate(skill.description, 300)) }] }] : []),
      {
        type: 'input',
        block_id: argsBlockId(rev),
        optional: true,
        label: { type: 'plain_text', text: '인자' },
        ...(others.length && { hint: { type: 'plain_text', text: '아래에서 고른 스킬은 입력란 끝에 /스킬이름 형태로 추가됩니다' } }),
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          ...(text && { initial_value: text }),
          placeholder: { type: 'plain_text', text: truncate(skill.argumentHint || '요청 내용', MAX_PLACEHOLDER) },
        },
      },
      ...(others.length ? [
        { type: 'actions', block_id: 'insert-buttons', elements: top.map(s => button(`picker_insert:${s.name}`, `/${s.name}`, s.name)) },
        // 선택창도 같은 이유로 block_id 가 같으면 고른 항목이 표시된 채 남으므로, 추가할 때마다 block_id 를 바꿔 선택을 해제한다
        { type: 'actions', block_id: `insert-all-${rev}`, elements: [select('picker_insert_select', `스킬 추가 (전체 ${others.length}개)`, skillOptions(others))] },
      ] : []),
    ],
  };
}

/**
 * 모달의 스킬 버튼·선택창 (block_actions). 고른 스킬을 입력란 끝에 추가한다.
 * 앞 글과는 공백으로 구분하고 뒤에도 공백을 추가해서 바로 이어서 입력할 수 있게 한다
 */
async function insertSkill(payload, action, getWorkdir) {
  const view = payload.view;
  const meta = JSON.parse(view?.private_metadata || '{}');
  if (!meta.channel || !meta.threadTs) return;
  const workdir = getWorkdir(`${meta.channel}-${meta.threadTs}`);
  const skills = listSkills(workdir);
  const skill = skills.find(s => s.name === meta.skill);
  const name = action.selected_option?.value ?? action.value;
  if (!skill || !skills.some(s => s.name === name)) return;
  const rev = meta.rev || 0;
  const current = view.state?.values?.[argsBlockId(rev)]?.value?.value || '';
  const text = `${current}${current && !/\s$/.test(current) ? ' ' : ''}/${name} `;
  // hash 는 연달아 누른 두 번째 추가가 첫 번째 결과를 덮어쓰지 않게 한다 (hash_conflict 로 실패)
  await slack.views.update({ view_id: view.id, hash: view.hash, view: argsModal(skill, workdir, { ...meta, rev: rev + 1 }, text) });
}

// ── 처리 ────────────────────────────────────────────────────────

/**
 * 스레드에서 고른 스킬이 있으면 메시지 앞에 `/스킬 ` 을 붙여 돌려준다. 고른 스킬은 한 번만 쓴다.
 * 메시지가 이미 `/` 로 시작하거나 고른 지 PICK_TTL_MS 가 지났으면 메시지를 그대로 돌려준다
 */
export function applyPickedSkill(threadKey, text) {
  const entry = picked.get(threadKey);
  if (!entry) return text;
  picked.delete(threadKey);
  if (text.startsWith('/') || Date.now() - entry.at > PICK_TTL_MS) return text;
  slack.chat.update({
    channel: entry.channel, ts: entry.messageTs, text: `/${entry.skill}`,
    blocks: ranBlocks(`/${entry.skill}`, entry.wdBlocks, ' — 아래 메시지를 인자로 실행'),
  }).catch(err => console.warn('[Picker] Failed to update picker message:', err.data?.error || err.message));
  return `/${entry.skill} ${text}`;
}

async function runPicked({ channel, threadTs, messageTs, userId, skill, args, wdBlocks, workdir }, runSkill) {
  const text = args ? `/${skill} ${args}` : `/${skill}`;
  picked.delete(`${channel}-${threadTs}`);
  await slack.chat.update({ channel, ts: messageTs, text, blocks: ranBlocks(text, wdBlocks) })
    .catch(err => console.warn('[Picker] Failed to update picker message:', err.data?.error || err.message));
  recordSkillRun(workdir, text);
  runSkill({ channel, threadTs, userId, text, eventTs: messageTs });
}

/**
 * 선택창의 버튼·선택 처리 (block_actions). 인자 입력 모달 안의 스킬 버튼·선택창도 이 함수로 전달된다
 * @param {object} payload
 * @param {object} deps
 * @param {(o: { threadKey: string, sessionKey: string, userId: string, dir: string }) => string} deps.setWorkdir - 스레드 작업 디렉토리 지정. 중단한 작업 안내 문구를 돌려준다
 * @param {(threadKey: string) => string|null} deps.getWorkdir - 스레드의 작업 디렉토리
 * @param {(o: { channel: string, threadTs: string, userId: string, text: string, eventTs: string }) => void} deps.runSkill
 */
export async function handlePickerAction(payload, { setWorkdir, getWorkdir, runSkill }) {
  const action = payload.actions?.[0];
  const actionId = action?.action_id || '';
  if (!actionId.startsWith('picker_')) return;
  if (actionId.startsWith('picker_insert')) {
    await insertSkill(payload, action, getWorkdir);
    return;
  }

  const channel = payload.container?.channel_id || payload.channel?.id;
  const messageTs = payload.container?.message_ts || payload.message?.ts;
  const threadTs = payload.container?.thread_ts || payload.message?.thread_ts || messageTs;
  const userId = payload.user?.id;
  const threadKey = `${channel}-${threadTs}`;
  const value = action.selected_option?.value ?? action.value;
  const wdBlocks = (payload.message?.blocks || []).filter(b => b.block_id === PICKER_BLOCK_PREFIX + 'wd');
  const update = (blocks, text) => slack.chat.update({ channel, ts: messageTs, text, blocks });

  if (actionId.startsWith('picker_repo')) {
    const dir = resolveRepo(value);
    if (!dir) return;
    picked.delete(threadKey);
    const stopped = setWorkdir({ threadKey, sessionKey: `${userId}-${threadTs}`, userId, dir });
    await update([workdirBlock(dir, stopped), ...skillPickerBlocks(dir)], `📂 이 스레드의 작업 디렉토리: ${displayPath(dir)}`);
    return;
  }

  const workdir = getWorkdir(threadKey);
  if (actionId === 'picker_skill_back') {
    picked.delete(threadKey);
    await update([...wdBlocks, ...skillPickerBlocks(workdir)], '스킬을 고르세요');
    return;
  }

  const skill = listSkills(workdir).find(s => s.name === value);
  if (!skill) return;

  if (actionId.startsWith('picker_skill:') || actionId === 'picker_skill_select') {
    picked.set(threadKey, { skill: skill.name, channel, messageTs, wdBlocks, at: Date.now() });
    await update(pickedBlocks(skill, wdBlocks), `/${skill.name} 선택됨`);
  } else if (actionId === 'picker_skill_modal') {
    await slack.views.open({
      trigger_id: payload.trigger_id,
      view: argsModal(skill, workdir, { channel, threadTs, messageTs, skill: skill.name, wd: wdBlocks[0]?.text?.text || '' }),
    });
  } else if (actionId === 'picker_skill_run') {
    await runPicked({ channel, threadTs, messageTs, userId, skill: skill.name, args: '', wdBlocks, workdir }, runSkill);
  }
}

/**
 * 인자 입력 모달 제출 (view_submission)
 */
export async function handlePickerSubmission(payload, { getWorkdir, runSkill }) {
  if (payload.view?.callback_id !== 'picker_skill_args') return;
  const { channel, threadTs, messageTs, skill, wd, rev } = JSON.parse(payload.view.private_metadata || '{}');
  if (!channel || !threadTs || !skill) return;
  const args = payload.view.state?.values?.[argsBlockId(rev)]?.value?.value?.trim() || '';
  const wdBlocks = wd ? [section('wd', wd)] : [];
  await runPicked({
    channel, threadTs, messageTs, userId: payload.user?.id, skill, args, wdBlocks,
    workdir: getWorkdir(`${channel}-${threadTs}`),
  }, runSkill);
}
