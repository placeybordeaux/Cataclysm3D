// Tiny typed event bus. Systems publish facts (a sound happened, a creature died)
// and other systems react, so e.g. combat code never needs to know about the UI log.

export interface GameEvents {
  /** Player-visible message, CDDA color tag like "c_red" optional. */
  message: { text: string; color?: string };
  /** A noise at tile position; volume in CDDA sound units (roughly tiles of range). */
  sound: {
    x: number; y: number; z: number; volume: number; description: string; source?: unknown;
    /** CDDA sound_effect id/variant to play (sounds::sound's id/variant). Omit to let
     *  src/audio/soundEvents.ts guess from the description; '' = already played, stay silent. */
    sfxId?: string;
    sfxVariant?: string;
  };
  creatureDied: { creature: unknown; killer?: unknown };
  mapChanged: { x: number; y: number; z: number };
  playerDied: { cause: string };
  /** The survivor was hit (renderer: red flash + camera shake). amount = HP lost (0 = blocked). */
  playerHurt: { amount: number; bp?: string; source?: unknown };
  /**
   * One of the survivor's attacks resolved (src/game/playercombat.ts) — hit feedback hooks:
   * impact particles + stagger (render/hitFx.ts), the crosshair hit marker (ui/hud.ts).
   * outcome: 'whiff' = swung at nothing, 'miss' = target dodged, 'block' = hit for 0.
   * x/y/z = impact point (tiles; z level), `heavy` = hard enough to stagger.
   */
  playerAttack: {
    kind: 'melee' | 'gun' | 'throw';
    outcome: 'hit' | 'crit' | 'kill' | 'block' | 'miss' | 'whiff';
    x: number; y: number; z: number;
    damage: number;
    heavy: boolean;
    target?: unknown;
    /** CDDA field id the target bleeds (fd_blood...), null = sparks/dust */
    blood?: string | null;
    /** Freeze-frame seconds the blow earned (feel layer); the struck sprite holds too. */
    hitStop?: number;
  };
  /** BN character_gets_headshot: the survivor's projectile landed with missed_by ≤ 0.1. */
  playerHeadshot: { target: unknown };
  /**
   * A monster's attack on the survivor changed phase (src/game/monai.ts, feel layer in
   * combatfeel.ts): 'windup' = it started telegraphing (`seconds` until it lands), then one of
   * 'resolved' (the CDDA attack ran; hit/miss/block come through playerHurt & messages),
   * 'whiff' (you were out of reach when it landed), 'interrupted' (staggered out of it).
   */
  monsterAttack: { monster: unknown; phase: 'windup' | 'resolved' | 'whiff' | 'interrupted'; x: number; y: number; z: number; seconds?: number; heavy?: boolean };
  /** A save was loaded into this game (renderer: rebuild chunk meshes; UI: refresh). */
  gameLoaded: { slot: string | null };
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
