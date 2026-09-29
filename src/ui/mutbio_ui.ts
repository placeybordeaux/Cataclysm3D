import type { Game } from '../game/game';
import type { BodyMods } from '../game/bodymods';
import { createItem, type Item } from '../game/item';
import { BODY_PARTS, isBodyPart } from '../game/bodyparts';
import { cddaText } from '../game/units';
import { c, colorize, confirm, openMenu, type MenuEntry, type UiWindow } from './framework';

// Screens for body modifications: the `[` mutations menu, the `p` bionics menu (CDDA
// bionics_ui.cpp look: power bar header, activatable list with letters, detail pane), the
// CBM installation flow (self-install via `A`pply or an Autodoc) and the '@' BIONICS box.

const kj = (v: number) => (v <= 0 ? '0' : v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(3));
/** CDDA-style energy text: "0.5 J", "25 J", "2 kJ". */
const energy = (v: number) => (v >= 1 ? `${+v.toFixed(2)} kJ` : `${+(v * 1000).toFixed(2)} J`);

/** "Power: 45/100 kJ" bar, CDDA sidebar style. */
export function powerBar(mods: BodyMods, width = 10): string {
  const max = mods.bio.maxPower();
  const cur = mods.bio.power;
  const n = max > 0 ? Math.round((cur / max) * width) : 0;
  const col = cur >= max * 0.5 ? 'c_light_blue' : cur >= max * 0.25 ? 'c_yellow' : 'c_red';
  return `${c(col, '|'.repeat(n))}${c('c_dark_gray', '.'.repeat(width - n))} ${c(col, kj(cur))}${c('c_light_gray', `/${kj(max)} kJ`)}`;
}

function pointsColor(points: number): string {
  return points > 0 ? 'c_light_green' : points < 0 ? 'c_light_red' : 'c_yellow';
}

// ------------------------------------------------------------------ mutations `[`

export function openMutationsMenu(game: Game, mods: BodyMods): UiWindow {
  const { mut } = mods;
  const entries = (): MenuEntry<string>[] => {
    const list = [...game.player.traits].filter((id) => mut.idx.visible(id));
    list.sort((a, b) => Number(!!mut.idx.def(b)?.active) - Number(!!mut.idx.def(a)?.active) || mut.name(a).localeCompare(mut.name(b)));
    return list.map((id) => {
      const d = mut.idx.def(id);
      const active = !!d?.active;
      const state = active ? (mut.isPowered(id) ? c('c_light_green', ' (active)') : c('c_dark_gray', ' (inactive)')) : '';
      return {
        label: `${c(pointsColor(d?.points ?? 0), mut.name(id))}${state}`,
        value: id,
        header: active ? 'Activatable' : 'Passive',
        disabled: !active,
        detail: () => {
          const cats = (d?.category ?? []).join(', ');
          return `${c('c_white', mut.name(id))}\n\n${colorize(cddaText(d?.description) || '')}${cats ? `\n\n${c('c_dark_gray', `Category: ${cats}`)}` : ''}${mut.isBase(id) ? `\n${c('c_dark_gray', 'Innate trait')}` : ''}`;
        },
      };
    });
  };
  const thresh = mut.thresholdCategory();
  const m = openMenu<string>({
    title: `Mutations${thresh ? ` — post-threshold: ${mut.idx.categories.get(thresh)?.name ?? thresh}` : ''}`,
    width: 'min(96ch, 94vw)',
    detailPane: true,
    entries: entries(),
    footer: `${c('c_light_green', 'letter')} activate/deactivate`,
    onSelect: (id) => {
      game.message(mut.toggle(id));
      m.refresh(entries());
      return false;
    },
  });
  return m;
}

// ------------------------------------------------------------------ bionics `p`

export function openBionicsMenu(game: Game, mods: BodyMods): UiWindow {
  const { bio } = mods;
  const entries = (): MenuEntry<string>[] => {
    const out: MenuEntry<string>[] = [];
    for (const b of bio.bionics) {
      if (b.included) continue;
      const d = bio.def(b.id);
      const act = bio.activatable(b);
      const cost: string[] = [];
      if (d?.act_cost) cost.push(`${energy(d.act_cost)} act`);
      if (d?.react_cost) cost.push(`${energy(d.react_cost)}/${d.time ?? 1}s`);
      if (d?.capacity) cost.push(`+${d.capacity} kJ`);
      const state = act ? (b.powered ? c('c_light_green', ' (ON)') : c('c_dark_gray', ' (off)')) : '';
      out.push({
        label: `${c(d?.flags?.includes('BIONIC_FAULTY') ? 'c_red' : 'c_white', bio.name(b.id))}${state}${cost.length ? c('c_dark_gray', ` ${cost.join(', ')}`) : ''}`,
        value: b.id,
        header: act ? 'ACTIVE' : 'PASSIVE',
        disabled: !act,
        detail: () => bionicDetail(mods, b.id),
      });
    }
    out.sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled));
    return out;
  };
  const m = openMenu<string>({
    title: 'Bionics',
    width: 'min(120ch, 96vw)',
    detailPane: true,
    entries: entries(),
    footer: `${c('c_light_green', 'letter')} activate/deactivate`,
    onSelect: (id) => {
      bio.toggle(id);
      m.refresh(entries());
      renderHeader();
      return false;
    },
  });
  // Power bar line above the list, like bionics_ui.cpp's header.
  const head = document.createElement('div');
  head.className = 'pre';
  head.style.marginBottom = '4px';
  const renderHeader = () => {
    head.innerHTML = bio.maxPower() > 0 ? `Bionic Power: ${powerBar(mods, 20)}` : c('c_dark_gray', 'No bionic power storage installed.');
  };
  renderHeader();
  m.body.prepend(head);
  if (!bio.bionics.length) head.innerHTML += `\n${c('c_light_gray', 'You have no bionics installed.')}`;
  return m;
}

const partLabel = (bp: string) => (isBodyPart(bp) ? BODY_PARTS[bp].name : bp);

function bionicDetail(mods: BodyMods, id: string): string {
  const { bio } = mods;
  const d = bio.def(id);
  if (!d) return id;
  const lines = [c('c_white', bio.name(id)), '', colorize(cddaText(d.description) || '')];
  const occ = (d.occupied_bodyparts ?? []).map(([bp, n]) => `${isBodyPart(bp) ? BODY_PARTS[bp].name : bp} (${n})`);
  if (occ.length) lines.push('', c('c_dark_gray', `Occupies: ${occ.join(', ')}`));
  const costs: string[] = [];
  if (d.act_cost) costs.push(`${energy(d.act_cost)} to activate`);
  if (d.react_cost) costs.push(`${energy(d.react_cost)} every ${d.time ?? 1} turn(s) while on`);
  if (d.trigger_cost) costs.push(`${energy(d.trigger_cost)} per trigger`);
  if (d.capacity) costs.push(`stores ${d.capacity} kJ`);
  if (costs.length) lines.push(c('c_dark_gray', `Power: ${costs.join(', ')}`));
  const protec = (['bash', 'cut', 'bullet'] as const).flatMap((k) => (d[`${k}_protec`] ?? []).map(([bp, v]) => `${partLabel(bp)} ${k} ${v}`));
  if (protec.length) lines.push(c('c_dark_gray', `Protection: ${protec.join('; ')}`));
  if (d.stat_bonus?.length) lines.push(c('c_dark_gray', `Stats: ${d.stat_bonus.map(([s, n]) => `${s} ${n > 0 ? '+' : ''}${n}`).join(', ')}`));
  const weapon = d.flags?.includes('BIONIC_WEAPON');
  if (d.fake_item && weapon) lines.push(c('c_dark_gray', 'Weapon: extends while active.'));
  else if (d.fake_item) lines.push(c('c_dark_gray', `Provides: ${bio.c.data.items[d.fake_item]?.name ?? d.fake_item}${d.flags?.includes('BIONIC_TOGGLED') ? ' (while active)' : ''}`));
  return lines.join('\n');
}

/** The '@' sheet box listing bionics (CDDA player_display BIONICS section). */
export function bionicsSheetBox(mods: BodyMods): { title: string; body: string } | null {
  const { bio } = mods;
  if (!bio.bionics.length) return null;
  const lines = bio.bionics.filter((b) => !b.included).map((b) => `${c(b.powered ? 'c_light_green' : 'c_white', bio.name(b.id))}${b.powered ? c('c_dark_gray', ' (on)') : ''}`);
  if (bio.maxPower() > 0) lines.unshift(`Power: ${powerBar(mods, 10)}`);
  return { title: `BIONICS (${bio.bionics.filter((b) => !b.included).length})`, body: lines.join('\n') };
}

// ------------------------------------------------------------------ installation

export interface InstallFlowOpts {
  autodoc: boolean;
  /** Remove the CBM item from wherever it is (inventory / map). */
  consumeItem: (it: Item) => void;
  /** Put a returned (used) CBM on the ground at the patient. */
  dropItem: (it: Item) => void;
}

/**
 * BN can_install_bionics + install_bionics as an activity (iexamine::autodoc for the
 * Autodoc): checks, the complication warning, anesthesia (required unless the patient feels
 * no pain; BN refuses without it), an install program (`installation_data` item: skill
 * override 10, consumed), the operation time (difficulty × 20 min) and the roll at the end.
 * BN always installs the CBM; a failed roll adds complications.
 */
export async function installCbmFlow(game: Game, mods: BodyMods, it: Item, opts: InstallFlowOpts): Promise<boolean> {
  const { bio } = mods;
  const p = game.player;
  const blocker = bio.installBlocker(it);
  if (blocker) {
    game.message(blocker, 'c_light_red');
    return false;
  }
  const bid = bio.idx.bionicOf(it.typeId);
  const program = it.def.installation_data as string | undefined;
  const programItem = program ? p.inv.allItems().find((x) => x.typeId === program) : undefined;
  const skillLevel = programItem ? 10 : -1;
  const chance = bio.successChance(it.typeId, opts.autodoc, skillLevel);
  const conflicts = (bio.def(bid)?.canceled_mutations ?? []).filter((m) => p.hasTrait(m));
  if (conflicts.length && !(await confirm(`Installing this bionic will remove the conflicting traits: ${conflicts.map((m) => p.traitName(m)).join(', ')}.  Continue anyway?`, { destructive: true }))) return false;
  const q = chance >= 100 ? 'Are you sure you wish to install the selected bionic?'
    : opts.autodoc ? `WARNING: There is a ${100 - chance} percent chance of complications, such as damage or faulty installation!  Continue anyway?`
      : `WARNING: There is a ${100 - chance} percent chance of complications, such as damage or faulty installation!  The following skills affect self-installation: First Aid, Electronics, and Mechanics.\n\nContinue anyway?`;
  if (!(await confirm(`${opts.autodoc ? 'Autodoc Mk. XI.  ' : ''}Install <color_white>${bio.name(bid)}</color>?\n${q}`, { destructive: true }))) return false;
  const need = bio.anesthesiaNeeded(it.typeId);
  const anesthesia = opts.autodoc && bio.needsAnesthesia();
  if (anesthesia && bio.anesthesiaAvailable() < need) {
    game.message(`You don't have enough anesthetic for this operation (${need} charges in anesthesia kits needed).`, 'c_light_red');
    return false;
  }
  if (anesthesia) bio.consumeAnesthesia(need);
  const difficulty = bio.idx.difficulty(it.typeId);
  opts.consumeItem(it);
  if (programItem) p.inv.remove(programItem);
  const itemId = it.typeId;
  if (opts.autodoc) {
    game.message('You set up the operation step-by-step, configuring the Autodoc to manipulate a CBM.');
    if (anesthesia) {
      game.message("You settle into position, sliding your right wrist into the couch's strap.");
      game.message('You feel a tiny pricking sensation in your right arm, and lose all sensation before abruptly blacking out.', 'c_pink');
    } else game.message('You stay very, very still, intently staring off into space, as the Autodoc slices painlessly into you.', 'c_pink');
  }
  const started = game.activities.start({
    name: `installing ${bio.name(bid)}`,
    duration: Math.max(1, difficulty) * 20 * 60,
    interruptible: false,
    onComplete: () => {
      const r = bio.install(itemId, { autodoc: opts.autodoc, skillLevel });
      if (r.success > 0) game.message(opts.autodoc ? 'The Autodoc returns to its resting position after successfully performing the operation.' : 'The operation is a success.', 'c_light_green');
      else game.message(opts.autodoc ? 'The Autodoc completes installation and activates bionic but reports about complications during operation.' : 'Bionic was installed and activated but a complication happened during operation!', 'c_yellow');
    },
  });
  if (!started) opts.dropItem(it);
  return started;
}

/** Autodoc examine menu (iexamine::autodoc, trimmed to install/uninstall). */
export function openAutodocMenu(game: Game, mods: BodyMods, cbms: () => { item: Item; consume: () => void }[], dropItem: (it: Item) => void): UiWindow {
  const { bio } = mods;
  return openMenu<'i' | 'u'>({
    title: 'Autodoc Mk. XI.  Status: Online.  Please choose operation.',
    width: 'min(70ch, 92vw)',
    entries: [
      { label: 'Choose Compact Bionic Module to install', value: 'i', hotkey: 'i' },
      { label: 'Choose installed bionic to uninstall', value: 'u', hotkey: 'u', disabled: !bio.bionics.some((b) => !b.included) },
    ],
    onSelect: (v) => {
      if (v === 'i') {
        const list = cbms();
        if (!list.length) {
          game.message("You don't have any bionics to install.", 'c_light_red');
          return;
        }
        openMenu({
          title: 'Choose Compact Bionic Module to install',
          width: 'min(80ch, 94vw)',
          detailPane: true,
          entries: list.map((e) => {
            const blocker = bio.installBlocker(e.item);
            return {
              label: `${c(blocker ? 'c_dark_gray' : 'c_white', e.item.name())} ${c('c_light_gray', `(${100 - bio.successChance(e.item.typeId, true, e.item.def.installation_data && game.player.inv.allItems().some((x) => x.typeId === e.item.def.installation_data) ? 10 : -1)}% complications)`)}`,
              value: e,
              detail: () => `${colorize(cddaText(e.item.def.description) || '')}${blocker ? `\n\n${c('c_red', blocker)}` : ''}\n\n${c('c_dark_gray', `Difficulty ${bio.idx.difficulty(e.item.typeId)}; anesthetic needed: ${bio.needsAnesthesia() ? bio.anesthesiaNeeded(e.item.typeId) : 0}`)}`,
            };
          }),
          onSelect: (e) => void installCbmFlow(game, mods, e.item, { autodoc: true, consumeItem: () => e.consume(), dropItem }),
        });
      } else {
        openMenu({
          title: 'Choose installed bionic to uninstall',
          entries: bio.bionics.filter((b) => !b.included).map((b) => ({ label: c('c_white', bio.name(b.id)), value: b.id })),
          onSelect: (id) => void uninstallFlow(game, mods, id, dropItem),
        });
      }
    },
  });
}

/** Autodoc uninstall: same odds as installing; success returns the (used) CBM. */
async function uninstallFlow(game: Game, mods: BodyMods, id: string, dropItem: (it: Item) => void): Promise<void> {
  const { bio } = mods;
  const chance = bio.successChance(id, true);
  if (!(await confirm(`Uninstall <color_white>${bio.name(id)}</color>?  ${chance}% chance of success.`, { destructive: true }))) return;
  const difficulty = bio.idx.difficulty(id);
  game.activities.start({
    name: `removing ${bio.name(id)}`,
    duration: Math.max(1, difficulty) * 20 * 60,
    interruptible: false,
    onComplete: () => {
      const p = game.player;
      if (chance - p.rng.int(0, 99) > 0) {
        bio.remove(id);
        game.message(`Successfully removed ${bio.name(id)}.`, 'c_light_green');
        const itemDef = p.data.items[id];
        if (itemDef) {
          const it = createItem(p.data, id);
          it.vars.cbm_salvaged = 1;
          dropItem(it);
        }
      } else {
        game.message('The removal is a failure.', 'c_red');
        p.modPain(p.rng.int(10, 30));
      }
    },
  });
}
