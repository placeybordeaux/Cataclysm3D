#!/usr/bin/env bash
# World screenshots of a Bright Nights world: shelter start, town street, house interior,
# forest, top-down town, overmap, classic lab. Usage: tools/bn-shots.sh [prefix] [seed]
#   (run from the repo root, inside nix-shell; wraps itself in tools/heavy)
# Output: shots/<prefix>_*.png and the OMTs visited on stdout.
set -euo pipefail
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then sed -n '2,5p' "$0"; exit 0; fi
P=${1:-bn}
SEED=${2:-1}
# The start town's centre is a road crossing; houses and forest are found from there.
TOWN='const s = cdda.startLocation(); const c = cdda.cities().filter(c => c.size >= 4).sort((a, b) => Math.hypot(a.x - s.omx, a.y - s.omy) - Math.hypot(b.x - s.omx, b.y - s.omy))[0];'
exec tools/heavy --mem 2 --name "cdda3d bn shots" -- npm run shot -- --params "seed=$SEED" --wait 1.5 \
  --eval 'cdda.godMode(true); cdda.setHour(11); cdda.settle()' --out "shots/${P}_shelter.png" \
  --eval "$TOWN cdda.teleportOmt(c.x, c.y, 0, 12, 20); cdda.look(0, -4); cdda.settle()" --out "shots/${P}_street.png" \
  --eval "$TOWN cdda.teleportOmt(c.x, c.y); const h = cdda.findOmt('house', 20); cdda.teleportOmt(h.x, h.y, 0, 12, 12); cdda.look(-120, -6); cdda.settle()" --out "shots/${P}_house.png" \
  --eval "const f = cdda.findOmt('forest_thick', 60); cdda.teleportOmt(f.x, f.y); cdda.look(30, 0); cdda.settle()" --out "shots/${P}_forest.png" \
  --eval "$TOWN cdda.teleportOmt(c.x, c.y); cdda.setCameraMode('top'); cdda.renderer.rig.topDistance = 60; cdda.settle()" --out "shots/${P}_town_top.png" \
  --eval "$TOWN cdda.setCameraMode('first'); cdda.teleportOmt(c.x, c.y); cdda.ui.open('map')" --out "shots/${P}_overmap.png" \
  --eval "cdda.pressKey?.('Escape'); const l = cdda.findOmt('lab_stairs', 80); cdda.teleportOmt(l.x, l.y, -1, 12, 12); cdda.look(45, -5); cdda.flashlight(true); cdda.settle()" --out "shots/${P}_lab.png" \
  --print "(() => { $TOWN return { town: c, street: cdda.omtAt(c.x, c.y), stats: cdda.worldgenStats() }; })()"
