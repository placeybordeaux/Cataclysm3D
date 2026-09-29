// Default game checkout for the world-data extractors (mapgen, npcs, vehicles, ui,
// achievements): Cataclysm: Bright Nights since v2. $CDDA_DIR overrides, as for the core
// extractor.
import os from 'node:os';
import path from 'node:path';

export function defaultGameDir(): string {
  return process.env.CDDA_DIR ?? path.join(os.homedir(), 'code/Cataclysm-BN');
}
