// Hand-built recreations of the panels in two published Cataclysm screenshots, for side-by-side
// comparisons (notes/blog-post/recreations.md has the inventory of each original and what matched).
//
//   BN  = Cataclysm: Bright Nights readme title image (4 panels, 1280x720)
//   DDA = Cataclysm: DDA "UltiCa showcase, Sep 2021" (4 panels, 2390x800)
//
// Evaluated in the game page by blog-shots.ts; defines window.recreate. Each scene is a tile grid
// (one character per tile, transcribed by eye from the original) plus lists of monsters, items,
// fields and vehicles. `panel` is the part of the grid the original shows; the rest is margin so
// buildings aren't cut off in first-person views. Everything is stamped into an open field block
// on seed 1 (OMTs 63..66 x 45..48), replacing terrain, furniture, items, fields and monsters.
//
// Grids fail loudly: a row of the wrong length or an unknown legend character throws.

(() => {
  const ORIGIN = { x: 1516, y: 1084 }; // top-left of the stamp area (tile coords, seed 1 field block)
  const AREA = 88; // tiles cleared around ORIGIN (square), all inside the field block

  // Legend shared by all scenes; scenes add their own. t = terrain, f = furniture.
  const COMMON = {
    '.': {}, // the scene's base terrain
    g: { t: 't_grass' }, G: { t: 't_grass_long' }, d: { t: 't_dirt' }, m: { t: 't_dirtmound' },
    s: { t: 't_sidewalk' }, c: { t: 't_concrete' }, p: { t: 't_pavement' }, y: { t: 't_pavement_y' },
    w: { t: 't_water_sh' }, W: { t: 't_water_dp' }, f: { t: 't_floor' }, '#': { t: 't_wall_w' },
    L: { t: 't_wall_log' }, l: { t: 't_thconc_floor' }, x: { t: 't_chainfence' }, '+': { t: 't_door_c' },
    o: { t: 't_window_domestic' }, r: { t: 't_carpet_red' }, R: { t: 't_rock_floor' }, '%': { t: 't_wall' },
    b: { t: 't_underbrush' }, h: { t: 't_shrub' }, v: { t: 't_tree_young' }, D: { t: 't_tree_dead' },
    T: { t: 't_tree' }, P: { t: 't_tree_pine' }, M: { t: 't_tree_maple' }, B: { t: 't_tree_birch' },
    H: { t: 't_tree_hickory' }, E: { t: 't_tree_elm' }, '=': { t: 't_wall_glass' }, e: { t: 't_metal_floor' },
    '^': { t: 't_stairs_down' },
  };

  const S = {};

  // ---------------------------------------------------------------- BN panel 1: house roof, grass fire
  // Original: two shingle-roofed houses, a grass strip between them on fire, zombies walking into the
  // flames from the sidewalk, mailboxes, flowers, a coil of rope on the grass. "Place: House roof",
  // cloudy, bright, spring. Panel = 17x11 tiles at 32 px.
  S.bn_fire = {
    base: 't_grass', season: 'spring', hour: 15, weather: 'cloudy', cutaway: false,
    legend: { K: { t: 't_grass', f: 'f_mailbox' }, U: { t: 't_grass', f: 'f_flower_tulip' }, V: { t: 't_grass', f: 'f_bluebell' } },
    rows: [
      //0123456789012345678901234
      '############.....########',
      '#fffffffffff#.....#fffffff',
      '#fffffffffff#.....#fffffff',
      '#fffffffffff#.....#fffffff',
      '#fffffffffff#..GG.#fffffff',
      '#fffffffffff#.G...#fffffff',
      '#fffffffffff#...h.#fffffff',
      '#fffffffffff#.....#fffffff',
      '#fffffffffff#.....#fffffff',
      '#fffffffffff#h....#fffffff',
      '#######+####v.....####+###',
      '....UVK....hhh....K.......',
      '.......s...........s......',
      '.......sG..........s......',
      'ssssssssssssssssssssssssss',
      'pppppppppppppppppppppppppp',
      'pppppppppppppppppppppppppp',
      'yyyyyyyyyyyyyyyyyyyyyyyyyy',
      'pppppppppppppppppppppppppp',
    ],
    // roofs one level up over each house footprint
    roofs: [[0, 0, 12, 10], [18, 0, 25, 10]],
    panel: { x: 4, y: 3, w: 17, h: 11 },
    // The original's survivor stands on the roof edge. Pitched roofs vanish while the player is on
    // their level, so ours stands on the grass just below that edge instead.
    player: { x: 13.5, y: 9.5, yaw: 150 },
    fields: [
      ...rect(14, 7, 16, 9).map(([x, y]) => ['fd_fire', x, y, 3]),
      ...rect(15, 10, 17, 12).map(([x, y]) => ['fd_fire', x, y, 3]),
      ['fd_blood', 17, 13, 3],
    ],
    items: [['rope_30', 13, 5], ['rope_30', 13, 6]],
    monsters: [
      ['mon_zombie_child', 14, 11, 200], ['mon_zombie', 15, 12, 180], ['mon_zombie_fat', 16, 13, 190],
      ['mon_zombie_tough', 17, 13, 170], ['mon_zombie', 20, 12, 230],
      // the rest of the sidebar's list, off-panel on the road
      ['mon_zombie_fireman', 10, 16, 20], ['mon_zombie_fireman', 22, 16, 330], ['mon_dog_zombie_rot', 6, 15, 60],
      ['mon_dog_zombie_rot', 24, 17, 300], ['mon_zombie_brainless', 3, 17, 90], ['mon_zombie_brainless', 14, 18, 0],
      ['mon_zombie_nurse', 18, 16, 340],
    ],
    corpses: [['mon_zombie', 17, 13]],
    fp: { x: 13.5, y: 16.5, yaw: -8, pitch: -4 }, // from the road, looking up the burning strip
  };

  // ---------------------------------------------------------------- BN panel 2: horde at the roundabout
  // Original: night-dark asphalt with yellow lane dots, a sidewalk-and-grass median heading north, a
  // round concrete planter island with a dead tree, and ~40 zombies mown down by an M2HB: blood
  // everywhere, bodies, casings. Sidebar: 5 zombies, 2 fat, 2 hazmat, 3 tough, 2 zapper, 7 technician.
  // 8:04 PM, spring day 2. Panel ~19x14 tiles at ~26 px.
  S.bn_horde = {
    // 8:04 PM in the original, drawn fully lit; ours at 20:04 is black, so late afternoon instead
    base: 't_pavement', season: 'spring', hour: 17.3, weather: 'clear',
    legend: { Q: { t: 't_sidewalk', f: 'f_street_light' } },
    rows: [
      //01234567890123456789012345678
      '.......sgs...................',
      '.......sDs...................',
      '.......sgs.......yyyyyyyyyyyy',
      '.......sgs...................',
      '.......sgs...................',
      '.......sgs...................',
      '.......sgs.....y.............',
      '.......sgs.....y.............',
      '.....sssgsss...y....sssss....',
      '....yy.shgs....y....sgvgs....',
      '.......shgs....y....sDhgs....',
      '.......sDQs....y....sghhs....',
      '.......ssss....y....sssss....',
      '......y......................',
      '......y......................',
      '......y......................',
      '......y......................',
      '......yyyy..........yyyyy....',
      '.............................',
      '.............................',
    ],
    panel: { x: 5, y: 2, w: 19, h: 14 },
    player: { x: 14.5, y: 9.5, yaw: 90 },
    monsters: horde(),
    fields: bloodSpray(),
    items: [...rect(11, 8, 17, 12).filter(([x, y]) => (x * 7 + y * 3) % 4 === 0).map(([x, y]) => ['50_casing', x, y])],
    corpses: [['mon_zombie', 12, 9], ['mon_zombie_fat', 14, 10], ['mon_zombie_technician', 16, 11], ['mon_zombie', 13, 12],
      ['mon_zombie_tough', 17, 9], ['mon_zombie', 15, 13], ['mon_zombie_hazmat', 11, 11], ['mon_zombie', 18, 13]],
    fp: { x: 9.5, y: 6.5, yaw: 125, pitch: -6 },
  };

  // ---------------------------------------------------------------- BN panel 3: science lab tower
  // Original: a dirt path through a lab compound, chain-link fences crackling with electricity,
  // hostile red crawlers, blood by the fence, a terminal and bookcase on the left, the player with a
  // headlamp. 9:16 AM, clear. Panel ~25x17 at ~21 px.
  S.bn_lab = {
    base: 't_thconc_floor', season: 'spring', hour: 9.3, weather: 'clear',
    legend: {
      C: { t: 't_console' }, K: { t: 't_thconc_floor', f: 'f_bookcase' }, Z: { t: 't_thconc_floor', f: 'f_table' },
      Y: { t: 't_thconc_floor', f: 'f_statue' }, N: { t: 't_grass', f: 'f_indoor_plant' }, X: { t: 't_chaingate_c' },
    },
    rows: [
      //0123456789012345678901234567890
      '...........dddddddddddddd.......',
      '............dddddddddddd........',
      '.............ddddddddddd........',
      '.....%%.......dddddddd..........',
      '.....%%........ddddd............',
      '.....%%..........fxxxxxxxxxX....',
      '.....%%..........f..............',
      '.....C...........e..............',
      '.....Z...........f.......NYN.x..',
      '......KK.........e.......NNN....',
      '.....ZZ..........e...........X..',
      '.................f...........x..',
      '.................f...........x..',
      '.................f...........x..',
      '................dfd..............',
      '................dfxxxxxxxxxxxxx..',
      '................d^d..............',
      '................d^d..............',
      '................ddd..............',
      '......%%%........................',
    ],
    panel: { x: 5, y: 1, w: 25, h: 17 },
    player: { x: 17.5, y: 8.5, yaw: 90 },
    fields: [
      ['fd_electricity', 27, 4, 3], ['fd_electricity', 28, 4, 3], ['fd_electricity', 29, 4, 3], ['fd_electricity', 27, 5, 3],
      ['fd_electricity', 27, 6, 3], ['fd_electricity', 26, 7, 3], ['fd_electricity', 27, 7, 2],
      ['fd_electricity', 23, 9, 3], ['fd_electricity', 24, 9, 3], ['fd_electricity', 25, 9, 3], ['fd_electricity', 26, 8, 3],
      ['fd_electricity', 22, 10, 3], ['fd_electricity', 22, 11, 3], ['fd_electricity', 22, 12, 2],
      ['fd_electricity', 25, 10, 3], ['fd_electricity', 25, 11, 3], ['fd_electricity', 25, 12, 3], ['fd_electricity', 25, 13, 2],
      ['fd_electricity', 21, 15, 3], ['fd_electricity', 26, 16, 3], ['fd_electricity', 27, 16, 2],
      ['fd_blood', 22, 3, 2], ['fd_blood', 20, 5, 3], ['fd_blood', 21, 5, 3], ['fd_blood', 21, 4, 2],
      ['fd_blood', 25, 7, 2], ['fd_blood', 24, 6, 2],
    ],
    items: [['id_science', 25, 3], ['id_science', 27, 8], ['9mm_casing', 13, 10], ['9mm_casing', 13, 10], ['canister_empty', 20, 16]],
    monsters: [['mon_zombie_crawler', 25, 6, 250], ['mon_zombie_crawler', 24, 7, 230], ['mon_secubot', 15, 5, 90], ['mon_secubot', 19, 18, 0]],
    corpses: [['mon_zombie_scientist', 21, 5]],
    fp: { x: 17.5, y: 11.5, yaw: 40, pitch: -3 },
    flashlight: true,
  };

  // ---------------------------------------------------------------- BN panel 4: the "floating temple"
  // Original (Arcana mod, not in core BN): a stone temple on a lake at dusk, pews down a nave, a red
  // altar carpet, skeletons of cultists, a corridor to a vestry with a cauldron and a blue orb.
  // Rebuilt from core pieces: rock floor and stone walls on deep water, benches, a red carpet,
  // skeleton corpses. Panel ~24x17 at ~21 px.
  S.bn_temple = {
    base: 't_water_dp', season: 'spring', hour: 17.4, weather: 'clear',
    legend: {
      n: { t: 't_rock_floor', f: 'f_bench' }, a: { t: 't_rock_floor', f: 'f_armchair' }, k: { t: 't_rock_floor', f: 'f_sink' },
      O: { t: 't_rock_floor', f: 'f_woodstove' }, Z: { t: 't_rock_floor', f: 'f_table' },
    },
    rows: [
      //0123456789012345678901234567
      '............................',
      '............................',
      '............................',
      '............................',
      '............................',
      '.........................%%%%',
      '.......%%%%%%%%%%%.......%RRR%',
      '..%%%%%%%RRRnnnnnRR%%%%%%RRRR%',
      '..%RRRRRR%arrRnRnRnRR%RRR+RZR%',
      '..%RnRnRnR%rraRnRnRnR+RRR%RRR%',
      '..%RnRnRnR%rrrRnRnRnR+RRRR+RkR%',
      '..%RRRRRRR%arrRRRRRRR%RRR%RRRR%',
      '..%%%%%%%RRRnnnnnRR%%%%%%%ROR%',
      '.......%%%%%%%%%%%.......%RRR%',
      '.........................%%%%',
      '............................',
      '............................',
      '............................',
    ],
    panel: { x: 2, y: 2, w: 24, h: 17 },
    player: { x: 18.5, y: 10.5, yaw: 180 },
    fields: [['fd_blood', 13, 9, 3], ['fd_blood', 14, 9, 2], ['fd_blood', 12, 10, 2], ['fd_blood', 16, 10, 2]],
    corpses: [['mon_skeleton', 13, 10], ['mon_skeleton', 15, 10], ['mon_skeleton', 17, 9], ['mon_skeleton', 12, 11], ['mon_zombie', 14, 10]],
    monsters: [],
    fp: { x: 20.5, y: 9.5, yaw: 270, pitch: -4 },
  };

  // ---------------------------------------------------------------- DDA panel A: bus, horde, mall
  // Original: a city street; a bus with a huge pale hulk inside and broken glass around it; a horde
  // of special zombies (acid, spitters, shockers, fungal, soldiers) in pools of blood; a sidewalk;
  // below, a mall: wood floor, four mannequins, rubble heaps, sale signs, a sofa, a glass atrium
  // with pine trees, a red rug, and a row of changing rooms full of zombies. 19x25 tiles at 32 px.
  S.dda_street = {
    base: 't_pavement', season: 'summer', hour: 13, weather: 'clear',
    legend: {
      Q: { t: 't_floor', f: 'f_mannequin' }, J: { t: 't_floor', f: 'f_rubble' }, I: { t: 't_floor', f: 'f_sign' },
      A: { t: 't_floor', f: 'f_trashcan' }, F: { t: 't_floor', f: 'f_sofa' },
    },
    rows: [
      //0123456789012345678901234
      '.........................',
      '.........................',
      '.........................',
      '.........................',
      '.........................',
      '...yyyyyyyyyyyyyyyyyyyyyy',
      '.........................',
      '.........................',
      '.........................',
      '.........................',
      '.........................',
      '.........................',
      'sssssssssssssssssssssssss',
      'sssssssssssssssssssssssss',
      'sssssssssssssssssssssssss',
      '###################g#####',
      'fffffAfffQQQfff#ff#g#fff',
      'ffJfffffffffQfff#ff#g#ffff',
      'fJJJfffIffffffff#ff#g#ffff',
      'ffJfffffffffIffff#f#g#ffff',
      'fffffIffffffffff#ff#g#ffff',
      'fffffffffffffffff#f#g#ffff',
      'ffffffffffffffff#ff#g#ffff',
      'fffffffffffffffff#f#g#ffff',
      'ffffffffffFFFffff#f#g#ffff',
      'fffffffff=====ffff^f#g#fff',
      'fffffffff=gPgg=fff^f#g#fff',
      'rrrfffff=ggPgP=ffff#g#ffff',
      'rrrfffff=gggggfffff#g#ffff',
    ],
    panel: { x: 3, y: 3, w: 19, h: 25 },
    player: { x: 14.5, y: 22.5, yaw: 0 },
    vehicles: [['bus', 10, 10, 0]],
    monsters: [
      ['mon_zombie_hulk', 7, 9, 180],
      ['mon_zombie', 6, 3, 200], ['mon_zombie', 20, 3, 160], ['mon_zombie_cop', 8, 5, 180], ['mon_zombie', 9, 5, 190],
      ['mon_zombie_runner', 17, 6, 240], ['mon_zombie', 18, 6, 220], ['mon_zombie_soldier', 20, 6, 250],
      ['mon_zombie_acidic', 14, 7, 200], ['mon_zombie_spitter', 15, 8, 230], ['mon_zombie_acidic', 16, 8, 190],
      ['mon_zombie_electric', 13, 9, 170], ['mon_zombie_fungus', 14, 10, 260], ['mon_zombie_acidic', 15, 10, 200],
      ['mon_zombie_spitter', 16, 11, 180], ['mon_zombie', 13, 11, 150], ['mon_zombie_fungus', 14, 12, 210],
      ['mon_zombie_soldier', 17, 9, 240], ['mon_zombie', 19, 10, 220], ['mon_zombie_electric', 12, 12, 180],
      ['mon_zombie_fungus', 16, 13, 200], ['mon_zombie_runner', 21, 14, 250],
      // the changing rooms
      ['mon_zombie_cop', 17, 16, 180], ['mon_zombie', 18, 16, 180], ['mon_zombie_soldier', 17, 18, 200],
      ['mon_zombie_brute', 18, 19, 190], ['mon_zombie', 18, 21, 180], ['mon_zombie_cop', 18, 23, 170],
      ['mon_zombie', 16, 22, 150], ['mon_zombie_fungus', 20, 26, 90],
    ],
    fields: [...rect(12, 4, 20, 14).filter(([x, y]) => (x * 13 + y * 7) % 5 < 2).map(([x, y]) => ['fd_blood', x, y, 3])],
    items: [['glass_shard', 3, 7], ['glass_shard', 5, 7], ['glass_shard', 10, 7], ['glass_shard', 5, 12], ['glass_shard', 7, 12], ['glass_shard', 9, 13]],
    corpses: [['mon_zombie', 13, 7], ['mon_zombie', 18, 8], ['mon_zombie_acidic', 14, 13], ['mon_zombie', 19, 12], ['mon_zombie', 11, 13]],
    fp: { x: 11.5, y: 14.5, yaw: 20, pitch: -3 },
  };

  // ---------------------------------------------------------------- DDA panel B: autumn forest
  // Original: dense mixed woods in autumn (red and yellow broadleaves, a few pines and dead trees),
  // tall grass and dirt, flowers; a pink carnivorous plant, green sprouting plants and a yellow
  // creature next to a dropped rifle in the middle. 19x25 at 32 px.
  S.dda_forest = {
    base: 't_grass_long', season: 'autumn', hour: 14, weather: 'clear',
    legend: { V: { t: 't_grass', f: 'f_bluebell' }, U: { t: 't_grass', f: 'f_flower_tulip' } },
    rows: [
      //01234567890123456789012
      'GGGGGGGGGGGGGGGGGGGGGGG',
      'GGGGGGGGGGGGGGGGGGGGGGG',
      'GGGGBGGMHGGGGGGGGGGGGGG',
      'GGGGGGGGGGHDPGGGGGGBGGG',
      'GGGGMDGGGGGGGGGMGGGGGGG',
      'GGGGGGGbGPGHGGMGGGGGGGG',
      'GGGGMGPGGGGGGBGGVGGGGGG',
      'GGGGGGGGGGGBGGGGMGBGGGG',
      'GGGGGdGGGGGGDGGGGGGHGGG',
      'GGGGGGGGGGBGGGGMGGGGGGG',
      'GGGBGBGGGGGGGGGGGGGGGGG',
      'GGGGGGGbGGBGGGGGGGGGGGG',
      'GGGHGMGGGGGGGGGGGGGGGGG',
      'GGGGGGGGGGGGGGGGGGGPGGG',
      'GGGGGGMGGGHDGMGGGGGGGGG',
      'GGGGGGGGGGGBGGGGGGGGGGG',
      'GGGGGBGGMGGGGGGGGGGGGGG',
      'GGGGGGGMGGGGGGGGGGGGGGG',
      'GGGGGGGHGGGGBGGGGGGGGGG',
      'GGGGGGGGGGGGGGGGGGGGGGG',
      'GGGGGMGGGGGGGGGGGBGGGGG',
      'GGGGGGGGGGGGGGGGGGMGGGG',
      'GGGGGGGGGGGGGGGGGGGGGGG',
      'GGGGGBGGGDGGGGGGBGGMGGG',
      'GGGGGGGGGGGGGGGGGGGGGGG',
      'GGGGDGGGGGGGGPGGGGGGGGG',
      'GGGGGGGGGGMGGGGGGGMGGGG',
      'GGGGGGGGGGGGGGGGGGGGGGG',
      'GGGGGGGGGGGGGGGGGGGGGGG',
    ],
    panel: { x: 2, y: 2, w: 19, h: 25 },
    player: { x: 11.5, y: 16.5, yaw: 0 },
    monsters: [['mon_triffid_young', 12, 13, 200], ['mon_skitterbot', 14, 13, 180], ['mon_triffid_sprig', 17, 14, 200],
      ['mon_triffid_sprig', 12, 17, 160], ['mon_triffid_sprig', 17, 21, 220], ['mon_triffid_sprig', 10, 6, 180]],
    items: [['m1a', 15, 13]],
    fp: { x: 11.5, y: 19.5, yaw: 5, pitch: -3 },
  };

  // ---------------------------------------------------------------- DDA panel C: log cabin farm
  // Original: a log cabin with a kitchen, lockers and a table; a small annex; a stone oven pair by
  // the door; three rows of crops in dirt; a second log building; swampy tall grass with puddles
  // and a creek to the south-west; a survivor between cabin and fields. 19x25 at 32 px.
  S.dda_farm = {
    base: 't_grass', season: 'summer', hour: 11, weather: 'clear',
    legend: {
      k: { t: 't_floor', f: 'f_locker' }, Z: { t: 't_floor', f: 'f_table' }, h: { t: 't_floor', f: 'f_chair' },
      n: { t: 't_floor', f: 'f_counter' }, O: { t: 't_floor', f: 'f_woodstove' }, F: { t: 't_floor', f: 'f_glass_fridge' },
      K: { t: 't_floor', f: 'f_rack' }, Y: { t: 't_floor', f: 'f_bed' }, X: { t: 't_floor', f: 'f_crate_c' },
      Q: { t: 't_floor', f: 'f_wood_keg' }, J: { t: 't_dirt', f: 'f_boulder_small' },
      '1': { t: 't_dirtmound', f: 'f_plant_seedling' }, '2': { t: 't_dirtmound', f: 'f_plant_mature' },
    },
    rows: [
      //012345678901234567890
      'ggggggggggggggggggggg',
      'gggLLLLLLLLLLLLLLgggg',
      'gggLkkfffKfYLXXLdddgg',
      'gggLkffffKffLffLddddd',
      'gTgLkfhZffffLnfLddddd',
      'gTgFkfhZfffffkfLddddd',
      'ggTLffffffkkLkfLddgdd',
      'gggLffffffffLkfLddddd',
      'wwgLfnnOnnFfLffLddddd',
      'wwgLLLLLLL+LLLLLddddd',
      'wwwwdddJJddddddddddgd',
      'ggwddddddddddddddddgd',
      'ggwddddddddddddLLLLLL',
      'gwgdd22111122ddLnKXXf',
      'ggddddddddddddd+ffQnf',
      'gwdd22222222dddLfffff',
      'ggddddddddddddgLLLLLL',
      'ggdd22222222ddTggTggT',
      'gTdddddddddddggggggg',
      'ggggggvgggggggwggggg',
      'wGGwGGGGwGGGGGGGGwGG',
      'wwGGGwGGGGGGGGwGGGGG',
      'GwGGGGGGGGwGGGGGGGGG',
      'GwwGwGGGGGGGGGwGGGwG',
      'GGwGGGGGGGGGGGGGGGGG',
      'wGGGGGwGGGGGwGGGGGGG',
      'GGGwGGGGGGGGGGGGwGGG',
    ],
    panel: { x: 1, y: 1, w: 19, h: 25 },
    player: { x: 6.5, y: 12.5, yaw: 0 },
    fp: { x: 9.5, y: 15.5, yaw: 345, pitch: -3 },
  };

  // ---------------------------------------------------------------- DDA panel D: laboratory
  // Original: a lab wing: white tile rooms with lab benches, glass walls and lockers down the left;
  // a wide grey corridor; a central sealed chamber ringed by glass cabinets with a scientist zombie
  // at a bench; smaller labs below with scientists and a bloody body; yellow six-legged robots;
  // green crawlers at a terminal by the outer wall; a road with a yellow centre line on the right.
  S.dda_lab = {
    base: 't_thconc_floor', season: 'summer', hour: 13, weather: 'clear',
    legend: {
      q: { t: 't_linoleum_white', f: 'f_lab_bench' }, k: { t: 't_linoleum_white', f: 'f_locker' },
      u: { t: 't_linoleum_white', f: 'f_glass_cabinet' }, i: { t: 't_linoleum_white' }, C: { t: 't_console' },
      K: { t: 't_linoleum_white', f: 'f_bookcase' }, J: { t: 't_thconc_floor', f: 'f_rubble' }, j: { t: 't_linoleum_white', f: 'f_chair' },
      Z: { t: 't_floor_red' },
    },
    rows: [
      //0123456789012345678901234
      '..iiiii.J.............sp..',
      '..iiiik..J............sy..',
      '..%%%%%=..%%%%%%%%%%%.sp..',
      '..iqqii=..%eeeeeeeee%.sy..',
      '..iiiii=..%euuuuuuue%.sp..',
      '..iiiii=..%euiiiiiue%.sy..',
      '..%%%%%%..%euiqqiiue%.sp..',
      '..iiiik=..%euiqqijueC.sy..',
      '..iqqii=..%euiiiiiue%.sp..',
      '..Kqqij=..%euuuuuuue%.sy..',
      '..iiiik=..%eeeeeeeee%.sp..',
      '..%%%%%%..%%%%%%%%%%%.sy..',
      '..iiiik=..ZZ%iiii%kii.sp..',
      '..iqqii=..ZZ%iiii%iii.sy..',
      '..iqqii=..%%%%%%%%%%%.sp..',
      '..iiiij=..%ii=iiiiii=.sy..',
      '..Kqqii=..%ii=iiqiii=.sp..',
      '..iiiik=..%ii=iiqiii=.sy..',
      '..%%%%%%..%%%=iiiiii=.sp..',
      '..iiiik=..%ii=iiqiii=.sy..',
      '..iqqii=..%ii=iiqiii=.sp..',
      '..iqqii=..%ii=iiiiii=.sy..',
      '..%%%%%%..%%%%%%%%%%%.sp..',
      '..ffffk=..............sy..',
      '..fKffk=..............sp..',
      '..................... sy..',
    ].map((r) => r.replace(' ', '.')),
    panel: { x: 2, y: 0, w: 19, h: 25 },
    player: { x: 8.5, y: 20.5, yaw: 90 },
    monsters: [
      ['mon_skitterbot', 6, 1, 90], ['mon_skitterbot', 6, 2, 120], ['mon_zombie', 3, 2, 180],
      ['mon_zombie_scientist', 17, 7, 200], ['mon_zombie_brute', 20, 6, 180], ['mon_zombie_dog', 22, 7, 270],
      ['mon_zombie_dog', 22, 8, 250], ['mon_zombie_dog', 23, 9, 280], ['mon_zombie_scientist', 6, 9, 160],
      ['mon_skitterbot', 16, 12, 200], ['mon_skitterbot', 19, 12, 90], ['mon_zombie_scientist', 15, 15, 180],
      ['mon_zombie_scientist', 17, 18, 200], ['mon_zombie_scientist', 15, 20, 190], ['mon_zombie', 24, 11, 270],
    ],
    fields: [['fd_blood', 14, 12, 3], ['fd_blood', 15, 12, 2], ['fd_blood', 23, 5, 2]],
    corpses: [['mon_zombie_scientist', 14, 12]],
    fp: { x: 15.5, y: 21.5, yaw: 350, pitch: -4 },
  };

  function rect(x0, y0, x1, y1) {
    const out = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
    return out;
  }
  // BN panel 2's horde, per the sidebar mix, packed around the lane line.
  function horde() {
    const mix = ['mon_zombie', 'mon_zombie_technician', 'mon_zombie_tough', 'mon_zombie_technician', 'mon_zombie',
      'mon_zombie_fat', 'mon_zombie_technician', 'mon_zombie_hazmat', 'mon_zombie_electric', 'mon_zombie_technician',
      'mon_zombie_tough', 'mon_zombie', 'mon_zombie_technician', 'mon_zombie_electric', 'mon_zombie_fat',
      'mon_zombie_technician', 'mon_zombie_tough', 'mon_zombie_hazmat', 'mon_zombie', 'mon_zombie_technician', 'mon_zombie'];
    const spots = [[12, 7], [13, 8], [11, 9], [14, 8], [15, 9], [13, 10], [16, 8], [12, 11], [17, 10], [14, 11],
      [16, 12], [18, 9], [11, 12], [15, 11], [17, 12], [13, 13], [18, 11], [19, 10], [10, 10], [12, 5], [18, 14]];
    return spots.map(([x, y], i) => [mix[i % mix.length], x, y, 200 + ((i * 37) % 60)]);
  }
  function bloodSpray() {
    return rect(9, 5, 19, 14).filter(([x, y]) => ((x * 31 + y * 17) % 7) < 4).map(([x, y]) => ['fd_blood', x, y, 3])
      .concat([['fd_blood', 18, 15, 3], ['fd_blood', 19, 16, 2], ['fd_blood', 5, 14, 3], ['fd_blood', 6, 14, 2]]);
  }

  // ---------------------------------------------------------------- stamping
  const c = () => window.cdda;

  function clearArea() {
    const m = c().game.map;
    for (let z = 0; z <= 1; z++)
      for (let y = ORIGIN.y - 4; y < ORIGIN.y + AREA; y++)
        for (let x = ORIGIN.x - 4; x < ORIGIN.x + AREA; x++) {
          if (z === 1) { m.setTer(x, y, 1, 't_open_air'); m.setFurn(x, y, 1, 'f_null'); continue; }
          for (const it of [...m.itemsAt(x, y, 0)]) m.removeItem(x, y, 0, it);
          const f = m.fieldsAt(x, y, 0);
          if (f.length) f.length = 0;
          m.setFurn(x, y, 0, 'f_null');
        }
  }

  function stamp(name) {
    const sc = S[name];
    if (!sc) throw new Error(`recreate: no scene ${name} (have ${Object.keys(S).join(', ')})`);
    const api = c(), m = api.game.map, p = api.game.player;
    const legend = { ...COMMON, ...sc.legend };
    const W = sc.rows[0].length;
    // rows may be ragged (the grid is transcribed by eye); tiles past a row's end keep the base terrain
    // monsters from an earlier scene would wander into this one
    api.clearMonsters();
    for (const v of [...(api.vehicleSystem?.list ?? [])]) api.vehicleSystem.remove?.(v);
    clearArea();
    const ox = ORIGIN.x + 20, oy = ORIGIN.y + 20;
    for (let y = -20; y < AREA - 24; y++)
      for (let x = -20; x < AREA - 24; x++) m.setTer(ox + x, oy + y, 0, sc.base);
    sc.rows.forEach((row, gy) => [...row].forEach((ch, gx) => {
      const L = legend[ch];
      if (!L) throw new Error(`${name}: unknown legend char '${ch}' at ${gx},${gy}`);
      m.setTer(ox + gx, oy + gy, 0, L.t ?? sc.base);
      if (L.f) m.setFurn(ox + gx, oy + gy, 0, L.f);
    }));
    for (const [x0, y0, x1, y1] of sc.roofs ?? [])
      for (const [x, y] of rect(x0, y0, x1, y1)) m.setTer(ox + x, oy + y, 1, 't_shingle_flat_roof');
    api.setSeason(sc.season);
    api.setHour(sc.hour);
    api.setWeather(sc.weather);
    // the player first: monster/item helpers place relative to the player
    const pl = sc.player;
    api.teleport(ox + pl.x, oy + pl.y, pl.z ?? 0);
    const rel = (x, y) => [ox + x + 0.5 - p.x, oy + y + 0.5 - p.y];
    const byUid = (uid) => api.monsterSystem.all.find((mm) => mm.uid === uid);
    const pinned = [];
    for (const [id, x, y, deg] of sc.monsters ?? []) {
      const [dx, dy] = rel(x, y);
      const uid = api.spawnMonster(id, dx, dy, { friendly: true });
      if (uid === null) { console.warn(`recreate ${name}: could not spawn ${id} at ${x},${y}`); continue; }
      const mm = byUid(uid);
      // pinned like tools/char-views.js: IMMOBILE so the tableau holds, facing a compass bearing
      mm.type = { ...mm.type, flags: [...mm.type.flags, 'IMMOBILE'] };
      mm.facing = ((deg ?? 180) * Math.PI) / 180;
      pinned.push(uid);
    }
    const corpseUids = [];
    for (const [id, x, y] of sc.corpses ?? []) {
      const [dx, dy] = rel(x, y);
      const uid = api.spawnMonster(id, dx, dy, {});
      if (uid !== null) corpseUids.push(uid);
    }
    for (const uid of corpseUids) { const mm = byUid(uid); if (mm) api.monsterSystem.die(mm, 'player'); }
    for (const [id, x, y] of sc.items ?? []) {
      const [dx, dy] = rel(x, y);
      api.placeItem(id, Math.round(dx - 0.5), Math.round(dy - 0.5));
    }
    for (const [type, x, y, n] of sc.fields ?? []) m.addField(ox + x, oy + y, 0, type, n);
    for (const [proto, x, y, deg] of sc.vehicles ?? []) {
      const [dx, dy] = rel(x, y);
      if (!api.spawnVehicle(proto, Math.round(dx - 0.5), Math.round(dy - 0.5), deg, { status: 1, force: true }))
        console.warn(`recreate ${name}: could not spawn vehicle ${proto}`);
    }
    return { name, origin: [ox, oy], player: [p.x, p.y, p.z], pinned: pinned.length, corpses: corpseUids.length };
  }

  /** Fire makes smoke and spreads between stamping and capture: reset every field to the scene's. */
  function clean(name) {
    const sc = S[name], m = c().game.map;
    for (let y = ORIGIN.y - 4; y < ORIGIN.y + AREA; y++)
      for (let x = ORIGIN.x - 4; x < ORIGIN.x + AREA; x++) {
        const f = m.fieldsAt(x, y, 0);
        if (f.length) { f.length = 0; m.setTer(x, y, 0, m.terAt(x, y, 0).id); }
      }
    const ox = ORIGIN.x + 20, oy = ORIGIN.y + 20;
    for (const [type, x, y, n] of sc.fields ?? []) m.addField(ox + x, oy + y, 0, type, n);
  }

  /** Straight-down view over the original's panel, spanning its height (or width) in tiles. */
  function top(name) {
    const sc = S[name], api = c(), rig = api.renderer.rig;
    const ox = ORIGIN.x + 20, oy = ORIGIN.y + 20;
    const P = sc.panel;
    api.setCameraMode('top');
    api.look(0, -10);
    rig.topPitch = (89.9 * Math.PI) / 180;
    rig.topFocus = { x: ox + P.x + P.w / 2, y: oy + P.y + P.h / 2 };
    // the capture is 16:9; fit the panel's height, or its width for wide panels
    const spanH = Math.max(P.h, (P.w * 9) / 16);
    rig.topDistance = spanH / 2 / Math.tan((rig.fovTop * Math.PI) / 360);
    api.renderer.topCutaway = sc.cutaway ?? true;
    return { focus: rig.topFocus, d: rig.topDistance, spanH };
  }

  /** Back to first person at the scene's ground-level viewpoint. */
  function fp(name) {
    const sc = S[name], api = c(), rig = api.renderer.rig;
    const ox = ORIGIN.x + 20, oy = ORIGIN.y + 20;
    rig.topFocus = null;
    rig.topPitch = (60 * Math.PI) / 180;
    api.renderer.topCutaway = true;
    api.setCameraMode('first');
    api.teleport(ox + sc.fp.x, oy + sc.fp.y, 0);
    api.look(sc.fp.yaw, sc.fp.pitch ?? 0);
    api.flashlight(!!sc.flashlight);
    return sc.fp;
  }

  window.recreate = { scenes: S, stamp, top, fp, clean, ORIGIN };
})();
