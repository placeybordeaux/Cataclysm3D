// Tiny typed event bus. Systems publish facts (a sound happened, a creature died)
// and other systems react, so e.g. combat code never needs to know about the UI log.

export interface GameEvents {
  /** Player-visible message, CDDA color tag like "c_red" optional. */
  message: { text: string; color?: string };
  /** A noise at tile position; volume in CDDA sound units (roughly tiles of range). */
  sound: { x: number; y: number; z: number; volume: number; description: string; source?: unknown };
  creatureDied: { creature: unknown; killer?: unknown };
  mapChanged: { x: number; y: number; z: number };
  playerDied: { cause: string };
  /** The player took damage (renderer: camera shake + red flash). */
  playerHurt: { amount: number; bp?: string };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<any>>>();
  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(type);
    if (set) for (const fn of set) fn(payload);
  }
}
