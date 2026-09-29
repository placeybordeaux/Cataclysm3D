// Download the CC-licensed CDDA sound packs into vendor/ (git-ignored).
//
// SFX: Fris0uman/CDDA-Soundpacks (CC-BY-SA 4.0, per-file CC0/CC-BY credits) as one tarball
// (~11 MB), unpacked to <vendor>/CDDA-Soundpacks.
// Music: Fris0uman/CDDA-Music-Packs (CC-BY-SA 4.0 repo, tracks by CO.AG used with their
// permission). The full pack is ~120 MB, so only musicset.json, the licence/credit files and
// the tracks we actually ship are fetched, one by one, into <vendor>/CDDA-Music-Packs.
// Already-present files are skipped, so re-running is cheap.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const HOST = 'https://codeload.' + 'github.com';
const RAW = 'https://raw.' + 'githubusercontent.com';
export const SFX_REPO = 'Fris0uman/CDDA-Soundpacks';
export const MUSIC_REPO = 'Fris0uman/CDDA-Music-Packs';
export const BRANCH = 'main';

async function download(url: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export async function fetchSfxPack(vendor: string, log: (s: string) => void): Promise<string> {
  const dest = join(vendor, 'CDDA-Soundpacks');
  if (existsSync(join(dest, 'sound', 'CC-Sounds', 'soundpack.txt'))) {
    log(`sfx pack already present: ${dest}`);
    return dest;
  }
  const url = `${HOST}/${SFX_REPO}/tar.gz/refs/heads/${BRANCH}`;
  log(`downloading ${url}`);
  const tgz = await download(url);
  mkdirSync(dest, { recursive: true });
  const tmp = join(vendor, '.cdda-soundpacks.tar.gz');
  writeFileSync(tmp, tgz);
  // Tarball root is "<repo>-<branch>/"; strip it so paths match the repo layout.
  execFileSync('tar', ['-xzf', tmp, '-C', dest, '--strip-components=1']);
  rmSync(tmp);
  log(`unpacked ${(tgz.length / 1e6).toFixed(1)} MB -> ${dest}`);
  return dest;
}

export const MUSIC_META_FILES = ['musicset.json', 'LICENSE.txt', 'credits.txt', 'README.md', 'CO.AG_authorisation.txt'];

/** Fetch music metadata + the given track files (paths relative to the music repo root). */
export async function fetchMusic(vendor: string, tracks: string[], log: (s: string) => void): Promise<string> {
  const dest = join(vendor, 'CDDA-Music-Packs');
  mkdirSync(dest, { recursive: true });
  for (const f of [...MUSIC_META_FILES, ...tracks]) {
    const out = join(dest, f);
    if (existsSync(out)) continue;
    const url = `${RAW}/${MUSIC_REPO}/${BRANCH}/${f}`;
    log(`downloading ${url}`);
    writeFileSync(out, await download(url));
  }
  return dest;
}
