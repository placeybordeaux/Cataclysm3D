// Monsters that crawl instead of walking. BN has no flag for it: the data says so in words
// (mon_zombie_crawler: "drags itself along slowly with its arms.  Its legs are damaged beyond
// repair."; mon_crawler: "slowly dragging its eldritch body across the ground"; the pupating
// crawler: "This half of a human corpse"; mon_zombie_creepy is named "creepy crawler"). The
// tileset draws them low too. Shared by the 3D rig (render/chars) and the game's fallback body
// column (aimmodel bodyHeightOf), so a crawler is hit low whichever way it's drawn.

/**
 * How it crawls:
 *  - 'drag': prone, pulling itself along with its arms, the legs trailing limp behind
 *  - 'legless': prone, only a torso and arms (half a corpse)
 *  - 'fours': low on hands and knees, scuttling (a mutant child)
 */
export type CrawlPlan = 'drag' | 'legless' | 'fours';

export interface CrawlerLike {
  id: string;
  name?: unknown;
  description?: string;
  bodytype?: string;
  species?: readonly string[];
}

/** Fraction of a standing body's height a crawler's drawn body reaches (rig.ts crawl pose). */
export const CRAWL_HEIGHT: Record<CrawlPlan, number> = { drag: 0.3, legless: 0.27, fours: 0.55 };

const nameOf = (n: unknown): string =>
  typeof n === 'string' ? n : n && typeof n === 'object' && typeof (n as { str?: unknown }).str === 'string' ? (n as { str: string }).str : '';

/**
 * The crawl plan its data implies, or null for a walker. Only bodies that would otherwise be
 * upright humanoids: a "crawler" that is a spider (mon_zombie_gasbag_crawler, bodytype spider)
 * or a slug already moves like one.
 */
export function crawlPlanOf(m: CrawlerLike): CrawlPlan | null {
  // human-shaped: BN bodytype human, or no bodytype on a human/aberration species (mon_crawler);
  // not the sludge crawler (a slug) or the spidery gangrenous crawler
  const sp = m.species ?? [];
  if (m.bodytype ? m.bodytype !== 'human' : !sp.includes('HUMAN') && !sp.includes('ABERRATION')) return null;
  const d = m.description ?? '';
  const name = nameOf(m.name);
  if (/\bhalf of a (human )?(corpse|body)\b|\blegless\b|\bno legs\b/i.test(d)) return 'legless';
  if (/drags? itself|dragging its .*body|legs are (damaged|broken|gone|missing)/i.test(d)) return 'drag';
  if (/(^|_)crawler($|_)/.test(m.id)) return 'drag';
  if (/\bcrawler\b/i.test(name)) return 'fours';
  return null;
}
