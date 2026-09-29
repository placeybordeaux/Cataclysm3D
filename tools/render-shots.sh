#!/usr/bin/env bash
# Renderer regression screenshots of the test scene (?gen=test): day outside/inside, dusk,
# night with flashlight, night outside, top-down, third-person, rain, campfire at night,
# pond, brick house interior, forest, top-down over the road.
# Usage: tools/render-shots.sh [prefix] [extra URL params, e.g. "&grade=smooth"]
#   (run from the repo root, inside nix-shell; wraps itself in ~/claude-stuff/bin/heavy)
# Output: shots/<prefix>_*.png plus renderer stats on stdout.
set -euo pipefail
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then sed -n '2,6p' "$0"; exit 0; fi
P=${1:-r}
X=${2:-}
exec ~/claude-stuff/bin/heavy --mem 1.5 --name "cdda3d render" -- npm run shot -- --params "seed=1&gen=test&debug=1$X" --wait 1.2 \
  --eval 'cdda.setHour(12); cdda.teleport(9.5, 23.5); cdda.look(-8, 4); cdda.settle()' --out "shots/${P}_day_out.png" \
  --eval 'cdda.setHour(13); cdda.teleport(12.5, 10.5); cdda.look(-60, -8); cdda.settle()' --out "shots/${P}_day_in.png" \
  --eval 'cdda.setHour(19.6); cdda.teleport(22.5, 20.5); cdda.look(-50, 6); cdda.settle()' --out "shots/${P}_dusk.png" \
  --eval 'cdda.setHour(23.5); cdda.teleport(12.5, 10.5); cdda.look(-60, -12); cdda.flashlight(true); cdda.settle()' --out "shots/${P}_night_flash.png" \
  --eval 'cdda.setHour(23.5); cdda.teleport(9.5, 22.5); cdda.look(0, 2); cdda.flashlight(false); cdda.settle()' --out "shots/${P}_night_out.png" \
  --eval 'cdda.setHour(15); cdda.teleport(9.5, 9.5); cdda.look(0, 0); cdda.setCameraMode("top"); cdda.settle()' --out "shots/${P}_top.png" \
  --eval 'cdda.setHour(16.5); cdda.teleport(9.5, 16.5); cdda.look(10, -5); cdda.setCameraMode("third"); cdda.settle()' --out "shots/${P}_third.png" \
  --eval 'cdda.setHour(10); cdda.setCameraMode("first"); cdda.setWeather("rain"); cdda.teleport(20.5, 18.5); cdda.look(-60, 0); cdda.settle()' --out "shots/${P}_rain.png" \
  --eval 'cdda.setWeather("clear"); cdda.setHour(22); cdda.teleport(9.5, 34.5); cdda.look(-45, -6); cdda.settle()' --out "shots/${P}_campfire.png" \
  --eval 'cdda.setHour(9); cdda.teleport(6.5, 36.5); cdda.look(95, -6); cdda.settle()' --out "shots/${P}_pond.png" \
  --eval 'cdda.setHour(11); cdda.teleport(33.5, 11.5); cdda.look(-35, 0); cdda.settle()' --out "shots/${P}_brick_in.png" \
  --eval 'cdda.setHour(14); cdda.teleport(-1.5, 15.5); cdda.look(-80, 3); cdda.settle()' --out "shots/${P}_forest.png" \
  --eval 'cdda.setHour(18); cdda.teleport(24.5, 21.5); cdda.look(0, 0); cdda.setCameraMode("top"); cdda.settle()' --out "shots/${P}_top2.png" \
  --print 'cdda.renderStats()'
