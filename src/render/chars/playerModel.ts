import type { Game, GameSystem } from '../../game/game';
import type { Renderer } from '../renderer';
import { bodyShapeOf, weaponOf, type Weapon } from './archetype';
import { CreatureModel } from './creature';
import { charLayers, charSettings, frameKey, spriteInfo } from './index';
import { makeRig, type Rig } from './rig';
import { Rider, riderSlot } from '../vehicleRider';

// The survivor's own body outside first person (third-person / top-down cameras): the same
// 3D humanoid as NPCs, painted from the player's outfit composite (renderer source sprite
// 'player'), in place of the billboard. Hidden in first person (and the cockpit camera, whose
// fists on the wheel are vehicleHands.ts). At the wheel in the chase / top-down cameras it
// sits in the seat: this hands the body to VehicleRenderer (riderSlot), which poses it on the
// saddle / seat every frame after placing the vehicle (vehicleRider.ts). The billboard mode
// still hides the survivor while driving.

export class PlayerModel implements GameSystem {
  readonly name = 'player-model';
  private c: CreatureModel | null = null;
  private key = '';
  private rig: Rig | null = null;
  private weapon: Weapon = 'none';
  private lx = 0;
  private ly = 0;
  private phase = 0;
  private rider: Rider | null = null;

  constructor(readonly renderer: Renderer) {}

  update(game: Game, dt: number): void {
    const r = this.renderer;
    const models = charSettings.mode === 'model';
    r.playerBodyOverride = models;
    const slot = riderSlot(r);
    const atWheel = !!r.rig.drive && !!game.vehicles?.driving;
    const show = models && r.cameraMode !== 'first' && (slot.enabled || !atWheel);
    const riding = show && atWheel;
    if (!show) {
      this.c?.remove();
      this.c = null;
      this.rider = null;
      slot.rider = null;
      return;
    }
    const p = game.player;
    const frame = r.source.sprite('player');
    const key = frameKey(frame);
    const L = charLayers(r);
    const weapon = weaponOf(p.inv.wielded);
    if (!this.rig || weapon !== this.weapon) {
      this.weapon = weapon;
      this.rig = makeRig({ ...bodyShapeOf({ id: p.male ? 'player_male' : 'player_female', bodytype: 'human', species: ['HUMAN'], volume: 62500 }), weapon });
      this.c?.remove();
      this.c = null;
      this.rider = null;
    }
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
    if (riding) {
      // VehicleRenderer poses and places it this frame (after the vehicle has moved)
      this.rider ??= new Rider(this.c.inst, this.rig);
      slot.rider = this.rider;
      this.lx = p.x;
      this.ly = p.y;
      return;
    }
    if (this.rider) {
      // Off the seat: a fresh walking body where you stand (the old one's gait would read the
      // whole drive as one frame's step and break into a run).
      this.rider.release();
      this.rider = null;
      this.c.remove();
      this.c = new CreatureModel(L.live, this.rig, L.store.get(this.rig, { key, info: () => spriteInfo(frame) }), 0.37, p.x, p.y, p.yaw);
    }
    slot.rider = null;
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
