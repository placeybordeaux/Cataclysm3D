"""Side-by-side sheet for docs/CHARACTERS.md "Zombie readability": the UltiCa sprites of a
lineup's zombies on top, then the same row as rendered by tools/char-shots.ts in each style
(cropped to the band the row stands in), each labelled.

    uv run -q --with pillow python tools/zombie-compare.py \\
        --ids mon_boomer,mon_boomer_huge,... \\
        --shot "before (boxy)=docs/screenshots/zombies/before_zombie_lineup_c.jpg" \\
        --shot "after=docs/screenshots/zombies/after_zombie_lineup_c.jpg" \\
        --band 0.36,0.70 --out docs/screenshots/zombies/compare_specials.jpg

The sprites come from the project's atlas (public/atlas, the shared checkout's copy so a
worktree without generated files still works; --atlas overrides).
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageDraw

DEFAULT_ATLAS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'atlas', '')


def sprite(atlas, pages, tid):
    t = atlas['tiles'].get(tid)
    if not t or not t.get('fg'):
        raise SystemExit(f'no sprite for {tid} in the atlas')
    sp = t['fg'][0]['sprites'][0]
    if isinstance(sp, list):
        sp = sp[0]
    f = atlas['frames'][sp]
    return pages[f['page']].crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h']))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--ids', required=True, help='comma-separated monster ids, in lineup order')
    ap.add_argument('--shot', action='append', default=[], help='"label=path" of a lineup screenshot (repeatable)')
    ap.add_argument('--band', default='0.36,0.70', help='vertical crop of the screenshots, fractions top,bottom')
    ap.add_argument('--xband', default='0,1', help='horizontal crop of the screenshots, fractions left,right (far rows)')
    ap.add_argument('--width', type=int, default=1600, help='output width (px)')
    ap.add_argument('--atlas', default=DEFAULT_ATLAS)
    ap.add_argument('--out', required=True)
    ap.add_argument('--dry-run', action='store_true', help='print what would be composed, write nothing')
    a = ap.parse_args()
    ids = [i for i in a.ids.split(',') if i]
    shots = []
    for s in a.shot:
        if '=' not in s:
            raise SystemExit(f'--shot wants label=path, got {s!r}')
        label, path = s.rsplit('=', 1)
        if not os.path.exists(path):
            raise SystemExit(f'missing screenshot {path}')
        shots.append((label, path))
    top, bot = (float(x) for x in a.band.split(','))
    left, right = (float(x) for x in a.xband.split(','))
    if a.dry_run:
        print(f'would compose {len(ids)} sprites + {len(shots)} rows ({", ".join(l for l, _ in shots)}) -> {a.out}')
        return
    atlas = json.load(open(os.path.join(a.atlas, 'atlas.json')))
    pages = [Image.open(os.path.join(a.atlas, p['file'])).convert('RGBA') for p in atlas['pages']]
    W = a.width
    cell = W // len(ids)
    # sprites: nearest-scaled to fit a cell, bottoms aligned (feet on one line)
    sprites = [sprite(atlas, pages, i) for i in ids]
    k = max(1, min(cell // max(s.width for s in sprites), 6))
    sh = max(s.height for s in sprites) * k
    strip = Image.new('RGB', (W, sh + 34), (58, 58, 62))
    d = ImageDraw.Draw(strip)
    for n, (tid, s) in enumerate(zip(ids, sprites)):
        im = s.resize((s.width * k, s.height * k), Image.NEAREST)
        x = n * cell + (cell - im.width) // 2
        strip.paste(im, (x, 22 + sh - im.height), im)
        d.text((n * cell + 4, 4), tid.replace('mon_', ''), fill=(235, 235, 235))
    rows = [('UltiCa sprites', strip)]
    for label, path in shots:
        im = Image.open(path).convert('RGB')
        c = im.crop((int(im.width * left), int(im.height * top), int(im.width * right), int(im.height * bot)))
        # a zoomed far row keeps its pixels hard
        c = c.resize((W, int(c.height * W / c.width)), Image.NEAREST if W > c.width * 1.5 else Image.LANCZOS)
        rows.append((label, c))
    H = sum(r.height + 26 for _, r in rows)
    out = Image.new('RGB', (W, H), (30, 30, 34))
    d = ImageDraw.Draw(out)
    y = 0
    for label, r in rows:
        d.text((8, y + 7), label, fill=(255, 220, 140))
        out.paste(r, (0, y + 26))
        y += r.height + 26
    out.save(a.out, quality=88)
    print(f'{a.out}: {W}x{H}', file=sys.stderr)


if __name__ == '__main__':
    main()
