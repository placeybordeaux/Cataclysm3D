import type { GameData } from '../data/types';
import { possibleItems } from '../data/index';
import type { Character } from './character';
import type { Item } from './item';
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
    const add = (list: TradeEntry[], it: Item, source: TradeSource, npcSells: boolean) => {
      if (it.isLiquid() && !it.isContainer()) return;
      if (it.countByCharges) {
        list.push({ item: it, items: [it], source, max: it.charges, count: 0, price: adjustedPrice(data, nd, npc, p, it, it.charges, npcSells) });
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
      const e: TradeEntry = { item: it, items: [it], source, max: 1, count: 0, price: unit };
      rows.set(key, e);
      list.push(e);
    };
    for (const it of p.inv.carried()) add(this.yours, it, 'carried', false);
    // Worn containers with things inside stay on (selling the backpack would hand over its contents).
    for (const it of p.inv.worn) if (!it.containerPockets().some((pk) => pk.contents.length)) add(this.yours, it, 'worn', false);
    if (p.inv.wielded) add(this.yours, p.inv.wielded, 'wielded', false);
    const sellsBelongings = nd.classes[npc.classId]?.sells_belongings !== false;
    for (const it of npc.stock) add(this.theirs, it, 'stock', true);
    if (sellsBelongings || !npc.isShopkeeper()) for (const it of npc.inv.carried()) add(this.theirs, it, 'npc', true);
    if (npc.isAlly() && npc.inv.wielded) add(this.theirs, npc.inv.wielded, 'npc', true);
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
   * Move the items and settle the balance. Returns false (nothing moved) when the NPC refuses.
   * `drop` puts items the survivor can't carry at their feet.
   */
  commit(drop: (it: Item) => void): boolean {
    if (!this.canAccept().ok) return false;
    const p = this.player, n = this.npc;
    const detach = (it: Item, e: TradeEntry, owner: 'player' | 'npc'): Item => {
      if (owner === 'player') {
        if (e.source === 'wielded') p.inv.wielded = null;
        else p.inv.remove(it);
      } else if (e.source === 'stock') n.stock.splice(n.stock.indexOf(it), 1);
      else if (n.inv.wielded === it) n.inv.wielded = null;
      else n.inv.remove(it);
      return it;
    };
    const take = (e: TradeEntry, owner: 'player' | 'npc'): Item[] => {
      if (e.count <= 0) return [];
      const it = e.item;
      if (it.countByCharges) return [e.count < it.charges ? it.split(e.count) : detach(it, e, owner)];
      return e.items.slice(0, e.count).map((x) => detach(x, e, owner));
    };
    const quiet = <T>(c: Character, fn: () => T): T => {
      const s = c.onMessage;
      c.onMessage = null;
      try {
        return fn();
      } finally {
        c.onMessage = s;
      }
    };
    const toNpc = this.yours.flatMap((e) => take(e, 'player'));
    const toPlayer = this.theirs.flatMap((e) => take(e, 'npc'));
    for (const it of toPlayer) if (!quiet(p, () => p.inv.pickUp(it)).ok) drop(it);
    for (const it of toNpc) {
      if (n.isShopkeeper()) n.stock.push(it);
      else {
        const left = quiet(n, () => n.inv.stash(it));
        if (left) n.stock.push(left);
      }
    }
    const bal = this.balance();
    n.op.owed = calcNpcOwesYou(n, bal);
    p.practice('speech', Math.floor(this.yourValue() / 10000));
    for (const e of [...this.yours, ...this.theirs]) e.count = 0;
    return true;
  }
}
