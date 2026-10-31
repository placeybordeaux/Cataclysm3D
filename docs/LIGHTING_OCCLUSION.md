# Headlight occlusion and stair lighting

Surface headlights previously used an unshadowed spotlight, bypassing the tile light map.
They could directly illuminate basement walls through the floor above. Headlights now cast
one 1024² spotlight shadow map, updating while active and retaining a compatible inactive
map to avoid shader recompilation when switched on. Shadow textures are recreated when
switching between basic and comparison-texture shadow modes.

The final narrow edge leak had two contributing paths. Structural floor/wall meshes defaulted
to back-face shadow casting; rendering both sides closes the seams where thin slabs meet
walls. The headlight's perspective depth bias also detached shadows at distance. Its depth
bias is now zero and normal bias is 2 mm. This follows Three.js's documented
[shadow side behavior](https://threejs.org/docs/pages/Material.html) and
[shadow bias controls](https://threejs.org/docs/pages/LightShadow.html).

Headlight point proxies remain available to the tile light map, but the shader rejects
point lights whose source and receiving surface occupy different levels. An unrelated
basement lamp can no longer enable upstairs point proxies through the aggregate artificial
light gate.

The abrupt stair transition came from keeping light-map data only for the player's current
level. Visible surfaces on the other level fell back to generic sky lighting, then changed
when the player's level switched. The renderer now caches independent current, above, and
below maps, choosing each surface's map from its physical height. Light is not blended
through a floor slab. Exposure retains its existing gradual adaptation; underground ambient
brightness is unchanged.

## Validation

Run through the repository's heavy wrapper and Nix environment:

```
tools/heavy --mem 2 --name lighting-regression -- nix-shell --run 'npx tsx tools/check-headlight-occlusion.ts /tmp/lighting-regression'
```

The isolated scene places a working car above a sealed basement. The check compares
headlights on/off with a basement lamp and without one, in legacy and smooth shadow modes.
It also checks fixed-view lighting while the primary light-map level changes, and verifies
that headlights still illuminate the surface. PNGs and numeric results are saved to the
output directory. Only the fixed world region is compared; changing HUD labels are excluded.
The final run had zero pixel difference in all four basement cases and the fixed-view
level-switch case. The surface control changed 675,512 RGB channels by more than 10 levels.
Typecheck, production build, and all 1,544 unit tests passed (19 skipped).

This fix adds an active headlight shadow pass and two 128² floating-point light-map textures
with independently cached grid/source rebuilds. A short Chromium RTX 5080 city-standing
regression passed all shadow/flashlight rendering gates and performance budgets at 1280×720:
frame interval p99 33.3ms. This is a
regression check on the development desktop, not an across-desktop performance claim or
an isolated measurement of active headlight shadow cost.
