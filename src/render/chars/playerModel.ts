import type { Game, GameSystem } from '../../game/game';
import type { Renderer } from '../renderer';
import { bodyShapeOf } from './archetype';
import { CreatureModel } from './creature';
import { charLayers, charSettings, frameKey, spriteInfo } from './index';
import { makeRig, type Rig } from './rig';

// The survivor's own body outside first person (third-person / top-down cameras): the same
// 3D humanoid as NPCs, painted from the player's outfit composite (renderer source sprite
// 'player'), in place of the billboard. Hidden at the wheel and in first person, like the
// billboard was.

export class PlayerModel implements GameSystem {
  readonly name = 'player-model';
  private c: CreatureModel | null = null;
  private key = '';
  private rig: Rig | null = null;
  private lx = 0;
  private ly = 0;
  private phase = 0;

  constructor(readonly renderer: Renderer) {}

  update(game: Game, dt: number): void {
    const r = this.renderer;
    const models = charSettings.mode === 'model';
    r.playerBodyOverride = models;
    const show = models && r.cameraMode !== 'first' && !r.rig.drive;
    if (!show) {
      this.c?.remove();
      this.c = null;
      return;
    }
    const p = game.player;
    const frame = r.source.sprite('player');
    const key = frameKey(frame);
    const L = charLayers(r);
    this.rig ??= makeRig(bodyShapeOf({ id: p.male ? 'player_male' : 'player_female', bodytype: 'human', species: ['HUMAN'], volume: 62500 }));
    if (!this.c) {
      this.c = new CreatureModel(L.live, this.rig, L.store.get(this.rig, { key, info: () => spriteInfo(frame) }), 0.37, p.x, p.y, p.yaw);
      this.key = key;
      this.lx = p.x;
      this.ly = p.y;
    } else if (key !== this.key) {
      // new clothes: repaint
      this.key = key;
      L.live.reskin(this.c.inst, L.store.get(this.rig, { key, info: () => spriteInfo(frame) }));
    }
    const moved = Math.hypot(p.x - this.lx, p.y - this.ly);
    this.lx = p.x;
    this.ly = p.y;
    // monsters advance walkPhase by 3 per tile; keep the same stride
    this.phase += moved * 3;
    this.c.update(dt, {
      x: p.x, y: p.y, z: p.z, facing: p.yaw, target: null,
      moving: moved > 0.003, walkPhase: this.phase, windup: null, flinch: 0,
      down: p.dead ? 1 : 0, visible: true, emph: 0, camDist: 0, sy: 1, sxz: 1,
    });
  }
}
