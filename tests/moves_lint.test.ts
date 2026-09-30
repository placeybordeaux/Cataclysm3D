import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Conservation holds because every change of an item's place goes through src/game/moves.ts
// (see docs/INVENTORY_MODEL.md). TypeScript already stops most bypasses (Inventory's lists
// and Item's slots are read-only views); this test catches the rest by reading the source:
// raw slot access, direct map item edits and hand-rolled edits of cargo/stock lists.

const SRC = path.join(__dirname, '../src');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(SRC, p).replaceAll(path.sep, '/');

interface Rule {
  what: string;
  re: RegExp;
  /** files (relative to src/) allowed to do it, and why */
  allowed: Record<string, string>;
}

const RULES: Rule[] = [
  {
    what: "an Item's raw slots (_contents, _magazine, _gunmods, _split)",
    re: /\._(contents|magazine|gunmods|split)\b/,
    allowed: { 'game/item.ts': 'the item itself: factories, fromJSON, splitting', 'game/moves.ts': 'the move API' },
  },
  {
    what: 'map item lists (addItem / removeItem / insertItemAt)',
    // (localStorage.removeItem and the save backend's put/remove are not items)
    re: /(?<!localStorage)\.(addItem|removeItem|insertItemAt)\(/,
    allowed: {
      'game/moves.ts': 'the move API',
      'world/': 'the map itself and mapgen placements (spawn descriptions, turned into items by GameMap.itemFactory)',
      'save/': 'save slots and chunk loading',
      'ui2/mock/data.ts': 'the UI toolkit mock (no game items)',
    },
  },
  {
    what: "an NPC shop's stock, vehicle cargo or a monster's stuck arrows edited by hand",
    re: /\b(stock|cargo\.items|part\.items|p\.items|stuck\.items)\.(push|splice|pop|shift|unshift)\(|\b(cargo|part)\.items\s*=[^=]/,
    allowed: { 'game/npc.ts': 'a new NPC stocks its shelf (creation)' },
  },
  {
    what: 'inventory slot registration',
    re: /registerInventorySlots\(/,
    allowed: { 'game/inventory.ts': 'each Inventory registers its own slots', 'game/moves.ts': 'the registry' },
  },
];

describe('only src/game/moves.ts changes where items are', () => {
  const all = files(SRC).map((f) => ({ f: rel(f), lines: fs.readFileSync(f, 'utf8').split('\n') }));
  for (const rule of RULES) {
    it(rule.what, () => {
      const hits: string[] = [];
      for (const { f, lines } of all) {
        if (Object.keys(rule.allowed).some((k) => (k.endsWith('/') ? f.startsWith(k) : f === k))) continue;
        lines.forEach((l, i) => {
          if (/^\s*(\/\/|\*)/.test(l)) return; // comments
          if (rule.re.test(l)) hits.push(`${f}:${i + 1}: ${l.trim()}`);
        });
      }
      expect(hits, `use src/game/moves.ts (moveItem / spawnItem / consumeItem) instead:\n${hits.join('\n')}`).toEqual([]);
    });
  }
});
