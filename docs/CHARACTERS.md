# Characters: 3D pixel-textured creatures (wave 3)

Monsters, NPCs and their corpses used to be camera-facing billboards of their UltiCa sprite.
Next to 3D geometry that read as cardboard cut-outs turning to follow you. They are now
**low-poly procedural bodies** in the Project Shadowglass manner: boxes with nearest-filtered
pixel-art textures at the project's **32 texels per metre**, **stepped animation** (10 poses
per second), turning to face where they walk or what they fight. The sprite is the
inspiration and the paint source; the model is the thing you walk around.

The billboards are still there as a variant.

| Switch | |
|---|---|
| `?chars=model` / `?chars=billboard` | URL, wins for the session |
| Options → **Creatures** | `3D models` / `sprites`, persisted (`localStorage cdda3d.chars`) |
| `cdda.chars('billboard')` | debug console; switches live, rebuilding every creature and body |
| `cdda.chars({ fps: 12 })` | pose rate (0 = every frame, smooth) |
| `cdda.chars({ far: [16, 45], emph: 0.35 })` | hostile readability ramp (m) and strength |
| `cdda.chars()` | current settings + live/body/skin/page counts |

## How it works (src/render/chars/)

| File | What |
|---|---|
| `archetype.ts` | Body plan from BN data: `bodytype` first (human, quadruped, dog, pig, bear, horse, gator, insect, spider, crab, bird, "flying insect", blob, snake, fish, frog, migo, angel), then species/flags/symbol for the ~120 without one (robots, plants, fungi, nether). Size from BN `volume` (ml), clamped. Zombie builds (fat, brute, hulk, child, skeleton…) from the id. Pure. |
| `rig.ts` | Rigid-part skeletons + poses per archetype: **humanoid** (hips, torso, head, two-segment arms and legs, feet; optional wings), **quadruped**/**critter** (body, head, 4 legs, tail, ears), **insect** (thorax, abdomen, head, 6 or 8 two-segment legs, antennae or fangs), **flyer** (body, head, wings, tail/abdomen), **blob** (mass + lumps, squash & stretch), **serpent** (7-segment chain), **plant** (base, stalk, bulb, leaves), **machine** (tracked body + turret head, or a turret), **lump** (fallback). Each pose function covers idle, walk/run, wind-up (melee/heavy/leap), strike follow-through, flinch, downed and dead. Pure. |
| `paint.ts` | Skins. Each box gets a Minecraft-style net; the part's rect of the sprite (opaque box, v down) is projected onto its front (people: drawn facing us) or right side (animals: drawn in profile, head to the right); other faces reuse the crop mirrored / its edge columns / hair rows for the back of heads. Sprite outlines are removed first (they would stripe every box edge), texels take the most common sprite colour in their footprint snapped to the sprite's own 16-colour ramp (a pixel-art downsample, not a blur), and every face gets a 1-texel darker rim. Pure (RGBA arrays), unit-tested. |
| `charLayer.ts` | Rendering: one `InstancedMesh` of a unit cube per skin page (1024², shelf-packed), one instance per body part. Per-instance face rects (the vertex shader picks the net rect from the face id), flash colour, sky visibility and the creature root (light-map sample, distance). Banded Lambert + light map + MRT normals like everything else, so outlines, flashlight, lamps and shadow maps just work. Two layers: live creatures (rewritten every frame) and bodies (rewritten only when one is added, removed or still falling). |
| `creature.ts` | Animation driver: stepped pose clock, gait from actual speed, facing that turns toward movement or the target it fights (9 rad/s), downed topple, and `FallingBody` (death: stagger along the killing blow, topple — backwards for people, onto a side for animals, onto the back for bugs — bounce, lie). |
| `index.ts` | Mode switch, shared layers per renderer, sprite pixel reading (atlas page or outfit composite canvas). |
| `playerModel.ts` | The survivor's own body in the third-person/top-down cameras, painted from the player's outfit composite (repainted when clothes change); hides the renderer's billboard via `renderer.playerBodyOverride`. |

`monsterView.ts` and `npcView.ts` keep all the combat-feel logic (telegraph warm/hot flashes,
rear-back, lunge, knock-back kicks, hit-stop, flinch shiver, downed, death sequence and the
body-landing callback) and feed it to either a billboard or a model. NPCs are painted from
their CDDA outfit composite (body + worn overlays + wielded item), so a survivor in a red
jacket is a 3D person in a red jacket; the skin is repainted when the outfit changes.

### Combat readability

- Wind-up: arms swing up over the head and the torso rears back (heavy: further, hands behind
  the head); a leap crouches with bent knees. The warm flash at the start and the hot flash just
  before the blow lands are unchanged. Animals crouch head-low or rear up; bugs rear their
  front legs; blobs stretch tall.
- Strike: arms slam forward, torso pitches in, the body lunges (same kick as before).
- Hits: red flash, knock-back and a head/torso flinch pose; hit-stop freezes the pose.
- Facing: a hostile winding up or within 2.5 m turns to face you; otherwise it faces where it
  walks. You can see which way a zombie is going, and that it has turned toward you.

### Distance readability

- **Far LOD thickening**: from 22 m to 55 m (`FAR_LOD` in `creature.ts`) limbs get up to 45%
  thicker (the core up to 18%), so a zombie stays a few pixels wide at 50 m instead of a
  1-pixel stick figure.
- **Hostile emphasis**: hostile creatures get a small self-lit share of their albedo ramping in
  from 16 m to 45 m (`cdda.chars({ far, emph })`), so they never sink into shade or dusk at
  range. Neutral animals and friendly NPCs don't.
- Box face rims and the post pass's crease outlines keep shapes separate from the ground.

### Picking and effects

Crosshair targeting, look cards and melee reach use the logical creature cylinder in
`game/raycast.ts` (`CREATURE_HEIGHT`), not render meshes, so they are unchanged. Blood sprays
and stuck arrows ask `MonsterView.bodyOf(m)` for the model's own height and half-width (the
billboard path still uses the sprite's art span). The point-blank sprite hacks (`nearClamp`,
`meleeAimLift`) only apply to billboards: a 3D zombie's head is at eye height anyway.

## Performance

`tools/char-shots.ts --gpu --bench --views bench` (60 hostile zombies and dogs 8–45 m down
the street, `full` look, RTX 5080, 1920×1080, `cdda.benchView(6)`):

| | frame p50 | p95 | p99 | work p50 | draw calls | triangles |
|---|---|---|---|---|---|---|
| billboards (`?chars=billboard`) | 7.7 ms | 14.6 | 23.9 | 11.0 | 405 | 437.7 k |
| 3D models | 7.4 ms | 14.6 | 23.6 | 10.7 | 405 | 446.4 k |

No measurable cost: ~800 part instances are one or two instanced draws (plus shadow), 12
triangles each. Matrices are rebuilt at the simulation rate (30 Hz) only for creatures that
moved; bodies are static once they land. Skins: a zombie is ~4 k texels; one 1024² page holds
~150–250 species/outfits; more pages are added as needed (a warning past 6 = 24 MB).

## Screenshots

`docs/screenshots/wave3/characters/` — `before_*` are the billboards, `after_*` the models:
zombie horde near / mid / far and at dusk, a dog, NPCs, corpses, a melee wind-up, critters.
Regenerate with

    ~/claude-stuff/bin/heavy --kind gpu --mem 2 -- nix-shell --run 'npx tsx tools/char-shots.ts --gpu --prefix after'
    ~/claude-stuff/bin/heavy --kind gpu --mem 2 -- nix-shell --run 'npx tsx tools/char-shots.ts --gpu --prefix before --params chars=billboard'

## Known gaps

- One body plan per archetype: a moose and a dog differ in proportions, not anatomy; spiders
  and ants share the insect plan; robots are a generic tracked machine.
- Wielded weapons aren't separate meshes (the NPC's weapon only tints its arm).
- Hordes of hundreds: every live part is re-uploaded each frame (fine for dozens; see perf).
