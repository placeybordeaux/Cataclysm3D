// Browser regression: a surface headlight must not light a sealed basement, even
// when a basement lamp enables artificial lighting. Run through heavy + nix-shell.
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error('Run inside nix-shell (CHROME_PATH required)');
const out = resolve(process.argv[2] ?? '.scratch/headlight-occlusion');
mkdirSync(out, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors: string[] = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/?seed=1&gen=test&radius=2&px=270`);
  await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 120_000 });
  const run = (js: string) => page.evaluate(`(async()=>{const cdda=window.cdda;${js}})()`);
  // ready precedes the initial streaming overlay; let its budgeted work finish.
  await run('await new Promise(r=>setTimeout(r,10000));');
  await run(`
    cdda.godMode(true); cdda.clearMonsters(); cdda.renderer.timeScale=0;
    const m=cdda.game.map;
    for(let x=4;x<=14;x++) for(let y=4;y<=14;y++) {
      m.setTer(x,y,-1,x===4||x===14||y===4||y===14?'t_wall':'t_floor');
      m.setTer(x,y,0,'t_floor');
    }
    cdda.teleport(8.5,8.5,-1); cdda.look(270,-15); cdda.setHour(0);
    window.occlusionCar=cdda.vehicleSystem.spawn('car',-12,8,0,0,{fuel:100,status:0,force:true});
    window.occlusionCar.lightsOn=true; await cdda.settle();
    await new Promise(r=>setTimeout(r,6000)); cdda.game.paused=true;
  `);
  const capture = async (name: string, on: boolean) => {
    await run(`window.occlusionCar.lightsOn=${on};await cdda.settle();`);
    await new Promise(r => setTimeout(r, 500));
    const bytes = await page.screenshot();
    writeFileSync(`${out}/${name}.png`, bytes);
    return PNG.sync.read(Buffer.from(bytes));
  };
  const difference = (a: PNG, b: PNG) => {
    let max=0, sum=0, count=0;
    // Fixed world region: exclude the changing DOM lighting label and hand HUD.
    for(let y=65;y<400;y++) for(let x=0;x<960;x++) for(let c=0;c<3;c++) {
      const i=(y*960+x)*4+c, d=Math.abs(a.data[i]-b.data[i]);
      max=Math.max(max,d);sum+=d;if(d>10)count++;
    }
    return {max,sum,count};
  };
  const results: Record<string, unknown> = {};
  for(const mode of ['legacy','smooth']) {
    await run(`cdda.setShadows('${mode}');await cdda.settle();`);
    for(const lamp of [false,true]) {
      await run(`if(window.occlusionLamp)window.occlusionLamp.remove();window.occlusionLamp=${lamp ? 'cdda.addLight(0,0,{intensity:1,radius:8,color:0xffddaa})' : 'null'};await cdda.settle();`);
      const name=`${mode}-${lamp?'lamp':'dark'}`;
      const on=await capture(`${name}-on`,true),off=await capture(`${name}-off`,false);
      const d=difference(on,off);results[name]=d;
      if(d.max>3)throw new Error(`${name}: headlight leaked into basement: ${JSON.stringify(d)}`);
    }
  }
  // Hold the view fixed while moving the primary map across the stair boundary.
  // The same physical surfaces must keep their lighting when map roles rotate.
  await run(`
    window.occlusionUpdate=cdda.renderer.lightmap.update.bind(cdda.renderer.lightmap);
    window.occlusionLevel=-1;
    cdda.renderer.lightmap.update=(x,y,z,...rest)=>window.occlusionUpdate(x,y,window.occlusionLevel,...rest);
  `);
  const before=await capture('transition-below',false);
  await run('window.occlusionLevel=0;');
  const after=await capture('transition-above',false);
  const transition=difference(before,after);results.transition=transition;
  if(transition.max>3)throw new Error(`Level switch relit the basement: ${JSON.stringify(transition)}`);
  await run('cdda.renderer.lightmap.update=window.occlusionUpdate;');
  await run('if(window.occlusionLamp)window.occlusionLamp.remove();cdda.teleport(8.5,8.5,0);cdda.look(270,-35);await cdda.settle();');
  const on=await capture('surface-on',true),off=await capture('surface-off',false);
  const surface=difference(on,off);results.surface=surface;
  if(surface.count<100)throw new Error(`Headlights no longer illuminate surface: ${JSON.stringify(surface)}`);
  if(errors.length)throw new Error(errors.join('\n'));
  writeFileSync(`${out}/results.json`,JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} finally {
  await browser.close();await server.close();
}
