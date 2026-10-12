import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CharLayer, type Skin, type SkinStore } from '../../src/render/chars/charLayer';
import { makeRig, type PoseIn } from '../../src/render/chars/rig';
import { bodyShapeOf } from '../../src/render/chars/archetype';

const pose: PoseIn = { t:0, phase:0, gait:1, windup:null, windKind:'melee', strike:0, down:0, flinch:0, dead:false, seed:0.3 };
const rig = makeRig(bodyShapeOf({id:'mon_dog', bodytype:'quadruped'}));
function fixture() {
  const layer = new CharLayer(false);
  const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const store = { upload() {}, texture() { return texture; } } as unknown as SkinStore;
  const skin = (x:number, page=0):Skin => ({page,refs:0,rects:Int32Array.from(Array.from({length:rig.parts.length*5},(_,i)=>i%5===0?x:i%5+1))});
  const add = (x:number, page=0) => layer.add(rig,skin(x,page));
  const flush = () => layer.flush(1/60,store);
  const meshes = () => layer.group.children as THREE.InstancedMesh[];
  const attr = (key:string, mesh=meshes()[0]) => mesh.geometry.getAttribute(key) as THREE.InstancedBufferAttribute;
  return {layer,add,skin,flush,meshes,attr};
}

describe('character static instance uploads', () => {
  it('keeps texture and taper buffers stable while pose, lighting and hit feedback update', () => {
    const f=fixture(), i=f.add(17);f.flush();
    const texVersion=f.attr('cTex').version, shapeVersion=f.attr('cShape').version;
    const before=(f.meshes()[0].instanceMatrix.array as Float32Array).slice();
    i.setPose({...pose,phase:0.25});i.emph=1;i.fade=0.4;i.flash(0xff0000);
    f.layer.skyVisAt=()=>0.25;f.flush();
    expect(f.attr('cTex').version).toBe(texVersion);
    expect(f.attr('cShape').version).toBe(shapeVersion);
    expect(f.meshes()[0].instanceMatrix.array).not.toEqual(before);
    expect(f.attr('cMisc').getY(0)).toBe(0.25);
    expect(f.attr('cMisc').getZ(0)).toBe(1);
    expect(f.attr('cRoot').getW(0)).toBeCloseTo(0.4);
    expect(f.attr('cFlash').getW(0)).toBeGreaterThan(0);
  });
  it('can request the full upload path for diagnostic comparisons', () => {
    const f=fixture(), i=f.add(11);f.flush();
    const before=f.attr('cTex').version;
    f.layer.reuseStaticUploads=false;i.setPose(pose);f.flush();
    expect(f.attr('cTex').version).toBeGreaterThan(before);
    const after=f.attr('cTex').version;
    f.layer.reuseStaticUploads=true;i.setPose({...pose,phase:0.25});f.flush();
    expect(f.attr('cTex').version).toBe(after);
  });
  it('repacks static slots on hide, show and removal', () => {
    const f=fixture(), a=f.add(11), b=f.add(22);f.flush();
    a.setVisible(false);f.flush();expect(f.attr('cTex').getX(0)).toBe(22);
    expect(f.meshes()[0].count).toBe(rig.parts.length);
    a.setVisible(true);f.flush();expect(f.attr('cTex').getX(0)).toBe(11);
    expect(f.attr('cTex').getX(rig.parts.length)).toBe(22);
    a.remove();f.flush();expect(f.attr('cTex').getX(0)).toBe(22);
    b.remove();f.flush();expect(f.meshes()[0].count).toBe(0);
  });
  it('refreshes changed skin rectangles and page membership', () => {
    const f=fixture(), i=f.add(11);f.flush();
    f.layer.reskin(i,f.skin(33));f.flush();expect(f.attr('cTex').getX(0)).toBe(33);
    f.layer.reskin(i,f.skin(44,1));f.flush();
    expect(f.meshes()[0].count).toBe(0);
    expect(f.attr('cTex',f.meshes()[1]).getX(0)).toBe(44);
    expect(f.meshes()[1].count).toBe(rig.parts.length);
  });
  it('initializes every static slot after batch capacity growth', () => {
    const f=fixture();f.add(11);f.flush();const old=f.meshes()[0];
    for(let i=0;i<40;i++)f.add(100+i);f.flush();
    expect(f.meshes()[0]).not.toBe(old);
    expect(f.attr('cTex').getX(0)).toBe(11);
    expect(f.attr('cTex').getX(40*rig.parts.length)).toBe(139);
    const taper=rig.parts[0].taper!;
    expect(f.attr('cShape').getX(40*rig.parts.length)).toBeCloseTo(taper[0]);
  });
  it('retains pending static upload ranges when consecutive frames precede a render', () => {
    const f=fixture(), i=f.add(11);f.flush();
    const range={...f.attr('cTex').updateRanges[0]};
    i.setPose({...pose,phase:0.25});f.flush();
    expect(f.attr('cTex').updateRanges[0]).toEqual(range);
    f.layer.reskin(i,f.skin(33));f.flush();
    expect(f.attr('cTex').updateRanges).toHaveLength(1);
    expect(f.attr('cTex').getX(0)).toBe(33);
  });
});
