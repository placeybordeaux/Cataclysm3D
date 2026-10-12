# Independent monster stair routing

Heard goals retain their level. A monster investigating a noise upstairs or
downstairs now selects a loaded stair flight and walks to its entrance without
requiring the survivor to have taken those stairs. Routing checks complete
budgeted paths on both levels; blocked landings, unreachable goals and unloaded
chunks cannot create a route. Monsters ride the existing continuous stair path.
The player's recent-trip chase behavior remains available for visual pursuit.

Cross-level hearing now calls the shared BN sound-distance model with the
listener's actual level; it previously passed the source level as the listener
and substituted an arbitrary one-third volume. The existing saved/stashed noise-goal tuple now includes an optional fourth z
coordinate; older three-coordinate saves default to the monster's own level.
Routes and windups are replanned after loading. Dormant monsters intentionally
hear only same-level horde signals; they return before loaded cross-level hearing.

The reality bubble hears and simulates adjacent levels. This package supports
sound-driven travel across those adjacent levels through existing solved links.
It does not claim multi-level shaft geometry, offset-link geometry, or a global
route through unloaded levels; these remain separate implementation gaps.

Tests verify climbing toward a noise with no prior survivor stair trip,
blocked destinations, absence of chunk generation and existing follower/stair
combat behavior. Reference: BN `monster::hear_sound`, `monmove.cpp` and the
shared `soundDistance` model.


Routing is cached per creature for 0.75–1 second and invalidated by goal, level or
map changes. All monsters share at most 2,000 path node expansions per tick;
exhausted requests are deferred. A 500-monster cold planning burst measured
7.24 ms and 20 cached ticks averaged 1.00 ms/tick on this host, excluding world
setup (well within a 16.7 ms frame budget for this subsystem). The separate
budget invariant test ensures expansion limits remain enforced without timing
assertions. Run the 500-monster test with `--silent=false` to reproduce timings.

Headful Chromium was resumed with an OS mouse click. A noise on the upper floor
made the zombie choose and climb this flight without a survivor trip; the
[continuous mid-flight frame](screenshots/gaps/stair-independent-climb.png) was
inspected and the creature subsequently reached level 1.
