import type { Game } from './game/game';
import type { PlayerCombat } from './game/playercombat';
import type { BodyMods } from './game/bodymods';
import { bionicGunSession } from './game/bionicguns';

// Wiring for bionic guns (src/game/bionicguns.ts, docs/BN_BIONIC_GUNS.md): activating a
// BIONIC_GUN bionic from the bionics menu starts aiming its detached fake gun in PlayerCombat;
// the menu key (Esc) stops aiming instead of opening the pause menu, as Esc leaves BN's aiming
// UI; loading a save drops the aim like any other activity. main.ts calls this once, after the
// UI has registered the menu key.

export function installBionicGuns(game: Game, combat: PlayerCombat, mods: BodyMods): void {
  const { bio } = mods;
  bio.onGunActivation = (id, gun, cost) => combat.startBionicGun(id, gun, bio, cost);
  const menu = game.keys.action('menu');
  if (menu) {
    game.keys.register('menu', menu.name, () => {
      const s = bionicGunSession(game);
      if (s) combat.cancelBionicGun(`You stop aiming your ${s.gun.name()}.`);
      else menu.handler();
    });
  }
  game.events.on('gameLoaded', () => combat.cancelBionicGun());
}
