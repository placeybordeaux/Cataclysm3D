// Runtime policy for bad content references (see ARCHITECTURE.md "Team conventions"):
// warn once per unknown id and continue. CDDA data references plenty of mod-only ids, so
// crashing would be wrong, but silently substituting would hide real bugs.

const seen = new Set<string>();

/** console.warn the first time `kind:id` is reported; returns true on that first time. */
export function warnOnce(kind: string, id: string, message?: string): boolean {
  const key = kind + ':' + id;
  if (seen.has(key)) return false;
  seen.add(key);
  console.warn(message ?? `[cdda-data] unknown ${kind} id "${id}"`);
  return true;
}

/** All kind:id pairs warned so far (for debug UI and tests). */
export function warnedIds(): string[] {
  return [...seen];
}

/** Test helper. */
export function resetWarnings(): void {
  seen.clear();
}
