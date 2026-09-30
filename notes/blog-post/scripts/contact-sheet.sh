#!/usr/bin/env bash
# Contact sheets of the blog images for reviewing them at a glance.
# Usage: contact-sheet.sh <out-prefix> [images...]   (default: every non-hero JPEG in images/)
# Writes <out-prefix>-N.jpg, 8 images per sheet (2 columns). Needs ImageMagick (nix-shell).
set -euo pipefail
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -lt 1 ]]; then sed -n '2,4p' "$0"; exit 0; fi
prefix=$1; shift
dir=$(dirname "$0")/../images
if [[ $# -gt 0 ]]; then files=("$@"); else mapfile -t files < <(ls "$dir"/*.jpg | grep -v -- '-hero.jpg'); fi
n=0
for ((i = 0; i < ${#files[@]}; i += 8)); do
  n=$((n + 1))
  magick montage "${files[@]:i:8}" -tile 2x -geometry 960x540+4+4 "$prefix-$n.jpg" 2>/dev/null || true
  echo "$prefix-$n.jpg: ${files[*]:i:8}"
done
