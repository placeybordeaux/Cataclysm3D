// Generation statistics + warn-once reporting. CDDA data references many things we don't
// implement yet (vehicles, NPCs, EOCs...) or ids from mods; the architecture rule is to
// warn once per distinct problem and keep generating rather than crash.

export class GenStats {
  /** feature name -> times encountered (unsupported mapgen keys, piece kinds) */
  readonly unsupported = new Map<string, number>();
  /** unknown terrain/furniture/nested/palette ids -> times encountered */
  readonly unknownIds = new Map<string, number>();
  /** chunk source -> count, e.g. "json", "builtin:forest", "uniform", "fallback" */
  readonly sources = new Map<string, number>();
  chunks = 0;
  /** z=0 chunks by source; upper/lower levels are mostly uniform air/rock and skew totals */
  readonly surfaceSources = new Map<string, number>();
  totalMs = 0;
  maxMs = 0;
  quiet = false;
  private warned = new Set<string>();

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    if (!this.quiet) console.warn(`[mapgen] ${msg}`);
  }
  unsupportedFeature(name: string): void {
    this.unsupported.set(name, (this.unsupported.get(name) ?? 0) + 1);
    this.warnOnce('f:' + name, `unsupported feature "${name}" (skipped; further occurrences counted silently)`);
  }
  unknownId(kind: string, id: string, context = ''): void {
    const k = `${kind}:${id}`;
    this.unknownIds.set(k, (this.unknownIds.get(k) ?? 0) + 1);
    this.warnOnce('u:' + k, `unknown ${kind} id "${id}"${context ? ' in ' + context : ''} (skipped)`);
  }
  chunkDone(source: string, ms: number, z = 0): void {
    this.sources.set(source, (this.sources.get(source) ?? 0) + 1);
    if (z === 0) this.surfaceSources.set(source, (this.surfaceSources.get(source) ?? 0) + 1);
    this.chunks++;
    this.totalMs += ms;
    this.maxMs = Math.max(this.maxMs, ms);
  }

  summary(): Record<string, unknown> {
    const top = (m: Map<string, number>, n = 15) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} x${v}`);
    const json = [...this.sources.entries()].filter(([k]) => k.startsWith('json')).reduce((a, [, v]) => a + v, 0);
    const z0 = [...this.surfaceSources.values()].reduce((a, v) => a + v, 0);
    const z0json = this.surfaceSources.get('json') ?? 0;
    return {
      chunks: this.chunks,
      jsonMapgenPct: this.chunks ? Math.round((1000 * json) / this.chunks) / 10 : 0,
      surfaceChunks: z0,
      surfaceJsonMapgenPct: z0 ? Math.round((1000 * z0json) / z0) / 10 : 0,
      msPerChunk: this.chunks ? Math.round((100 * this.totalMs) / this.chunks) / 100 : 0,
      maxMs: Math.round(this.maxMs * 100) / 100,
      sources: Object.fromEntries([...this.sources.entries()].sort((a, b) => b[1] - a[1])),
      topUnsupported: top(this.unsupported),
      topUnknownIds: top(this.unknownIds),
    };
  }
}
