/**
 * 현재 엔진은 탐색 우선순위로만 사용하고 Claude/Codex 저장소를 모두 확인합니다.
 */
export async function resolveSessionSource(preferredEngine, { readClaude, readCodex }) {
  const order = preferredEngine === 'codex'
    ? [['codex', readCodex], ['claude', readClaude]]
    : [['claude', readClaude], ['codex', readCodex]];

  for (const [engine, read] of order) {
    const summary = await read();
    if (summary) return { engine, summary };
  }
  return null;
}
