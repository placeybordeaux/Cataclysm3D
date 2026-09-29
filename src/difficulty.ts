import type { Game } from './game/game';
import type { DebugApi } from './debug';
import type { Spawner } from './game/spawner';
import {
  applyDifficultySettings, difficultyState, DIFFICULTY_PRESETS, formatKnob, cycleKnob, KNOBS, matchingPreset, registerDifficultyTargets,
  settingsFor, storeCustom, storedCustom, validateSettings, type DifficultySettings, type DifficultyState, type Knob,
} from './game/difficulty';
import { DIFFICULTIES, customRulesEditor, difficultyHooks, preferredDifficulty, type Difficulty } from './progression/difficulty';
import { progressionOf } from './progression/registry';
import { registerSaveable } from './save/registry';
import { c, openMenu, type MenuEntry, type UiWindow } from './ui/framework';
import { registerOption } from './ui/options';
import { settings as ui2Settings, saveSettings as saveUi2Settings } from './ui2/host';

// Wiring for the difficulty presets (src/game/difficulty.ts): who the knobs reach (spawner,
// ui2 pause setting), the new-game hook from src/progression, the per-world save section, the
// Options > Difficulty screen (view a preset, edit Custom) and window.cdda helpers.
// main.ts calls installDifficulty once, after installMonsters and before installProgression.

export function installDifficulty(game: Game, o: { spawner: Spawner | null; api?: DebugApi }): void {
  registerDifficultyTargets(game, {
    spawner: o.spawner ?? undefined,
    setPauseInInventory: (on) => {
      if (ui2Settings.pauseInInventory === on) return;
      ui2Settings.pauseInInventory = on;
      saveUi2Settings();
    },
  });
  // Until a new game or a save says otherwise (the title screen's backdrop world, automation
  // that never picks): the preset the player picked last.
  const pref = preferredDifficulty();
  applyDifficultySettings(game, pref, settingsFor(pref));

  // A loaded world's own `difficulty` section is the authority (it holds Custom's values and
  // any change made in Options mid-run); progression's hook fires later in the same load.
  let loadedThisPass = false;
  difficultyHooks.push((d, g) => {
    if (g !== game) return;
    const st = difficultyState(game);
    if (loadedThisPass && st) {
      loadedThisPass = false;
      return applyDifficultySettings(game, st.preset, st.settings);
    }
    applyDifficultySettings(game, d, settingsFor(d));
  });
  game.events.on('gameLoaded', () => void (loadedThisPass = false));

  registerSaveable<DifficultyState>(game, 'difficulty', {
    order: 18,
    save: () => difficultyState(game)!,
    load: (j, ctx) => {
      let settings: DifficultySettings;
      if (j.preset === 'accessible' || j.preset === 'classic') {
        // A named preset means "these rules as the game defines them now": retuning a preset
        // reaches existing worlds too. Only Custom keeps its own numbers.
        settings = settingsFor(j.preset);
      } else {
        try {
          // Knobs added after this save was written start at Accessible's value.
          const saved = Object.fromEntries(Object.entries(j.settings ?? {}).filter(([, v]) => v !== undefined));
          settings = validateSettings({ ...settingsFor('accessible'), ...saved });
        } catch (e) {
          // A damaged section: say so, fall back to Accessible.
          ctx.warn(`${(e as Error).message}; using the Accessible rules`);
          settings = settingsFor('accessible');
        }
      }
      applyDifficultySettings(game, j.preset, settings);
      loadedThisPass = true;
    },
    // Saves from before presets existed keep what the boot applied (the player's preference);
    // progression's section (if any) re-applies its choice after this.
  });

  customRulesEditor.open = (onClose) => void openDifficultyEditor(game, 'template', onClose);
  registerOption({
    name: 'Difficulty…',
    value: () => presetName(difficultyState(game)?.preset ?? 'accessible'),
    change: () => void openDifficultyEditor(game, 'game'),
    desc: 'The rules of this world: spawns, monster speed, needs, healing, cold, day length, pausing and permadeath.  Accessible and Classic are fixed presets; change any rule and the world becomes Custom.',
  });

  if (o.api)
    Object.assign(o.api, {
      difficulty: () => difficultyState(game),
      setDifficulty: (d: Difficulty, overrides: Partial<DifficultySettings> = {}) => {
        const s = { ...settingsFor(d), ...overrides };
        setWorldDifficulty(game, matchingPreset(s) === d ? d : 'custom', s);
        return difficultyState(game);
      },
      openDifficulty: () => openDifficultyEditor(game, 'game'),
      difficultyPresets: () => DIFFICULTY_PRESETS,
    });
}

function presetName(d: Difficulty): string {
  return DIFFICULTIES.find((x) => x.id === d)?.name ?? d;
}

/** Change this world's rules mid-run (Options), keeping progression's run record in step. */
export function setWorldDifficulty(game: Game, preset: Difficulty, settings: DifficultySettings): void {
  applyDifficultySettings(game, preset, settings);
  if (preset === 'custom') storeCustom(settings);
  const prog = progressionOf(game);
  if (prog) prog.run.difficulty = preset;
}

/**
 * The Difficulty screen. 'game' edits this world's rules (live); 'template' edits the Custom
 * rules a new Custom game starts with (the new-game flow's "Edit rules" button).
 */
export function openDifficultyEditor(game: Game, mode: 'game' | 'template', onClose?: () => void): UiWindow {
  type Row = { kind: 'preset' } | { kind: 'knob'; knob: Knob };
  const cur = (): DifficultyState =>
    mode === 'game' ? difficultyState(game) ?? { preset: 'accessible', settings: settingsFor('accessible') } : { preset: 'custom', settings: storedCustom() };
  const set = (preset: Difficulty, s: DifficultySettings) => {
    if (mode === 'game') setWorldDifficulty(game, preset, s);
    else storeCustom(s);
  };
  const presetColor = (d: Difficulty) => (d === 'accessible' ? 'c_light_green' : d === 'classic' ? 'c_light_red' : 'c_yellow');
  const entries = (): MenuEntry<Row>[] => {
    const st = cur();
    const out: MenuEntry<Row>[] = [];
    if (mode === 'game')
      out.push({
        label: `${'Preset'.padEnd(26)} ${c('c_dark_gray', '<')} ${c(presetColor(st.preset), presetName(st.preset).padEnd(10))} ${c('c_dark_gray', '>')}`,
        value: { kind: 'preset' },
        header: 'Preset',
        detail: () => `${DIFFICULTIES.find((x) => x.id === st.preset)?.desc ?? ''}\n\nChanging any rule below makes this world Custom.  Spawn rules apply to places you haven't visited yet.`,
      });
    for (const k of KNOBS) {
      const v = st.settings[k.key];
      const base = DIFFICULTY_PRESETS.classic[k.key];
      const col = v === base ? 'c_white' : 'c_light_cyan';
      out.push({
        label: `${k.name.padEnd(26)} ${c('c_dark_gray', '<')} ${c(col, formatKnob(k, v).padEnd(10))} ${c('c_dark_gray', '>')}`,
        value: { kind: 'knob', knob: k },
        header: k.group,
        detail: () =>
          `${k.desc}${k.newAreasOnly ? '\n\nApplies to places generated from now on.' : ''}\n\n` +
          `Accessible: ${formatKnob(k, DIFFICULTY_PRESETS.accessible[k.key])}   Classic: ${formatKnob(k, DIFFICULTY_PRESETS.classic[k.key])}`,
      });
    }
    return out;
  };
  const change = (row: Row, dir: 1 | -1) => {
    const st = cur();
    if (row.kind === 'preset') {
      const order: Difficulty[] = ['accessible', 'classic', 'custom'];
      const next = order[(order.indexOf(st.preset) + dir + order.length) % order.length];
      set(next, settingsFor(next));
      return;
    }
    const s = { ...st.settings, [row.knob.key]: cycleKnob(row.knob, st.settings[row.knob.key], dir) } as DifficultySettings;
    set(mode === 'game' ? matchingPreset(s) : 'custom', s);
  };
  const win = openMenu<Row>({
    title: mode === 'game' ? 'Difficulty' : 'Custom rules (new games)',
    width: 'min(96ch, 94vw)',
    detailPane: true,
    footer: `${c('c_light_green', '←→')}/${c('c_light_green', 'Enter')} change`,
    closeLabel: 'done',
    onClose,
    entries: entries(),
    onKey: (e, row) => {
      if (!row) return false;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        change(row, e.key === 'ArrowLeft' ? -1 : 1);
        win.refresh(entries());
        return true;
      }
      return false;
    },
    onSelect: (row) => {
      change(row, 1);
      win.refresh(entries());
      return false;
    },
  });
  return win;
}
