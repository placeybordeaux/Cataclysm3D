import { c, confirm, openMenu, openWindow, colorize } from '../ui/framework';
import { durationText } from '../ui/format';
import type { SaveMeta } from './format';
import type { MemorialEntry, SaveManager } from './manager';

// Save-related screens, built from the shared UI framework: the Load slot list (CDDA's world
// + character picker folded into one list), the "save is damaged" dialog and the memorial.

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  return new Date(ms).toLocaleDateString();
}

const kb = (n?: number) => (n === undefined ? '?' : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);

/** Pick a save slot. Resolves the slot id, or null on Esc. `D` deletes the highlighted save. */
export function openLoadMenu(mgr: SaveManager): Promise<string | null> {
  return new Promise((resolve) => {
    let picked: string | null = null;
    const entries = () =>
      mgr.slots.map((m) => ({
        label: `${c('c_white', m.name)} ${c('c_dark_gray', `day ${m.day + 1}`)}`,
        value: m,
        detail: () => slotDetail(m),
      }));
    const win = openMenu<SaveMeta>({
      title: 'Load game',
      width: 'min(110ch, 94vw)',
      detailPane: true,
      footer: `${c('c_light_green', 'Enter')} load  ${c('c_light_green', 'D')} delete  ${c('c_light_green', 'Esc')} back`,
      entries: entries(),
      onKey: (e, cur) => {
        if (e.key !== 'D' || !cur) return false;
        void confirm(`Delete the save of <color_white>${cur.name}</color>?  <color_light_red>This cannot be undone.</color>`).then(async (yes) => {
          if (!yes) return;
          await mgr.delete(cur.slot);
          if (!mgr.slots.length) win.close();
          else win.refresh(entries());
        });
        return true;
      },
      onSelect: (m) => {
        picked = m.slot;
      },
      onClose: () => resolve(picked),
    });
  });
}

function slotDetail(m: SaveMeta): string {
  return colorize([
    `<color_white>${m.name}</color>`,
    m.profession ? `<color_light_gray>${m.profession}</color>` : '',
    '',
    `<color_light_gray>In game:</color> ${m.time}  (day ${m.day + 1})`,
    `<color_light_gray>Saved:</color> ${ago(m.savedAt)}`,
    `<color_light_gray>World:</color> ${m.seed}${m.gen !== 'world' ? ` (${m.gen})` : ''}`,
    `<color_light_gray>Size:</color> ${kb(m.bytes)}${m.rawBytes && m.bytes !== m.rawBytes ? ` <color_dark_gray>(${kb(m.rawBytes)} uncompressed)</color>` : ''}`,
  ].join('\n')).replace(/\n/g, '<br>');
}

/** A save that can't be loaded: explain, and offer to delete it. Resolves true if deleted. */
export function showLoadError(mgr: SaveManager, slot: string | null, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    let deleted = false;
    const w = openWindow({
      title: 'Cannot load save',
      width: 'min(70ch, 90vw)',
      footer: slot ? `${c('c_light_green', 'd')} delete this save  ${c('c_light_green', 'Esc')} back` : `${c('c_light_green', 'Esc')} back`,
      onKey: (e) => {
        if (e.key === 'd' && slot) {
          void mgr.delete(slot).then(() => {
            deleted = true;
            w.close();
          });
          return true;
        }
        if (e.key === 'Enter') w.close();
        return false;
      },
      onClose: () => resolve(deleted),
    });
    w.body.innerHTML = colorize(`<color_light_red>${message.replace(/</g, '&lt;')}</color>`);
    w.body.style.whiteSpace = 'pre-wrap';
  });
}

/** CDDA's memorial / hall of fame: every character who died, newest first. */
export async function openMemorial(mgr: SaveManager): Promise<void> {
  const list = (await mgr.memorial()).slice().reverse();
  openMenu<MemorialEntry | null>({
    title: 'Memorial',
    width: 'min(110ch, 94vw)',
    detailPane: list.length > 0,
    footer: c('c_light_green', 'Esc') + ' back',
    entries: list.length
      ? list.map((e) => ({
          label: `${c('c_white', e.name)} ${c('c_dark_gray', durationText(e.survived))}`,
          value: e,
          hotkey: '',
          detail: () => memorialDetail(e),
        }))
      : [{ label: c('c_dark_gray', 'Nobody has died yet.'), value: null, hotkey: '', disabled: true }],
    onSelect: () => false,
  });
}

function memorialDetail(e: MemorialEntry): string {
  const kills = e.topKills.map(([id, n]) => `  <color_white>${String(n).padStart(3)}</color> <color_light_gray>${e.killNames?.[id] ?? id}</color>`);
  return colorize([
    `<color_light_red>In memory of</color> <color_white>${e.name}</color>`,
    e.profession ? `<color_light_gray>${e.profession}${e.scenario ? ` · ${e.scenario}` : ''}</color>` : '',
    '',
    `<color_light_gray>Cause of death:</color> <color_red>${e.cause}</color>`,
    `<color_light_gray>Survived:</color> ${durationText(e.survived)}  <color_dark_gray>(${e.gameTime})</color>`,
    `<color_light_gray>Kills:</color> ${e.kills}`,
    ...(kills.length ? kills : ['  <color_dark_gray>A pacifist.</color>']),
    `<color_light_gray>Distance walked:</color> ${(e.distance / 1000).toFixed(2)} km`,
    ...(e.achievements?.length ? ['<color_light_gray>Achievements:</color>', ...e.achievements.map((n) => `  <color_light_green>${n}</color>`)] : []),
    `<color_dark_gray>Died ${new Date(e.diedAt).toLocaleString()}</color>`,
  ].join('\n')).replace(/\n/g, '<br>');
}
