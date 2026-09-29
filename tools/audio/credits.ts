// Parse the per-folder attribution files of CC-Sounds and decide which files we may ship.
//
// CC-Sounds keeps a `credits.md` markdown table in (almost) every sound folder:
//   | File Name | Author | License | Link |
//   | walk_dirt_1.ogg | nuFF3 | **CC-BY** | https://freesound.org/s/477396/ |
// and a few folders add a free-form `credits.txt`:
//   "close_curtain" and "open_curtain" by Tats14 (https://...) licensed under CC-BY-NC
// The two sometimes disagree (open_curtain is CC-BY in the .md, CC-BY-NC in the .txt), so a
// file is only shippable when every statement about it is a redistributable licence.

export interface Credit {
  /** file basename without extension, e.g. "walk_dirt_1" */
  name: string;
  author: string;
  license: string;
  link: string;
  /** credits file this came from, for error messages */
  source: string;
}

const stem = (f: string) => f.trim().replace(/\.(ogg|wav|mp3|flac)$/i, '');

export function parseCreditsMd(text: string, source: string): Credit[] {
  const out: Credit[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    const [file, author, rawLicense, link] = cells;
    if (!file || /^-+$/.test(file) || /^file name$/i.test(file)) continue;
    const license = rawLicense.replace(/\*/g, '').trim();
    out.push({ name: stem(file), author, license, link, source });
  }
  return out;
}

export function parseCreditsTxt(text: string, source: string): Credit[] {
  const out: Credit[] = [];
  const re = /^((?:"[^"]+"(?:,\s*|\s+and\s+)?)+)\s+by\s+(.+?)\s+\((\S+)\)\s+licensed under\s+(\S+)/i;
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (!m) continue;
    for (const n of m[1].matchAll(/"([^"]+)"/g)) {
      out.push({ name: stem(n[1]), author: m[2], license: m[4], link: m[3], source });
    }
  }
  return out;
}

/**
 * True for licences that allow redistribution in a commercial-friendly, modifiable way
 * (CC0 / CC-BY / CC-BY-SA, any version). NC, ND and the retired Sampling licences are out.
 */
export function isRedistributable(license: string): boolean {
  const l = license.toUpperCase().replace(/\s+/g, ' ').trim();
  if (!l) return false;
  if (/\bNC\b|NON-?COMMERCIAL|\bND\b|NO-?DERIV|SAMPLING/.test(l)) return false;
  // Every alternative in "CC-BY/CC0" style dual statements must be free.
  // Spellings seen: "CC0", "CC0 1.0", "CC 0", "CC-BY", "CC BY 3.0", "CC-BY-4.0".
  return l.split('/').every((part) => /^CC(0|BY(SA)?)(\d(\.\d)?)?$/.test(part.replace(/[\s-]/g, '')));
}

export interface CreditDecision {
  ok: boolean;
  credits: Credit[];
  reason?: string;
}

/** Decide on one audio file given every credit statement found for its stem. */
export function decide(credits: Credit[]): CreditDecision {
  if (credits.length === 0) return { ok: false, credits, reason: 'no attribution found' };
  const bad = credits.filter((c) => !isRedistributable(c.license));
  if (bad.length) return { ok: false, credits, reason: `licence ${bad.map((c) => `"${c.license}" (${c.source})`).join(', ')}` };
  return { ok: true, credits };
}
