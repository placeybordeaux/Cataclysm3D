import { describe, expect, it } from 'vitest';
import type { TerrainDef } from '../../src/data/types';
import { surfaceKind } from '../../src/render/props';

// Flags as BN's terrain JSON has them (ROAD = smooth for vehicles, on most built floors).
const ter = (id: string, flags: string[]) => ({ id, flags }) as unknown as TerrainDef;

describe('scattered props: surface kinds', () => {
  it('only asphalt counts as road (puddles), not every ROAD-flagged floor', () => {
    expect(surfaceKind(ter('t_pavement', ['TRANSPARENT', 'FLAT', 'ROAD']))).toBe(3);
    expect(surfaceKind(ter('t_pavement_y', ['TRANSPARENT', 'FLAT', 'ROAD']))).toBe(3);
    expect(surfaceKind(ter('t_ramp_up_high', ['TRANSPARENT', 'FLAT', 'ROAD']))).toBe(3);
    // wooden floors under open sky (a roofless ruin, a deck, the style gallery) had puddles
    expect(surfaceKind(ter('t_floor', ['TRANSPARENT', 'FLAMMABLE_HARD', 'SUPPORTS_ROOF', 'COLLAPSES', 'FLAT', 'ROAD']))).toBe(0);
    expect(surfaceKind(ter('t_floor_noroof', ['TRANSPARENT', 'FLAT', 'ROAD']))).toBe(0);
    expect(surfaceKind(ter('t_metal_floor', ['TRANSPARENT', 'FLAT', 'ROAD']))).toBe(0);
    expect(surfaceKind(ter('t_door_o', ['TRANSPARENT', 'FLAT', 'ROAD', 'DOOR']))).toBe(0);
    expect(surfaceKind(ter('t_guardrail', ['TRANSPARENT', 'ROAD']))).toBe(0);
  });

  it('sidewalks and concrete get litter, natural ground rocks, interiors nothing', () => {
    expect(surfaceKind(ter('t_sidewalk', ['TRANSPARENT', 'FLAT', 'ROAD']))).toBe(2);
    expect(surfaceKind(ter('t_concrete', ['TRANSPARENT', 'FLAT', 'ROAD']))).toBe(2);
    expect(surfaceKind(ter('t_dirt', ['TRANSPARENT', 'FLAT', 'PLOWABLE']))).toBe(1);
    expect(surfaceKind(ter('t_linoleum_white', ['TRANSPARENT', 'FLAT', 'ROAD', 'INDOORS']))).toBe(0);
  });
});
