// Paste into tools/drive.ts eval after gallery scene=horde, chars=model has settled.
// Renderer-only duplicate instances isolate upload work; no crowd AI or FPS claim.
const c = cdda, renderer = c.renderer, gl = renderer.three.getContext();
const layer = c.monsterView.chars.live;
const base = [...layer.live][0], pose = {t:0,phase:0,gait:1,windup:null,windKind:'melee',strike:0,down:0,flinch:0,dead:false,seed:0.3};
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const debug = gl.getExtension('WEBGL_debug_renderer_info');
const results=[];
for(const count of [200,600]) {
  const extras=Array.from({length:Math.max(0,count-layer.count)},(_,j)=>{
    const i=layer.add(base.rig,base.skin);
    i.x=c.game.player.x-8+(j%16);i.y=c.game.player.y-6-Math.floor(j/16)*0.8;i.z=c.game.player.z;i.setPose(pose);return i;
  });
  const fixtures=[false,true].map(reuse=>({reuse,cpu:[],bytes:[],queries:[]}));
  let bytes=0;
  const original=gl.bufferSubData;
  gl.bufferSubData=function(target,offset,data,sourceOffset,length){
    if(target===gl.ARRAY_BUFFER)bytes+=(length??data.length)*data.BYTES_PER_ELEMENT;
    return original.apply(this,arguments);
  };
  try {
    for(let frame=0;frame<120;frame++) for(const f of frame%2?fixtures:[...fixtures].reverse()) {
      layer.reuseStaticUploads=f.reuse;
      extras.forEach((i,j)=>i.setPose({...pose,t:frame/60,phase:(frame+j)/60}));
      gl.finish();bytes=0;
      const q=ext?gl.createQuery():null;
      if(q)gl.beginQuery(ext.TIME_ELAPSED_EXT,q);
      const start=performance.now();renderer.render();
      if(q)gl.endQuery(ext.TIME_ELAPSED_EXT);
      gl.finish();
      if(frame>=40){f.cpu.push(performance.now()-start);f.bytes.push(bytes);if(q)f.queries.push(q);}else if(q)gl.deleteQuery(q);
    }
  } finally {gl.bufferSubData=original;layer.reuseStaticUploads=true;extras.forEach(i=>i.remove());}
  const pending=fixtures.flatMap(f=>f.queries);
  for(let spin=0;pending.length&&spin<100;spin++){
    if(pending.every(q=>gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)))break;
    await new Promise(r=>setTimeout(r,10));
  }
  const disjoint=ext&&gl.getParameter(ext.GPU_DISJOINT_EXT);
  const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
  for(const f of fixtures){
    const gpu=f.queries.filter(q=>gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)).map(q=>gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6);
    results.push({count,reuse:f.reuse,samples:f.cpu.length,renderAndFinishMedianMs:median(f.cpu),arrayUploadMedianBytes:median(f.bytes),gpuMedianMs:disjoint?null:median(gpu),gpuSamples:gpu.length,disjoint});
    f.queries.forEach(q=>gl.deleteQuery(q));
  }
}
c.settle();
return {renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),results};
