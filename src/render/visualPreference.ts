/** Validated visual preferences. URL values override storage for this session. */
export function visualPreference<T extends string>(param: string, values: readonly T[], fallback: T): T {
  const query = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get(param);
  if (query !== null) {
    if (values.includes(query as T)) return query as T;
    throw new Error(`?${param}=${query}: expected ${values.join('|')}`);
  }
  try {
    const stored = localStorage.getItem(`cdda3d.visual.${param}`);
    if (values.includes(stored as T)) return stored as T;
  } catch { /* blocked storage: factory default */ }
  return fallback;
}
export function storeVisualPreference(param: string, value: string): void {
  try { localStorage.setItem(`cdda3d.visual.${param}`, value); }
  catch { /* blocked storage: live value still works */ }
}
