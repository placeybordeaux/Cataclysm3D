"""Low-poly zombie models that read like their UltiCa sprites (docs/SPRITE3D.md).

Run inside Blender (headless), after tools/blender/export-rigs.ts:

    blender -b --factory-startup --python tools/blender/zombies.py -- [options]

    --rigs PATH       rig boxes + palettes (default tools/blender/rigs.json)
    --out DIR         where the GLBs + manifest.json go (default public/models/zombies)
    --sheets DIR      comparison sheets (default docs/screenshots/sprite3d)
    --models a,b      only these models (default: all in rigs.json)
    --no-render       skip the comparison renders
    --no-export       skip writing GLBs / manifest (renders only)
    --dry-run         build the meshes, print triangle counts, write nothing
    --help

Why the models are built this way:

* The game animates zombies as rigid boxes (src/render/chars/rig.ts + zombie.ts): poses, rag
  dolls and aim picking all read those boxes. So every mesh here is modelled *inside one rig
  box* and exported in that box's unit frame (-0.5..0.5): the game draws it with the box's own
  instance matrix (charLayer.ts) and nothing about animation changes. No armature, no skinning.
* Colours are not baked: a face's material names a *palette region* (`pal:shirt:0.85` = the
  shirt colour read off the sprite at runtime, shaded 0.85) or a fixed colour (`fix:7a1214`)
  or a glowing one (`glow:ff2a1e:0.9`). One walker model therefore wears every zombie sprite's
  clothes, exactly like the painted boxes do; only the specials have their own models.
* The look is a 2D-pixel-art one: few, large, flat-shaded facets; the proportions of the sprite
  (big head, mitt hands, short legs: zombie.ts buildOf 'sprite3d'); 2-3 tone steps per region,
  done with geometry (a lighter top ring, a darker underside), not texture.

Coordinates: meshes are authored in three.js terms (x = the model's right, y up, -z = front),
in metres around the box centre, then divided by the box size. Blender's frame is
(x, -z, y) of that; the glTF exporter turns it back into y-up.
"""

import json
import math
import os
import sys
import time

try:
    import bpy
    import bmesh  # noqa: F401  (used through bpy.ops-free mesh building below)
    from mathutils import Matrix, Vector
except ImportError:  # pragma: no cover
    bpy = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

# ------------------------------------------------------------------ args


def parse_args(argv):
    args = argv[argv.index('--') + 1:] if '--' in argv else []
    opt = {
        'rigs': os.path.join(ROOT, 'tools/blender/rigs.json'),
        'out': os.path.join(ROOT, 'public/models/zombies'),
        'sheets': os.path.join(ROOT, 'docs/screenshots/sprite3d'),
        'models': None, 'render': True, 'export': True, 'dry': False,
    }
    i = 0
    while i < len(args):
        a = args[i]
        if a in ('--help', '-h'):
            print(__doc__)
            sys.exit(0)
        elif a == '--rigs':
            opt['rigs'] = os.path.abspath(args[i + 1]); i += 1
        elif a == '--out':
            opt['out'] = os.path.abspath(args[i + 1]); i += 1
        elif a == '--sheets':
            opt['sheets'] = os.path.abspath(args[i + 1]); i += 1
        elif a == '--models':
            opt['models'] = args[i + 1].split(','); i += 1
        elif a == '--no-render':
            opt['render'] = False
        elif a == '--no-export':
            opt['export'] = False
        elif a == '--dry-run':
            opt['dry'] = True
        else:
            raise SystemExit(f'unknown argument {a} (--help)')
        i += 1
    return opt


# ------------------------------------------------------------------ mesh building (pure python)


class M:
    """A mesh under construction: vertices (three.js metres, box-centred) and faces with a
    material name each. Faces are convex polygons wound outward-ish; normals are recomputed."""

    def __init__(self):
        self.v = []
        self.f = []  # (indices, material)
        self.decals = set()  # face indices that must face the front (-z) whatever recalc says

    def vert(self, p):
        self.v.append((float(p[0]), float(p[1]), float(p[2])))
        return len(self.v) - 1

    def face(self, idx, mat):
        self.f.append((list(idx), mat))

    def ring(self, y, w, d, n=8, ox=0.0, oz=0.0, phase=None, front=0.0, back=0.0, sq=1.0):
        """n points round an ellipse-ish ring at height y. `front`/`back` push the -z / +z
        halves out (a chest, a brow, a heel); `sq` < 1 squares the ring off."""
        if phase is None:
            phase = math.pi / n
        out = []
        for k in range(n):
            a = phase + k * 2 * math.pi / n
            c, s = math.cos(a), math.sin(a)
            # superellipse-ish: sq<1 pushes points toward the corners
            cx = math.copysign(abs(c) ** sq, c)
            sz = math.copysign(abs(s) ** sq, s)
            z = sz * d / 2
            if z < 0:
                z *= 1 + front
            else:
                z *= 1 + back
            out.append(self.vert((ox + cx * w / 2, y, oz + z)))
        return out

    def bridge(self, r1, r2, mat):
        n = len(r1)
        for k in range(n):
            j = (k + 1) % n
            m = mat(k) if callable(mat) else mat
            self.face([r1[k], r1[j], r2[j], r2[k]], m)

    def cap(self, r, mat, apex=None):
        if apex is None:
            self.face(list(reversed(r)) if False else r, mat)
            return
        a = self.vert(apex)
        n = len(r)
        for k in range(n):
            self.face([r[k], r[(k + 1) % n], a], mat(k) if callable(mat) else mat)

    def loft(self, secs, n, mats, cap_lo='flat', cap_hi='flat', lo_mat=None, hi_mat=None, phase=None):
        """secs: [(y, w, d, ox, oz, front, back)] bottom to top; mats(seg, k) or a name."""
        rings = []
        for s in secs:
            y, w, d = s[0], s[1], s[2]
            ox = s[3] if len(s) > 3 else 0.0
            oz = s[4] if len(s) > 4 else 0.0
            fr = s[5] if len(s) > 5 else 0.0
            bk = s[6] if len(s) > 6 else 0.0
            rings.append(self.ring(y, w, d, n, ox, oz, phase, fr, bk))
        for i in range(len(rings) - 1):
            self.bridge(rings[i], rings[i + 1], (lambda k, i=i: mats(i, k)) if callable(mats) else mats)
        lm = lo_mat or (mats(0, 0) if callable(mats) else mats)
        hm = hi_mat or (mats(len(rings) - 2, 0) if callable(mats) else mats)
        if cap_lo == 'flat':
            self.face(list(reversed(rings[0])), lm)
        elif cap_lo:
            y, (cx, cz) = cap_lo
            self.cap(list(reversed(rings[0])), lm, (cx, y, cz))
        if cap_hi == 'flat':
            self.face(rings[-1], hm)
        elif cap_hi:
            y, (cx, cz) = cap_hi
            self.cap(rings[-1], hm, (cx, y, cz))
        return rings

    def block(self, c, s, mat, taper=(1.0, 1.0)):
        """An axis box (centre c, size s); `taper` scales the top face's x, z (wedges)."""
        x, y, z = c
        w, h, d = s[0] / 2, s[1] / 2, s[2] / 2
        tx, tz = taper
        lo = [self.vert((x - w, y - h, z - d)), self.vert((x + w, y - h, z - d)), self.vert((x + w, y - h, z + d)), self.vert((x - w, y - h, z + d))]
        hi = [self.vert((x - w * tx, y + h, z - d * tz)), self.vert((x + w * tx, y + h, z - d * tz)), self.vert((x + w * tx, y + h, z + d * tz)), self.vert((x - w * tx, y + h, z + d * tz))]
        self.face(list(reversed(lo)), mat)
        self.face(hi, mat)
        for k in range(4):
            j = (k + 1) % 4
            self.face([lo[k], lo[j], hi[j], hi[k]], mat(k) if callable(mat) else mat)

    def decal(self, c, w, h, mat):
        """A flat quad facing -z (the front) at c: paint on a surface for 2 triangles instead of
        a 12-triangle block. Sits a few mm proud so it never z-fights."""
        x, y, z = c
        a = [self.vert((x - w / 2, y - h / 2, z)), self.vert((x - w / 2, y + h / 2, z)), self.vert((x + w / 2, y + h / 2, z)), self.vert((x + w / 2, y - h / 2, z))]
        self.decals.add(len(self.f))
        self.face(a, mat)

    def merge(self, other):
        base = len(self.v)
        self.decals |= {i + len(self.f) for i in other.decals}
        self.v.extend(other.v)
        for idx, m in other.f:
            self.f.append(([i + base for i in idx], m))

    def tris(self):
        return sum(len(i) - 2 for i, _ in self.f)


def pal(region, shade=1.0):
    return f'pal:{region}:{shade:.2f}'


def fix(rgb):
    return 'fix:%02x%02x%02x' % tuple(int(max(0, min(255, round(c)))) for c in rgb)


def glow(rgb, k):
    return 'glow:%02x%02x%02x:%.2f' % (tuple(int(max(0, min(255, round(c)))) for c in rgb) + (k,))


BLOOD = (122, 18, 20)
BLOOD_DARK = (84, 12, 14)
MOUTH = (34, 14, 16)
TEETH = (196, 186, 150)
SOCKET = (26, 24, 22)
EYE = (214, 196, 92)
BONE = (206, 196, 166)

# ------------------------------------------------------------------ the parts
#
# Every part function gets (sx, sy, sz): the rig box size in metres, and `st`: the model's
# style knobs (STYLES below). It returns an M in metres, centred on the box. Shapes may poke a
# little out of their box (hair, a hem, claws): aim picking reads the box, not the mesh.


def tone(top, mid, low):
    """Light from above: three steps down a part (the sprites' top-lit shading)."""
    def f(seg, k, n):
        if seg >= n - 1:
            return top
        if seg == 0:
            return low
        return mid
    return f


def p_torso(sx, sy, sz, st):
    m = M()
    w, d, h = sx, sz, sy
    y0, y1 = -h / 2, h / 2
    shirt = st['shirt']
    sl = st.get('sleeveless', False)
    # waist -> belly -> chest -> shoulders -> collar; the chest pushes forward (front)
    secs = [
        (y0 - 0.03, w * 0.86, d * 0.92, 0, 0, 0.05, 0),
        (y0 + h * 0.3, w * 0.86, d * 0.95, 0, 0, 0.12, 0),
        (y0 + h * 0.66, w * 1.0, d * 1.0, 0, -d * 0.03, 0.18, 0.05),
        (y0 + h * 0.9, w * 0.98, d * 0.88, 0, 0, 0.05, 0.1),
        (y1, w * 0.5, d * 0.62, 0, 0, 0, 0),
    ]

    def mats(seg, k):
        # k: ring index (0 = the right side front corner, going round toward the back)
        front = k in (4, 5, 6, 7) if False else None
        if sl and seg >= 3 and k in (0, 3, 4, 7):
            return pal('skin', 0.95)
        if seg == 3:
            return pal(shirt, 1.12)
        if seg == 0:
            return pal(shirt, 0.78)
        return pal(shirt, 0.95)
    rings = m.loft(secs, 8, mats, cap_lo='flat', cap_hi='flat', lo_mat=pal(shirt, 0.6), hi_mat=pal('skin', 0.9))
    # torn hem: jagged teeth hanging off the waist ring, and a hole showing belly skin
    lo = rings[0]
    for k in range(8):
        if (k * 5 + st['seed']) % 3 == 0:
            continue
        a, b = m.v[lo[k]], m.v[lo[(k + 1) % 8]]
        tip = ((a[0] + b[0]) / 2 * 1.04, a[1] - 0.05 - 0.03 * ((k * 7) % 3), (a[2] + b[2]) / 2 * 1.04)
        m.face([lo[(k + 1) % 8], lo[k], m.vert(tip)], pal(shirt, 0.8))
    if st.get('inner'):
        # an open jacket / undershirt: a front panel down the chest
        m.decal((0, y0 + h * 0.5, -d * 0.58), w * 0.32, h * 0.7, pal('inner', 1.0))
    # gore on the chest and a torn hole showing skin (top-lit sprite reads this at 30 px)
    m.decal((-w * 0.18, y0 + h * 0.3, -d * 0.6), w * 0.24, h * 0.16, pal('skin', 0.85))
    if st.get('blood', 0) > 0.6:
        # a sprite this red is soaked: whole flanks of the shirt are blood
        for sgn in (-1, 1):
            m.block((sgn * w * 0.4, y0 + h * 0.55, -d * 0.1), (w * 0.24, h * 0.7, d * 1.1), fix(BLOOD))
    if st.get('blood', 0) > 0.2:
        m.decal((w * 0.16, y0 + h * 0.62, -d * 0.62), w * 0.2, h * 0.2, fix(BLOOD))
        m.decal((w * 0.2, y0 + h * 0.42, -d * 0.6), w * 0.08, h * 0.2, fix(BLOOD_DARK))
    return m


def p_hips(sx, sy, sz, st):
    m = M()
    w, h, d = sx, sy, sz
    secs = [(-h / 2, w * 0.92, d * 0.92), (0, w, d), (h / 2, w * 0.96, d * 0.96)]
    m.loft(secs, 8, lambda s, k: pal('pants', 0.9 if s == 0 else 1.0), lo_mat=pal('pants', 0.6), hi_mat=pal('pants', 0.6))
    # belt line
    m.block((0, h * 0.36, 0), (w * 1.02, h * 0.16, d * 1.02), pal('shoes', 0.7))
    return m


def p_neck(sx, sy, sz, st):
    m = M()
    m.loft([(-sy / 2, sx * 1.05, sz * 1.05), (sy / 2, sx * 0.9, sz * 0.9)], 6, pal('skin', 0.8))
    return m


def p_head(sx, sy, sz, st):
    """The cranium: a faceted egg, hair on top and round the back, a heavy brow, dark sockets
    with a dull glint, a nose. The jaw is its own part (headJaw)."""
    m = M()
    w, h, d = sx, sy, sz
    y0 = -h / 2
    bald = st.get('bald', False)
    hair = 'skin' if bald else 'hair'
    secs = [
        (y0, w * 0.82, d * 0.8, 0, 0.0, 0.0, 0.05),
        (y0 + h * 0.35, w * 0.98, d * 0.98, 0, 0, 0.06, 0.08),
        (y0 + h * 0.62, w * 1.0, d * 1.0, 0, 0, 0.1, 0.06),
        (y0 + h * 0.86, w * 0.86, d * 0.9, 0, 0.01, 0, 0.04),
    ]

    # ring index k: phase pi/8, k=0..7 going counter-clockwise from +x; front (-z) is k 4..7
    front = {5, 6}
    side_front = {4, 7}

    def mats(seg, k):
        if seg == 2:
            # the crown band: hair all round except the forehead
            if k in front:
                return pal('skin', 1.05)
            return pal(hair, 1.0)
        if seg == 1:
            if k in front:
                return pal('skin', 0.95)
            if k in side_front:
                return pal('skin', 0.85)
            return pal(hair, 0.85)
        if k in front or k in side_front:
            return pal('skin', 0.8)
        return pal(hair, 0.7)
    m.loft(secs, 8, mats, cap_lo='flat', cap_hi=(y0 + h * 1.02, (0, 0.01)), lo_mat=pal('skin', 0.55), hi_mat=pal(hair, 1.15))
    # brow ridge, sockets and their glint, nose (all on the front, -z)
    fz = -d / 2 * 1.08
    m.block((0, y0 + h * 0.6, fz + 0.004), (w * 0.72, h * 0.1, 0.03), pal('skin', 1.08))
    for sgn in (-1, 1):
        m.decal((sgn * w * 0.2, y0 + h * 0.44, fz - 0.002), w * 0.22, h * 0.16, fix(SOCKET))
        m.block((sgn * w * 0.2, y0 + h * 0.45, fz - 0.008), (w * 0.07, h * 0.06, 0.006), glow(st.get('eye', EYE), st.get('eyeGlow', 0.15)))
    m.block((0, y0 + h * 0.28, fz - 0.01), (w * 0.12, h * 0.2, 0.04), pal('skin', 0.92), taper=(0.6, 0.5))
    # ears
    for sgn in (-1, 1):
        m.block((sgn * w * 0.5, y0 + h * 0.4, 0.0), (0.02, h * 0.22, d * 0.18), pal('skin', 0.75))
    if st.get('ponytail') and not bald:
        m.loft([(y0 + h * 0.7, w * 0.25, w * 0.25, 0, d * 0.55), (y0 + h * 0.2, w * 0.2, w * 0.2, 0, d * 0.75), (y0 - h * 0.3, w * 0.12, w * 0.12, 0, d * 0.7)], 5, pal('hair', 1.0))
    if st.get('cap'):
        m.loft([(y0 + h * 0.78, w * 1.08, d * 1.06), (y0 + h * 1.05, w * 0.9, d * 0.92)], 8, pal('inner', 1.0) if st.get('inner') else fix(st['cap']), cap_hi=(y0 + h * 1.12, (0, 0)))
        m.block((0, y0 + h * 0.8, -d * 0.62), (w * 0.8, 0.012, d * 0.4), fix(st['cap']))
    return m


def p_jaw(sx, sy, sz, st):
    m = M()
    w, h, d = sx, sy, sz
    secs = [(-h / 2, w * 0.66, d * 0.72, 0, -d * 0.05, 0.1, 0), (h / 2, w * 0.98, d, 0, 0, 0.06, 0)]
    m.loft(secs, 8, lambda s, k: pal('skin', 0.85 if k in (4, 5, 6, 7) else 0.7), lo_mat=pal('skin', 0.6), hi_mat=fix(MOUTH))
    # lower teeth along the front edge, dark mouth, a blood drip
    m.block((0, h / 2 + 0.006, -d * 0.4), (w * 0.62, 0.016, 0.022), fix(TEETH))
    m.decal((w * 0.12, -h * 0.1, -d * 0.55), w * 0.12, h * 0.6, fix(BLOOD))
    return m


def p_upper_arm(sx, sy, sz, st):
    m = M()
    w, h, d = sx, sy, sz
    sleeve = 'skin' if st.get('sleeveless') else st['shirt']
    secs = [(-h / 2, w * 0.82, d * 0.82), (-h * 0.1, w * 0.95, d * 0.95), (h / 2, w, d)]
    m.loft(secs, 6, lambda s, k: pal(sleeve, 1.0 if k in (1, 2) else 0.82), lo_mat=pal('skin', 0.7), hi_mat=pal(sleeve, 1.0))
    if not st.get('sleeveless'):
        # a ragged sleeve end
        m.loft([(-h / 2 + h * 0.18, w * 1.06, d * 1.06), (-h / 2 + h * 0.02, w * 1.0, d * 1.0)], 6, pal(sleeve, 0.78), cap_lo=None, cap_hi=None)
    return m


def p_fore_arm(sx, sy, sz, st):
    m = M()
    w, h, d = sx, sy, sz
    reg = st.get('forearm', 'skin')
    secs = [(-h / 2, w * 0.7, d * 0.7), (h * 0.15, w, d), (h / 2, w * 0.9, d * 0.9)]
    m.loft(secs, 6, lambda s, k: pal(reg, 0.95 if k in (1, 2) else 0.78), lo_mat=pal(reg, 0.7), hi_mat=pal(reg, 0.7))
    if st.get('blood', 0) > 0.2:
        m.decal((0, -h * 0.25, -d * 0.5), w * 0.5, h * 0.3, fix(BLOOD_DARK))
    return m


def p_hand(sx, sy, sz, st):
    """A clawing mitt: palm + three fingers curling toward the palm (-z), dark nails. Brutes
    get a clenched fist (st['fist'])."""
    m = M()
    w, h, d = sx, sy, sz
    if st.get('gloves'):
        g = st['gloves']
        m.loft([(-h / 2, w * 0.9, d * 0.95), (0, w, d), (h / 2, w * 0.85, d * 0.85)], 6, lambda s, k: fix([v * (1.2 if s == 1 else 0.9) for v in g]), lo_mat=fix(g))
        return m
    if st.get('fist'):
        m.loft([(-h / 2, w * 0.95, d * 0.95), (0, w, d), (h / 2, w * 0.8, d * 0.85)], 6, pal('skin', 0.9), lo_mat=pal('skin', 0.7))
        m.block((0, -h * 0.3, -d * 0.45), (w * 0.9, h * 0.25, d * 0.2), pal('skin', 1.0))
        m.block((0, -h * 0.45, 0), (w * 0.8, 0.02, d * 0.6), fix(BLOOD_DARK))
        return m
    palm_h = h * 0.5
    m.loft([(h / 2 - palm_h, w * 0.95, d * 0.85), (h / 2, w * 0.75, d * 0.8)], 6, pal('skin', 0.92), lo_mat=pal('skin', 0.7))
    fw = w * 0.26
    for i, x in enumerate((-w * 0.33, 0.0, w * 0.33)):
        ln = h * (0.5 if i == 1 else 0.44)
        top = h / 2 - palm_h
        # two segments: straight down, then curled toward the palm (-z)
        m.block((x, top - ln * 0.28, 0), (fw, ln * 0.56, d * 0.6), pal('skin', 0.85))
        m.block((x, top - ln * 0.7, -d * 0.18), (fw * 0.8, ln * 0.4, d * 0.5), pal('skin', 0.75), taper=(1.0, 1.0))
        m.block((x, top - ln * 0.95, -d * 0.3), (fw * 0.6, ln * 0.14, d * 0.3), fix((52, 44, 34)))
    # thumb
    m.block((w * 0.52, h * 0.05, -d * 0.2), (w * 0.2, h * 0.3, d * 0.5), pal('skin', 0.8))
    return m


def p_thigh(sx, sy, sz, st):
    m = M()
    w, h, d = sx, sy, sz
    m.loft([(-h / 2, w * 0.82, d * 0.82, 0, 0, 0.1), (h * 0.1, w * 0.98, d, 0, 0, 0.08), (h / 2, w, d)], 6,
           lambda s, k: pal('pants', 1.0 if k in (3, 4) else 0.85), lo_mat=pal('pants', 0.7), hi_mat=pal('pants', 0.9))
    if st.get('blood', 0) > 0.2:
        m.decal((w * 0.1, -h * 0.1, -d * 0.52), w * 0.4, h * 0.25, fix(BLOOD_DARK))
    return m


def p_shin(sx, sy, sz, st):
    m = M()
    w, h, d = sx, sy, sz
    reg = 'skin' if st.get('shorts') else 'pants'
    m.loft([(-h / 2, w * 0.82, d * 0.8), (h * 0.2, w, d, 0, 0, 0, 0.1), (h / 2, w * 0.95, d * 0.95)], 6,
           lambda s, k: pal(reg, 0.95 if k in (3, 4) else 0.8), lo_mat=pal(reg, 0.7), hi_mat=pal(reg, 0.8))
    if not st.get('shorts'):
        # a torn trouser cuff
        m.loft([(-h / 2 + 0.01, w * 1.08, d * 1.06), (-h / 2 + h * 0.18, w * 1.0, d * 1.0)], 6, pal('pants', 0.7), cap_lo=None, cap_hi=None)
    return m


def p_foot(sx, sy, sz, st):
    """A shoe along -z: heel at +z, toe at -z, a lighter sole edge."""
    m = M()
    w, h, d = sx, sy, sz
    secs = [  # along z: (z, w, h)
        (d / 2, w * 0.8, h), (d * 0.1, w, h), (-d * 0.35, w * 0.95, h * 0.85), (-d / 2, w * 0.7, h * 0.55),
    ]
    rings = []
    for z, ww, hh in secs:
        r = []
        for k in range(6):
            a = math.pi / 6 + k * math.pi / 3
            r.append(m.vert((math.cos(a) * ww / 2, -h / 2 + (math.sin(a) + 1) / 2 * hh, z)))
        rings.append(r)
    for i in range(len(rings) - 1):
        m.bridge(rings[i], rings[i + 1], lambda k: pal('shoes', 0.65 if k in (3, 4, 5) else 1.0))
    m.face(rings[0], pal('shoes', 0.8))
    m.face(list(reversed(rings[-1])), pal('shoes', 0.9))
    return m


def p_delt(sx, sy, sz, st):
    m = M()
    w, h, d = sx, sy, sz
    reg = 'skin' if st.get('sleeveless') else st['shirt']
    m.loft([(-h / 2, w * 0.7, d * 0.7), (0, w, d), (h / 2, w * 0.6, d * 0.6)], 6, lambda s, k: pal(reg, 1.08 if s == 1 else 0.88), cap_hi=(h * 0.6, (0, 0)), lo_mat=pal(reg, 0.7))
    return m


def p_hump(sx, sy, sz, st):
    m = M()
    w, h, d = sx, sy, sz
    reg = 'skin' if st.get('sleeveless') else st['shirt']
    m.loft([(-h / 2, w * 0.6, d * 0.6), (0, w, d), (h / 2, w * 0.7, d * 0.6)], 6, lambda s, k: pal(reg, 1.05 if s == 1 else 0.85))
    return m


def p_belly(sx, sy, sz, st):
    """A distended ball of belly: shirt over the top riding up, pale skin bulging below."""
    m = M()
    w, h, d = sx, sy, sz
    secs = [(-h / 2, w * 0.45, d * 0.45), (-h * 0.3, w * 0.86, d * 0.86), (0, w, d), (h * 0.28, w * 0.9, d * 0.9), (h / 2, w * 0.5, d * 0.5)]
    up = st['shirt']

    top = 3 if st.get('bellySkin') else 2  # a boomer's shirt has ridden right up

    def mats(seg, k):
        if seg >= top:
            return pal(up, 1.0 if seg == 2 else 1.1)
        return pal('skin', 1.05 if seg in (1, 2) else 0.8)
    m.loft(secs, 8, mats, lo_mat=pal('skin', 0.7), hi_mat=pal(up, 1.1))
    # torn shirt edge hanging over the skin, a navel, blood
    m.block((0, -h * 0.06, -d * 0.5), (w * 0.12, h * 0.06, 0.02), pal('skin', 0.6))
    if st.get('blood', 0) > 0.2:
        m.block((w * 0.2, h * 0.15, -d * 0.52), (w * 0.22, h * 0.18, 0.02), fix(BLOOD))
    return m


# gear (bespoke models only)


def p_helmet(sx, sy, sz, st):
    m = M()
    w, h, d = sx, sy, sz
    c = st['helmet']
    m.loft([(-h / 2, w, d), (h * 0.1, w * 0.96, d * 0.96), (h / 2, w * 0.66, d * 0.66)], 8, lambda s, k: fix([v * (1.15 if s == 1 else 0.9) for v in c]), cap_hi=(h * 0.62, (0, 0.0)), lo_mat=fix([v * 0.5 for v in c]))
    return m


def p_visor(sx, sy, sz, st):
    m = M()
    m.block((0, 0, 0), (sx, sy, sz), glow((150, 176, 200), 0.1))
    return m


def p_badge(sx, sy, sz, st):
    m = M()
    m.block((0, 0, 0), (sx, sy, sz), glow((214, 186, 90), 0.2), taper=(0.6, 1.0))
    return m


def p_vest(sx, sy, sz, st):
    m = M()
    w, h, d = sx, sy, sz
    c = st['vest']
    m.loft([(-h / 2, w * 0.92, d * 0.9), (0, w, d), (h / 2, w * 0.9, d * 0.86)], 8, lambda s, k: fix([v * (1.1 if s == 1 else 0.88) for v in c]), lo_mat=fix([v * 0.7 for v in c]))
    # camo blotches
    for i, (x, y) in enumerate(((-0.3, 0.2), (0.25, -0.1), (0.05, 0.3), (-0.1, -0.3))):
        m.block((w * x, h * y, -d * 0.51), (w * 0.22, h * 0.18, 0.01), fix([v * (0.7 if i % 2 else 1.25) for v in c]))
    return m


def p_pouch(sx, sy, sz, st):
    m = M()
    m.block((0, 0, 0), (sx, sy, sz), fix([v * 0.85 for v in st['vest']]))
    return m


def p_sac(sx, sy, sz, st):
    """A glowing acid sac: a lumpy faceted ball (the game pulses its box)."""
    m = M()
    c = (176, 214, 64)
    m.loft([(-sy / 2, sx * 0.5, sz * 0.5), (-sy * 0.15, sx, sz), (sy * 0.2, sx * 0.95, sz * 0.95), (sy / 2, sx * 0.45, sz * 0.45)], 6,
           lambda s, k: glow([v * (1.1 if s == 1 else 0.85) for v in c], 0.55))
    return m


def p_drool(sx, sy, sz, st):
    m = M()
    m.loft([(-sy / 2, sx * 0.4, sz * 0.4), (sy / 2, sx, sz)], 5, glow((190, 220, 80), 0.7))
    return m


def p_rib(sx, sy, sz, st):
    m = M()
    m.loft([(-sy / 2, sx, sz), (sy / 2, sx * 0.96, sz)], 6, fix(BONE))
    return m


PARTS = {
    'torso': p_torso, 'hips': p_hips, 'neck': p_neck, 'head': p_head, 'headJaw': p_jaw,
    'uArmR': p_upper_arm, 'uArmL': p_upper_arm, 'fArmR': p_fore_arm, 'fArmL': p_fore_arm,
    'handR': p_hand, 'handL': p_hand, 'thighR': p_thigh, 'thighL': p_thigh, 'shinR': p_shin, 'shinL': p_shin,
    'footR': p_foot, 'footL': p_foot, 'uArmDeltR': p_delt, 'uArmDeltL': p_delt, 'torsoHump': p_hump, 'torsoBelly': p_belly,
    'headHelmet': p_helmet, 'headVisor': p_visor, 'torsoBadge': p_badge, 'torsoVest': p_vest,
    'torsoPouch0': p_pouch, 'torsoPouch1': p_pouch, 'torsoPouch2': p_pouch,
    'sac0': p_sac, 'sac1': p_sac, 'sac2': p_sac, 'sac3': p_sac, 'sac4': p_sac, 'uArmSac5': p_sac, 'thighSac6': p_sac, 'sac7': p_sac, 'fxDrool': p_drool,
    'torsoRib0': p_rib, 'torsoRib1': p_rib, 'torsoRib2': p_rib, 'torsoRib3': p_rib,
}

# Per-model knobs, from looking at the sprites (docs/SPRITE3D.md "What the sprites say").
STYLES = {
    'walker': {'shirt': 'shirt', 'seed': 1},
    'fat': {'shirt': 'shirt', 'seed': 2, 'cap': (220, 220, 214)},
    'brute': {'shirt': 'shirt', 'seed': 0, 'sleeveless': True, 'fist': True},
    'runner': {'shirt': 'shirt', 'seed': 2, 'ponytail': True, 'shorts': True},
    'cop': {'shirt': 'shirt', 'seed': 1, 'helmet': (30, 36, 58), 'forearm': 'shirt', 'gloves': (24, 26, 32)},
    'soldier': {'shirt': 'shirt', 'seed': 0, 'helmet': (78, 84, 56), 'vest': (92, 96, 62), 'forearm': 'shirt'},
    'boomer': {'shirt': 'shirt', 'seed': 1, 'bellySkin': True},
    'spitter': {'shirt': 'shirt', 'seed': 2},
    'child': {'shirt': 'shirt', 'seed': 0},
    'skeleton': {'shirt': 'skin', 'seed': 1, 'bald': True, 'eye': (40, 30, 24), 'eyeGlow': 0.0},
}

# ------------------------------------------------------------------ palette -> preview colours


def resolve_rgb(mat, palette):
    """sRGB 0..255 colour + glow 0..1 for a material name, with this model's sprite palette."""
    kind, rest = mat.split(':', 1)
    if kind == 'fix':
        return tuple(int(rest[i:i + 2], 16) for i in (0, 2, 4)), 0.0
    if kind == 'glow':
        hexs, k = rest.split(':')
        return tuple(int(hexs[i:i + 2], 16) for i in (0, 2, 4)), float(k)
    region, shade = rest.split(':')
    c = palette.get(region) or palette.get('shirt')
    return tuple(max(0, min(255, v * float(shade))) for v in c), 0.0


# ------------------------------------------------------------------ Blender side

C3 = None  # three.js -> Blender frame


def three_to_blender():
    # (x, y, z)_three -> (x, -z, y)_blender
    return Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def make_material(name, palette):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    rgb, g = resolve_rgb(name, palette)
    lin = [srgb_to_linear(v) for v in rgb]
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*lin, 1.0)
    bsdf.inputs['Roughness'].default_value = 1.0
    if 'Specular IOR Level' in bsdf.inputs:
        bsdf.inputs['Specular IOR Level'].default_value = 0.0
    if g > 0:
        bsdf.inputs['Emission Color'].default_value = (*lin, 1.0)
        bsdf.inputs['Emission Strength'].default_value = g * 1.5
    mat.diffuse_color = (*lin, 1.0)
    return mat


def to_object(name, mesh, size, palette, normalise=True):
    """A Blender object from an M: vertices divided by the box size (unit frame) when
    normalise, converted to Blender's frame; flat-shaded; one material slot per name."""
    sx, sy, sz = size
    verts = []
    for x, y, z in mesh.v:
        if normalise:
            x, y, z = x / sx, y / sy, z / sz
        verts.append((x, -z, y))
    names = sorted({m for _, m in mesh.f})
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], [idx for idx, _ in mesh.f])
    me.validate(clean_customdata=False)
    for nm in names:
        me.materials.append(make_material(nm, palette))
    idx = {nm: i for i, nm in enumerate(names)}
    for poly, (_, m) in zip(me.polygons, mesh.f):
        poly.material_index = idx[m]
        poly.use_smooth = False
    # faces were authored with loose winding: make every normal point outward
    import bmesh as _bm
    bm = _bm.new()
    bm.from_mesh(me)
    _bm.ops.recalc_face_normals(bm, faces=bm.faces)
    # a lone decal quad has no inside for recalc to find: it faces the front (three -z =
    # Blender +y), always
    bm.faces.ensure_lookup_table()
    flip = [bm.faces[i] for i in mesh.decals if bm.faces[i].normal.y < 0]
    if flip:
        _bm.ops.reverse_faces(bm, faces=flip)
    bm.to_mesh(me)
    bm.free()
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        bpy.data.meshes.remove(me)
    for ma in list(bpy.data.materials):
        bpy.data.materials.remove(ma)


def build_model(md, hi=False):
    """Objects for every meshed part of a model (unit frames). Returns {part: object}."""
    st = dict(STYLES[md['model']])
    pal_ = md['palette']
    st['blood'] = pal_.get('blood', 0)
    st['bald'] = st.get('bald', False) or pal_.get('bald', False)
    if pal_.get('inner'):
        st['inner'] = True
    obs = {}
    parts = [p for p in md['parts'] if p['mesh']]
    have = {p['name'] for p in parts}
    for name in md['contract']:
        if name not in have:
            # another monster of the family has it (a corrosive zombie's eighth sac): built at a
            # nominal size, the game stretches the unit-frame mesh into whatever box it gets
            parts.append({'name': name, 'size': [0.1, 0.1, 0.1]})
    for p in parts:
        fn = PARTS.get(p['name'])
        if not fn:
            raise SystemExit(f"{md['model']}: no mesh builder for meshed part {p['name']}")
        mesh = fn(*p['size'], st)
        ob = to_object(p['name'], mesh, p['size'], pal_)
        if hi:
            # the close-range variant: one Catmull-Clark step rounds every facet off, then
            # flat shading keeps it reading as facets (4x the triangles)
            mod = ob.modifiers.new('sub', 'SUBSURF')
            mod.levels = 1
            mod.render_levels = 1
            bpy.context.view_layer.objects.active = ob
            with bpy.context.temp_override(object=ob, active_object=ob):
                bpy.ops.object.modifier_apply(modifier='sub')
            for poly in ob.data.polygons:
                poly.use_smooth = False
        obs[p['name']] = ob
    return obs


def tri_count(obs):
    return sum(sum(len(pl.vertices) - 2 for pl in ob.data.polygons) for ob in obs.values())


def export_glb(obs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for ob in obs.values():
        ob.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True,
        export_yup=True, export_normals=True, export_materials='EXPORT', export_texcoords=False,
        export_animations=False, export_skins=False, export_morph=False,
    )


# ------------------------------------------------------------------ validation renders

# The UltiCa people are drawn from the side, three-quarters toward the viewer, a little from
# above; facing right. Tuned by eye against the sprites (docs/SPRITE3D.md).
VIEW_AZIMUTH = float(os.environ.get("SPRITE3D_AZ", "35"))   # degrees from pure side view toward the front
VIEW_ELEVATION = 16.0
PX_PER_M = 48 / 1.75  # monsterView.ts MON_PPM: a 32x48 sprite is a 1.75 m person
SUPER = 8             # render at 8x, then pixel-art downsample


def assemble_preview(md, obs):
    """Copies of the part objects placed by their idle-pose box matrices (world, Blender)."""
    C = three_to_blender()
    Ci = C.inverted()
    out = []
    for p in md['parts']:
        ob = obs.get(p['name'])
        if ob is None:
            continue
        b = p['box']
        Mb = Matrix(((b[0], b[4], b[8], b[12]), (b[1], b[5], b[9], b[13]), (b[2], b[6], b[10], b[14]), (0, 0, 0, 1)))
        cp = ob.copy()
        cp.data = ob.data
        cp.hide_render = False
        cp.matrix_world = C @ Mb @ Ci
        bpy.context.scene.collection.objects.link(cp)
        out.append(cp)
    return out


def setup_render(w, h, height_m):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 24
    sc.cycles.use_denoising = False
    sc.render.film_transparent = True
    sc.render.resolution_x = w
    sc.render.resolution_y = h
    sc.render.resolution_percentage = 100
    sc.render.filter_size = 0.01
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    world = bpy.data.worlds.get('W') or bpy.data.worlds.new('W')
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.42, 0.42, 0.45, 1)
    bg.inputs['Strength'].default_value = 1.6
    sc.world = world
    # key light from the upper left of the picture (UltiCa's light), toward the camera
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 3.2
    sun.angle = 0.05
    so = bpy.data.objects.new('sun', sun)
    sc.collection.objects.link(so)
    so.rotation_euler = (math.radians(40), 0, math.radians(-120))
    cam = bpy.data.cameras.new('cam')
    cam.type = 'ORTHO'
    cam.ortho_scale = max(w, h) / SUPER / PX_PER_M  # (the big render keeps it: same canvas in m)
    co = bpy.data.objects.new('cam', cam)
    sc.collection.objects.link(co)
    sc.camera = co
    # the figure faces +y (three's -z): look at it from its right side (+x), turned toward the
    # front, from slightly above
    az, el = math.radians(VIEW_AZIMUTH), math.radians(VIEW_ELEVATION)
    dist = 10
    target = Vector((0, 0, height_m * 0.5))
    pos = target + Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el))) * dist
    co.location = pos
    co.rotation_euler = (target - pos).to_track_quat('-Z', 'Y').to_euler()
    return co


def render_to_pixels(path):
    sc = bpy.context.scene
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    w, h = img.size
    px = list(img.pixels)
    bpy.data.images.remove(img)
    return w, h, px


def downsample(w, h, px, k):
    """Pixel-art downsample: per k x k block the most common (quantised) colour of the covered
    samples, transparent under 40 % coverage; then a 1 px dark outline on the silhouette's own
    edge, as UltiCa draws it. px is Blender's float RGBA, rows bottom-up. Returns rows top-down
    of (r, g, b, a) bytes."""
    W, H = w // k, h // k
    out = [[(0, 0, 0, 0)] * W for _ in range(H)]
    for by in range(H):
        for bx in range(W):
            counts = {}
            cov = 0
            for yy in range(k):
                for xx in range(k):
                    x, y = bx * k + xx, (h - 1) - (by * k + yy)
                    i = (y * w + x) * 4
                    a = px[i + 3]
                    if a < 0.5:
                        continue
                    cov += 1
                    rgb = tuple(int(max(0, min(1, px[i + c])) * 255) for c in range(3))
                    q = (rgb[0] >> 3, rgb[1] >> 3, rgb[2] >> 3)
                    e = counts.setdefault(q, [0, 0, 0, 0])
                    e[0] += 1
                    e[1] += rgb[0]; e[2] += rgb[1]; e[3] += rgb[2]
            if cov < k * k * 0.4:
                continue
            n, r, g, b = max(counts.values(), key=lambda e: e[0])
            out[by][bx] = (r // n, g // n, b // n, 255)
    edge = []
    for y in range(H):
        for x in range(W):
            if out[y][x][3] == 0:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                xx, yy = x + dx, y + dy
                if xx < 0 or yy < 0 or xx >= W or yy >= H or out[yy][xx][3] == 0:
                    edge.append((x, y))
                    break
    for x, y in edge:
        r, g, b, _ = out[y][x]
        out[y][x] = (int(r * 0.3), int(g * 0.3), int(b * 0.32), 255)
    return out


def load_png_rows(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    px = list(img.pixels)
    bpy.data.images.remove(img)
    rows = []
    for y in range(h):
        sy = h - 1 - y
        rows.append([tuple(int(round(px[(sy * w + x) * 4 + c] * 255)) for c in range(4)) for x in range(w)])
    return rows


def save_rows(rows, path):
    h, w = len(rows), len(rows[0])
    img = bpy.data.images.new('sheet', w, h, alpha=True)
    flat = []
    for y in range(h - 1, -1, -1):
        for r, g, b, a in rows[y]:
            flat.extend((r / 255, g / 255, b / 255, a / 255))
    img.pixels = flat
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def blit(dst, src, ox, oy, scale, bg):
    for y, row in enumerate(src):
        for x, c in enumerate(row):
            if c[3] < 128:
                continue
            for yy in range(scale):
                for xx in range(scale):
                    dst[oy + y * scale + yy][ox + x * scale + xx] = c[:3] + (255,)


def bbox_rows(rows):
    ys = [y for y, r in enumerate(rows) if any(c[3] >= 128 for c in r)]
    xs = [x for r in rows for x, c in enumerate(r) if c[3] >= 128]
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1) if xs else (0, 0, 1, 1)


def place_like(src, sprite_rows, scale):
    """Crop/pad a rendered figure into the sprite's frame (x scale): its feet on the sprite's
    lowest opaque row, centred on the sprite's opaque columns."""
    sb = bbox_rows(sprite_rows)
    mb = bbox_rows(src)
    sh, sw = len(sprite_rows) * scale, len(sprite_rows[0]) * scale
    dx = round((sb[0] + sb[2]) / 2 * scale - (mb[0] + mb[2]) / 2)
    dy = sb[3] * scale - mb[3]
    out = [[(0, 0, 0, 0)] * sw for _ in range(sh)]
    for y, row in enumerate(src):
        ty = y + dy
        if ty < 0 or ty >= sh:
            continue
        for x, c in enumerate(row):
            tx = x + dx
            if 0 <= tx < sw and c[3] >= 128:
                out[ty][tx] = c
    return out


def render_model(md, obs, sheets, tmp):
    """sprite | 3D at sprite scale | 3D large: one comparison sheet per model."""
    sw, sh = md['sprite']['w'], md['sprite']['h']
    sprite = load_png_rows(os.path.join(ROOT, 'tools/blender', md['sprite']['file']))
    preview = assemble_preview(md, obs)
    # (the unit-frame originals all sit at the origin: keep them out of the picture)
    for ob in obs.values():
        ob.hide_render = True
    # a canvas a bit bigger than the sprite at the game's px/m; placed into the sprite's frame
    # (feet on its foot row) afterwards
    cw, ch = sw + 24, sh + 24
    cam = setup_render(cw * SUPER, ch * SUPER, md['height'])
    # Scale: the sprite's figure height, not the game's px/m. UltiCa draws a zombie ~29 px tall
    # in a 48 px frame; the comparison is about shape, so the 3D figure is scaled to the same
    # height (in game the LOD billboard is sized the other way round, monsterView.ts).
    w, h, px = render_to_pixels(os.path.join(tmp, md['model'] + '_probe.png'))
    probe = bbox_rows(downsample(w, h, px, SUPER))
    sb = bbox_rows(sprite)
    cam.data.ortho_scale *= (probe[3] - probe[1]) / (sb[3] - sb[1])
    w, h, px = render_to_pixels(os.path.join(tmp, md['model'] + '_small.png'))
    small = place_like(downsample(w, h, px, SUPER), sprite, 1)
    big_k = 6
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = cw * big_k, ch * big_k
    w2, h2, px2 = render_to_pixels(os.path.join(tmp, md['model'] + '_big.png'))
    big = place_like(downsample(w2, h2, px2, 1), sprite, big_k)
    for ob in preview:
        bpy.data.objects.remove(ob, do_unlink=True)
    for ob in obs.values():
        ob.hide_render = False
    for name in ('sun', 'cam'):
        ob = bpy.data.objects.get(name)
        if ob:
            bpy.data.objects.remove(ob, do_unlink=True)
    # sheet: [sprite x6 | 3D small x6 | 3D big] and, underneath, both at 2x and at 1x
    S = big_k
    pad = 8
    sheetW = sw * S * 3 + pad * 4
    sheetH = sh * S + pad * 3 + sh * 2
    bg = (88, 88, 98, 255)
    rows = [[bg] * sheetW for _ in range(sheetH)]
    blit(rows, sprite, pad, pad, S, bg)
    blit(rows, small, pad * 2 + sw * S, pad, S, bg)
    blit(rows, big, pad * 3 + sw * S * 2, pad, 1, bg)
    y1 = pad * 2 + sh * S
    blit(rows, sprite, pad, y1, 2, bg)
    blit(rows, small, pad * 2 + sw * 2, y1, 2, bg)
    blit(rows, sprite, pad * 3 + sw * 4, y1 + sh // 2, 1, bg)
    blit(rows, small, pad * 4 + sw * 5, y1 + sh // 2, 1, bg)
    out = os.path.join(sheets, f"compare_{md['model']}.png")
    save_rows(rows, out)
    return out, small, sprite


def contact_sheet(items, path):
    """All models: sprite over 3D, 3x."""
    S, pad = 3, 6
    cw = max(len(s[0]) for s, _ in items) * S + pad
    chh = max(len(s) for s, _ in items) * S
    W = cw * len(items) + pad
    H = chh * 2 + pad * 3
    bg = (88, 88, 98, 255)
    rows = [[bg] * W for _ in range(H)]
    for i, (spr, sm) in enumerate(items):
        x = pad + i * cw
        blit(rows, spr, x, pad + chh - len(spr) * S, S, bg)
        blit(rows, sm, x, pad * 2 + chh * 2 - len(sm) * S, S, bg)
    save_rows(rows, path)


# ------------------------------------------------------------------ main


def main():
    opt = parse_args(sys.argv)
    if bpy is None:
        raise SystemExit('run inside Blender: blender -b --factory-startup --python tools/blender/zombies.py -- --help')
    rigs = json.load(open(opt['rigs']))
    models = [m for m in rigs['models'] if not opt['models'] or m['model'] in opt['models']]
    if opt['models']:
        missing = set(opt['models']) - {m['model'] for m in models}
        if missing:
            raise SystemExit(f'not in {opt["rigs"]}: {sorted(missing)}')
    tmp = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'cdda-sprite3d')
    os.makedirs(tmp, exist_ok=True)
    if not opt['dry']:
        if opt['export']:
            os.makedirs(opt['out'], exist_ok=True)
        if opt['render']:
            os.makedirs(opt['sheets'], exist_ok=True)
    manifest_path = os.path.join(opt['out'], 'manifest.json')
    manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {'models': {}}
    manifest['generated'] = 'tools/blender/zombies.py'
    pairs = []
    for md in models:
        t0 = time.time()
        clear_scene()
        lo = build_model(md)
        lo_tris = tri_count(lo)
        parts = sorted(lo.keys())
        entry = {'lo': f"{md['model']}.glb", 'hi': f"{md['model']}_hi.glb", 'parts': parts, 'monster': md['monster']}
        if opt['dry']:
            clear_scene()
            hi = build_model(md, hi=True)
            print(f"[dry-run] {md['model']:9s} {len(parts)} parts  lo {lo_tris} tris  hi {tri_count(hi)} tris")
            continue
        if opt['render']:
            out, small, spr = render_model(md, lo, opt['sheets'], tmp)
            pairs.append((spr, small))
            print(f"  sheet {out}")
        if opt['export']:
            export_glb(lo, os.path.join(opt['out'], entry['lo']))
            clear_scene()
            hi = build_model(md, hi=True)
            entry['tris'] = {'lo': lo_tris, 'hi': tri_count(hi)}
            export_glb(hi, os.path.join(opt['out'], entry['hi']))
            manifest['models'][md['model']] = entry
        print(f"{md['model']:9s} {len(parts)} parts  lo {lo_tris} tris  ({time.time() - t0:.1f}s)")
    if opt['dry']:
        return
    if opt['export']:
        with open(manifest_path, 'w') as f:
            json.dump(manifest, f, indent=1, sort_keys=True)
        print(f'wrote {manifest_path}')
    if opt['render'] and len(pairs) > 1:
        path = os.path.join(opt['sheets'], 'compare_all.png')
        contact_sheet(pairs, path)
        print(f'wrote {path}')


if __name__ == '__main__':
    main()
