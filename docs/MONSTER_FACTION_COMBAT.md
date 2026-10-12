# Monster faction combat and third-party telegraphs

Monsters choose the closest visible hated or anger-driven faction alongside the
survivor and NPC targets. Friendly pets fight hostile wild monsters, while pets
leave other friendly creatures alone. Shared friendly factions and neutral
relations prevent wild fights; mood relations respect anger and morale. Walls
hide candidates, and surround slots remain reserved for survivor attackers.

Plain melee uses BN monster hit rolls, target dodge, monster armor and melee dice.
Damage and death carry the attacking monster as source, so these fights do not
award survivor kills. Both monster-vs-monster and monster-vs-NPC melee now use the
existing visible windup, recovery, interruption and whiff events. A victim that
moves out of reach during the tell escapes the hit.

Targets and windups are temporary AI state and are replanned after loading;
monster friendliness, damage and positions continue using the existing save
format. Special attack actors still target the survivor; this package adds plain
third-party melee rather than pretending every special actor supports all bodies.

Reference: BN `monmove.cpp:compute_plan`, `monster.cpp:attitude_to/melee_attack`,
and the existing combat feel adaptation. Tests cover pets, wild hated wasp/bee
factions, allies, walls and telegraphed movement evasion. 100 targeted combat/NPC
checks pass, typecheck and production build pass. Headful Chromium was resumed
with OS input and the [rendered dog/zombie combat tell](screenshots/gaps/faction-combat.png)
was inspected; the zombie's raised arms target the dog.
