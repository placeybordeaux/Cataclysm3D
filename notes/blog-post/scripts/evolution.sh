#!/usr/bin/env bash
# "Then and now" images for the blog: v1 (DDA, tag-era README gallery, commit f13503c) and v2
# (BN, end of wave 2, commit 941157a) screenshots pulled from git history, next to the current
# render of the same viewpoint (images/02 and 03 from blog-shots.ts), plus side-by-side
# composites (the tileset-vs-3D pairs too). Run from the repo root inside nix-shell (ImageMagick).
# Usage: notes/blog-post/scripts/evolution.sh [--dry-run]
set -euo pipefail
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then sed -n '2,7p' "$0"; exit 0; fi
dry=${1:-}
out=notes/blog-post/images
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# commit:path -> output name
pull() {
  if [[ $dry == --dry-run ]]; then echo "would write $out/$2.jpg from $1"; return; fi
  git show "$1" > "$tmp/$2.png"
  magick "$tmp/$2.png" -resize 960x540 -quality 82 -strip "$out/$2.jpg"
}
pull f13503c:docs/screenshots/01_shelter_start.png 70-v1-shelter
pull f13503c:docs/screenshots/02_town_street_golden_hour.png 71-v1-street
pull f13503c:docs/screenshots/03_zombie_melee.png 72-v1-zombie
pull 941157a:docs/screenshots/looks/full_shelter.png 73-v2-shelter
pull 941157a:docs/screenshots/looks/full_street.png 74-v2-street
[[ $dry == --dry-run ]] && { echo "would write composites 75-77"; exit 0; }
# v1 | v2 | now, 640x360 each
magick "$out/71-v1-street.jpg" "$out/74-v2-street.jpg" "$out/03-town-street.jpg" -resize 640x360 +append -quality 82 -strip "$out/75-evolution-street.jpg"
magick "$out/70-v1-shelter.jpg" "$out/73-v2-shelter.jpg" "$out/02-evac-shelter-inside.jpg" -resize 640x360 +append -quality 82 -strip "$out/76-evolution-shelter.jpg"
# UltiCa tiles | 3D engine, same place
magick "$out/63-compare-shelter-tiles.jpg" "$out/62-compare-shelter-3d.jpg" +append -resize 1920x540 -quality 82 -strip "$out/77-tiles-vs-3d-shelter.jpg"
magick "$out/61-compare-town-tiles.jpg" "$out/60-compare-town-3d.jpg" +append -resize 1920x540 -quality 82 -strip "$out/78-tiles-vs-3d-town.jpg"
# the v1 camera-facing zombie billboard | a wave-3 modelled horde
magick "$out/72-v1-zombie.jpg" "$out/10-horde-near.jpg" +append -resize 1920x540 -quality 82 -strip "$out/79-v1-vs-now-zombies.jpg"
# the five visual styles, same street, one strip (order: full classic crisp terrain voxel)
magick "$out/50-style-full.jpg" "$out/50-style-classic.jpg" "$out/50-style-crisp.jpg" "$out/50-style-terrain.jpg" "$out/50-style-voxel.jpg" -resize 384x216 +append -quality 82 -strip "$out/51-styles-strip.jpg"
ls -la "$out"/7*.jpg "$out"/51-*.jpg
