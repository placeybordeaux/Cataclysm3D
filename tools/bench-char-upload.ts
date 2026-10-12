// CPU flush + requested attribute bytes, not GPU time/FPS. Run inside Nix/heavy:
// nix-shell --run '~/claude-stuff/bin/heavy --mem 1.5 --name char-upload -- npx tsx tools/bench-char-upload.ts'
import * as THREE from 'three';
import { CharLayer, type SkinStore, type Skin } from '../src/render/chars/charLayer';
import { bodyShapeOf } from '../src/render/chars/archetype';
import { makeRig } from '../src/render/chars/rig';
import monsters from '../public/data/monsters.json';
for (const count of [200,600]) {
  const rig=makeRig(bodyShapeOf(monsters.mon_zombie));
  const texture=new THREE.DataTexture(new Uint8Array(4),1,1);
  const store={upload(){},texture(){return texture;}} as unknown as SkinStore;
  const fixtures=[false,true].map(reuse => {
    const layer=new CharLayer(false);layer.reuseStaticUploads=reuse;
    const skin:Skin={page:0,rects:new Int32Array(rig.parts.length*5),refs:0};
    return {reuse,layer,instances:Array.from({length:count},()=>layer.add(rig,skin)),times:[] as number[]};
  });
  for(let frame=0;frame<600;frame++) for(const f of frame%2 ? fixtures : [...fixtures].reverse()) {
    f.instances.forEach((i,j)=>i.setPose({t:frame/60,phase:(frame+j)/60,gait:1,windup:null,windKind:'melee',strike:0,down:0,flinch:0,dead:false,seed:j/count}));
    const start=performance.now();f.layer.flush(1/60,store);
    if(frame>=300)f.times.push(performance.now()-start);
  }
  for(const f of fixtures) {
    const mesh=f.layer.group.children[0] as THREE.InstancedMesh;
    const names=['matrix','cTex','cMisc','cFlash','cRoot','cShape'];
    const attrs=[mesh.instanceMatrix,...names.slice(1).map(k=>mesh.geometry.getAttribute(k) as THREE.BufferAttribute)];
    const versions=attrs.map(a=>a.version);
    f.instances.forEach(i=>i.setPose({t:20,phase:0.25,gait:1,windup:null,windKind:'melee',strike:0,down:0,flinch:0,dead:false,seed:0.3}));
    f.layer.flush(1/60,store);
    const bytes=attrs.reduce((sum,a,j)=>sum+(a.version>versions[j]?mesh.count*a.itemSize*4:0),0);
    f.times.sort((a,b)=>a-b);
    console.log(JSON.stringify({count,parts:rig.parts.length,reuse:f.reuse,medianMs:f.times[150],p95Ms:f.times[285],requestedBytes:bytes,changed:names.filter((_,j)=>attrs[j].version>versions[j])}));
    f.layer.dispose();
  }
  texture.dispose();
}
