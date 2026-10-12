import type { CraftHost } from '../crafting';
import type { Activity } from '../activity';
import { Item } from '../item';
import { unfinishedState } from '../construction';
import { disassemblyYield, uncraftRecipe } from '../disassembly';
import { effectiveSkills } from '../adaptation_rules';
import { cddaText } from '../units';
import { withPracticeSource } from '../practice';

export type ToyKind = 'construction' | 'disassemble';
export interface ToyHost extends CraftHost {
  simSpeed?: number;
  paused?: boolean;
  tacticalPause?: boolean;
  lockPaused?: boolean;
  input?: { captured: boolean; captureTimeFlows?: boolean };
}
export interface TeardownPart { label: string; blockedBy: number[]; removed: boolean }
/** Layered, acyclic blocking graph. Every part can be freed without guessing or damage. */
export function teardownParts(labels: readonly string[], skill = 0, difficulty = 0): TeardownPart[] {
  // More component types make a bigger assembly. Skill above recipe difficulty reveals
  // several independent entry points and shallower layers; unfamiliar work is a chain.
  const advantage = Math.max(0, skill - difficulty);
  const roots = Math.min(3, 1 + Math.floor(advantage / 3));
  const branches = Math.min(4, 1 + Math.floor(advantage / 2));
  return labels.slice(0, 8).map((label, i) => ({ label, blockedBy: i < roots ? [] : [Math.floor((i - roots) / branches)], removed: false }));
}
export function partFree(parts: readonly TeardownPart[], index: number): boolean {
  const p = parts[index];
  return !!p && !p.removed && p.blockedBy.every(i => parts[i]?.removed);
}

// Optional bonus work. Ignore/miss/blocked clicks never modify normal activity speed,
// consume items, damage products or remove ordinary completion practice.
export class ActivityToyController {
  activity: Activity | null = null;
  kind: ToyKind | null = null;
  parts: TeardownPart[] = [];
  seconds = 0;
  frozen = false;
  lastHit = -1;
  hits = 0;
  skipped = 0;
  private item: Item | null = null;
  private rewardedBeat = -1;
  constructor(private host: ToyHost, private enabled: (kind: ToyKind) => boolean) {}

  update(realSeconds: number, paused = false): void {
    const a = this.host.activities.current;
    const kind = a?.spec.kind;
    const valid = kind === 'construction' || kind === 'disassemble';
    if (!a || !valid || !this.enabled(kind) || !(a.spec.target instanceof Item)) {
      this.activity = null; this.kind = null; this.item = null; this.parts = []; return;
    }
    if (a !== this.activity) {
      this.activity = a; this.kind = kind; this.item = a.spec.target;
      this.seconds = 0; this.hits = 0; this.skipped = 0; this.lastHit = -1; this.rewardedBeat = -1;
      const recipe = kind === 'disassemble' ? uncraftRecipe(this.host.data, this.item.typeId) : undefined;
      const labels = recipe ? disassemblyYield(this.host.data, recipe).map(({id, count}) => `${count} × ${cddaText(this.host.data.items[id]?.name) || id}`) : [];
      this.parts = teardownParts(labels, recipe?.skill_used ? this.host.player.getSkill(recipe.skill_used) : 0, recipe?.difficulty ?? 0);
    }
    this.frozen = paused || (this.host.simSpeed ?? 1) > 1;
    if (!this.frozen) this.seconds += Math.max(0, Math.min(realSeconds, 0.1));
  }
  /** Moving hammer mark goes 0→1 each 1.2 seconds; aim for the centre. */
  phase(): number { return (this.seconds % 1.2) / 1.2; }
  timingWindow(): number {
    const st = this.item ? unfinishedState(this.host.data, this.item) : null;
    const skill = st ? effectiveSkills(st.con)[0]?.[0] : undefined;
    return 0.1 + Math.min(0.08, (skill ? this.host.player.getSkill(skill) : 0) * 0.01);
  }
  press(index = 0): boolean {
    if (!this.activity || !this.kind || !this.item || this.frozen || this.host.activities.current !== this.activity) return false;
    // Input can arrive before the next UI frame after a menu/speed/options change.
    if (!this.enabled(this.kind) || (this.host.simSpeed ?? 1) > 1 || this.host.paused || this.host.tacticalPause || this.host.lockPaused ||
      (this.host.input?.captured && !this.host.input.captureTimeFlows)) return false;
    if (this.kind === 'construction') {
      const beat = Math.floor(this.seconds / 1.2);
      if (index !== 0 || Math.abs(this.phase() - 0.5) > this.timingWindow() || this.rewardedBeat === beat) return false;
      this.rewardedBeat = beat;
    } else {
      if (!partFree(this.parts, index)) return false;
      this.parts[index].removed = true;
    }
    const a = this.activity;
    const key = `activity_toy_${this.kind}`;
    const used = Math.max(0, Math.min(0.2, Number(this.item.vars[key]) || 0));
    const fraction = Math.min(0.04, 0.2 - used);
    const skip = Math.min(Math.max(0, a.spec.duration - a.elapsed), a.spec.duration * fraction);
    if (skip <= 0) return false;
    // Stored with the real item: interrupted/resumed or saved work cannot farm bonuses.
    this.item.vars[key] = used + fraction;
    a.elapsed += skip;
    // Synchronise the unfinished construction immediately, before a same-frame cancel/save.
    a.spec.onProgress?.(0, a.fraction);
    this.hits++; this.skipped += skip; this.lastHit = this.seconds;
    const construction = this.kind === 'construction' ? unfinishedState(this.host.data, this.item)?.con : null;
    const recipe = this.kind === 'disassemble' ? uncraftRecipe(this.host.data, this.item.typeId) : null;
    const req = construction ? effectiveSkills(construction)[0] : recipe?.skill_used ? [recipe.skill_used, recipe.difficulty] as const : null;
    if (req) withPracticeSource('Careful hands', () => this.host.player.practice(req[0], 1, Math.max(1, req[1])));
    return true;
  }
}
