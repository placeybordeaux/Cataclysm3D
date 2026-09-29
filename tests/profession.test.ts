// BN starting kits (profession::items) against the extracted Bright Nights data.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { Rng } from '../src/core/rng';
import { professionItems, type ProfessionItemsDef } from '../src/game/profession';
import { permittedProfessions, type ScenarioDef } from '../src/ui/chargen_logic';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;

beforeAll(() => {
  data = {
    terrain: {}, furniture: {}, items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: {}, monsterGroups: {}, recipes: [], misc: load('misc.json'),
  };
});

const prof = (id: string) => (data.misc.profession as Record<string, ProfessionItemsDef & { id: string }>)[id];
const ids = (list: { id: string; contents?: { id: string }[] }[]) => list.flatMap((s) => [s.id, ...(s.contents ?? []).map((c) => c.id)]);

describe('BN professions', () => {
  it('the quick-start Evacuee is a BN Survivor with the BN kit', () => {
    const scen = (data.misc.scenario as Record<string, ScenarioDef>).evacuee;
    const first = permittedProfessions(scen, data.misc.profession as never)[0];
    expect(first.id).toBe('unemployed');
    const kit = professionItems(data, prof('unemployed'), true, [], new Rng(1));
    const got = ids(kit);
    for (const id of ['lighter', 'jeans', 'longshirt', 'socks', 'sneakers', 'mbag', 'pockknife', 'water_clean', 'smart_phone', 'wristwatch', 'boxer_shorts']) expect(got).toContain(id);
    expect(got).not.toContain('bra');
    // Starting clothes fit (VARSIZE → FIT).
    const jeans = kit.find((s) => s.id === 'jeans')!;
    if (data.items.jeans.flags?.includes('VARSIZE')) expect(jeans.flags).toContain('FIT');
    const female = ids(professionItems(data, prof('unemployed'), false, [], new Rng(1)));
    expect(female).toContain('bra');
    expect(female).not.toContain('boxer_shorts');
  });

  it('traits swap and add items (profession_item_substitutions)', () => {
    // Myopic survivors get glasses (bonus); wool allergy swaps wool socks for cotton.
    const myopic = ids(professionItems(data, prof('unemployed'), true, ['MYOPIC'], new Rng(1)));
    expect(myopic).toContain('glasses_eye');
    const woolly = Object.values(data.misc.profession as Record<string, ProfessionItemsDef & { id: string }>).find((p) =>
      ids(professionItems(data, p, true, [], new Rng(2))).includes('socks_wool'),
    );
    if (woolly) {
      const swapped = ids(professionItems(data, woolly, true, ['WOOLALLERGY'], new Rng(2)));
      expect(swapped).not.toContain('socks_wool');
      expect(swapped).toContain('socks');
    }
  });

  it('profession CBMs and pets are BN data', () => {
    const profs = Object.values(data.misc.profession as Record<string, { CBMs?: string[]; pets?: { name: string; amount?: number }[] }>);
    const cbms = profs.flatMap((p) => p.CBMs ?? []);
    expect(cbms.length).toBeGreaterThan(0);
    for (const id of cbms) expect((data.misc.bionic as Record<string, unknown>)[id], id).toBeDefined();
    const pets = profs.flatMap((p) => p.pets ?? []);
    expect(pets.length).toBeGreaterThan(0);
    for (const p of pets) expect(typeof p.name).toBe('string');
  });
});
