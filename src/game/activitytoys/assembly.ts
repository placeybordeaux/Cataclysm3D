import { craftState, type CraftState } from '../crafting';
import type { Activity } from '../activity';
import { Item } from '../item';
import type { ToyHost } from './controller';

export interface AssemblySlot { alternatives: string[]; placed: boolean; automatic: boolean }
function ledger(item: Item, key: string): number[] {
  try { const v: unknown = JSON.parse(String(item.vars[key] ?? '[]')); return Array.isArray(v) ? key === 'assembly_bonus' ? v.map(n => typeof n === 'number' && Number.isFinite(n) ? n : 0) : v.filter(n => typeof n === 'number' && Number.isFinite(n)) : []; }
  catch { return []; }
}
/** Cosmetic assembly over normal crafting. Existing crafting owns materials, failure and practice. */
export class CraftAssemblyController {
  activity: Activity | null = null;
  state: CraftState | null = null;
  slots: AssemblySlot[] = [];
  batchIndex = 0;
  frozen = false;
  skipped = 0;
  private item: Item | null = null;
  constructor(private host: ToyHost, private enabled: () => boolean) {}
  update(paused = false): void {
    const a = this.host.activities.current;
    const item = a?.spec.target;
    const state = a?.spec.kind === 'craft' && item instanceof Item ? craftState(this.host.data, item) : null;
    if (!a || !state || !(item instanceof Item) || !this.enabled()) {
      this.activity = null; this.state = null; this.item = null; this.slots = []; return;
    }
    if (this.activity !== a) { this.activity = a; this.skipped = 0; }
    this.item = item; this.state = state;
    this.batchIndex = Math.min(Math.max(0, state.batch - 1), Math.floor(state.progress * state.batch));
    const fraction = Math.min(1, Math.max(0, state.progress * state.batch - this.batchIndex));
    const manual = new Set(ledger(item, 'assembly_placed'));
    const groups = state.recipe.components ?? [];
    const committed = new Set(state.comps.map(c => c.id));
    this.slots = groups.map((group, i) => ({ alternatives: group.map(c => c.id).filter(id => committed.has(id)),
      placed: manual.has(this.batchIndex * groups.length + i), automatic: fraction >= (i + 1) / Math.max(1, groups.length) }));
    this.frozen = paused || (this.host.simSpeed ?? 1) > 1;
  }
  place(slotIndex: number, id: string): boolean {
    const previous = this.activity, previousBatch = this.batchIndex;
    if (!previous || this.host.activities.current !== previous) return false;
    this.update(this.frozen);
    if (this.activity !== previous || this.batchIndex !== previousBatch) return false;
    const a = this.activity, item = this.item, state = this.state, slot = this.slots[slotIndex];
    if (!a || !item || !state || !slot || slot.placed || slot.automatic || !slot.alternatives.includes(id) || this.frozen || !this.enabled() || this.host.activities.current !== a) return false;
    if ((this.host.simSpeed ?? 1) > 1 || this.host.paused || this.host.tacticalPause || this.host.lockPaused || (this.host.input?.captured && !this.host.input.captureTimeFlows)) return false;
    const bonuses = ledger(item, 'assembly_bonus');
    const used = Math.max(0, Math.min(.2, bonuses[this.batchIndex] ?? 0));
    const reward = Math.min(.04, .2 - used);
    if (reward <= 0) return false;
    // Convert a per-batch normalized bonus to current remaining work, even after resume.
    const fullDuration = (a.spec.duration - a.elapsed) / Math.max(1e-9, 1 - state.progress);
    const seconds = Math.min(a.spec.duration - a.elapsed, fullDuration * reward / Math.max(1, state.batch));
    if (seconds <= 0) return false;
    const placed = ledger(item, 'assembly_placed');
    placed.push(this.batchIndex * this.slots.length + slotIndex);
    item.vars.assembly_placed = JSON.stringify(placed);
    bonuses[this.batchIndex] = used + reward;
    item.vars.assembly_bonus = JSON.stringify(bonuses);
    a.elapsed += seconds;
    this.skipped += seconds;
    // Uses the ordinary callback, preserving crafting mishaps and saved progress on cancel.
    // A mishap may replace/cancel this activity; update reattaches rather than touching it.
    a.spec.onProgress?.(0, a.fraction);
    this.update();
    return true;
  }
}
