import * as THREE from 'three';
import type { Game } from '../../game/game';
import type { Renderer } from '../renderer';
import type { Viewmodel, ViewmodelItem, ViewmodelState } from '../viewmodel';
import { AtlasTextureSource } from '../atlasSource';
import { bodyShapeOf } from './archetype';
import { CharLayer, fpMaterial, type CharInstance } from './charLayer';
import { buildHeld, heldClass, heldVariant, type HeldBuild, type HeldClass } from './held';
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
// arms and items are seen from 30-60 cm, where a low-res pixel is ~1 mm: paint at 256 texels/m
// so a knuckle is a few texels and a slide has room for serrations
const TEXELS = 8;
const FLASH_COLOR = new THREE.Color(1.0, 0.55, 0.12);

type Side = 1 | -1;

/** Index of the hand in armParts (the rolled frame the fingers and a held grip live in). */
const HAND = 1;

/**
 * Forearm + upper arm + a modelled fist, rooted at the wrist. Hand frame: x across the
 * knuckles, y out of the back of the hand, -z toward the knuckles. Four fingers curl round a
 * grip along x (proximal row = the knuckles, middle row curled under), the thumb wraps across
 * the front of them, the back of the hand is domed, the wrist is narrower than the hand. A
 * held item's grip passes through the curled fingers (heldRig rolls the hand to match it).
 */
function armParts(side: Side, handRest: [number, number, number] = [0, 0, 0]): PartDef[] {
  const P: PartDef[] = [
    { name: 'wrist', parent: -1, joint: [0, 0, 0], size: [0.001, 0.001, 0.001], center: [0, 0, 0], src: { color: [0, 0, 0] }, kind: 'thin' },
    { name: 'hand', parent: 0, joint: [0, 0, -0.045], size: [0.08, 0.034, 0.078], center: [0, 0.012, 0.004], rest: handRest, taper: [1.04, 1, 0.9, 0.95], taperAxis: 'z', src: { region: 'fpBack' }, kind: 'limb' },
    { name: 'dome', parent: 1, joint: [0, 0.03, 0.006], size: [0.062, 0.012, 0.06], center: [0, 0, 0], src: { region: 'fpBack' }, kind: 'limb' },
    { name: 'palm', parent: 1, joint: [0, -0.017, 0.008], size: [0.074, 0.03, 0.068], center: [0, 0, 0], src: { region: 'fpPalm' }, kind: 'limb' },
    // the forearm runs back toward the elbow (+z, down a little): its +y end is the wrist
    { name: 'fArm', parent: 0, joint: [0, -0.004, 0.012], size: [0.066, 0.3, 0.062], center: [0, -0.15, 0], rest: [-1.07, side * 0.3, 0], taper: [1.14, 1.12, 0.86, 0.86], src: { region: 'fpSleeveLower' }, kind: 'limb' },
    { name: 'uArm', parent: 4, joint: [0, -0.3, 0], size: [0.086, 0.3, 0.082], center: [0, -0.15, 0], rest: [-0.5, 0, 0], src: { region: 'fpSleeveUpper' }, kind: 'limb' },
  ];
  // fingers, index (thumb side) to little, the little finger a touch shorter
  for (let i = 0; i < 4; i++) {
    const x = side * (-0.0285 + i * 0.019);
    const shrink = i === 3 ? 0.85 : 1;
    const prox = P.length;
    P.push({ name: `prox${i}`, parent: HAND, joint: [x, 0.004, -0.047], size: [0.0172, 0.028 * shrink, 0.03], center: [0, 0, -0.004], taper: [1, 1, 0.94, 0.94], taperAxis: 'z', src: { region: 'fpFinger' }, kind: 'limb' });
    P.push({ name: `mid${i}`, parent: prox, joint: [0, -0.012, -0.016], size: [0.016, 0.03 * shrink, 0.022], center: [0, -0.012, 0.002], rest: [0.25, 0, 0], src: { region: 'fpFinger' }, kind: 'limb' });
  }
  // thumb: base along the inner side, tip lying across the front of the curled fingers
  const tb = P.length;
  P.push({ name: 'thumbBase', parent: HAND, joint: [-side * 0.037, -0.018, -0.018], size: [0.024, 0.026, 0.044], center: [0, 0, -0.012], rest: [0, -side * 0.25, 0], src: { region: 'fpThumb' }, kind: 'limb' });
  P.push({ name: 'thumbTip', parent: tb, joint: [side * 0.004, -0.004, -0.034], size: [0.044, 0.02, 0.021], center: [side * 0.016, 0, 0], rest: [0, side * 0.2, 0], taper: [0.86, 0.9, 1, 1], taperAxis: 'y', src: { region: 'fpThumb' }, kind: 'limb' });
  return P;
}

function rigOf(parts: PartDef[]): Rig {
  return {
    shape: bodyShapeOf({ id: 'player', bodytype: 'human', species: ['HUMAN'] }),
    parts, height: 0.3, hover: 0, lie: { angle: 0, lift: 0, side: false }, texels: TEXELS,
    pose() {},
  };
}

const _hm = new THREE.Matrix4();
const _he = new THREE.Euler();

/**
 * Right arm holding an item: the item hangs from a pivot at the fist's centre (its `hold`
 * rotation), and the hand is rolled so its knuckle row runs along the item's grip (item +y):
 * hand = hold · Rz(90°). The fingers then curl round the grip instead of a block floating beside it.
 */
function heldRig(h: HeldBuild | null): { rig: Rig; pivot: number } {
  if (!h) return { rig: rigOf(armParts(1)), pivot: -1 };
  _hm.makeRotationFromEuler(_he.set(h.hold[0], h.hold[1], h.hold[2]));
  _hm.multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  _he.setFromRotationMatrix(_hm, 'XYZ');
  const parts = armParts(1, [_he.x, _he.y, _he.z]);
  const pivot = parts.length;
  // the grip runs through the curled fingers; undo the hand's roll so the item keeps `hold`
  parts.push({ name: 'pivot', parent: HAND, joint: [0, -0.014, -0.05], size: [0.001, 0.001, 0.001], center: [0, 0, 0], rest: [0, 0, -Math.PI / 2], src: { color: [0, 0, 0] }, kind: 'thin' });
  for (const p of h.parts) parts.push({ ...p, parent: p.parent < 0 ? pivot : p.parent + pivot + 1 });
  return { rig: rigOf(parts), pivot };
}

const BOW_L = { bow: 0.34, slingshot: 0.075 } as const;
const vmAimX = (vm: Viewmodel) => vm.aimPx.x;
const vmAimY = (vm: Viewmodel) => vm.aimPx.y;

/** Left fist on a bow: riser, two limbs, two string halves, an arrow (pose sets their angles). */
function bowRig(kind: 'bow' | 'slingshot', pal: Palette): Rig {
  // left fist rolled knuckles-up round the riser, which runs through the curled fingers
  const parts = armParts(-1, [0, 0, Math.PI / 2]);
  const L = BOW_L[kind];
  const wood = pal.main;
  const riser = parts.length;
  parts.push({ name: 'riser', parent: 0, joint: [0.014, 0, -0.095], size: [0.03, kind === 'bow' ? 0.14 : 0.1, 0.034], center: [0, kind === 'bow' ? 0 : 0.03, 0], src: { color: wood }, kind: 'thin' });
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
  private cls: HeldClass | null = null;
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
    this.cls = cls;
    this.held = item && cls ? buildHeld(cls, pal!, item.def?.volume, heldVariant(item as never, cls)) : null;
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
    // Drawn bows/slingshots stay 2D: bowArt's hand-drawn bend and string read better than the
    // 3D bow in side-by-side shots (docs/CHARACTERS.md round 4), so hand that pose back (cdda.chars({ fpBow: true }) shows the 3D bow).
    if (st.mode === 'drawn' && !charSettings.fpBow) {
      vm.hide2d = false;
      if (this.right) this.drop();
      this.key = '';
      return null;
    }
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
      const base = armParts(-1).length; // bow parts follow the arm
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
        place(i ? this.rootR : this.rootL, at(h.x, h.y + H * 0.06, 0.52 + reach * 0.3), [0.12 + h.dy * 0.8, -side * 0.12, -h.rot]);
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
        // a pistol is small: hold it higher, nearer and turned in so it reads as a gun at the
        // hip rather than a fist with something behind it
        const pistol = this.cls === 'pistol';
        const hip = at(it.x - it.dx * H * 0.5 - (pistol ? H * 0.08 : 0), it.y - it.dy * H * 0.55 + (pistol ? H * 0.1 : 0), pistol ? 0.34 : 0.4);
        // the grip sits ~9.5 cm ahead of the wrist root
        const aim = at(W / 2 + vmAimX(this.vm), H / 2 + vmAimY(this.vm), 0.405);
        const sightY = h.muzzle ? h.muzzle[1] + 0.03 : 0.08;
        aim[1] -= sightY;
        const k = st.ads;
        place(this.rootR, [hip[0] + (aim[0] - hip[0]) * k, hip[1] + (aim[1] - hip[1]) * k, hip[2] + (aim[2] - hip[2]) * k + Math.max(0, it.dy) * 0.15],
          [it.rot * 0.9, (pistol ? 0.28 : 0.1) * (1 - k), 0]);
        // down the sights the stock is at the shoulder, below the view: don't let it slab the screen
        const stock = R.rig.parts.findIndex((q) => q.name === 'stock');
        // the stock is under the forearm at the hip and at the shoulder down the sights: out of view either way
        if (stock >= 0) R.pose.scl.set([0.0001, 0.0001, 0.0001], stock * 3);
        const butt = R.rig.parts.findIndex((q) => q.name === 'butt');
        if (butt >= 0) R.pose.scl.set([0.0001, 0.0001, 0.0001], butt * 3);
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
          // the off hand's grip hole on the support point, its forearm coming in from the left
          _m.copy(this.itemFrame(R, this.rootR));
          _m.multiply(new THREE.Matrix4().makeTranslation(h.support[0], h.support[1], h.support[2]));
          _m.multiply(place(new THREE.Matrix4(), [0, 0, 0], h.gun ? [0.2, -0.75, 0.25] : [-h.hold[0], -h.hold[1] - 0.6, -h.hold[2]]));
          _m.multiply(new THREE.Matrix4().makeTranslation(0, 0.014, 0.095));
          this.setRoot(L, _m);
          show(L, it.vis);
        } else show(L, false);
      }
      if (F && h.muzzle) {
        this.rootF.copy(this.itemFrame(R, this.rootR)).multiply(new THREE.Matrix4().makeTranslation(h.muzzle[0], h.muzzle[1], h.muzzle[2]));
        this.setRoot(F, this.rootF);
        F.flashT = F.flashDur = 1; // full strength: the material emits flash colour unlit
        show(F, st.flash && it.vis);
      }
    }
    this.layer.flush(dt, charLayers(this.renderer).store);
    return this;
  }

  /** The held item's frame (the pivot in the fist) for a root: joints and rests down the chain. */
  private itemFrame(inst: CharInstance, root: THREE.Matrix4): THREE.Matrix4 {
    const parts = inst.rig.parts;
    const chain: number[] = [];
    for (let i = this.pivot; i >= 0; i = parts[i].parent) chain.unshift(i);
    const m = new THREE.Matrix4().copy(root);
    for (const i of chain) {
      const p = parts[i];
      m.multiply(place(new THREE.Matrix4(), p.joint, [0, 0, 0]));
      const r = p.rest ?? [0, 0, 0];
      m.multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(r[0], r[1], r[2])));
    }
    return m;
  }

  private setRoot(inst: CharInstance, m: THREE.Matrix4): void {
    inst.rootOverride!.copy(m);
    inst.dirty = true;
  }
}

/** Default pose buffer size check (tests). */
export const _fpInternals = { armParts, heldRig, bowRig, newPoseOut };
