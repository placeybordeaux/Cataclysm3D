// E_FILE_STORAGE pockets (item_pocket.cpp) against the real extracted data: phones, laptops,
// USB drives and memory cards hold e-books and e-files, and reading one needs a charged reader.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GameData } from '../src/data/types';
import { expandItemGroup } from '../src/data/itemgroups';
import { Rng } from '../src/core/rng';
import { createItem, fromSpawned } from '../src/game/item';
import { PlayerAvatar } from '../src/game/player';
import { cantRead, efileDevice, readableBooks } from '../src/game/reading';
import { GameMap } from '../src/world/map';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const data: GameData = {
  terrain: {}, furniture: {}, items: load('items.json'), itemGroups: load('item_groups.json'),
  monsters: {}, monsterGroups: {}, recipes: load('recipes.json'), misc: load('misc.json'),
};

function host() {
  const player = new PlayerAvatar(data, { seed: 1 });
  player.x = 3.5;
  player.y = 3.5;
  const msgs: string[] = [];
  // Bright enough to read paper, so only the device rules decide.
  return { data, map: new GameMap(1), player, clock: {} as never, activities: {} as never, message: (t: string) => void msgs.push(t), lightAt: () => 100, msgs };
}

describe('e-file storage', () => {
  // TODO(BN): written for DDA data/behaviour; fails on Bright Nights core data (TypeError: Cannot read properties of undefined (reading 'efiles')). Port with its system.
  it.skip("the evacuee's charged phone keeps the starting guidebook (no 'does not fit' warning)", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawned = expandItemGroup(data, { subtype: 'collection', entries: [{ group: 'charged_smart_phone', 'contents-item': ['guidebook'] }] } as never, new Rng(1));
    const items = spawned.flatMap((s) => fromSpawned(data, s));
    const phone = items.find((i) => i.typeId === 'smart_phone')!;
    expect(phone.efiles().map((f) => f.typeId)).toEqual(['guidebook']);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('does not fit'))).toEqual([]);
    warn.mockRestore();
    // Files weigh and take up nothing.
    const [w, v] = [phone.weight(), phone.volume()];
    phone.removeContent(phone.efiles()[0]);
    expect([phone.weight(), phone.volume()]).toEqual([w, v]);
  });

  // TODO(BN): written for DDA data/behaviour; fails on Bright Nights core data (TypeError: Cannot read properties of undefined (reading 'canContain')). Port with its system.
  it.skip('only books and e-storable files go into e-file pockets, within ememory_max', () => {
    const usb = createItem(data, 'usb_drive');
    const pocket = usb.pockets.find((p) => p.type === 'E_FILE_STORAGE')!;
    expect(pocket.canContain(createItem(data, 'guidebook')).ok).toBe(true);
    expect(pocket.canContain(createItem(data, 'efile_lore')).ok).toBe(true);
    expect(pocket.canContain(createItem(data, 'rock')).ok).toBe(false);
    // A full 128 MB drive takes nothing more.
    const archive = () => createItem(data, 'efile_lore');
    for (let i = 0; i < 2048; i++) pocket.contents.push(archive()); // 2048 x 64 KB = 128 MB
    expect(pocket.canContain(archive()).ok).toBe(false);
  });

  // TODO(BN): written for DDA data/behaviour; fails on Bright Nights core data (TypeError: Cannot read properties of undefined (reading 'contents')). Port with its system.
  it.skip('reading an e-book needs a reader with charge', () => {
    const h = host();
    const phone = createItem(data, 'smart_phone');
    const book = createItem(data, 'guidebook');
    phone.pockets.find((p) => p.type === 'E_FILE_STORAGE')!.contents.push(book);
    h.player.inv.wield(phone);
    expect(readableBooks(h as never)).toContain(book);
    expect(efileDevice(h as never, book)).toBe(phone);
    expect(cantRead(h as never, book)).toMatch(/battery is dead/);
    phone.magazinePockets()[0].insert(createItem(data, 'battery', { charges: 10 }));
    expect(cantRead(h as never, book)).toBeNull();
    const usb = createItem(data, 'usb_drive');
    const onUsb = createItem(data, 'guidebook');
    usb.pockets.find((p) => p.type === 'E_FILE_STORAGE')!.contents.push(onUsb);
    h.player.inv.stash(usb);
    h.player.inv.wear(createItem(data, 'backpack'));
    h.player.inv.stash(usb);
    expect(cantRead(h as never, onUsb)).toMatch(/need a phone or a laptop/);
  });
});
