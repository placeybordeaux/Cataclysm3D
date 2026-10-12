import type { Game } from './game/game';
import type { Renderer } from './render/renderer';
import type { DebugApi } from './debug';
import { attachBodyMods, type BodyMods } from './game/bodymods';
import { createItem, Item } from './game/item';
import { consumeItem, L, locate, spawnItem, type Loc } from './game/moves';
import { visionHooks } from './game/vision';
import { interactOverrides } from './game/interact';
import { targetTile } from './game/targeting';
import { hasFlag } from './world/registry';
import { registerSaveable } from './save/registry';
import { hud } from './ui/hud';
import { charsheetSections } from './ui/charsheet';
import { bionicsSheetBox, installCbmFlow, openAutodocMenu, openBionicsMenu, openMutationsMenu, powerBar } from './ui/mutbio_ui';
import type { MutationStateJSON } from './game/mutations';
import type { BionicStateJSON } from './game/bionics';

// Wiring for mutations and bionics (src/game/mutations.ts, bionics.ts, bodymods.ts): the
// player's hooks, per-tick simulation, vision/light/sprite hooks, keys (`[` mutations,
// `p` bionics), CBM `A`pply self-install, Autodoc examine, sidebar power, '@' box, save
// section 'bodymods' and window.cdda helpers. main.ts calls installMutBio() once.

/**
 * The Autodoc screen, replaceable: installScreens (src/screens/install.ts) swaps in the ui2
 * surgery panel; the curses menu in src/ui/mutbio_ui.ts is the default.
 */
export const autodocScreen = {
  open: (game: Game, mods: BodyMods, cbms: () => { item: Item; consume: () => void }[], dropItem: (it: Item) => void): void => void openAutodocMenu(game, mods, cbms, dropItem),
};

export function installMutBio(game: Game, renderer: Renderer | null, api?: DebugApi): BodyMods {
  const p = game.player;
  const mods = attachBodyMods(p, { isDay: () => game.clock.hourOfDay >= 6 && game.clock.hourOfDay < 20 });
  const { mut, bio } = mods;
  // a new or given-back item (a salvaged CBM) lands at the survivor's feet; gear a mutation
  // pushes off is moved there by mutations.ts itself (onDropItem is only a notice)
  const drop = (it: Item) => void spawnItem(it, L.ground(game.map, p.tileX, p.tileY, p.z), { force: true, quiet: true });
  bio.nearbyItems = () => itemsNear(game, 2);

  // ---- simulation
  let lastX = p.x, lastY = p.y;
  game.systems.push({
    name: 'bodymods',
    update(_g, _realDt, gameDt) {
      mut.update(gameDt);
      bio.update(gameDt);
      const moved = Math.hypot(p.x - lastX, p.y - lastY);
      lastX = p.x;
      lastY = p.y;
      // Teleports aren't walking: only count plausible steps for the torsion ratchet.
      if (moved > 0 && moved < 2) bio.onMoved(moved);
      // Bionic weapon gone from the hands some other way (thrown, swapped): power it down.
      for (const b of bio.bionics) {
        const d = bio.def(b.id);
        const fw = b.powered && d?.flags?.includes('BIONIC_WEAPON') ? d.fake_item : undefined;
        if (fw && p.inv.wielded?.typeId !== fw) bio.deactivate(b.id, true);
      }
    },
  });

  // ---- vision / light
  const hooks = visionHooks(game);
  hooks.lights.push(() => {
    const lum = bio.light();
    return lum > 0 ? { lum, directional: true, name: 'Cranial Flashlight' } : null;
  });
  hooks.nightVision.push(() => Math.max(mut.nightVisionRange(), bio.nightVisionRange()));
  if (renderer) {
    renderer.playerMutationOverlays = () => mut.overlays();
    renderer.beforeRender.push(() => {
      // CDDA +10 range (NV goggles / bionic) ≈ doubles the night image; natural NV less.
      renderer.nightVision = Math.max(mut.nightVisionRange(), bio.nightVisionRange()) / 5;
    });
  }

  // ---- UI
  const hasDom = typeof document !== 'undefined' && !!renderer;
  if (hasDom) {
    game.keys.register('mutations', 'View/activate mutations', () => void openMutationsMenu(game, mods));
    game.keys.register('bionics', 'View/activate bionics', () => void openBionicsMenu(game, mods));
    hud.addSidebarProvider(() => (bio.maxPower() > 0 ? [`${'Power:'.padEnd(6)} ${powerBar(mods, 8)}`] : null));
    charsheetSections.push(() => bionicsSheetBox(mods));
  }

  // CBMs: `A`pply = self-install, only with BN's MANUAL_BIONIC_INSTALLATION option (off by
  // default: an Autodoc does it).
  p.inv.useHandlers.set('install_bionic', (it) => {
    if (!bio.idx.manualInstall && !p.hasTrait('DEBUG_BIONICS')) return { ok: false, msg: "You can't self-install bionics.  An Autodoc can install it.", moves: 0 };
    if (!hasDom) return { ok: false, msg: 'No UI to confirm the operation.', moves: 0 };
    // Pre-transform snapshot: consumeItem below removes it from inventory (and the operation
    // itself installs, not drops, the CBM), so the gesture can't read `it` back later.
    const gun = it.isGun();
    const shown = { typeId: it.typeId, def: it.def, isGun: () => gun };
    void installCbmFlow(game, mods, it, {
      autodoc: false,
      consumeItem: (x) => {
        const loc = p.inv.locOf(x) ?? locate(x, nearTiles(game, 2));
        if (loc) consumeItem(x, loc, x.countByCharges ? 1 : undefined);
      },
      dropItem: drop,
      onInstalled: () => p.inv.presentDeferredUse(shown),
    });
    // Accepted so far (confirm dialogs still ahead): the gesture fires only from
    // onInstalled, once the operation activity actually completes.
    return { ok: true, msg: '', moves: 0, deferred: true };
  });

  // Autodoc: `e` on an f_autodoc (or its couch) opens the operation menu.
  const autodocAimed = () => {
    const t = targetTile(game);
    if (!t) return false;
    const f = game.map.furnAt(t.x, t.y, t.z);
    return hasFlag(f, 'AUTODOC') || hasFlag(f, 'AUTODOC_COUCH');
  };
  interactOverrides.push({
    interact: (g) => {
      if (!autodocAimed() || !hasDom) return false;
      autodocScreen.open(g, mods, () => cbmsNearby(g), drop);
      return true;
    },
    prompt: () => (autodocAimed() ? `[${game.keys.keyFor('interact')}] Use the Autodoc` : null),
  });

  // ---- save
  registerSaveable<{ mut: MutationStateJSON; bio: BionicStateJSON }>(game, 'bodymods', {
    order: 15, // after the player (10): traits and worn integrated armor are already loaded
    save: () => ({ mut: mut.toJSON(), bio: bio.toJSON() }),
    load: (data, ctx) => {
      mut.load(data.mut);
      bio.load(data.bio, ctx.warn);
    },
    missing: () => {
      mut.load({ powered: [], base: [...p.traits] });
      bio.load({ bionics: [], power: 0, maxPower: 0 });
    },
  });

  if (api) installDebug(game, api, mods);
  /** Open the Autodoc screen as if you used one (the CBMs you carry or that lie near you). */
  if (api) api.openAutodoc = () => autodocScreen.open(game, mods, () => cbmsNearby(game), drop);
  return mods;
}

/** CBM items the player carries or that lie within 2 tiles (the Autodoc's hopper). */
function cbmsNearby(game: Game): { item: Item; consume: () => void }[] {
  const p = game.player;
  const out: { item: Item; consume: () => void }[] = [];
  const isCbm = (it: Item) => it.def.subtypes?.includes('BIONIC_ITEM');
  for (const it of p.inv.allItems()) if (isCbm(it)) out.push({ item: it, consume: () => void (p.inv.locOf(it) && consumeItem(it, p.inv.locOf(it)!, it.countByCharges ? 1 : undefined)) });
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const x = p.tileX + dx, y = p.tileY + dy;
      for (const mi of game.map.itemsAt(x, y, p.z)) {
        if (mi instanceof Item && isCbm(mi)) out.push({ item: mi, consume: () => void consumeItem(mi, L.ground(game.map, x, y, p.z), mi.countByCharges ? 1 : undefined) });
      }
    }
  return out;
}

/** Map items within `r` tiles of the survivor (the Autodoc's supplies). */
function itemsNear(game: Game, r: number): Item[] {
  const p = game.player;
  const out: Item[] = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) for (const mi of game.map.itemsAt(p.tileX + dx, p.tileY + dy, p.z)) if (mi instanceof Item) out.push(mi);
  return out;
}

/** The tiles within `r` of the survivor (where an Autodoc's hopper can reach). */
function nearTiles(game: Game, r: number): Loc[] {
  const p = game.player;
  const out: Loc[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out.push(L.ground(game.map, p.tileX + dx, p.tileY + dy, p.z));
  return out;
}

function installDebug(game: Game, api: DebugApi, mods: BodyMods): void {
  const { mut, bio } = mods;
  const p = game.player;
  /**
   * Mutate: a trait id mutates towards it (prerequisites first, like BN's debug menu); a
   * category id (LIZARD, ANY …) does one mutate_category step; no argument = one
   * Character::mutate (spends accumulated mutagen). Returns the mutations after.
   */
  api.mutate = (idOrCat?: string, n = 1) => {
    if (idOrCat && !mut.idx.categories.has(idOrCat) && mut.idx.def(idOrCat)) {
      // Keep stepping up the prerequisite chain until the trait is there (debug menu style);
      // stepping again once present would undo it (mutate_towards removes children).
      for (let i = 0; i < 12 && !p.hasTrait(idOrCat); i++) if (!mut.mutateTowards(idOrCat)) break;
      return api.mutations();
    }
    for (let i = 0; i < n; i++) {
      if (!idOrCat) mut.mutate();
      else if (mut.idx.categories.has(idOrCat)) mut.mutateCategory(idOrCat);
      else throw new Error(`cdda.mutate: unknown mutation or category ${idOrCat}`);
    }
    return api.mutations();
  };
  api.mutations = () => ({
    traits: [...p.traits].map((id) => ({ id, name: mut.name(id), visible: mut.idx.visible(id), powered: mut.isPowered(id), base: mut.isBase(id) })),
    accumulatedMutagenDays: (p.effects.get('accumulated_mutagen')?.duration ?? 0) / 86400,
    levels: Object.fromEntries(mut.categoryLevels()),
    threshold: mut.thresholdCategory(),
    threshTier: mut.threshTier,
  });
  /** Try crossing a category's threshold like an IV serum does (test_crossing_threshold). */
  api.crossThreshold = (cat: string, tier = 1) => mut.testCrossingThreshold(cat, tier);
  api.removeMutation = (id: string) => mut.removeMutation(id);
  api.toggleMutation = (id: string) => mut.toggle(id);
  /** Install without surgery (debug); `roll` < chance runs the real odds instead. */
  api.installBionic = (id: string, opts: { surgery?: boolean; autodoc?: boolean; roll?: number } = {}) => {
    if (!bio.def(id)) throw new Error(`cdda.installBionic: unknown bionic ${id}`);
    if (opts.surgery) return bio.install(id, { autodoc: opts.autodoc, roll: opts.roll });
    const blocker = bio.installBlocker(id);
    if (blocker) return { ok: false, messages: [blocker] };
    bio.add(id);
    return { ok: true, messages: [`Installed ${bio.name(id)}.`] };
  };
  api.bionics = () => ({
    power: +bio.power.toFixed(4),
    maxPower: bio.maxPower(),
    installed: bio.bionics.map((b) => ({ id: b.id, name: bio.name(b.id), powered: b.powered, included: !!b.included })),
  });
  api.givePower = (kj: number) => {
    bio.modPower(kj);
    return bio.power;
  };
  api.toggleBionic = (id: string) => (bio.toggle(id), bio.isActive(id));
  api.bionicChance = (itemId: string, autodoc = false) => bio.successChance(itemId, autodoc);
  api.spawnAutodoc = (dx = 2, dy = 0) => {
    const x = p.tileX + dx, y = p.tileY + dy;
    game.map.setFurn(x, y, p.z, 'f_autodoc');
    return { x, y };
  };
  api.giveCbm = (id: string) => (p.inv.giveNew(createItem(game.data, id)) ? `got ${id}` : `no room for ${id}`);
}
