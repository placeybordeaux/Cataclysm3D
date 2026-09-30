import type { Game } from '../../game/game';
import type { Renderer } from '../renderer';
import type { StairsHandle } from '../../stairs';
import { STAIR_LABEL } from '../../stairs';
import { STAIR_VARIANTS, type StairLink } from '../../game/stairs';
import { climbOf, liftOf, treadRise } from '../../game/stairwalk';
import { registerOption } from '../../ui/options';
import { sfx } from '../../audio/sfx';
import { emitSound, footstepVolume } from '../../game/sound';
import { StairMesher } from './mesher';

// The renderer side of walkable stairs (docs/STAIRS.md): modelled flights and stairwells in
// the chunk meshes, rebuilding the chunks a newly solved flight touches, the eye riding the
// steps (with a small bob per tread), footsteps per tread, and Options > Stairs.

/** Eye bob per tread (m): the head lifts a little between steps. */
const TREAD_BOB = 0.035;

export function installStairsView(game: Game, renderer: Renderer, stairs: StairsHandle): StairMesher {
  const walker = stairs.walker;
  const mesher = new StairMesher(walker, renderer.models.atlas, game.map);
  const prev = renderer.chunks.extras;
  renderer.chunks.extras = (near) => {
    const e = prev?.(near);
    return e && mesher.active ? { ...e, stairs: mesher } : e;
  };
  stairs.onVariant.push(() => renderer.chunks.invalidateAll());

  renderer.beforeRender.push(() => {
    // chunks whose meshes a (newly) solved flight changes
    const dirty = walker.index.dirtyChunks;
    if (dirty.size) {
      for (const k of dirty) {
        const [cx, cy, z] = k.split(',').map(Number);
        renderer.chunks.invalidateChunk(cx, cy, z);
      }
      dirty.clear();
    }
    const p = game.player;
    const c = climbOf(p);
    let lift = liftOf(p);
    if (c) lift += stepBob(c.link, c.h);
    renderer.rig.lift = lift;
  });

  // a footstep per tread: yours through the audio engine, and noise for the monsters
  let n = 0;
  walker.onTread.push((e) => {
    const p = game.player;
    const l = e.link;
    if (e.walker === p) {
      const variant = l.kind === 'ladder' ? 'walk_metal' : /wood/.test(l.terId) || l.terId === 't_stairs_up' ? 't_floor' : 'walk_tarmac';
      sfx.footstep(variant, (e.running ? 1 : p.crouching ? 0.35 : 0.8) * (e.up ? 1 : 0.85));
      // wooden stairs creak: every other tread is a footstep the monsters hear
      if (++n % 2 === 0) emitSound(game, { x: p.x, y: p.y, z: p.z }, footstepVolume(e.running, p.crouching, p.hasTrait('LIGHTSTEP')) + 1, 'footsteps', { category: 'movement', source: p, sfxId: '' });
    }
  });

  registerOption({
    name: 'Stairs',
    value: () => STAIR_LABEL[walker.variant],
    change: (d) => {
      const i = STAIR_VARIANTS.indexOf(walker.variant);
      stairs.setVariant(STAIR_VARIANTS[(i + d + STAIR_VARIANTS.length) % STAIR_VARIANTS.length], true);
    },
    desc: 'Flights: walk up and down stairs; a flight spreads over free floor next to the stairs when there is room (a real 3-step-per-metre flight), else it turns in its tile as a spiral.\nCompact: walk up and down, every flight stays inside its stair tiles (steep, or a spiral).\nClassic: the old stairs — press < / > on the stair tile to change level.',
  });
  return mesher;
}

/** The small lift of the head between treads, as a function of height on the flight. */
function stepBob(l: StairLink, h: number): number {
  if (l.kind === 'slope') return 0;
  const r = treadRise(l);
  return TREAD_BOB * Math.abs(Math.sin((Math.PI * h) / r));
}
