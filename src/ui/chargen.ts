import { Rng } from '../core/rng';
import { cycleDensity, defaultDensity, densityLabel, setDefaultDensity, zombieDensity } from '../game/density';
import type { MutationDef } from '../data/types';
import { fromSpawned, type Item } from '../game/item';
import { cddaText } from '../game/units';
import { c, colorize, confirm, openWindow, prompt, type UiWindow } from './framework';
import { randomName, fit } from './format';
import {
  BASE_STAT, canAddTrait, finishCheck, multiPool, permittedProfessions, profName, scenName, skillPointsUsed, startingTraits,
  STAT_MAX, STAT_MIN, statPointsUsed, statStepCost, traitPointsUsed, type ProfessionDef, type ScenarioDef, type StatId, type Stats,
} from './chargen_logic';
import { spriteImg, type UiContext } from './context';
import { applyProfessionKnowledge } from '../game/crafting';
import { globalAchievements } from '../game/achievements';
import { achievementsOf } from '../achievements';
import { professionItems, type ProfessionItemsDef } from '../game/profession';
import { bodyMods } from '../game/bodymods';

// New character (CDDA newcharacter.cpp), simplified to five tabs: SCENARIO, PROFESSION,
// TRAITS, STATS, DESCRIPTION. Point pools follow CDDA's "multiple pools" rules
// (chargen_logic.ts). Every scenario starts in the evac shelter for now; the scenario's
// points, forced traits and allowed professions still apply.
//
// Keys: Tab / Shift+Tab (or > <) switch tabs, ↑↓ / jk move, Enter selects or toggles,
// ←→ change stats, on DESCRIPTION: n name, ? random name, g gender, F finish. Bksp (or Esc) goes
// back. Space isn't a close key here: it toggles traits, and leaving discards the character.

export interface Build {
  scenario: ScenarioDef;
  profession: ProfessionDef;
  traits: Set<string>;
  stats: Stats;
  male: boolean;
  name: string;
  /** World option: zombie density (CDDA SPAWN_DENSITY), see src/game/density.ts. */
  density?: number;
}

const TABS = ['SCENARIO', 'PROFESSION', 'TRAITS', 'STATS', 'DESCRIPTION'] as const;

const STAT_INFO: Record<StatId, [string, string]> = {
  str: ['Strength', 'Strength affects your melee damage, the amount of weight you can carry, your total HP, your resistance to many diseases, and the effectiveness of actions which require brute force.'],
  dex: ['Dexterity', 'Dexterity affects your chance to hit in melee combat, helps you steady your gun for ranged combat, and enhances many actions that require finesse.'],
  int: ['Intelligence', 'Intelligence is less important in most situations, but it is vital for more complex tasks like electronics crafting.  It also affects how much skill you can pick up from reading a book.'],
  per: ['Perception', "Perception is the most important stat for ranged combat.  It's also used for detecting traps and other things of interest."],
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (v: unknown, male = true): string => {
  if (v && typeof v === 'object' && ('male' in (v as object) || 'female' in (v as object))) {
    const o = v as { male?: string; female?: string };
    return (male ? o.male : o.female) ?? o.male ?? '';
  }
  return cddaText(v);
};

export function defaultBuild(ctx: UiContext): Build {
  const misc = ctx.game.data.misc ?? {};
  const scen = misc.scenario?.evacuee as ScenarioDef;
  if (!scen) throw new Error('chargen: scenario "evacuee" missing from misc.json');
  const male = Math.random() < 0.5;
  return {
    scenario: scen,
    profession: permittedProfessions(scen, misc.profession ?? {})[0],
    traits: new Set(),
    stats: { str: BASE_STAT, dex: BASE_STAT, int: BASE_STAT, per: BASE_STAT },
    male,
    name: randomName(ctx.data.names, male),
    density: defaultDensity(),
  };
}

function lockedTraits(b: Build): Set<string> {
  return new Set([...(b.scenario.forced_traits ?? []), ...(b.profession.traits ?? [])]);
}

export function buildPools(b: Build, defs: Record<string, MutationDef>) {
  return multiPool(statPointsUsed(b.stats), traitPointsUsed(b.traits, lockedTraits(b), defs), skillPointsUsed(b.scenario.points ?? 0, b.profession.points ?? 0));
}

/**
 * Turn the build into the survivor: stats, skills, traits, and the profession's starting
 * gear (worn when wearable, like CDDA's add_profession_items; the rest goes into pockets,
 * then hands, then the floor).
 */
export function applyBuild(ctx: UiContext, b: Build): void {
  const { game } = ctx;
  const p = game.player;
  const data = game.data;
  p.name = b.name;
  p.male = b.male;
  if (b.density !== undefined) {
    zombieDensity(game)?.set(b.density);
    setDefaultDensity(b.density);
  }
  p.str_base = b.stats.str;
  p.dex_base = b.stats.dex;
  p.int_base = b.stats.int;
  p.per_base = b.stats.per;
  for (const t of [...p.traits]) p.removeTrait(t);
  for (const t of lockedTraits(b)) p.addTrait(t);
  for (const t of b.traits) p.addTrait(t);
  for (const s of b.profession.skills ?? []) p.setSkill(s.name, s.level);
  applyProfessionKnowledge(p, b.profession.id);
  p.recalcHp(true);
  p.stamina = p.staminaMax();

  // CDDA equips starting gear silently; don't flood the log with "You put on your socks."
  const sink = p.onMessage;
  p.onMessage = null;
  try {
    const rng = new Rng(game.seed ^ 0x5eed);
    const items: Item[] = [];
    // CDDA "custom-flags": ["auto_wield"] (the baseball player's bat): wielded before anything
    // else can end up in the hands.
    let autoWield: Item | null = null;
    // BN profession::items: groups, trait bonuses/substitutions, VARSIZE → FIT.
    for (const s of professionItems(data, b.profession as ProfessionItemsDef, b.male, p.traits, rng)) {
      const made = fromSpawned(data, s);
      if (!autoWield && s.flags?.includes('auto_wield')) autoWield = made[0] ?? null;
      for (const it of made) if (it.isBook()) p.identifiedBooks.add(it.typeId);
      items.push(...made);
    }
    const inv = p.inv;
    if (autoWield && inv.canWield(autoWield).ok) inv.wield(autoWield, null);
    const rest: Item[] = [];
    for (const it of items) {
      if (it === inv.wielded) continue;
      if (it.isArmor() && inv.canWear(it).ok && !it.hasFlag('NO_AUTO_EQUIP') && inv.wear(it, null).ok) continue;
      rest.push(it);
    }
    // add_profession_items: the rest into the inventory, hands, else at the survivor's feet
    for (const it of rest) inv.giveNew(it);
    startBodyMods(game, b);
  } finally {
    p.onMessage = sink;
  }
  startPets(game, b);
  game.stats.startSeconds = game.clock.seconds;
  ctx.build = { scenario: scenName(b.scenario, b.male), profession: profName(b.profession, b.male) };
}

/**
 * newcharacter.cpp / game.cpp start_game, the body parts: profession CBMs (power filled),
 * starts_active mutations powered, and BN's starting accumulated mutagen.
 */
function startBodyMods(game: UiContext['game'], b: Build): void {
  const mods = bodyMods(game.player);
  if (!mods) return;
  mods.mut.syncBase();
  for (const t of game.player.traits) if (mods.mut.idx.def(t)?.starts_active) mods.mut.powered.add(t);
  for (const id of (b.profession as { CBMs?: string[] }).CBMs ?? []) {
    if (mods.bio.def(id)) mods.bio.add(id);
    else console.warn(`profession ${b.profession.id}: unknown CBM ${id}`);
  }
  mods.bio.power = mods.bio.maxPower();
  mods.mut.startGame();
}

/** Profession `pets` ({name, amount}) spawn tame next to the survivor (start_game). */
function startPets(game: UiContext['game'], b: Build): void {
  const pets = (b.profession as { pets?: { name: string; amount?: number }[] }).pets ?? [];
  const sys = (game as unknown as { monsters?: { spawnById(id: string, x: number, y: number, z: number, o: { friendly?: boolean }): unknown } }).monsters;
  if (!pets.length || !sys) return;
  const p = game.player;
  let n = 0;
  for (const pet of pets) {
    for (let i = 0; i < (pet.amount ?? 1); i++, n++) {
      const a = (n * 2 * Math.PI) / 6;
      const m = sys.spawnById(pet.name, p.tileX + Math.round(Math.cos(a) * 2), p.tileY + Math.round(Math.sin(a) * 2), p.z, { friendly: true });
      if (!m) console.warn(`profession ${b.profession.id}: unknown pet ${pet.name}`);
    }
  }
}

/** BN profession CBMs and pets for the detail pane (newcharacter.cpp profession tab). */
function profExtras(ctx: UiContext, p: ProfessionDef): string {
  const misc = ctx.game.data.misc ?? {};
  const cbms = ((p as { CBMs?: string[] }).CBMs ?? []).map((id) => cddaText((misc.bionic?.[id] as { name?: unknown } | undefined)?.name) || id);
  const pets = ((p as { pets?: { name: string; amount?: number }[] }).pets ?? []).map((pet) => `${pet.amount ?? 1} × ${cddaText(ctx.game.data.monsters[pet.name]?.name) || pet.name}`);
  let out = '';
  if (cbms.length) out += `\n\n${c('c_light_blue', 'Profession bionics:')}\n${cbms.map(esc).join('\n')}`;
  if (pets.length) out += `\n\n${c('c_light_blue', 'Profession pets:')}\n${pets.map(esc).join('\n')}`;
  return out;
}

/** Opens character creation; resolves with the build, or null if the player backed out. */
export function openCharGen(ctx: UiContext): Promise<Build | null> {
  return new Promise((resolve) => {
    const misc = ctx.game.data.misc ?? {};
    const defs = (misc.mutation ?? {}) as Record<string, MutationDef>;
    const scenarios = (Object.values(misc.scenario ?? {}) as ScenarioDef[])
      .sort((a, b) => (a.id === 'evacuee' ? -1 : b.id === 'evacuee' ? 1 : (a.points ?? 0) - (b.points ?? 0) || scenName(a, true).localeCompare(scenName(b, true))));
    const traitLists = startingTraits(defs);
    const traitRows: { def: MutationDef; header: string }[] = [
      ...traitLists.good.map((def) => ({ def, header: 'POSITIVE' })),
      ...traitLists.bad.map((def) => ({ def, header: 'NEGATIVE' })),
      ...traitLists.neutral.map((def) => ({ def, header: 'NEUTRAL' })),
    ];
    const b = defaultBuild(ctx);
    let tab = 0;
    const sel = [0, 0, 0, 0, 0];
    let flash = '';
    let done = false;

    const profs = () => permittedProfessions(b.scenario, misc.profession ?? {});

    const w: UiWindow = openWindow({
      title: 'New Character',
      width: '96vw',
      height: '92vh',
      closeLabel: null, // the footer inside the body explains Bksp (back a tab)
      closeKey: false,
      onKey: (e) => {
        const k = e.key;
        flash = '';
        if (e.repeat && k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'ArrowLeft' && k !== 'ArrowRight') return true;
        if (k === 'Escape' || k === 'Backspace') {
          if (tab > 0) tab--;
          else void confirm('Return to the main menu?  <color_light_red>This character will be discarded.</color>', { destructive: true }).then((y) => y && (done = true, w.close()));
          render();
          return true;
        }
        if (k === 'Tab' || k === '>') tab = e.shiftKey && k === 'Tab' ? Math.max(0, tab - 1) : Math.min(TABS.length - 1, tab + 1);
        else if (k === '<') tab = Math.max(0, tab - 1);
        // Play now from any tab (CDDA needs a trip to the last tab; new players get lost there).
        else if (k === 'F') void finish();
        else if (!onTabKey(e)) return false;
        render();
        return true;
      },
      onClose: () => {
        if (!done) resolve(null);
      },
    });
    w.body.style.whiteSpace = 'normal';
    w.body.style.display = 'flex';
    w.body.style.flexDirection = 'column';

    const listLen = () => [scenarios.length, profs().length, traitRows.length, 4, 0][tab];
    function move(d: number) {
      const n = listLen();
      if (n) sel[tab] = Math.max(0, Math.min(n - 1, sel[tab] + d));
    }

    function onTabKey(e: KeyboardEvent): boolean {
      const k = e.key;
      if (k === 'ArrowDown' || k === 'j') return move(1), true;
      if (k === 'ArrowUp' || k === 'k') return move(-1), true;
      if (k === 'PageDown') return move(10), true;
      if (k === 'PageUp') return move(-10), true;
      const pools = buildPools(b, defs);
      switch (TABS[tab]) {
        case 'SCENARIO':
          if (k === 'Enter') {
            const s = scenarios[sel[0]];
            if (lockedBy(s)) return (flash = c('c_light_red', `This scenario is locked: it requires the achievement "${achName(ctx, lockedBy(s)!)}".`)), true;
            b.scenario = s;
            for (const t of s.forbidden_traits ?? []) b.traits.delete(t);
            b.profession = profs()[0];
            sel[1] = 0;
            return true;
          }
          return false;
        case 'PROFESSION':
          if (k === 'Enter') {
            const pr = profs()[sel[1]];
            if (lockedBy(pr)) return (flash = c('c_light_red', `This profession is locked: it requires the achievement "${achName(ctx, lockedBy(pr)!)}".`)), true;
            b.profession = pr;
            for (const t of pr.traits ?? []) b.traits.delete(t);
            return true;
          }
          return false;
        case 'TRAITS':
          if (k === 'Enter' || k === ' ') {
            const id = traitRows[sel[2]].def.id;
            if (lockedTraits(b).has(id)) return (flash = c('c_light_red', 'Your scenario or profession gives you this trait.')), true;
            if (b.traits.has(id)) b.traits.delete(id);
            else {
              const chk = canAddTrait(id, new Set([...b.traits, ...lockedTraits(b)]), lockedTraits(b), defs, pools, new Set(b.scenario.forbidden_traits ?? []));
              if (!chk.ok) flash = c('c_light_red', chk.reason!);
              else b.traits.add(id);
            }
            return true;
          }
          return false;
        case 'STATS': {
          const stat = (['str', 'dex', 'int', 'per'] as StatId[])[sel[3]];
          if (k === 'ArrowRight' || k === 'l' || k === '+') {
            const v = b.stats[stat];
            if (v >= STAT_MAX) flash = c('c_light_red', `Max ${STAT_INFO[stat][0].toLowerCase()}.`);
            else if (statStepCost(v) > pools.statLeft) flash = c('c_light_red', 'Not enough points left.');
            else b.stats[stat]++;
            return true;
          }
          if (k === 'ArrowLeft' || k === 'h' || k === '-') {
            if (b.stats[stat] <= STAT_MIN) flash = c('c_light_red', `Min ${STAT_INFO[stat][0].toLowerCase()}.`);
            else b.stats[stat]--;
            return true;
          }
          return false;
        }
        case 'DESCRIPTION':
          if (k === 'n') {
            void prompt('Enter a name:', b.name).then((v) => {
              if (v && v.trim()) b.name = v.trim().slice(0, 40);
              render();
            });
            return true;
          }
          if (k === '?' || k === '*') return (b.name = randomName(ctx.data.names, b.male)), true;
          if (k === 'g') {
            b.male = !b.male;
            return true;
          }
          if (k === 'z') {
            b.density = cycleDensity(b.density ?? 1, 1);
            return true;
          }
          if (k === 'F' || k === 'Enter') {
            void finish();
            return true;
          }
          return false;
      }
    }

    async function finish() {
      const pools = buildPools(b, defs);
      const chk = finishCheck(pools);
      if (!chk.ok) {
        flash = c('c_light_red', chk.reason!);
        return render();
      }
      if (pools.skillLeft > 0 && !(await confirm('Remaining points will be discarded, are you sure you want to proceed?'))) return;
      if (!(await confirm(`Are you SURE you're finished?  Your name will be <color_white>${esc(b.name)}</color>.`))) return;
      done = true;
      w.close();
      resolve(b);
    }

    function listHtml(rows: { label: string; key?: string }[], cur: number, height: number): string {
      const start = Math.max(0, Math.min(cur - Math.floor(height / 2), rows.length - height));
      let out = '';
      let lastHeader = '';
      for (let i = start; i < Math.min(rows.length, start + height); i++) {
        const r = rows[i];
        if (r.key && r.key !== lastHeader) {
          out += `<div class="pre" style="color:var(--c-light_blue)">${esc(r.key)}</div>`;
          lastHeader = r.key;
        }
        out += `<div class="pre menu-entry${i === cur ? ' sel' : ''}" data-i="${i}">${r.label}</div>`;
      }
      return out;
    }

    function pointsLine(): string {
      const pl = buildPools(b, defs);
      const col = (v: number) => (v < 0 ? 'c_red' : v > 0 ? 'c_light_green' : 'c_light_gray');
      return `Points left: Stats ${c(col(pl.statLeft), String(pl.statLeft))}  Traits ${c(col(pl.traitLeft), String(pl.traitLeft))}  Skills ${c(col(pl.skillLeft), String(pl.skillLeft))}`;
    }

    // The same roll applyBuild makes, so the list shows what you will actually start with
    // (a wallet with its three bills, not every coin the wallet distribution could hold).
    function itemsOf(pr: ProfessionDef, male: boolean): string[] {
      const rng = new Rng(ctx.game.seed ^ 0x5eed);
      const items: Item[] = [];
      const traits = new Set([...(b.scenario.forced_traits ?? []), ...(pr.traits ?? []), ...b.traits]);
      for (const sp of professionItems(ctx.game.data, pr as ProfessionItemsDef, male, traits, rng)) items.push(...fromSpawned(ctx.game.data, sp));
      return items.map((it) => `${spriteImg(ctx.renderer, it.typeId) || '<span class="icon"></span>'}${esc(it.name())}`);
    }

    function render() {
      // Rows that fit the list pane: window is 92vh, lines ~1.15 x 16px, minus tabs/footer.
      const H = Math.max(8, Math.floor((window.innerHeight * 0.92) / 18.4) - 8);
      const tabs = TABS.map((t, i) => `<span class="tab${i === tab ? ' on' : ''}" data-tab="${i}" style="cursor:pointer">${t}</span>`).join(' ');
      let left = '', right = '';
      const T = TABS[tab];
      if (T === 'SCENARIO') {
        const rows = scenarios.map((s) => ({
          label: `${s === b.scenario ? c('c_light_green', '*') : ' '} ${c(lockedBy(s) ? 'c_dark_gray' : 'c_light_gray', fit(scenName(s, b.male), 30))} ${c('c_dark_gray', String(s.points ?? 0).padStart(3))}`,
        }));
        left = listHtml(rows, sel[0], H);
        const s = scenarios[sel[0]];
        right = `${c('c_white', scenName(s, b.male))}  ${c('c_light_gray', `(${s.points ?? 0} points)`)}\n\n${colorize(text(s.description, b.male))}\n\n${c('c_light_gray', 'Start location:')} ${c('c_white', s.start_name || '?')}${s.id !== 'evacuee' ? c('c_dark_gray', '\n(this port starts every scenario in the evac shelter for now)') : ''}${s.forced_traits?.length ? `\n\n${c('c_light_gray', 'Forced traits:')} ${s.forced_traits.map((t) => c('c_yellow', text(defs[t]?.name) || t)).join(', ')}` : ''}${requirementText(ctx, s)}`;
      } else if (T === 'PROFESSION') {
        const ps = profs();
        const rows = ps.map((p) => ({
          label: `${p === b.profession ? c('c_light_green', '*') : ' '} ${c(lockedBy(p) ? 'c_dark_gray' : 'c_light_gray', fit(profName(p, b.male), 30))} ${c('c_dark_gray', String(p.points ?? 0).padStart(3))}`,
        }));
        left = listHtml(rows, sel[1], H);
        const p = ps[sel[1]];
        const skills = (p.skills ?? []).map((s) => `${c('c_light_gray', ctx.game.player.skillName(s.name))} ${c('c_white', String(s.level))}`);
        const traits = (p.traits ?? []).map((t) => c('c_yellow', text(defs[t]?.name) || t));
        const items = itemsOf(p, b.male);
        right = `${c('c_white', profName(p, b.male))}  ${c('c_light_gray', `(${p.points ?? 0} points)`)}\n\n${colorize(text(p.description, b.male))}\n\n${c('c_light_blue', 'Profession skills:')}\n${skills.join('\n') || c('c_dark_gray', 'None')}\n${traits.length ? `\n${c('c_light_blue', 'Profession traits:')}\n${traits.join('\n')}\n` : ''}\n${c('c_light_blue', 'Profession items:')}\n${items.join('\n') || c('c_dark_gray', 'None')}${profExtras(ctx, p)}${requirementText(ctx, p)}`;
      } else if (T === 'TRAITS') {
        const locked = lockedTraits(b);
        const rows = traitRows.map(({ def, header }) => {
          const on = b.traits.has(def.id) || locked.has(def.id);
          const pts = def.points ?? 0;
          const col = on ? (pts > 0 ? 'c_light_green' : pts < 0 ? 'c_light_red' : 'c_yellow') : pts > 0 ? 'c_green' : pts < 0 ? 'c_red' : 'c_light_gray';
          return { key: header, label: `${on ? c('c_white', '[X]') : '[ ]'} ${c(col, fit(text(def.name), 28))} ${c('c_dark_gray', ((pts > 0 ? '+' : '') + pts).padStart(3))}` };
        });
        left = listHtml(rows, sel[2], H);
        const d = traitRows[sel[2]].def;
        const pts = d.points ?? 0;
        right = `${c(pts > 0 ? 'c_light_green' : pts < 0 ? 'c_light_red' : 'c_yellow', text(d.name))}  ${c('c_light_gray', `(${pts} points)`)}\n\n${colorize(text(d.description))}`;
      } else if (T === 'STATS') {
        const ids: StatId[] = ['str', 'dex', 'int', 'per'];
        left = ids.map((id, i) => `<div class="pre menu-entry${i === sel[3] ? ' sel' : ''}">${fit(STAT_INFO[id][0] + ':', 16)} ${c('c_dark_gray', '<')} ${c('c_white', String(b.stats[id]).padStart(2))} ${c('c_dark_gray', '>')}${b.stats[id] > 12 ? c('c_yellow', '  (costs 2 per point)') : ''}</div>`).join('');
        const id = ids[sel[3]];
        const s = b.stats;
        // Only numbers this port actually derives from the stat (character.ts / inventory.ts).
        const derived: Record<StatId, string> = {
          str: `Base HP: ${c('c_white', String(60 + 3 * s.str))}\nCarry weight: ${c('c_white', `${13 + 4 * s.str} kg`)}`,
          dex: `Dodge skill bonus: ${c('c_white', (s.dex / 2).toFixed(1))}`,
          int: '',
          per: '',
        };
        right = `${c('c_white', STAT_INFO[id][0])}\n\n${esc(STAT_INFO[id][1])}\n\n${derived[id]}`;
      } else {
        const locked = lockedTraits(b);
        const allTraits = [...locked, ...b.traits].map((t) => text(defs[t]?.name) || t);
        left = [
          `${c('c_light_gray', 'Name:')} ${c('c_white', esc(b.name))}   ${c('c_dark_gray', '(n to edit, ? random)')}`,
          `${c('c_light_gray', 'Gender:')} ${c('c_white', b.male ? 'Male' : 'Female')}   ${c('c_dark_gray', '(g to change)')}`,
          '',
          `${c('c_light_gray', 'Scenario:')} ${c('c_white', scenName(b.scenario, b.male))}`,
          `${c('c_light_gray', 'Profession:')} ${c('c_white', profName(b.profession, b.male))}`,
          `${c('c_light_gray', 'Stats:')} Str ${b.stats.str}  Dex ${b.stats.dex}  Int ${b.stats.int}  Per ${b.stats.per}`,
          `${c('c_light_gray', 'Traits:')} ${allTraits.length ? allTraits.map((t) => c('c_white', t)).join(', ') : c('c_dark_gray', 'none')}`,
          '',
          `${c('c_light_gray', 'Zombie density:')} ${c((b.density ?? 1) > 1 ? 'c_light_red' : (b.density ?? 1) < 1 ? 'c_light_green' : 'c_white', densityLabel(b.density ?? 1))}   ${c('c_dark_gray', '(z to change)')}`,
          '',
          `${c('c_yellow', 'Press F (or Enter) to finish and start the game.')}`,
        ].map((l) => `<div class="wrap">${l}</div>`).join('');
        right = `${c('c_light_blue', 'Starting location')}\n${c('c_white', 'Evac Shelter')}\n\n${c('c_light_gray', 'You will wake up with your profession\'s gear already on.')}`;
      }
      w.body.innerHTML = `<div class="tabs pre" style="display:flex;justify-content:space-between"><span>${tabs}</span><span>${pointsLine()}</span></div>
        <div class="pre" style="border-bottom:1px solid var(--c-light_gray);margin:2px 0 4px"></div>
        <div class="cols" style="flex:1;min-height:0">
          <div style="overflow:hidden">${left}</div>
          <div class="wrap" style="border-left:1px solid var(--c-dark_gray);padding-left:8px;overflow:auto">${right}</div>
        </div>
        <div class="pre" style="min-height:1.2em">${flash}</div>
        <div class="pre" style="color:var(--c-dark_gray)">${c('c_light_green', 'Tab')}/${c('c_light_green', '<>')} switch tab  ${c('c_light_green', '↑↓')} move  ${c('c_light_green', 'Enter')} ${T === 'STATS' ? 'use ←→' : T === 'DESCRIPTION' ? 'finish' : 'select'}  ${c('c_light_green', 'F')} finish &amp; play  ${c('c_light_green', 'Bksp')} ${tab > 0 ? 'previous tab' : 'main menu'}</div>`;
      w.body.querySelectorAll<HTMLElement>('.tab[data-tab]').forEach((t) => {
        t.onclick = () => {
          tab = Number(t.dataset.tab);
          flash = '';
          render();
        };
      });
      w.body.querySelectorAll<HTMLElement>('.menu-entry[data-i]').forEach((row) => {
        row.onclick = () => {
          sel[tab] = Number(row.dataset.i);
          onTabKey(new KeyboardEvent('keydown', { key: 'Enter' }));
          render();
        };
      });
    }
    render();
    (window as any).cdda && ((window as any).cdda.chargen = {
      setTab: (i: number) => ((tab = i), render()),
      build: b,
      select: (i: number) => ((sel[tab] = i), render()),
      key: (key: string) => (onTabKey(new KeyboardEvent('keydown', { key })), render()),
    });
  });
}

/**
 * CDDA meta-progression (profession::can_pick): a scenario/profession "requirement" (one
 * achievement id, or a list that must all be completed) unlocks it once any character has
 * completed it. Returns the first missing achievement, or null when unlocked.
 */
function lockedBy(x: { requirement?: string | string[] }): string | null {
  const reqs = x.requirement === undefined ? [] : Array.isArray(x.requirement) ? x.requirement : [x.requirement];
  return reqs.find((r) => !globalAchievements().has(r)) ?? null;
}
function achName(ctx: UiContext, id: string): string {
  return achievementsOf(ctx.game)?.data.achievements[id]?.name ?? id;
}
function requirementText(ctx: UiContext, x: { requirement?: string | string[] }): string {
  if (!x.requirement) return '';
  const names = (Array.isArray(x.requirement) ? x.requirement : [x.requirement]).map((r) => `"${achName(ctx, r)}"`).join(', ');
  return lockedBy(x) ? `\n\n${c('c_red', `Locked: requires the achievement ${names}.`)}` : `\n\n${c('c_light_green', `Unlocked by the achievement ${names}.`)}`;
}
