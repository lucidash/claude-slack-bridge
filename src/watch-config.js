// engine/model은 기존 watch의 작업 수행 설정. triage 설정과 서로 상속하지 않는다.
const ENGINE_FIELDS = { engine: ['claude', 'pty-claude', 'codex'], triageEngine: ['claude', 'codex'] };
const FIELDS = {
  engine: 'engine', actionengine: 'engine', model: 'model', actionmodel: 'model',
  triageengine: 'triageEngine', triagemodel: 'triageModel',
};

export function watchRuntimeField(field) {
  return FIELDS[field.toLowerCase()] || null;
}

export function watchRuntimeUpdate(existing, values) {
  const update = {};
  for (const [key, raw] of Object.entries(values)) {
    const field = watchRuntimeField(key);
    if (!field) continue;
    const value = raw.trim();
    update[field] = /^(reset|default|null)$/i.test(value) ? null : value;
    if (ENGINE_FIELDS[field] && update[field]) update[field] = value.toLowerCase();
  }
  for (const [engineField, modelField] of [['engine', 'model'], ['triageEngine', 'triageModel']]) {
    if (Object.hasOwn(update, engineField)
        && (update[engineField] || 'claude') !== (existing[engineField] || 'claude')
        && !Object.hasOwn(update, modelField)) {
      update[modelField] = null;
    }
    const engine = update[engineField] === undefined ? existing[engineField] : update[engineField];
    if (engine && !ENGINE_FIELDS[engineField].includes(engine)) {
      throw new Error(`${engineField}: 알 수 없는 엔진 ${engine}. 사용 가능: ${ENGINE_FIELDS[engineField].join(', ')}`);
    }
    const model = update[modelField] === undefined ? existing[modelField] : update[modelField];
    if (model && (typeof model !== 'string' || /\s/.test(model) || model.length > 200)) {
      throw new Error(`${modelField}: 공백 없는 모델 ID를 지정하세요.`);
    }
    if (model && engine !== 'codex' && !/^(sonnet|opus|haiku|claude-[\w.-]+)$/i.test(model)) {
      throw new Error(`${modelField}: Claude 모델은 sonnet, opus, haiku 또는 claude- 모델 ID를 사용하세요.`);
    }
  }
  return update;
}

export function watchRuntimeSummary(config) {
  const triageEngine = config.triageEngine || 'claude';
  const engine = config.engine || 'claude';
  const defaultModel = engine === 'codex' ? (process.env.CODEX_MODEL || 'Codex CLI 기본값')
    : engine === 'pty-claude' ? 'Claude CLI 기본값' : (process.env.CLAUDE_MODEL || 'sonnet');
  const triageModel = config.triageModel || (triageEngine === 'claude' ? 'haiku' : (process.env.CODEX_MODEL || 'Codex CLI 기본값'));
  return [
    `감지: \`${triageEngine}\` / \`${triageModel}\`${config.triageModel ? '' : ' (기본 모델)'}`,
    `수행: \`${engine}\` / \`${config.model || defaultModel}\`${config.model ? '' : ' (기본 모델)'}`,
  ];
}
