// CDDA sound packs -> public/audio/ (Opus-in-Ogg files + soundset.json + CREDITS.md).
//
// Source: the CC-Sounds pack (Fris0uman/CDDA-Soundpacks, CC0/CC-BY per file) plus a few
// CO.AG tracks from its music pack (Fris0uman/CDDA-Music-Packs). Both are fetched into
// vendor/ on first run (tools/audio/fetch.ts). The pack's `sound_effect` JSON is kept as-is
// semantically (id / variant / season / is_indoors / is_night / volume / files) so the runtime
// can apply CDDA's fallback rules; see src/audio/soundsetTypes.ts for the output format.
//
// Every shipped file must have a redistributable licence in the pack's credits files
// (tools/audio/credits.ts); files without one are dropped and listed, never shipped silently.
//
// Usage: npm run audio -- [--dry-run] [--no-fetch] [--vendor DIR] [--out DIR]
//                         [--music-tracks N] [--budget-mb N] [--exclude-ids a,b] [--jobs N]
// Needs ffmpeg/ffprobe (nix-shell provides them).

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AudioFileInfo, PlaylistDef, Season, SoundEffectDef, SoundsetFile } from '../../src/audio/soundsetTypes';
import { decide, isRedistributable, parseCreditsMd, parseCreditsTxt, type Credit } from './credits';
import { fetchMusic, fetchSfxPack, MUSIC_REPO, SFX_REPO } from './fetch';

const run = promisify(execFile);
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`audio: build public/audio/ from the CC-licensed CDDA sound packs
  --dry-run          select + licence-check + estimate sizes, write nothing (still fetches)
  --no-fetch         fail instead of downloading missing packs into the vendor dir
  --vendor DIR       where packs live (default /home/peter/code/CDDA-3d/vendor)
  --out DIR          output directory (default public/audio)
  --music-tracks N   how many CO.AG tracks of the "title" playlist to ship (default 6, 0 = none)
  --budget-mb N      fail if the output would exceed N MB (default 25)
  --exclude-ids a,b  CDDA sound_effect ids to skip (default: engine/vehicle ids, no vehicles yet)
  --jobs N           parallel ffmpeg processes (default 4)`);
  process.exit(0);
}
function arg(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const DRY = argv.includes('--dry-run');
const NO_FETCH = argv.includes('--no-fetch');
const VENDOR = resolve(arg('--vendor') ?? '/home/peter/code/CDDA-3d/vendor');
const OUT = resolve(arg('--out') ?? 'public/audio');
const MUSIC_TRACKS = Number(arg('--music-tracks') ?? 6);
const BUDGET_MB = Number(arg('--budget-mb') ?? 25);
const JOBS = Number(arg('--jobs') ?? 4);
const EXCLUDE_IDS = new Set(
  (arg('--exclude-ids') ??
    'engine_start,engine_stop,engine_working_external,engine_working_internal,vehicle,vehicle_open,vehicle_close')
    .split(',')
    .filter(Boolean),
);
for (const [k, v] of [['--music-tracks', MUSIC_TRACKS], ['--budget-mb', BUDGET_MB], ['--jobs', JOBS]] as const) {
  if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be a non-negative number`);
}

const C = process.stdout.isTTY
  ? { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, g: (s: string) => `\x1b[32m${s}\x1b[0m`, y: (s: string) => `\x1b[33m${s}\x1b[0m`, b: (s: string) => `\x1b[1m${s}\x1b[0m` }
  : { dim: (s: string) => s, g: (s: string) => s, y: (s: string) => s, b: (s: string) => s };
const log = (s: string) => console.log(s);
const mb = (n: number) => `${(n / 1e6).toFixed(2)} MB`;

// Encoding profiles. Everything is mono except music: positional sounds are panned by
// WebAudio anyway, and the pack's sources are mono 80 kbit/s Vorbis already.
interface Profile { name: string; args: string[]; kbps: number }
const PROFILES: Record<'sfx' | 'ambient' | 'music', Profile> = {
  sfx: { name: 'sfx', kbps: 40, args: ['-ac', '1', '-c:a', 'libopus', '-b:a', '40k', '-application', 'audio'] },
  ambient: { name: 'ambient', kbps: 40, args: ['-ac', '1', '-c:a', 'libopus', '-b:a', '40k', '-application', 'audio'] },
  music: { name: 'music', kbps: 64, args: ['-ac', '2', '-c:a', 'libopus', '-b:a', '64k', '-application', 'audio'] },
};

// ---------------------------------------------------------------- fetch & load

if (NO_FETCH && !existsSync(join(VENDOR, 'CDDA-Soundpacks'))) throw new Error(`no sound pack in ${VENDOR} (--no-fetch)`);
const sfxRoot = join(await fetchSfxPack(VENDOR, log), 'sound', 'CC-Sounds');

interface RawEffect {
  type: string;
  id: string;
  variant?: string | string[];
  season?: string;
  is_indoors?: boolean;
  is_night?: boolean;
  volume?: number;
  files: string[];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const allFiles = walk(sfxRoot).sort();
const warnings: string[] = [];

// Credits: index every statement by file stem, remembering which folder it came from so a
// stem reused in two folders (e.g. "open_door") is matched to the nearest credits file.
const creditsByStem = new Map<string, Credit[]>();
for (const f of allFiles) {
  const b = basename(f);
  let list: Credit[] = [];
  if (b === 'credits.md') list = parseCreditsMd(readFileSync(f, 'utf8'), relative(sfxRoot, f));
  else if (b === 'credits.txt') list = parseCreditsTxt(readFileSync(f, 'utf8'), relative(sfxRoot, f));
  for (const c of list) {
    const k = c.name.toLowerCase();
    creditsByStem.set(k, [...(creditsByStem.get(k) ?? []), c]);
  }
}
/**
 * Credits for an audio file: statements from its own folder or an ancestor win for
 * attribution. Any non-free statement about the same file name anywhere in the pack also
 * counts, because the pack copies files between folders (close_curtain is CC-BY in
 * close_door/window/credits.md but CC-BY-NC in open_door/window/credits.txt).
 */
function creditsFor(relFile: string): Credit[] {
  const all = creditsByStem.get(basename(relFile).replace(/\.\w+$/, '').toLowerCase()) ?? [];
  const dir = dirname(relFile);
  const near = all.filter((c) => dir === dirname(c.source) || dir.startsWith(dirname(c.source) + '/'));
  if (!near.length) return all;
  return [...near, ...all.filter((c) => !near.includes(c) && !isRedistributable(c.license))];
}

const SEASONS = new Set(['spring', 'summer', 'autumn', 'winter']);
const effects: SoundEffectDef[] = [];
const shipped = new Map<string, { src: string; profile: Profile; credits: Credit[] }>(); // out rel -> src
const dropped = new Map<string, string>(); // src rel -> reason
const outName = (rel: string) => 'sfx/' + rel.replace(/\.\w+$/, '.ogg').replace(/\s+/g, '_');

for (const f of allFiles.filter((f) => f.endsWith('.json'))) {
  const rel = relative(sfxRoot, f);
  const data = JSON.parse(readFileSync(f, 'utf8')) as RawEffect[];
  for (const e of data) {
    if (e.type !== 'sound_effect') throw new Error(`${rel}: unexpected type ${e.type}`);
    if (EXCLUDE_IDS.has(e.id)) continue;
    const variants = (e.variant === undefined ? ['default'] : Array.isArray(e.variant) ? e.variant : [e.variant]).map((v) => {
      // The pack has a few " t_chaingate_c" typos; CDDA would never match those either.
      if (v !== v.trim()) warnings.push(`${rel}: variant "${v}" has stray whitespace, trimmed`);
      return v.trim();
    });
    if (e.season !== undefined && !SEASONS.has(e.season)) throw new Error(`${rel}: bad season ${e.season}`);
    const profile = e.id === 'environment' && !/^thunder/.test(variants[0]) ? PROFILES.ambient : PROFILES.sfx;
    const files: string[] = [];
    for (const src of e.files) {
      if (!existsSync(join(sfxRoot, src))) throw new Error(`${rel}: missing file ${src}`);
      const d = decide(creditsFor(src));
      if (!d.ok) {
        dropped.set(src, d.reason!);
        continue;
      }
      const out = outName(src);
      shipped.set(out, { src: join(sfxRoot, src), profile, credits: d.credits });
      files.push(out);
    }
    if (!files.length) {
      warnings.push(`${rel}: ${e.id}/${variants.join(',')} has no shippable files, skipped`);
      continue;
    }
    const def: SoundEffectDef = { id: e.id, variants, volume: e.volume ?? 100, files };
    if (e.season) def.season = e.season as Season;
    if (e.is_indoors !== undefined) def.indoors = e.is_indoors;
    if (e.is_night !== undefined) def.night = e.is_night;
    effects.push(def);
  }
}

// ---------------------------------------------------------------- music

const playlists: PlaylistDef[] = [];
const musicCredits: string[] = [];
if (MUSIC_TRACKS > 0) {
  const musicDir = await fetchMusic(VENDOR, [], log);
  const set = JSON.parse(readFileSync(join(musicDir, 'musicset.json'), 'utf8')) as {
    playlists: { id: string; shuffle?: boolean; files: { file: string; volume: number }[] }[];
  }[];
  const title = set.flatMap((s) => s.playlists).find((p) => p.id === 'title');
  if (!title) throw new Error('musicset.json has no "title" playlist');
  // The pack's paths are "music/<file>" relative to the soundpack; in the music repo they sit at the root.
  const picked = title.files.slice(0, MUSIC_TRACKS);
  await fetchMusic(VENDOR, picked.map((t) => basename(t.file)), log);
  const lic = readFileSync(join(musicDir, 'LICENSE.txt'), 'utf8');
  if (!/Attribution-ShareAlike 4\.0/.test(lic)) throw new Error('music pack licence changed; re-check before shipping');
  const files = picked.map((t) => {
    const out = 'music/' + basename(t.file);
    shipped.set(out, { src: join(musicDir, basename(t.file)), profile: PROFILES.music, credits: [] });
    musicCredits.push(basename(t.file).replace(/^CO\.AG_/, '').replace(/\.ogg$/, ''));
    return { file: out, volume: t.volume };
  });
  playlists.push({ id: 'title', shuffle: title.shuffle ?? true, files });
}

// ---------------------------------------------------------------- report selection

const byId = new Map<string, number>();
for (const e of effects) byId.set(e.id, (byId.get(e.id) ?? 0) + e.files.length);
log(C.b(`\nselected ${effects.length} sound_effect entries, ${shipped.size} files`));
log(C.dim([...byId].map(([k, n]) => `${k}:${n}`).join('  ')));
if (dropped.size) {
  log(C.y(`\ndropped ${dropped.size} files (licence / attribution):`));
  for (const [f, r] of dropped) log(C.y(`  ✗ ${f}: ${r}`));
}
for (const w of warnings) log(C.y(`  ! ${w}`));

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`ffprobe: no duration for ${file}`);
  return d;
}
async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
}

const jobs = [...shipped.entries()];
if (DRY) {
  let est = 0;
  await pool(jobs, JOBS * 2, async ([, j]) => {
    // (don't write `est += await ...`: est would be read before the await and lose updates)
    const d = await probeDuration(j.src);
    est += (d * j.profile.kbps * 1000) / 8 + 800;
  });
  log(`\n${C.b('dry run')}: would write ${jobs.length} files to ${OUT}, estimated ${mb(est)} (budget ${BUDGET_MB} MB)`);
  if (est > BUDGET_MB * 1e6) throw new Error('estimated size exceeds budget');
  process.exit(0);
}

// ---------------------------------------------------------------- transcode

execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
// Cache in vendor/ (not committed): skip files whose source and profile are unchanged.
const cachePath = join(VENDOR, '.audio-build-cache.json');
const cache: Record<string, string> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const files: Record<string, AudioFileInfo> = {};
let done = 0, reused = 0;
await pool(jobs, JOBS, async ([out, j]) => {
  const dst = join(OUT, out);
  const key = `${j.src}|${statSync(j.src).mtimeMs}|${j.profile.args.join(' ')}`;
  if (cache[out] === key && existsSync(dst)) reused++;
  else {
    mkdirSync(dirname(dst), { recursive: true });
    await run('ffmpeg', ['-v', 'error', '-y', '-i', j.src, '-map_metadata', '-1', ...j.profile.args, dst]);
    cache[out] = key;
  }
  files[out] = { bytes: statSync(dst).size, duration: Math.round((await probeDuration(dst)) * 1000) / 1000 };
  done++;
  if (process.stdout.isTTY) process.stdout.write(`\r  transcoding ${'█'.repeat(Math.round((done / jobs.length) * 30)).padEnd(30, '░')} ${done}/${jobs.length}`);
});
if (process.stdout.isTTY) process.stdout.write('\n');
writeFileSync(cachePath, JSON.stringify(cache));

// Remove outputs of files no longer selected so public/audio never carries orphans.
for (const sub of ['sfx', 'music']) {
  const d = join(OUT, sub);
  if (!existsSync(d)) continue;
  for (const f of walk(d)) {
    const rel = relative(OUT, f);
    if (!shipped.has(rel)) {
      rmSync(f);
      log(C.dim(`  removed stale ${rel}`));
    }
  }
}

const sortedFiles = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
const soundset: SoundsetFile = {
  version: 1,
  sources: [
    { name: 'CC-Sounds (CDDA soundpack) by Fris0uman et al.', url: `https://github.com/${SFX_REPO}`, license: 'CC-BY-SA 4.0 pack; files CC0 / CC-BY, see CREDITS.md' },
    ...(playlists.length ? [{ name: 'Music by CO.AG (CDDA music pack, remastered by SkyBreach)', url: `https://github.com/${MUSIC_REPO}`, license: 'CC-BY-SA 4.0 pack; used with the composer\'s permission' }] : []),
  ],
  effects,
  playlists,
  files: sortedFiles,
};
writeFileSync(join(OUT, 'soundset.json'), JSON.stringify(soundset, null, 1) + '\n');

// ---------------------------------------------------------------- credits

const esc = (s: string) => s.replace(/\|/g, '\\|');
const lines = [
  '# Audio credits',
  '',
  'Generated by `npm run audio` (tools/audio). Do not edit by hand.',
  '',
  `Sound effects come from the **CC-Sounds** CDDA soundpack (https://github.com/${SFX_REPO}),`,
  'a continuation of the CO.AG soundpack by SkyBreach, maintained by Fris0uman and contributors.',
  'The pack is distributed under CC-BY-SA 4.0; each file below is CC0 or CC-BY as listed, from',
  'freesound.org. Files were transcoded to Opus (mono) and otherwise unmodified. Files whose',
  'licence is non-commercial, no-derivatives, Sampling+ or unattributed were not included.',
  '',
  '| File | Author | License | Source |',
  '|------|--------|---------|--------|',
];
for (const [out, j] of [...shipped].sort(([a], [b]) => a.localeCompare(b))) {
  if (!out.startsWith('sfx/')) continue;
  const c = j.credits[0];
  lines.push(`| ${esc(out)} | ${esc(c.author)} | ${esc(c.license)} | ${esc(c.link)} |`);
}
if (musicCredits.length) {
  lines.push(
    '',
    '## Music',
    '',
    'Original music composed and produced by **CO.AG**, remastered by SkyBreach, from the CDDA music',
    `pack (https://github.com/${MUSIC_REPO}, CC-BY-SA 4.0), used with the composer's permission`,
    '("fine to use my music as long as credit is given"; see CO.AG_authorisation.txt in that repo).',
    'CO.AG: https://www.youtube.com/channel/UCcavSftXHgxLBWwLDm_bNvA',
    '',
    ...musicCredits.map((t) => `- "${t}" by CO.AG — \`music/CO.AG_${t}.ogg\``),
  );
}
lines.push(
  '',
  '## Procedural sounds',
  '',
  'Sounds the packs lack (bullet impacts, metal hits, fire crackle, wind, UI confirm, monster',
  'growls/footsteps, heartbeat) are synthesized at runtime by src/audio/procedural.ts (no assets).',
  '',
);
writeFileSync(join(OUT, 'CREDITS.md'), lines.join('\n'));

// ---------------------------------------------------------------- summary

const total = Object.values(files).reduce((a, f) => a + f.bytes, 0);
const group = (p: string) => (p.startsWith('music/') ? 'music' : p.startsWith('sfx/environment/') ? 'ambient' : 'sfx');
const sums = new Map<string, number>();
for (const [p, f] of Object.entries(files)) sums.set(group(p), (sums.get(group(p)) ?? 0) + f.bytes);
log(`\n${C.g('✓')} wrote ${Object.keys(files).length} files (${reused} unchanged) to ${OUT}`);
for (const [g, n] of sums) log(`  ${g.padEnd(8)} ${mb(n)}`);
log(`  ${C.b('total'.padEnd(8))} ${C.b(mb(total))} of ${BUDGET_MB} MB budget`);
if (total > BUDGET_MB * 1e6) throw new Error(`output ${mb(total)} exceeds budget ${BUDGET_MB} MB`);
