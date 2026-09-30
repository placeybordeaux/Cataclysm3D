import * as THREE from 'three';
import type { Game } from '../../game/game';
import type { Renderer } from '../renderer';
import type { Viewmodel, ViewmodelItem, ViewmodelState } from '../viewmodel';
import { AtlasTextureSource } from '../atlasSource';
import { bodyShapeOf } from './archetype';
import { CharLayer, fpMaterial, type CharInstance } from './charLayer';
import { buildHeld, heldClass, type HeldBuild } from './held';
import { charLayers, charSettings, frameKey, spriteInfo } from './index';
import { analyseSprite, type Palette } from './paint';
import { newPoseOut, type PartDef, type Rig } from './rig';
import type { TileFrame } from '../textureSource';

// The first-person view in 3D (docs/CHARACTERS.md): forearms and fists in the survivor's own
// sleeves and skin (styled from their outfit composite), held items as low-poly meshes by
// class (held.ts), a bow that bends and a string that pulls back. It is a second *renderer*
// of the sprite viewmodel's animation, not a second animation system: render/viewmodel.ts
// still runs every pose (phased swings, guard, recoil, reload, ADS, bow draw, jolts, bob,
// sway, free-aim follow) and publishes where it put things (Viewmodel.state); this maps those
// screen-space poses into a small perspective scene drawn as the overlay instead.
//
//   ?viewmodel=model|sprite · Options → First-person hands · cdda.chars({ viewmodel: 'sprite' })

const FOV = 56;
const TEXELS = 2.5; // arms and items are seen from 30 cm: 80 texels/m
const FLASH_COLOR = new THREE.Color(1.0, 0.55, 0.12);

type Side = 1 | -1;

/** Forearm + fist (+ upper arm) seen from the shoulder: the hand is the root. */
function armParts(side: Side): PartDef[] {
  return [
    { name: 'hand', parent: -1, joint: [0, 0, 0], size: [0.085, 0.085, 0.1], center: [0, 0, 0], taper: [0.95, 0.9, 1, 1], taperAxis: 'z', src: { region: 'hand' }, kind: 'limb' },
    { name: 'fArm', parent: 0, joint: [side * 0.005, -0.015, 0.045], size: [0.075, 0.072, 0.3], center: [0, 0, 0.15], rest: [0.5, side * 0.3, 0], taper: [0.85, 0.85, 1.05, 1.05], taperAxis: 'z', src: { region: 'foreArm' }, kind: 'limb' },
    { name: 'uArm', parent: 1, joint: [0, 0, 0.3], size: [0.09, 0.088, 0.3], center: [0, 0, 0.15], rest: [-0.5, side * 0.25, 0], src: { region: 'upperArm' }, kind: 'limb' },
    // a fist is not a cube: a knuckle ridge along the front, a thumb folded across on the inside
    { name: 'knuckles', parent: 0, joint: [0, 0.028, -0.05], size: [0.082, 0.03, 0.022], center: [0, 0, 0], src: { region: 'hand' }, kind: 'limb' },
    { name: 'thumb', parent: 0, joint: [-side * 0.036, -0.012, -0.02], size: [0.026, 0.026, 0.06], center: [0, 0, 0], rest: [0, side * 0.5, 0], src: { region: 'hand' }, kind: 'limb' },
  ];
}

function rigOf(parts: PartDef[]): Rig {
  return {
    shape: bodyShapeOf({ id: 'player', bodytype: 'human', species: ['HUMAN'] }),
    parts, height: 0.3, hover: 0, lie: { angle: 0, lift: 0, side: false }, texels: TEXELS,
    pose() {},
  };
}

/** Right arm holding an item: arm parts, a pivot carrying the grip rotation, the item. */
function heldRig(h: HeldBuild | null): { rig: Rig; pivot: number } {
  const parts = armParts(1);
  if (!h) return { rig: rigOf(parts), pivot: -1 };
  const pivot = parts.length;
  parts.push({ name: 'pivot', parent: 0, joint: [0, 0, 0], size: [0.001, 0.001, 0.001], center: [0, 0, 0], rest: h.hold, src: { color: [0, 0, 0] }, kind: 'thin' });
  for (const p of h.parts) parts.push({ ...p, parent: p.parent < 0 ? pivot : p.parent + pivot + 1 });
  return { rig: rigOf(parts), pivot };
}

const BOW_L = { bow: 0.34, slingshot: 0.075 } as const;
const vmAimX = (vm: Viewmodel) => vm.aimPx.x;
const vmAimY = (vm: Viewmodel) => vm.aimPx.y;

/** Left fist on a bow: riser, two limbs, two string halves, an arrow (pose sets their angles). */
function bowRig(kind: 'bow' | 'slingshot', pal: Palette): Rig {
  const parts = armParts(-1);
  const L = BOW_L[kind];
  const wood = pal.main;
  const riser = parts.length;
  parts.push({ name: 'riser', parent: 0, joint: [0, 0, 0], size: [0.03, kind === 'bow' ? 0.14 : 0.1, 0.034], center: [0, kind === 'bow' ? 0 : 0.03, 0], src: { color: wood }, kind: 'thin' });
  parts.push({ name: 'limbU', parent: riser, joint: [0, kind === 'bow' ? 0.07 : 0.08, 0], size: [0.022, L, 0.028], center: [0, L / 2, 0], taper: [1, 1, 0.55, 0.6], src: { color: wood }, kind: 'thin' });
  parts.push({ name: 'limbD', parent: riser, joint: [0, kind === 'bow' ? -0.07 : 0.08, 0], size: [0.022, L, 0.028], center: [0, -L / 2, 0], taper: [0.55, 0.6, 1, 1], src: { color: wood }, kind: 'thin' });
  parts.push({ name: 'stringU', parent: riser, joint: [0, 0, 0], size: [0.006, 1, 0.006], center: [0, 0.5, 0], src: { color: kind === 'bow' ? [226, 220, 200] : [120, 60, 40] }, kind: 'thin' });
  parts.push({ name: 'stringD', parent: riser, joint: [0, 0, 0], size: [0.006, 1, 0.006], center: [0, 0.5, 0], src: { color: kind === 'bow' ? [226, 220, 200] : [120, 60, 40] }, kind: 'thin' });
  parts.push({ name: 'arrow', parent: riser, joint: [0, 0, 0], size: [0.009, 0.009, 0.72], center: [0, 0, -0.36], src: { color: [150, 112, 70] }, kind: 'thin' });
  parts.push({ name: 'head', parent: riser, joint: [0, 0, 0], size: [0.02, 0.012, 0.05], center: [0, 0, -0.74], taper: [0.2, 0.3, 1, 1], taperAxis: 'z', src: { color: [150, 154, 160] }, kind: 'thin' });
  parts.push({ name: 'fletch', parent: riser, joint: [0, 0, 0], size: [0.004, 0.03, 0.08], center: [0, 0, -0.03], src: { color: [200, 40, 40] }, kind: 'thin' });
  return rigOf(parts);
}

function flashRig(): Rig {
  const c: [number, number, number] = [255, 214, 120];
  return rigOf([
    { name: 'a', parent: -1, joint: [0, 0, 0], size: [0.07, 0.018, 0.018], center: [0, 0, -0.01], rest: [0, 0, 0.7], src: { color: c }, kind: 'thin' },
    { name: 'b', parent: -1, joint: [0, 0, 0], size: [0.07, 0.018, 0.018], center: [0, 0, -0.01], rest: [0, 0, -0.7], src: { color: c }, kind: 'thin' },
    { name: 'c', parent: -1, joint: [0, 0, 0], size: [0.03, 0.03, 0.1], center: [0, 0, -0.05], taper: [1, 1, 0.3, 0.3], taperAxis: 'z', src: { color: c }, kind: 'thin' },
  ]);
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

function place(out: THREE.Matrix4, pos: [number, number, number], euler: [number, number, number]): THREE.Matrix4 {
  _e.set(euler[0], euler[1], euler[2], 'YXZ');
  _q.setFromEuler(_e);
  return out.compose(_v.set(pos[0], pos[1], pos[2]), _q, ONE);
}

export class FpView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.02, 6);
  private layer: CharLayer;
  private right: CharInstance | null = null;
  private left: CharInstance | null = null;
  private flash: CharInstance | null = null;
  private bow: CharInstance | null = null;
  private key = '';
  private held: HeldBuild | null = null;
  private pivot = -1;
  private rootR = new THREE.Matrix4();
  private rootL = new THREE.Matrix4();
  private rootF = new THREE.Matrix4();

  constructor(readonly game: Game, readonly renderer: Renderer, readonly vm: Viewmodel) {
    this.scene.name = 'viewmodel-3d';
    this.layer = new CharLayer(false, 'fp', (page) => fpMaterial(page, vm.tint));
    this.scene.add(this.layer.group);
    // the renderer asks for the overlay after the sprite viewmodel has updated its poses
    renderer.viewmodelOverlay = (dt) => this.frame(dt);
  }

  private get active(): boolean {
    return charSettings.viewmodel === 'model';
  }

  /** The player's outfit composite (body + worn, no wielded overlay) for the sleeves and skin. */
  private outfitFrame(): TileFrame {
    const src = this.renderer.source;
    const p = this.game.player;
    if (src instanceof AtlasTextureSource) {
      const worn = p.inv.worn.length ? p.inv.worn.map((w) => w.typeId) : ['jeans', 'tshirt', 'sneakers', 'jacket_flannel'];
      const f = src.composite(src.layersFor(worn, null, p.male ? 'male' : 'female'));
      if (f) return f;
    }
    return src.sprite('player');
  }

  private drop(): void {
    for (const i of [this.right, this.left, this.flash, this.bow]) i?.remove();
    this.right = this.left = this.flash = this.bow = null;
  }

  private rebuild(item: ViewmodelItem | null, st: ViewmodelState): void {
    const store = charLayers(this.renderer).store;
    const outfit = this.outfitFrame();
    const skinKey = frameKey(outfit);
    const info = () => spriteInfo(outfit);
    this.drop();
    const add = (rig: Rig, key: string) => {
      const inst = this.layer.add(rig, store.get(rig, { key: `fp:${skinKey}:${key}`, info }));
      inst.rootOverride = new THREE.Matrix4();
      return inst;
    };
    let pal: Palette | null = null;
    if (item) {
      const f = this.renderer.source.item(item.typeId);
      pal = spriteInfo(f)?.pal ?? analyseSprite({ w: 1, h: 1, data: new Uint8Array([128, 128, 128, 255]) }).pal;
    }
    if (st.mode === 'drawn' && st.drawn && pal) {
      this.bow = add(bowRig(st.drawn.kind, pal), `bow:${st.drawn.kind}:${item!.typeId}`);
      this.right = add(heldRig(null).rig, 'fist');
      this.held = null;
      return;
    }
    const cls = item ? heldClass(item as never) : null;
    this.held = item && cls ? buildHeld(cls, pal!, item.def?.volume) : null;
    const hr = heldRig(this.held);
    this.pivot = hr.pivot;
    this.right = add(hr.rig, `R:${item?.typeId ?? ''}`);
    this.left = add(rigOf(armParts(-1)), 'L');
    if (this.held?.muzzle) {
      this.flash = add(flashRig(), 'flash');
      this.flash.flashColor.copy(FLASH_COLOR);
    }
  }

  /** Called by the renderer each frame (after Viewmodel.update); null = draw the sprites. */
  private frame(dt: number): { scene: THREE.Scene; camera: THREE.Camera } | null {
    const vm = this.vm;
    vm.hide2d = this.active;
    if (!this.active) {
      if (this.right) this.drop();
      this.key = '';
      return null;
    }
    const st = vm.state;
    const item = this.game.player.inv.wielded as unknown as ViewmodelItem | null;
    const W = st.lowW, H = st.lowH;
    this.camera.aspect = W / H;
    this.camera.updateProjectionMatrix();
    const key = `${st.mode === 'drawn' ? `drawn:${st.drawn?.kind}` : st.mode}|${item?.typeId ?? ''}|${frameKey(this.outfitFrame())}`;
    if (key !== this.key || !this.right) {
      this.key = key;
      this.rebuild(st.mode === 'none' ? null : item, st);
    }
    const tanH = Math.tan((FOV * Math.PI) / 360);
    // a screen point (low-res px from the bottom-left) at depth d in front of the camera
    const at = (px: number, py: number, d: number): [number, number, number] =>
      [((px - W / 2) / (H / 2)) * d * tanH, ((py - H / 2) / (H / 2)) * d * tanH, -d];
    const R = this.right!, L = this.left, F = this.flash;
    const show = (i: CharInstance | null, v: boolean) => i?.setVisible(v);

    if (st.mode === 'drawn' && st.drawn && this.bow) {
      const b = st.drawn;
      const kind = b.kind;
      const d = b.draw;
      // left fist on the riser, canted with the 2D pose; the string and the right hand come back with the draw
      place(this.rootL, at(b.x, b.y, 0.8), [0.05, 0.12, b.rot * 0.8]);
      this.setRoot(this.bow, this.rootL);
      const po = this.bow.pose;
      po.rot.fill(0);
      po.scl.fill(1);
      const Lb = BOW_L[kind];
      const a = -0.1 + (kind === 'bow' ? 0.32 : 0.1) * d;
      const riserY = kind === 'bow' ? 0.07 : 0.08;
      const nockZ = 0.04 + (kind === 'bow' ? 0.34 : 0.26) * d;
      const base = 5; // parts after the arm (hand, forearm, upper arm, knuckles, thumb)
      po.rot[(base + 1) * 3] = a;
      po.rot[(base + 2) * 3] = -a;
      const tipU: [number, number] = [riserY + Lb * Math.cos(a), Lb * Math.sin(a)];
      const tipD: [number, number] = [(kind === 'bow' ? -riserY : riserY) - Lb * Math.cos(a), Lb * Math.sin(a)];
      const nock: [number, number] = [kind === 'bow' ? 0 : riserY + Lb * 0.6, nockZ];
      for (const [i, tip] of [[base + 3, tipU], [base + 4, tipD]] as const) {
        const vy = nock[0] - tip[0], vz = nock[1] - tip[1];
        // joint at the tip (in the riser frame): the part's pose moves it there via the scale/rotation
        this.bow.rig.parts[i].joint[1] = tip[0];
        this.bow.rig.parts[i].joint[2] = tip[1];
        po.rot[i * 3] = Math.atan2(vz, vy);
        po.scl[i * 3 + 1] = Math.max(0.001, Math.hypot(vy, vz));
      }
      const nocked = b.nocked;
      for (const i of [base + 5, base + 6, base + 7]) {
        this.bow.rig.parts[i].joint[1] = nock[0];
        this.bow.rig.parts[i].joint[2] = nockZ;
        if (!nocked) po.scl.set([0.0001, 0.0001, 0.0001], i * 3);
      }
      this.bow.dirty = true;
      // right fist pinches the nock
      _m.copy(this.rootL).multiply(place(new THREE.Matrix4(), [0.012, nock[0], nockZ + 0.03], [0.2, -0.35, 0]));
      this.setRoot(R, _m);
      show(this.bow, true);
      show(R, true);
      this.layer.flush(dt, charLayers(this.renderer).store);
      return this;
    }

    if (st.mode === 'fists' || !this.held) {
      // bare hands: two fists, knuckles forward; a punch drives forward as well as up
      for (const [i, inst, side] of [[1, R, 1], [0, L, -1]] as const) {
        const h = st.hands[i];
        const reach = Math.max(0, h.dy) * 0.55;
        place(i ? this.rootR : this.rootL, at(h.x, h.y + H * 0.05, 0.58 + reach * 0.3), [0.12 + h.dy * 0.8, -side * 0.12, -h.rot]);
        _v.set(0, 0, -reach);
        (i ? this.rootR : this.rootL).multiply(_m.makeTranslation(_v.x, _v.y, _v.z));
        if (inst) this.setRoot(inst, i ? this.rootR : this.rootL);
      }
      show(R, st.mode !== 'none');
      show(L, st.mode !== 'none');
      show(F, false);
    } else {
      const it = st.item;
      const h = this.held;
      if (h.gun) {
        // the gun points ahead (a little toed-in at the hip), recoil lifts the muzzle
        // hip: low right; ADS: the sights come to the centre of the view, just under the crosshair
        // ADS: the sight line on the eye axis (following the free-aim offset), the stock at the
        // shoulder below and behind the view. Hip: where the 2D viewmodel put the grip.
        // The 2D pose's offsets (recoil kick, the reload dip) are sized for a flat sprite that
        // fills a third of the screen: halve them in 3D so a reloading gun dips, not vanishes.
        const hip = at(it.x - it.dx * H * 0.5, it.y - it.dy * H * 0.55, 0.46);
        const aim = at(W / 2 + vmAimX(this.vm), H / 2 + vmAimY(this.vm), 0.5);
        const sightY = h.muzzle ? h.muzzle[1] + 0.03 : 0.08;
        aim[1] -= sightY;
        const k = st.ads;
        place(this.rootR, [hip[0] + (aim[0] - hip[0]) * k, hip[1] + (aim[1] - hip[1]) * k, hip[2] + (aim[2] - hip[2]) * k + Math.max(0, it.dy) * 0.15],
          [it.rot * 0.9, 0.08 * (1 - k), 0]);
        // down the sights the stock is at the shoulder, below the view: don't let it slab the screen
        const stock = R.rig.parts.findIndex((q) => q.name === 'stock');
        if (stock >= 0) R.pose.scl.set(k > 0.5 ? [0.0001, 0.0001, 0.0001] : [1, 1, 1], stock * 3);
      } else if (st.mode === 'whirl') {
        place(this.rootR, at(it.x, it.y, 0.42), [0, 0, it.rot]);
      } else {
        // melee: the 2D swing rotation becomes a roll across the view plus a chop forward
        place(this.rootR, at(it.x, it.y, 0.56 + Math.max(0, it.dy) * 0.4), [it.rot * 0.55, -it.rot * 0.25, it.rot * 0.85]);
      }
      this.setRoot(R, this.rootR);
      show(R, it.vis);
      // the off hand on a two-handed grip, else out of view
      if (L) {
        if (h.support) {
          _m.copy(this.rootR).multiply(place(new THREE.Matrix4(), [0, 0, 0], h.hold));
          _m.multiply(new THREE.Matrix4().makeTranslation(h.support[0], h.support[1], h.support[2]));
          _m.multiply(place(new THREE.Matrix4(), [0, 0, 0], [-h.hold[0], -h.hold[1], -h.hold[2]]));
          this.setRoot(L, _m);
          show(L, it.vis);
        } else show(L, false);
      }
      if (F && h.muzzle) {
        this.rootF.copy(this.rootR).multiply(place(new THREE.Matrix4(), [0, 0, 0], h.hold)).multiply(new THREE.Matrix4().makeTranslation(h.muzzle[0], h.muzzle[1], h.muzzle[2]));
        this.setRoot(F, this.rootF);
        F.flashT = F.flashDur = 1; // full strength: the material emits flash colour unlit
        show(F, st.flash && it.vis);
      }
    }
    this.layer.flush(dt, charLayers(this.renderer).store);
    return this;
  }

  private setRoot(inst: CharInstance, m: THREE.Matrix4): void {
    inst.rootOverride!.copy(m);
    inst.dirty = true;
  }
}

/** Default pose buffer size check (tests). */
export const _fpInternals = { armParts, heldRig, bowRig, newPoseOut };
