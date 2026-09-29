// Run statistics for the memorial / death screen (CDDA's kill_tracker + stats_tracker,
// much simplified). Systems increment these directly; nothing here is load-bearing for
// gameplay.
//
//   game.stats.addKill('mon_zombie')     // monsters system, when the player kills something
//   game.stats.itemsCrafted++            // crafting
//   game.stats.distanceWalked            // tiles, updated by the UI's tracker system
//
// Kills are also counted automatically from `creatureDied` events whose killer is the
// player (see src/ui/index.ts), so the monster system should emit that event rather than
// call addKill as well.

export interface GameStatsJSON {
  kills: Record<string, number>;
  distanceWalked: number;
  itemsCrafted: number;
  damageTaken: number;
  startSeconds: number;
}

export class GameStats {
  /** monster type id -> count */
  kills: Record<string, number> = {};
  /** tiles (metres) walked */
  distanceWalked = 0;
  itemsCrafted = 0;
  damageTaken = 0;
  /** game clock seconds when this character started (time survived = now - start). */
  startSeconds = 0;

  addKill(monsterId: string): void {
    this.kills[monsterId] = (this.kills[monsterId] ?? 0) + 1;
  }
  totalKills(): number {
    let n = 0;
    for (const v of Object.values(this.kills)) n += v;
    return n;
  }
  toJSON(): GameStatsJSON {
    return { kills: { ...this.kills }, distanceWalked: this.distanceWalked, itemsCrafted: this.itemsCrafted, damageTaken: this.damageTaken, startSeconds: this.startSeconds };
  }
  load(j: GameStatsJSON): void {
    Object.assign(this, { ...j, kills: { ...j.kills } });
  }
}
