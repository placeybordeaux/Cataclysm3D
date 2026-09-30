import type { Game } from './game/game';
import type { Renderer } from './render/renderer';
import type { DebugApi } from './debug';
import type { MonstersHandle } from './monsters';
import type { Character } from './game/character';
import { createItem, defaultLoad, loadAmmo, type Item } from './game/item';
import { L, spawnOnGround } from './game/moves';
import { aimState, dispersionBreakdown, meleeHooks } from './game/combat';
import { drawStyle, effectiveRange, strDrawRangeMod } from './game/rangedfeel';
import { FEEL } from './game/combatfeel';
import { freeAim, timingGames } from './game/aimmodel';
import { modSum } from './game/gunmods';
import { bodyMods } from './game/bodymods';
import {
  activeBuffSummary, autolearnStyles, currentStyle, learnStyle, maOf, maWorld, selectStyle, styleBuffs, styleDef, styleWeaponValid,
  traitStyleChoices, BUFF_TRIGGERS, type MartialArtDef, type MartialArtsJSON,
} from './game/martialarts';
import { availableTechniques, blockHooks, combatHooks, pickTechnique, techniqueDef, type TechniqueDef } from './game/techniques';
import {
  clearJam, currentMode, cycleMode, gunModes, gunmodCompatible, gunmodSkillShortfall, installGunmod, installSeconds, isGunmod, isJammed,
  modLocations, removableReason, removeGunmod,
} from './game/gunmods';
import { monsterTargetInfo } from './game/playercombat';
import { explode } from './game/explosion';
import { monGunState, monsterGunHooks } from './game/monguns';
import { addField, ignite } from './game/fields';
import { readHooks } from './game/reading';
import { registerSaveable } from './save/registry';
import { hud } from './ui/hud';
import { c, colorize, cssColor, getUiRoot, openMenu, type MenuEntry } from './ui/framework';
import { extraItemActions } from './ui/inventory_ui';
import { cddaText } from './game/units';
import { warnOnce } from './data/warn';

// Wiring for combat depth (techniques, blocking, martial arts, gunmods, fire modes): keys
// (`_` martial arts, `b` fire mode), the martial arts menu, gunmod install/remove in the item
// menu, HUD style/mode line and the aim-level readout by the crosshair, the viewmodel block
// pose, weapon-break spills, ammo-effect world hooks, the martial-arts save section and
// window.cdda helpers. The rules themselves live in src/game/{techniques,martialarts,gunmods}.ts.

export function installCombatDepth(game: Game, renderer: Renderer | null, monsters: MonstersHandle, api?: DebugApi): void {
  const p = game.player;
  const combat = monsters.combat;

  // --- hooks from the pure combat code into the world
  combatHooks.onBlock = (who) => {
    if (who === p) renderer?.viewmodel?.block();
  };
  // BN melee needs a little of the world: wall_adjacent techniques (map::is_wall_adjacent:
  // any impassable neighbour), powered mutations (NEED_ACTIVE_TO_MELEE claws) and bionics
  // (razors, arm/leg-armor blocks).
  maWorld.wallAdjacent = (who) => {
    const pos = who as unknown as { x: number; y: number; z: number };
    const x = Math.floor(pos.x), y = Math.floor(pos.y);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && !game.map.passable(x + dx, y + dy, pos.z)) return true;
    return false;
  };
  meleeHooks.mutationActive = (who, id) => bodyMods(who)?.mut.isPowered(id) ?? false;
  meleeHooks.hasBionic = (who, id) => bodyMods(who)?.bio.has(id) ?? false;
  blockHooks.hasBionic = meleeHooks.hasBionic;
  combat.hooks = {
    ignite: (x, y, z) => void ignite(game, x, y, z, 1),
    addField: (x, y, z, type, n) => {
      try {
        addField(game, x, y, z, type, n);
      } catch {
        warnOnce('field', type);
      }
    },
    explode: (x, y, z, power, factor, fire) => void explode(game, monsters.sys, x, y, z, power, factor, fire),
  };

  // Monster guns draw their bullet lines with the survivor's tracers; DROPS_AMMO monsters
  // (turrets, secubots) leave their unspent ammo behind.
  monsterGunHooks.tracer = (x0, y0, x1, y1, z) => void combat.tracers.push({ x0, y0, x1, y1, z, t: 0.08 });
  monsters.sys.onDied.push((m) => {
    if (!m.has('DROPS_AMMO')) return;
    for (const [id, n] of Object.entries(monGunState(m).ammo)) {
      if (n <= 0 || !game.data.items[id]) continue;
      spawnOnGround(game.map, m.tileX, m.tileY, m.z, createItem(game.data, id, { count: n }));
    }
  });

  // --- learning styles: manuals (read or activate), autolearn (Brawling), trait choices
  const learnFromManual = (who: Character, it: Item): boolean => {
    const id = it.def.martial_art;
    if (typeof id !== 'string') return false;
    return learnStyle(who, id);
  };
  readHooks.push((who, it) => void learnFromManual(who, it));
  p.inv.useHandlers.set('MA_MANUAL', (it) => {
    const ok = learnFromManual(p, it);
    return { ok, msg: ok ? '' : `You can't learn anything new from ${cddaText(it.def.name)}.`, moves: ok ? 100 : 0 };
  });
  let learnT = 0;
  game.systems.push({
    name: 'martial-arts-autolearn',
    update(_g, dt) {
      if ((learnT -= dt) > 0) return;
      learnT = 3;
      for (const id of autolearnStyles(p)) game.message(`You have learned a new style: ${styleDef(game.data, id)?.name ?? id}!`, 'c_light_blue');
    },
  });

  // --- save: the survivor's known styles, current style and running buffs
  registerSaveable<MartialArtsJSON>(game, 'martialarts', {
    order: 12,
    save: () => maOf(p).toJSON(),
    load: (j, ctx) => maOf(p).load(j, ctx.warn),
    missing: () => maOf(p).load({ known: ['style_none'], style: 'style_none' }),
  });

  // --- keys
  game.keys.register('martial_arts', 'Martial arts style', () => openMartialArtsMenu(game));
  game.keys.register('fire_mode', 'Select fire mode', () => {
    const g = p.inv.wielded;
    if (!g?.isGun()) return game.message("You're not wielding a firearm.");
    const modes = gunModes(g);
    if (modes.length <= 1) return game.message(`Your ${g.baseName()} has only one firing mode.`);
    const m = cycleMode(g);
    game.message(`Your ${g.baseName()} is set to ${m.name}${m.qty > 1 ? ` (${m.qty} rounds)` : ''}.`);
  });
  // Clearing a jam: reload (CDDA: fix the fault via the gun's action menu / reload).
  const reload = game.keys.handler('reload');
  if (reload) {
    game.keys.register('reload', 'Reload / clear jam', () => {
      const g = p.inv.wielded;
      if (g?.isGun() && isJammed(g)) {
        clearJam(g);
        game.message(`You clear the jam in your ${g.baseName()}.`);
        combat.cooldown = Math.max(combat.cooldown, 1);
        return;
      }
      reload();
    });
  }

  // --- gunmods in the item action menu
  extraItemActions.push(
    {
      key: 'M',
      label: (e) => (isGunmod(e.item) ? 'Attach to a gun' : 'Attach a gunmod'),
      ok: (e) => (isGunmod(e.item) && e.where !== 'ground') || (e.item.isGun() && candidateMods(game, e.item).length > 0),
      run: (_ctx, e) => (isGunmod(e.item) ? pickGunFor(game, e.item) : pickModFor(game, e.item)),
    },
    {
      key: 'O',
      label: () => 'Remove a gunmod',
      ok: (e) => e.item.isGun() && e.item.gunmods.length > 0 && e.where !== 'ground',
      run: (_ctx, e) => openRemoveMods(game, e.item),
    },
  );

  // --- HUD: style + buffs, fire mode / jam, aim level near the crosshair
  hud.addSidebarProvider(() => {
    const L: string[] = [];
    const st = currentStyle(p);
    const w = p.inv.wielded;
    const bad = !styleWeaponValid(st, w);
    L.push(`${c('c_light_gray', 'Style:')} ${c(bad ? 'c_dark_gray' : st.id === 'style_none' ? 'c_light_gray' : 'c_light_blue', st.name)}`);
    const buffs = activeBuffSummary(p);
    if (buffs.length) L.push(c('c_light_green', ' ' + buffs.map((b) => (b.stacks > 1 ? `${b.name} ×${b.stacks}` : b.name)).join(', ')));
    if (w?.isGun()) {
      const m = currentMode(w);
      L.push(`${c('c_light_gray', 'Mode:')} ${c('c_white', m.name)}${m.qty > 1 ? c('c_light_gray', ` (${m.qty})`) : ''}${isJammed(w) ? '  ' + c('c_red', 'JAMMED') : ''}`);
    }
    return L;
  });
  if (renderer) {
    const el = document.createElement('div');
    el.className = 'aim-level';
    Object.assign(el.style, {
      position: 'absolute', left: '50%', top: 'calc(50% + 18px)', transform: 'translateX(-50%)', pointerEvents: 'none',
      font: 'inherit', fontSize: '15px', textShadow: '1px 1px 0 #000', whiteSpace: 'nowrap', display: 'none', zIndex: '5',
      background: 'rgba(0,0,0,0.55)', padding: '0 5px',
    });
    getUiRoot().appendChild(el);
    let t = 0;
    let last = '';
    game.systems.push({
      name: 'aim-level-readout',
      update(_g, dt) {
        if ((t -= dt) > 0) return;
        t = 0.1;
        const w = p.inv.wielded;
        let html = '';
        if (w?.isGun() && renderer.cameraMode !== 'top' && !game.input.captured) {
          const aiming = (game.input.mouseButtons & 4) !== 0;
          const lvl = aimState(p, w);
          const col = { Immediate: 'c_light_gray', Regular: 'c_yellow', Careful: 'c_light_green', Precise: 'c_light_cyan' }[lvl];
          const style = drawStyle(w);
          const d = combat.draw;
          const parts: string[] = [];
          // Bows: the draw comes first (aim only builds at full draw), then the aim level.
          const free = freeAim();
          if (style !== 'trigger' && d && d.t < d.full) parts.push(`<span style="color:${cssColor('c_yellow')}">${style === 'whirl' ? 'Whirling…' : 'Drawing…'}</span>`);
          // Free aim: no aim levels (the reticle's weave shows how steady you are); the timing
          // model names the breath instead.
          else if (free) {
            if (timingGames() && aiming && style === 'trigger') {
              const st = combat.breath.state(combat.aimSkill(w), p.stamina / Math.max(1, p.staminaMax()));
              const [txt, bc] = ({
                none: ['[Shift] hold breath', 'c_light_gray'], settling: ['holding breath…', 'c_light_cyan'], perfect: ['NOW', 'c_yellow'],
                steady: ['steady', 'c_light_cyan'], straining: ['can’t hold it!', 'c_light_red'], recovering: ['catching breath', 'c_dark_gray'],
              } as Record<string, [string, string]>)[st];
              parts.push(`<span style="color:${cssColor(bc)}">${txt}</span>`);
            }
          } else if (aiming || lvl !== 'Immediate' || d) parts.push(`<span style="color:${cssColor(col)}">${lvl}</span>`);
          if (d && d.style === 'draw' && d.t >= d.full && d.heldFull > FEEL.drawHoldSteady) parts.push(`<span style="color:${cssColor('c_light_red')}">arms shaking</span>`);
          // Distance to what's under the crosshair against the range and the distance at which
          // your current spread still lands on a body (rangedfeel.effectiveRange).
          if (aiming || d) {
            const t = combat.rangedTarget(60);
            if (t) {
              const range = Math.max(1, gunRange(w, p));
              const eff = effectiveRange(dispersionBreakdown(p, w), t.m.radius);
              const far = t.dist > range ? 'c_light_red' : free ? 'c_light_gray' : t.dist > eff ? 'c_yellow' : 'c_light_green';
              const effTxt = t.dist > range ? `out of range (${Math.round(range)} m)` : free ? '' : `likely hit ≤ ${eff >= 99 ? '99+' : Math.max(1, Math.round(eff))} m`;
              parts.push(`<span style="color:${cssColor(far)}">${Math.round(t.dist)} m${effTxt ? ` · ${effTxt}` : ''}</span>`);
            }
          }
          html = parts.join(' ');
          if (isJammed(w)) html += ` <span style="color:${cssColor('c_red')}">JAMMED</span>`;
        }
        if (html !== last) {
          last = html;
          el.innerHTML = html;
          el.style.display = html ? '' : 'none';
        }
      },
    });
  }

  if (api) installDebug(api, game, monsters);
}

/** A gun's range with what it has loaded (or would nock), as fireGun computes it, in tiles. */
function gunRange(w: Item, p: Character): number {
  // An empty bow has no ammo data: arrows add no range of their own, so the bow's is right.
  const ammo = w.ammoData();
  return ((ammo?.range ?? 0) + (w.def.range ?? 0) + modSum(w, 'range_modifier')) * strDrawRangeMod(w, p) || 30;
}

// ------------------------------------------------------------------ martial arts menu

function styleDetail(game: Game, st: MartialArtDef): string {
  const p = game.player;
  const out: string[] = [];
  out.push(`<div style="color:${cssColor('c_white')}">${colorize(st.name)}</div>`);
  if (st.description) out.push(`<div style="margin:4px 0">${colorize(cddaText(st.description))}</div>`);
  const w = p.inv.wielded;
  if (w && !styleWeaponValid(st, w)) out.push(`<div style="color:${cssColor('c_yellow')}">Can't be used with your ${w.baseName()}.</div>`);
  const weapons = [...(st.weapon_category ?? []).map((cat) => (game.data.misc?.weapon_category?.[cat]?.name as string | undefined) ?? cat)];
  if (st.allow_melee) out.push(`<div style="color:${cssColor('c_light_gray')}">Usable with any weapon.</div>`);
  else if (weapons.length) out.push(`<div style="color:${cssColor('c_light_gray')}">Weapons: ${weapons.join(', ')}</div>`);
  const buffs: string[] = [];
  for (const t of BUFF_TRIGGERS) for (const b of styleBuffs(game.data, st, t)) buffs.push(`${c('c_light_green', b.name)} ${c('c_dark_gray', `(${t === 'static' ? 'passive' : t})`)}`);
  if (buffs.length) out.push(`<div style="margin-top:4px">${c('c_white', 'Buffs:')}<br>${buffs.join('<br>')}</div>`);
  const tecs: string[] = [];
  for (const id of st.techniques ?? []) {
    const t = techniqueDef(game.data, id);
    if (!t) continue;
    const req = (t.skill_requirements ?? []).map((s) => `${p.skillName(s.name)} ${s.level}`).join(', ');
    const met = (t.skill_requirements ?? []).every((s) => p.getSkill(s.name) >= s.level);
    tecs.push(`${c('c_light_blue', t.name)}${req ? c(met ? 'c_dark_gray' : 'c_red', ` [${req}]`) : ''}`);
  }
  if (tecs.length) out.push(`<div style="margin-top:4px">${c('c_white', 'Techniques:')}<br>${tecs.join('<br>')}</div>`);
  return out.join('');
}

export function openMartialArtsMenu(game: Game): void {
  const p = game.player;
  const ma = maOf(p);
  type V = { kind: 'select' | 'learn'; id: string };
  const entries: MenuEntry<V>[] = [];
  const known = [...ma.known].map((id) => styleDef(game.data, id)).filter((s): s is MartialArtDef => !!s);
  // "No style" first, then alphabetical like CDDA's list.
  known.sort((a, b) => (a.id === 'style_none' ? -1 : b.id === 'style_none' ? 1 : a.name.localeCompare(b.name)));
  for (const st of known) {
    const cur = st.id === ma.style;
    entries.push({
      label: `${c(cur ? 'c_light_green' : 'c_white', st.name)}${cur ? c('c_light_gray', '  (active)') : ''}`,
      value: { kind: 'select', id: st.id },
      header: 'Known styles',
      detail: () => styleDetail(game, st),
    });
  }
  for (const id of traitStyleChoices(p)) {
    const st = styleDef(game.data, id);
    if (!st) continue;
    entries.push({ label: c('c_yellow', st.name), value: { kind: 'learn', id }, header: 'Training: learn one style', detail: () => styleDetail(game, st) });
  }
  openMenu<V>({
    title: 'Select a style.',
    width: 'min(110ch, 94vw)',
    detailPane: true,
    entries,
    onSelect: (v) => {
      if (v.kind === 'learn') {
        learnStyle(p, v.id);
        selectStyle(p, v.id);
        return;
      }
      if (v.id === ma.style) return;
      selectStyle(p, v.id);
    },
  });
}

// ------------------------------------------------------------------ gunmods UI

function candidateMods(game: Game, gun: Item): Item[] {
  return game.player.inv.carried().flatMap((i) => [...i.walk()]).filter((m) => isGunmod(m) && m !== gun && gunmodCompatible(gun, m).ok);
}

function startInstall(game: Game, gun: Item, mod: Item): void {
  const p = game.player;
  const why = gunmodCompatible(gun, mod);
  if (!why.ok) return game.message(`Your ${gun.baseName()} ${why.reason}.`, 'c_light_red');
  const skill = gunmodSkillShortfall(p, gun, mod);
  if (skill) return game.message(skill, 'c_light_red');
  game.activities.start({
    name: `installing ${mod.baseName()}`,
    duration: installSeconds(mod),
    onComplete: () => {
      const from = p.inv.locOf(mod);
      if (!from || !p.inv.has(gun)) return game.message('You no longer have what you needed.');
      const r = installGunmod(p, gun, mod, from);
      if (!r.ok) game.message(r.msg, 'c_light_red');
    },
  });
}

function pickModFor(game: Game, gun: Item): void {
  const mods = candidateMods(game, gun).sort((a, b) => String(a.def.location).localeCompare(String(b.def.location)) || a.name().localeCompare(b.name()));
  if (!mods.length) return game.message(`You don't have any gunmods for your ${gun.baseName()}.`);
  openMenu<Item>({
    title: `Attach which mod to your ${gun.baseName()}?`,
    width: 'min(96ch, 94vw)',
    detailPane: true,
    entries: mods.map((m) => ({ label: m.name(), value: m, header: String(m.def.location ?? ''), detail: () => gunmodDetail(game, m, gun) })),
    onSelect: (m) => {
      setTimeout(() => startInstall(game, gun, m), 0);
    },
  });
}

function pickGunFor(game: Game, mod: Item): void {
  const p = game.player;
  const guns = [p.inv.wielded, ...p.inv.carried().flatMap((i) => [...i.walk()])].filter((g): g is Item => !!g && g.isGun() && g !== mod);
  if (!guns.length) return game.message("You don't have a gun to mod.");
  openMenu<Item>({
    title: `Attach the ${mod.baseName()} to which gun?`,
    width: 'min(96ch, 94vw)',
    detailPane: true,
    entries: guns.map((g) => {
      const ok = gunmodCompatible(g, mod);
      return { label: ok.ok ? g.name() : `${c('c_dark_gray', g.name())} ${c('c_red', ok.reason ?? '')}`, value: g, disabled: !ok.ok, detail: () => gunmodDetail(game, mod, g) };
    }),
    onSelect: (g) => {
      setTimeout(() => startInstall(game, g, mod), 0);
    },
  });
}

function openRemoveMods(game: Game, gun: Item): void {
  const p = game.player;
  openMenu<Item>({
    title: `Remove which mod from your ${gun.baseName()}?`,
    entries: gun.gunmods.map((m) => {
      const why = removableReason(gun, m);
      return { label: why ? `${c('c_dark_gray', m.name())} ${c('c_red', why)}` : m.name(), value: m, disabled: !!why, header: String(m.def.location ?? '') };
    }),
    onSelect: (m) => {
      const ground = p.inv.groundHere();
      const r = removeGunmod(p, gun, m, ground ? [L.inv(p), ground] : [L.inv(p)]);
      if (!r.ok) return void game.message(r.msg, 'c_light_red');
    },
  });
}

function gunmodDetail(game: Game, mod: Item, gun: Item): string {
  const d = mod.def;
  const L: string[] = [c('c_white', mod.baseName()), `${c('c_light_gray', 'Location:')} ${c('c_white', String(d.location ?? '?'))}`];
  const stat = (label: string, v: unknown, good: 'low' | 'high') => {
    if (typeof v !== 'number' || v === 0) return;
    const better = good === 'low' ? v < 0 : v > 0;
    L.push(`${c('c_light_gray', label)} ${c(better ? 'c_light_green' : 'c_light_red', (v > 0 ? '+' : '') + v)}`);
  };
  stat('Dispersion:', d.dispersion_modifier, 'low');
  stat('Handling:', d.handling_modifier, 'high');
  stat('Loudness:', d.loudness_modifier, 'low');
  if (typeof d.loudness_multiplier === 'number') L.push(`${c('c_light_gray', 'Loudness ×')}${c(d.loudness_multiplier < 1 ? 'c_light_green' : 'c_light_red', String(d.loudness_multiplier))}`);
  if (typeof d.sight_dispersion === 'number') L.push(`${c('c_light_gray', 'Sight dispersion:')} ${c('c_white', String(d.sight_dispersion))}`);
  if (typeof d.aim_speed_modifier === 'number') stat('Aim speed:', d.aim_speed_modifier, 'high');
  const need = gunmodSkillShortfall(game.player, gun, mod);
  if (need) L.push(c('c_red', need));
  const slots = [...modLocations(gun)].map(([loc, n]) => `${loc} ${gun.gunmods.filter((m) => m.def.location === loc).length}/${n}`);
  L.push(`${c('c_light_gray', 'Slots on ' + gun.baseName() + ':')}<br>${c('c_dark_gray', slots.join(', '))}`);
  const secs = installSeconds(mod);
  L.push(c('c_light_gray', `Takes ${secs < 60 ? `${secs} seconds` : `${Math.round(secs / 60)} minutes`} to install.`));
  return L.map((l) => `<div>${l}</div>`).join('');
}

// ------------------------------------------------------------------ debug

function installDebug(api: DebugApi, game: Game, monsters: MonstersHandle): void {
  const p = () => game.player;
  /** Learn a martial art style by id (e.g. 'style_karate'). */
  api.learnStyle = (id: string) => learnStyle(p(), id);
  /** Switch style (learning it first if needed). */
  api.setStyle = (id: string) => {
    if (!maOf(p()).known.has(id)) learnStyle(p(), id, true);
    return selectStyle(p(), id);
  };
  api.martialArts = () => {
    const ma = maOf(p());
    return { style: ma.style, known: [...ma.known], buffs: activeBuffSummary(p()), dodgesLeft: ma.dodgesLeft, blocksLeft: ma.blocksLeft };
  };
  api.openMartialArts = () => openMartialArtsMenu(game);
  /** Techniques available with the wielded weapon/style, and which one a hit on the nearest monster would use now. */
  api.techniques = (crit = false) => {
    const w = p().inv.wielded;
    const list = availableTechniques(p(), w);
    const m = monsters.sys.active.filter((x) => !x.dead).sort((a, b) => monsters.sys.distToPlayer(a) - monsters.sys.distToPlayer(b))[0];
    const pick = m ? pickTechnique(p(), monsterTargetInfo(m), w, { crit, aoeTargets: (k) => monsters.combat.aoeVictims(k, m).length }, monsters.sys.rng) : null;
    return { weapon: w?.typeId ?? null, techniques: list.map((t: TechniqueDef) => ({ id: t.id, name: t.name, crit: !!t.crit_tec, dummy: !!t.dummy })), wouldUse: pick?.id ?? null };
  };
  api.fireMode = () => {
    const g = p().inv.wielded;
    if (!g?.isGun()) return null;
    const m = currentMode(g);
    return { id: m.id, name: m.name, qty: m.qty, modes: gunModes(g).map((x) => x.id), jammed: isJammed(g) };
  };
  api.cycleFireMode = () => {
    const g = p().inv.wielded;
    return g?.isGun() ? cycleMode(g).id : null;
  };
  /**
   * Install a gunmod instantly: installGunmod(modId) on the wielded gun, or
   * installGunmod(gunId, modId) to wield a fresh loaded `gunId` first.
   */
  api.installGunmod = (a: string, b?: string) => {
    const modId = b ?? a;
    if (b) {
      const gun = createItem(game.data, a);
      const ammo = defaultLoad(gun);
      if (ammo) loadAmmo(gun, ammo);
      p().inv.wield(gun, null);
    }
    const gun = p().inv.wielded;
    if (!gun?.isGun()) return 'not wielding a gun';
    const r = installGunmod(p(), gun, createItem(game.data, modId), null);
    return r.msg;
  };
  api.openGunmods = () => {
    const g = p().inv.wielded;
    if (g?.isGun()) pickModFor(game, g);
  };
  api.aimState = () => {
    const g = p().inv.wielded;
    return g?.isGun() ? { level: aimState(p(), g), recoil: Math.round(p().recoil) } : null;
  };
}

