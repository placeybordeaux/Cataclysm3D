import type { GameData } from '../data/types';
import { possibleItems } from '../data/index';
import type { Character } from './character';
import type { Item } from './item';
import { isAt, L, moveItem, transaction, type Loc } from './moves';
import type { Npc, NpcData, PriceRule } from './npc';

// Bartering (npctrade.cpp + trade_ui.cpp), UI-free. Prices are cents from the item's
// post-apocalypse price, adjusted by faction/shopkeeper price rules, the NPC's valuation and
// the int/speech difference between the traders. The balance is what the NPC owes the
// survivor after the exchange (op_of_u.owed carries over between trades); a trade goes
// through when the balance plus the credit the NPC extends is not negative. Friends
// (followers) swap items freely.

/** skill.cpp price_adjustment: 1 +- 0.045*s^2 - 0.025*s for a speech difference s (capped at 5). */
export function priceAdjustment(barterSkill: number): number {
  const s = Math.min(5, Math.abs(barterSkill));
  const v = 0.045 * s * s - 0.025 * s + 1;
  return barterSkill >= 0 ? v : 1 / v;
}

/** npc_trading::net_price_adjustment (seller's perspective; negative when the survivor sells). */
export function netPriceAdjustment(buyer: Character, seller: Character, sellerIsNpc: boolean): number {
  const intDiff = seller.int - buyer.int;
  const intAdj = 1 + 0.05 * Math.min(19, Math.abs(intDiff));
  const socAdj = priceAdjustment(Math.round(seller.getSkill('speech') - buyer.getSkill('speech')));
  const adjust = intDiff >= 0 ? intAdj * socAdj : socAdj / intAdj;
  return sellerIsNpc ? adjust : -1 / adjust;
}

/** item::price(true) for `count` units (count-by-charges prices are per stack_size units). */
export function marketPrice(it: Item, count = it.count()): number {
  const base = it.def.price_postapoc ?? it.def.price ?? 0;
  if (it.countByCharges) return (base * count) / Math.max(1, it.stackSize());
  return base;
}

const groupCache = new WeakMap<GameData, Map<string, Set<string>>>();
function groupItems(data: GameData, group: string): Set<string> {
  let m = groupCache.get(data);
  if (!m) groupCache.set(data, (m = new Map()));
  let s = m.get(group);
  if (!s) m.set(group, (s = possibleItems(data, group)));
  return s;
}

/** npc::get_price_rules: shopkeeper class rules first, then the faction's (last match wins). */
export function priceRuleFor(data: GameData, nd: NpcData, npc: Npc, it: Item): PriceRule | undefined {
  const lists = [nd.factions[npc.faction]?.price_rules ?? [], nd.classes[npc.classId]?.shopkeeper_price_rules ?? []];
  let found: PriceRule | undefined;
  for (const list of lists)
    for (const r of list) {
      if (r.condition !== undefined) continue; // dialogue-conditional rules are ignored
      const hit = (r.item && r.item === it.typeId) || (r.category && r.category === it.def.category) || (r.flag && it.hasFlag(r.flag))
        || (r.group && groupItems(data, r.group).has(it.typeId));
      if (hit) found = r;
    }
  return found;
}

/**
 * npc_trading::adjusted_price: the price of `count` units of `it` when `npcSells` (the NPC is
 * the seller) or the survivor sells to the NPC.
 */
export function adjustedPrice(data: GameData, nd: NpcData, npc: Npc, player: Character, it: Item, count: number, npcSells: boolean): number {
  const rule = priceRuleFor(data, nd, npc, it);
  const unit = rule?.price !== undefined ? rule.price : undefined;
  let price = unit !== undefined ? (it.countByCharges ? (unit * count) / Math.max(1, it.stackSize()) : unit) : marketPrice(it, count);
  if (rule) {
    price *= rule.premium ?? 1;
    if (npcSells) price *= rule.markup ?? 1;
  }
  // npc::value: shopkeepers and faction currency trade at market price; others roughly too.
  // Money is money: the faction's own currency changes hands without haggling.
  if (nd.factions[npc.faction]?.currency === it.typeId && rule?.fixed_adj === undefined) return Math.ceil(price);
  if (rule?.fixed_adj !== undefined) price *= 1 + (npcSells ? rule.fixed_adj : -rule.fixed_adj);
  else {
    const adj = npcSells ? netPriceAdjustment(player, npc, true) : netPriceAdjustment(npc, player, false);
    price *= 1 + 0.25 * adj;
  }
  return Math.ceil(price);
}

/**
 * npc_trading::trading_price: an item is worth itself plus everything inside it, so a box of
 * ammo sells for its rounds (the cardboard alone is worth nothing).
 */
export function tradingPrice(data: GameData, nd: NpcData, npc: Npc, player: Character, it: Item, npcSells: boolean): number {
  let sum = 0;
  for (const e of it.walk()) sum += adjustedPrice(data, nd, npc, player, e, e.count(), npcSells);
  return sum;
}

/** npc::max_credit_extended */
export function maxCreditExtended(npc: Npc): number {
  if (npc.isAlly()) return Infinity;
  const op = npc.op;
  return Math.max(0, op.trust * 50 + op.value * 50 + op.fear * 50 + npc.personality.altruism * 100 + op.anger * -200);
}

/** npc::max_willing_to_owe */
export function maxWillingToOwe(npc: Npc): number {
  if (npc.isAlly()) return Infinity;
  const op = npc.op;
  return Math.max(0, 10000 + Math.max(0, op.trust) * 10000 + Math.max(0, op.value) * 10000 + Math.max(0, op.fear) * 10000 + Math.max(0, npc.personality.altruism) * 10000 - op.anger * 10000);
}

/** npc_trading::calc_npc_owes_you */
export function calcNpcOwesYou(npc: Npc, balance: number): number {
  if (npc.isAlly()) return 0;
  if (balance > npc.op.owed && balance > maxWillingToOwe(npc)) return Math.max(npc.op.owed, maxWillingToOwe(npc));
  return balance;
}

export type TradeSource = 'carried' | 'worn' | 'wielded' | 'stock' | 'npc';

export interface TradeEntry {
  /** First item of the row (for its name); identical items share one row (`items`). */
  item: Item;
  items: Item[];
  source: TradeSource;
  /** Where the row's items are (moves.ts). */
  loc: Loc;
  /** Units available (charges for a stack, else the number of identical items). */
  max: number;
  /** Units selected for the exchange. */
  count: number;
  /** Price for all `max` units (cents). */
  price: number;
}

export class TradeSession {
  readonly yours: TradeEntry[] = [];
  readonly theirs: TradeEntry[] = [];

  /**
   * `cost` > 0: the survivor owes that much for a service or item bought through dialogue
   * (u_buy_item / mission rewards use a negative cost: the NPC owes the survivor).
   */
  constructor(readonly data: GameData, readonly nd: NpcData, readonly player: Character, readonly npc: Npc, readonly cost = 0) {
    const p = player;
    const rows = new Map<string, TradeEntry>();
    const add = (list: TradeEntry[], it: Item, source: TradeSource, loc: Loc, npcSells: boolean) => {
      if (it.isLiquid() && !it.isContainer()) return;
      if (it.countByCharges) {
        list.push({ item: it, items: [it], source, loc, max: it.charges, count: 0, price: adjustedPrice(data, nd, npc, p, it, it.charges, npcSells) });
        return;
      }
      // Identical items (same type and state) stack into one row like CDDA's trade screen.
      const key = `${npcSells ? 'n' : 'u'}:${source}:${JSON.stringify(it.toJSON())}`;
      const row = rows.get(key);
      const unit = tradingPrice(data, nd, npc, p, it, npcSells);
      if (row) {
        row.items.push(it);
        row.max++;
        row.price += unit;
        return;
      }
      const e: TradeEntry = { item: it, items: [it], source, loc, max: 1, count: 0, price: unit };
      rows.set(key, e);
      list.push(e);
    };
    for (const it of p.inv.carried()) add(this.yours, it, 'carried', L.inv(p), false);
    // Worn holsters/containers with something in them stay on (selling one would hand over
    // what it holds without pricing it); integrated items can't come off at all.
    for (const it of p.inv.worn) if (!it.hasContents() && !it.hasFlag('INTEGRATED') && !it.hasFlag('NO_TAKEOFF')) add(this.yours, it, 'worn', L.worn(p), false);
    if (p.inv.wielded && !p.inv.wielded.hasFlag('NO_UNWIELD') && !p.inv.wielded.hasFlag('BIONIC_WEAPON')) add(this.yours, p.inv.wielded, 'wielded', L.hands(p), false);
    const sellsBelongings = nd.classes[npc.classId]?.sells_belongings !== false;
    for (const it of npc.stock) add(this.theirs, it, 'stock', L.stock(npc), true);
    if (sellsBelongings || !npc.isShopkeeper()) for (const it of npc.inv.carried()) add(this.theirs, it, 'npc', L.inv(npc), true);
    if (npc.isAlly() && npc.inv.wielded) add(this.theirs, npc.inv.wielded, 'npc', L.hands(npc), true);
    // Goods first (by category, then name), the faction's currency last.
    const cur = nd.factions[npc.faction]?.currency;
    this.theirs.sort((a, b) => Number(a.item.typeId === cur) - Number(b.item.typeId === cur) || String(a.item.def.category).localeCompare(String(b.item.def.category)) || a.item.name().localeCompare(b.item.name()));
  }

  /** Value of a selected entry (price scales with the units chosen). */
  static value(e: TradeEntry): number {
    return e.max > 0 ? Math.ceil((e.price * e.count) / e.max) : 0;
  }

  yourValue(): number {
    return this.yours.reduce((s, e) => s + TradeSession.value(e), 0);
  }
  theirValue(): number {
    return this.theirs.reduce((s, e) => s + TradeSession.value(e), 0);
  }

  /** What the NPC will owe the survivor after this exchange (negative: you owe them). */
  balance(): number {
    return this.npc.op.owed - this.cost + this.yourValue() - this.theirValue();
  }

  /** npc_trading::npc_will_accept_trade (+ weight check for what the survivor takes). */
  canAccept(): { ok: boolean; reason?: string } {
    const free = this.npc.isAlly();
    if (!free && this.balance() + maxCreditExtended(this.npc) < 0) return { ok: false, reason: `${this.npc.name} thinks you're getting the better end of this deal.` };
    return { ok: true };
  }

  setCount(e: TradeEntry, n: number): void {
    e.count = Math.max(0, Math.min(e.max, Math.round(n)));
  }
  toggle(e: TradeEntry): void {
    this.setCount(e, e.count > 0 ? 0 : e.max);
  }

  /**
   * Move the items and settle the balance. Returns false (nothing moved) when the NPC refuses
   * or a selected item is no longer where the session saw it. What the survivor gets but can't
   * carry is set down at their feet and reported to `onDropped`.
   */
  commit(onDropped: (it: Item) => void = () => {}): boolean {
    if (!this.canAccept().ok) return false;
    const p = this.player, n = this.npc;
    const dropped: Item[] = [];
    const ok = transaction(() => {
      const give = (e: TradeEntry, to: () => Loc[]): boolean => {
        if (e.count <= 0) return true;
        const units: [Item, number | undefined][] = e.item.countByCharges ? [[e.item, e.count]] : e.items.slice(0, e.count).map((x) => [x, undefined]);
        for (const [it, count] of units) {
          if (!isAt(it, e.loc)) return false;
          // Part of the stack went (eaten, fired) while the screen was open: the offer is stale.
          if (count !== undefined && count > it.count()) return false;
          let moved = false;
          for (const dest of to()) {
            const r = moveItem(it, e.loc, dest, { count, quiet: true, actor: dest.kind === 'inv' ? dest.who : undefined });
            if (!r.ok) continue;
            if (dest.kind === 'ground') dropped.push(r.item ?? it);
            moved = true;
            break;
          }
          if (!moved) return false;
        }
        return true;
      };
      const ground = p.inv.groundHere();
      const toPlayer = () => [L.inv(p), ...(ground ? [ground] : [])];
      // A shopkeeper puts what they buy on the shelf; anyone else carries it if they can.
      const toNpc = () => (n.isShopkeeper() ? [L.stock(n)] : [L.inv(n), L.stock(n)]);
      for (const e of this.theirs) if (!give(e, toPlayer)) return false;
      for (const e of this.yours) if (!give(e, toNpc)) return false;
      return true;
    });
    if (!ok) return false;
    for (const it of dropped) onDropped(it);
    const bal = this.balance();
    n.op.owed = calcNpcOwesYou(n, bal);
    p.practice('speech', Math.floor(this.yourValue() / 10000));
    for (const e of [...this.yours, ...this.theirs]) e.count = 0;
    return true;
  }
}
