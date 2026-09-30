// Credits: the attribution this adaptation owes (title screen and Esc menu). Every fact here
// comes from a licence file in the repo or its sources; if you change one, re-check the file:
//   ~/code/Cataclysm-BN/LICENSE.txt        BN: CC-BY-SA 3.0 Unported; GNU Unifont: GPLv2+ with
//                                          the font embedding exception; Terminus: SIL OFL
//   vendor/tilesets/readme.md, LICENSE.txt UltiCa (I-am-Erk/CDDA-Tilesets): CC-BY-SA 3.0
//   vendor/tilesets/gfx/UltimateCataclysm/tileset.txt   filler trees by Yar (opengameart.org)
//   public/fonts/LICENSE-OFL-Terminus-Font.txt           Terminus copyright lines
//   public/audio/CREDITS.md                sound effects (per file) and CO.AG music
// The per-file sound credits aren't repeated in-game (400 rows); the screen points to the file.

import { h } from '../ui2/dom';
import { closeKeyLabel } from '../ui2/host';
import { openPanel, closeGroup } from '../ui2/window';
import './credits.css';

interface Credit {
  title: string;
  lines: string[];
  links?: [label: string, url: string][];
}

/** The credits, as data (also used by tests to check nothing required is missing). */
export const CREDITS: Credit[] = [
  {
    title: 'A fan adaptation',
    lines: [
      'CDDA-3D is an unofficial, fan-made, real-time first-person adaptation of Cataclysm: Bright Nights. It is not made or endorsed by the Cataclysm: Bright Nights or Cataclysm: Dark Days Ahead teams.',
      'The game rules, items, monsters, recipes, maps and text come from Cataclysm: Bright Nights and were changed to fit a real-time 3D game (see the Tips and Options for what differs).',
    ],
  },
  {
    title: 'Cataclysm: Bright Nights',
    lines: [
      'Game data and text © the Cataclysm: Bright Nights contributors, and before them the Cataclysm: Dark Days Ahead and Cataclysm contributors (Bright Nights is a fork of Dark Days Ahead).',
      'Licensed under the Creative Commons Attribution-ShareAlike 3.0 Unported licence (CC BY-SA 3.0). This adaptation is a derivative work of that content and is shared under the same licence.',
    ],
    links: [
      ['Cataclysm: Bright Nights', 'https://github.com/cataclysmbn/Cataclysm-BN'],
      ['Cataclysm: Dark Days Ahead', 'https://github.com/CleverRaven/Cataclysm-DDA'],
      ['CC BY-SA 3.0', 'https://creativecommons.org/licenses/by-sa/3.0/'],
    ],
  },
  {
    title: 'UltimateCataclysm (UltiCa) tileset',
    lines: [
      'The pixel art that the 3D world is textured and modelled from: the UltimateCataclysm tileset by I-am-Erk and the CDDA-Tilesets contributors. Filler trees originally from opengameart.org by Yar, edited by I-am-Erk.',
      'Licensed under CC BY-SA 3.0. The sprites are cut up, recoloured and turned into 3D models and textures here.',
    ],
    links: [
      ['CDDA-Tilesets', 'https://github.com/I-am-Erk/CDDA-Tilesets'],
      ['Per-tile credits', 'https://github.com/I-am-Erk/CDDA-Tilesets/tree/master/gfx/UltimateCataclysm'],
    ],
  },
  {
    title: 'Sound effects',
    lines: [
      'From the CC-Sounds CDDA soundpack, a continuation of the CO.AG soundpack by SkyBreach, maintained by Fris0uman and contributors (pack under CC BY-SA 4.0). Each sound is CC0 or CC BY, mostly from freesound.org, transcoded to Opus and otherwise unmodified.',
      'Every file with its author, licence and source is listed in audio/CREDITS.md, which ships with the game.',
    ],
    links: [
      ['CDDA-Soundpacks', 'https://github.com/Fris0uman/CDDA-Soundpacks'],
      ['audio/CREDITS.md', '/audio/CREDITS.md'],
    ],
  },
  {
    title: 'Music',
    lines: [
      'Original music composed and produced by CO.AG, remastered by SkyBreach, from the CDDA music pack (CC BY-SA 4.0), used with the composer\'s permission ("fine to use my music as long as credit is given"): Cataclysm, The Ones Who Never Rest, Red Tears, Omen, Encounters With The Slenderman, Among The Cold Stones.',
    ],
    links: [
      ['CDDA-Music-Packs', 'https://github.com/Fris0uman/CDDA-Music-Packs'],
      ['CO.AG', 'https://www.youtube.com/channel/UCcavSftXHgxLBWwLDm_bNvA'],
    ],
  },
  {
    title: 'Fonts',
    lines: [
      'Terminus Font © 2020 Dimitar Toshkov Zhekov (Reserved Font Name "Terminus Font"); Vecterminus © 2017 tisimst; Terminus (TTF) © 2011-2023 Tilman Blumenbach. SIL Open Font License 1.1 (fonts/LICENSE-OFL-Terminus-Font.txt).',
      'GNU Unifont, as shipped with Cataclysm: GNU General Public License v2 or later, with the GNU font embedding exception.',
    ],
    links: [
      ['SIL OFL 1.1', 'https://openfontlicense.org'],
      ['Unifont licence', 'http://unifoundry.com/LICENSE.txt'],
    ],
  },
  {
    title: 'Inspiration',
    lines: ['The 3D pixel-art look is inspired by Starhelm Studios\' Project Shadowglass. No assets or code from it are used.'],
  },
];

export function openCredits(): void {
  closeGroup('credits');
  const panel = openPanel({
    id: 'credits', title: 'Credits', group: 'credits', pauses: true,
    width: 'min(calc(var(--fs) * 46), 94vw)', height: 'min(calc(var(--fs) * 34), 90vh)',
    footer: `${closeKeyLabel() || 'Bksp'} close · links open in a new tab`,
  });
  panel.body.classList.add('cr-body');
  for (const c of CREDITS) {
    const links = c.links?.length
      ? h('div', { class: 'cr-links' }, ...c.links.map(([label, url]) => {
          const a = h('a', { text: label, attrs: { href: url, target: '_blank', rel: 'noopener' } });
          return a;
        }))
      : null;
    panel.body.append(h('section', { class: 'cr-sec' }, h('div', { class: 'cr-title', text: c.title }), ...c.lines.map((l) => h('p', { text: l })), links));
  }
  const r = panel.el.getBoundingClientRect();
  panel.moveTo(Math.round((innerWidth - r.width) / 2), Math.round((innerHeight - r.height) / 2));
}
