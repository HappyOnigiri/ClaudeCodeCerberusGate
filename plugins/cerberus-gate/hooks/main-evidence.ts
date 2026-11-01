// Only host-observed completed main-thread calls enter this supplement. Never use assistant
// assurances as evidence, truncate an entry, or silently drop early results to fit the budget.
export const MAX_MAIN_EVIDENCE = 160_000;
export function createMainEvidence() {
  return { entries: [] as string[], chars: 2, incomplete: false };
}
export type MainEvidence = ReturnType<typeof createMainEvidence>;

export function observeMainCall(
  evidence: MainEvidence,
  input: { tool: string },
  result: unknown,
): void {
  if (evidence.incomplete) return;
  try {
    const entry = JSON.stringify({ tool: input.tool, input, result });
    const added = entry.length + (evidence.entries.length ? 1 : 0);
    if (evidence.chars + added > MAX_MAIN_EVIDENCE) {
      evidence.incomplete = true;
      return;
    }
    evidence.entries.push(entry);
    evidence.chars += added;
  } catch {
    evidence.incomplete = true;
  }
}

export function mainEvidenceText(evidence: MainEvidence): string {
  return `[${evidence.entries.join(",")}]`;
}
