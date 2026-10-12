# BN firearm modifications and buckshot

Gunmod compatibility recognizes BN mod_target_category as an OR of category groups, each requiring all listed weapon_category members. mod_exclusions and mod_exclusion_category reject targets, while explicit mod_targets IDs override category exclusions. Legacy skill targets remain supported. No target restrictions means any gun with an available slot is eligible.

The extracted suppressor applies loudness_modifier -45. BN Glock pistols have muzzle slots and accept it; the shotgun categories are excluded. The red dot sight has sight_dispersion 26 and aim_speed 9, and remains effective after save/load. BN sight selection requires nonnegative aim_speed, rather than DDA field_of_view. Disabled iron sights fall back to 90, matching BN item.cpp:8350–8364.

Buckshot reads BN ammo.shot count and half_angle. The extracted 00 shot emits five pellets with a three-degree half-angle, each using normal combined gun/ammo damage and armor penetration. Pellets remain separate at point-blank. Horizontal pellet deviations are uniform over the BN angle range; free aim extends this to the existing three-dimensional ray cone. NPC interception still precedes the multishot loop and requires a separate followup; this package covers monster hits. It does not claim full integer-grid BN trajectory or NPC multishot fidelity.

Source references: item.cpp is_gunmod_compatible (8949–8990), sight_dispersion (8350–8364); item_factory.cpp2496–2499; ranged.cpp get_shot_count/get_shot_half_angle/get_pellet_target (214–300), projectile loop1437–1445. Source comparison confirms all-of groups, explicit ID override, nonnegative aim_speed, normal projectile damage per pellet, and uniform half-angle deviation.

Validation: three previously skipped BN firearm tests ported, category inclusion/exclusion regression, point-blank live PlayerCombat regression, sight save/load, additive noise/restoration, and single-shell charge consumption. Targeted combat/aimmodel suites (77 tests), typecheck and production build pass.

Headful Chromium OS input selected suppressor and red dot in the actual attachment picker. Both installation activities completed naturally. The mod objects moved from carried inventory into the SCAR-L, with all 30 rounds retained. Item save/load preserved both installed IDs and 30 rounds. Inspected [initial picker](screenshots/gaps/bn-gunmod-menu.png) and [occupied muzzle slot after installation](screenshots/gaps/bn-gunmod-installed.png), which also shows the BN red-dot dispersion 26.
