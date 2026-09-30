#!/usr/bin/env python3
"""Compose the official-screenshot comparison images (original | ours) with ImageMagick.

Inputs:
  images/originals/bn-readme-title.png, images/originals/dda-ultica-showcase-sep-2021.png
  <raw>/rc-<scene>-top.png and rc-<scene>-fp.png (full-size captures from
  `blog-shots.ts --shots recreate-shots.js --raw <raw>`)
Outputs (in images/):
  rc-<scene>-pair.jpg        one panel: the original's map area | our straight-down view, same size
  rc-bn-compare.jpg          all four BN panels, original left, ours right
  rc-dda-compare.jpg         the DDA showcase on top, our four panels below in the same layout
  rc-bn-strip.jpg / rc-dda-strip.jpg   the original with our four first-person views underneath

Our top view is cropped to the panel's tile size (recreate-scenes.js `panel`) around the capture's
centre: the capture spans max(h, w*9/16) tiles vertically (see recreate.top()).

Usage: recreate-compose.py --raw DIR [--out images] [--dry-run]   (needs `magick` on PATH: nix-shell)
"""
import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
ORIG = os.path.join(HERE, "images", "originals")

# scene: (original file, map-area crop WxH+X+Y in the original, panel tiles w, h)
PANELS = {
    "bn_fire": ("bn-readme-title.png", (555, 360, 0, 0), 17, 11),
    "bn_horde": ("bn-readme-title.png", (500, 360, 640, 0), 19, 14),
    "bn_lab": ("bn-readme-title.png", (525, 360, 0, 360), 25, 17),
    "bn_temple": ("bn-readme-title.png", (500, 360, 640, 360), 24, 17),
    "dda_street": ("dda-ultica-showcase-sep-2021.png", (598, 800, 0, 0), 19, 25),
    "dda_forest": ("dda-ultica-showcase-sep-2021.png", (598, 800, 598, 0), 19, 25),
    "dda_farm": ("dda-ultica-showcase-sep-2021.png", (598, 800, 1196, 0), 19, 25),
    "dda_lab": ("dda-ultica-showcase-sep-2021.png", (596, 800, 1794, 0), 19, 25),
}
CAP_W, CAP_H = 1920, 1080


def run(args, dry):
    if dry:
        print("would run: magick " + " ".join(args))
        return
    subprocess.run(["magick", *args], check=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", required=True, help="dir with the full-size rc-*.png captures")
    ap.add_argument("--out", default=os.path.join(HERE, "images"))
    ap.add_argument("--tmp", default=os.path.join(os.environ.get("TMPDIR", "/tmp"), "cdda3d-rc-compose"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if not a.dry_run and not shutil.which("magick"):
        sys.exit("magick not on PATH: run inside nix-shell")
    os.makedirs(a.tmp, exist_ok=True)
    for s in PANELS:
        for kind in ("top", "fp"):
            p = os.path.join(a.raw, f"rc-{s}-{kind}.png")
            if not os.path.exists(p):
                sys.exit(f"missing capture {p}")

    crops = {}
    for s, (orig, (w, h, x, y), tw, th) in PANELS.items():
        o = os.path.join(a.tmp, f"{s}-orig.png")
        run([os.path.join(ORIG, orig), "-crop", f"{w}x{h}+{x}+{y}", "+repage", o], a.dry_run)
        span_h = max(th, tw * 9 / 16)
        ppt = CAP_H / span_h
        cw, ch = round(tw * ppt), round(th * ppt)
        ours = os.path.join(a.tmp, f"{s}-ours.png")
        run([os.path.join(a.raw, f"rc-{s}-top.png"), "-gravity", "center", "-crop", f"{cw}x{ch}+0+0", "+repage",
             "-resize", f"{w}x{h}!", ours], a.dry_run)
        crops[s] = (o, ours, w, h)
        run([o, ours, "-background", "#111", "-splice", "8x0", "+append", "-chop", "8x0",
             "-quality", "85", "-strip", os.path.join(a.out, f"rc-{s}-pair.jpg")], a.dry_run)

    # BN: four rows of original | ours
    rows = []
    for s in ("bn_fire", "bn_horde", "bn_lab", "bn_temple"):
        o, ours, w, h = crops[s]
        r = os.path.join(a.tmp, f"{s}-row.png")
        # +gravity before the splice: with gravity center the gap lands mid-image
        run([o, ours, "-resize", "x360", "-background", "#111", "-gravity", "center", "-extent", "555x360",
             "+gravity", "-splice", "8x0", "+append", "-chop", "8x0", r], a.dry_run)
        rows.append(r)
    run([*rows, "-background", "#111", "-splice", "0x8", "-append", "-chop", "0x8", "-quality", "85", "-strip",
         os.path.join(a.out, "rc-bn-compare.jpg")], a.dry_run)

    # DDA: original on top, ours below in the same four-panel layout (at 75% to keep the file small)
    dda_ours = os.path.join(a.tmp, "dda-ours.png")
    run([*(crops[s][1] for s in ("dda_street", "dda_forest", "dda_farm", "dda_lab")), "+append", dda_ours], a.dry_run)
    run([os.path.join(ORIG, "dda-ultica-showcase-sep-2021.png"), dda_ours, "-resize", "2390x800!", "-background", "#111",
         "-splice", "0x10", "-append", "-chop", "0x10", "-resize", "75%", "-quality", "85", "-strip",
         os.path.join(a.out, "rc-dda-compare.jpg")], a.dry_run)

    # strips: the original over our four first-person views
    for key, orig, scenes in (("bn", "bn-readme-title.png", ("bn_fire", "bn_horde", "bn_lab", "bn_temple")),
                              ("dda", "dda-ultica-showcase-sep-2021.png", ("dda_street", "dda_forest", "dda_farm", "dda_lab"))):
        width = 1280 if key == "bn" else 1600
        fps = os.path.join(a.tmp, f"{key}-fps.png")
        run([*(os.path.join(a.raw, f"rc-{s}-fp.png") for s in scenes), "-resize", f"{width // 2}x", "(", "-clone", "0,1",
             "+append", ")", "(", "-clone", "2,3", "+append", ")", "-delete", "0-3", "-append", fps], a.dry_run)
        run([os.path.join(ORIG, orig), "-resize", f"{width}x", fps, "-background", "#111", "-splice", "0x10", "-append",
             "-chop", "0x10", "-quality", "82", "-strip", os.path.join(a.out, f"rc-{key}-strip.jpg")], a.dry_run)


if __name__ == "__main__":
    main()
