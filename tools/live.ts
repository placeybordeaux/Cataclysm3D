// Talk to the game tab a human is playing under `npm run dev` (dev bridge, see
// tools/dev/liveBridge.ts + src/dev/bridge.ts).
//
//   tsx tools/live.ts state            # what the player sees right now (JSON summary)
//   tsx tools/live.ts shot [out.png]   # screenshot of the 3D view (HUD is DOM: see `state`)
//   tsx tools/live.ts eval "<js>"      # run JS in the tab; `cdda` and `game` are in scope
//   tsx tools/live.ts perf [out.json]  # the tab's performance recording (last 60 s, docs/PERF.md)
//                                      # saved to a file (default .scratch/live/perf-<time>.json) + report
//
// LIVE_URL overrides the dev server address (default http://localhost:5173).

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { printReport } from './perf-report';
import type { PerfDump } from '../src/perf/analyze';

const [cmd, arg] = process.argv.slice(2);
const base = process.env.LIVE_URL ?? 'http://localhost:5173';
if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log('usage: tsx tools/live.ts state | shot [out.png] | eval "<js>" | perf [out.json]   (LIVE_URL, default http://localhost:5173)');
  process.exit(0);
}
if (cmd === 'perf') {
  const r = await fetch(`${base}/__cdda/eval`, { method: 'POST', body: 'cdda.perf.dump(60)' });
  const json = (await r.json()) as { result?: PerfDump; error?: string };
  if (!json.result) throw new Error(`perf dump failed: ${json.error ?? r.status}`);
  const out = arg ?? `.scratch/live/perf-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.json`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(json.result));
  printReport(json.result, out);
  process.exit(0);
}
const route = { state: 'state', shot: 'shot', eval: 'eval' }[cmd];
if (!route) throw new Error(`unknown command ${cmd}`);
const r = await fetch(`${base}/__cdda/${route}`, { method: cmd === 'state' ? 'GET' : 'POST', body: cmd === 'eval' ? arg ?? '' : undefined });
const json = (await r.json()) as { file?: string; error?: string };
if (cmd === 'shot' && json.file && arg) {
  copyFileSync(json.file, arg);
  json.file = arg;
}
console.log(JSON.stringify(json, null, 2));
process.exit(r.ok ? 0 : 1);
