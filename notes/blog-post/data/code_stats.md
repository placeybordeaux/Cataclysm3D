# Code stats at bn (e8fe3a3a2e)

| language | files | code | comment | blank |
|---|---:|---:|---:|---:|
| TypeScript | 841 | 167,409 | 26,902 | 12,578 |
| Markdown | 63 | 11,618 | 1 | 2,137 |
| JSON | 9 | 10,630 | 0 | 0 |
| CSS | 24 | 1,638 | 138 | 90 |
| Python | 6 | 1,267 | 69 | 199 |
| JavaScript | 6 | 866 | 131 | 1 |
| Shell | 2 | 33 | 13 | 0 |
| HTML | 2 | 18 | 0 | 0 |
| Nix | 1 | 8 | 4 | 0 |

| area (code files) | files | code lines |
|---|---:|---:|
| src/game | 151 | 40,584 |
| tests | 188 | 33,655 |
| src/render | 142 | 31,691 |
| tools | 138 | 21,642 |
| src/ui | 79 | 13,651 |
| src/ui2 | 49 | 7,119 |
| src/world | 29 | 6,092 |
| src | 20 | 4,750 |
| src/screens | 21 | 2,981 |
| src/progression | 13 | 1,923 |
| src/audio | 12 | 1,760 |
| src/save | 11 | 1,464 |
| src/gallery | 6 | 1,242 |
| src/perf | 5 | 1,144 |
| src/data | 5 | 856 |
| src/core | 6 | 320 |
| src/loadgate | 3 | 246 |
| src/dev | 1 | 87 |
| (root) | 2 | 24 |

test files: 186, static it()/test() count: 2086, tracked files (excl. public/vendor/notes): 1772

| data file | bytes | counts |
|---|---:|---|
| achievements.json | 58,404 | achievements 95, statistics 70, transformations 68, scores 14 |
| furniture.json | 414,188 | entries 490 |
| item_groups.json | 1,238,460 | entries 2,688 |
| items.json | 5,827,322 | entries 6,061 |
| mapgen.json | 3,592,701 | omt 2,315, nested 849, objects 3,153, update 3, extras 2, builtin 47 |
| misc.json | 2,545,343 | monster_blacklist 1, nested_category 21, uncraft 1,093, requirement 216, construction 632, profession 266, material 79, tool_quality 65, ammunition_type 116, scenario 40, start_location 89, mutation 760, mutation_category 25, mutation_type 23, mutation_flag 26, trait_group 142, effect_type 287, martial_art 37, technique 181, harvest 115, field_type 62, trap 67, construction_group 390, construction_category 14, body_part 13, anatomy 2, skill 28, item_category 44, monster_faction 53, species 29, bionic 144, fault 16, morale_type 88, recipe_category 10, item_action 218, emit 57, vitamin 17, weather_type 16, ammo_effect 89, json_flag 531, monster_attack 6, spell 99, enchantment 23, enchantment_value 96, enchantment_flag 27, enchantment_condition 15, enchantment_vision 5, gate 9, ter_furn_transform 1, rotatable_symbol 24, weapon_category 54, clothing_mod 14, scent_type 3, activity_type 110, hit_range 1, disease_type 1, item_migration 189, external_option 49, snippet 226, speech 65, profession_item_substitutions 32, dream 25 |
| monster_groups.json | 253,883 | entries 232 |
| monsters.json | 758,155 | entries 615 |
| npcs.json | 1,150,705 | templates 105, classes 89, topics 979, missions 177, factions 17, eocs 0, names 3 |
| overmap.json | 717,976 | terrains 2,333, specials 442, locations 49, region 8, wildSpecials 35, connections 5, mutableWildSpecials 10, lakeSpecials 1, names 3, mutables 8, connectionTerrains 5 |
| palettes.json | 154,486 | entries 114 |
| recipes.json | 2,535,988 | entries 3,187 |
| terrain.json | 627,160 | entries 869 |
| ui.json | 167,657 | title 18, tombstone 3, names 5, help 24, moodFaces 7, tips 86 |
| unlocks.json | 9,643 | unlocks 23 |
| vehicles.json | 1,981,408 | parts 813, vehicles 257, groups 76, fuels 28 |

public/ bytes by folder: {'activity-assembly-mock.html': '0.0 MB', 'atlas': '14.8 MB', 'audio': '16.9 MB', 'data': '22.0 MB', 'favicon.ico': '0.0 MB', 'favicon.png': '0.0 MB', 'fonts': '12.8 MB', 'models': '4.4 MB'}

git: 1033 commits across all refs, 699 on bn (158 merges), 23 local branches of which 0 are subagent worktree branches

| phase | commit | date (PDT) | commits | TS/JS code | src | tests | tools | test files | markdown lines |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| scaffold (first commit) | ce7b579 | 2026-09-28 22:33 | 1 | 1,014 | 933 | 0 | 80 | 0 | 133 |
| v1 first working copy (0251064) | 0251064 | 2026-09-29 03:48 | 123 | 52,760 | 41,297 | 7,890 | 3,684 | 36 | 681 |
| v1-dda tag | aff1709 | 2026-09-29 08:21 | 134 | 54,546 | 42,160 | 8,096 | 4,405 | 38 | 816 |
| end of v2 (BN) push | 941157a | 2026-09-29 22:41 | 301 | 87,138 | 67,435 | 12,930 | 8,013 | 62 | 2,854 |
| end of wave 3 overnight | 3e89023 | 2026-09-30 05:11 | 479 | 107,083 | 82,968 | 15,493 | 9,985 | 84 | 4,983 |
| end of wave 4 | 03c547c | 2026-10-02 12:38 | 631 | 128,287 | 94,952 | 20,692 | 14,220 | 116 | 8,257 |
| gap work merged (genVersion 3) | 9fa6ac6 | 2026-10-11 20:24 | 661 | 159,582 | 110,275 | 31,966 | 19,019 | 176 | 12,760 |
| end of zombie round | 3a98913 | 2026-10-13 13:52 | 692 | 165,786 | 113,942 | 33,538 | 21,180 | 185 | 13,460 |
| now (bn head) | e8fe3a3 | 2026-10-17 20:56 | 699 | 168,275 | 115,910 | 33,655 | 21,642 | 186 | 13,756 |
