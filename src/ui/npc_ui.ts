import type { Game } from '../game/game';
import type { Renderer } from '../render/renderer';
import type { Atlas, FrameRef } from '../render/atlas';
import type { Npc } from '../game/npc';
import type { NpcSystem } from '../game/npcai';
import type { Dialogue } from '../game/talk';
import { TradeSession, type TradeEntry } from '../game/trade';
import type { Item } from '../game/item';
import { npcLayers } from '../render/npcView';
import { atlasOf } from './context';
import { c, colorize, openMenu, openWindow, confirm, type UiWindow } from './framework';
import { sfx } from '../audio/sfx';
import { CHUNK } from '../world/coords';

// NPC screens in CDDA's curses style: the dialogue window (portrait, what was said,
// lettered responses; greyed responses are unavailable), the trade screen (two columns
// with prices and the running balance), the mission log and the chat menu (C).

export interface NpcUiCtx {
  game: Game;
  renderer: Renderer;
  sys: NpcSystem;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The NPC's composited sprite (body + clothes + weapon) scaled up for the dialogue portrait. */
export function portraitCanvas(atlas: Atlas | null, n: Npc, looksLike: (id: string) => string | undefined, scale = 4): HTMLCanvasElement | null {
  if (!atlas) return null;
  const refs = npcLayers(atlas, n, looksLike).map((id) => atlas.lookup(id)?.fg).filter((r): r is FrameRef => !!r);
  if (!refs.length) return null;
  let minX = 0, minY = 0, maxX = atlas.tileSize, maxY = atlas.tileSize;
  for (const r of refs) {
    minX = Math.min(minX, r.ox);
    minY = Math.min(minY, r.oy);
    maxX = Math.max(maxX, r.ox + r.w);
    maxY = Math.max(maxY, r.oy + r.h);
  }
  const cv = document.createElement('canvas');
  cv.width = (maxX - minX) * scale;
  cv.height = (maxY - minY) * scale;
  const g = cv.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  for (const r of refs) g.drawImage(r.image, r.px.x, r.px.y, r.px.w, r.px.h, (r.ox - minX) * scale, (r.oy - minY) * scale, r.w * scale, r.h * scale);
  cv.style.imageRendering = 'pixelated';
  return cv;
}

function attitudeText(n: Npc): string {
  if (n.isEnemy()) return c('c_red', 'Hostile');
  if (n.isAlly()) return c('c_light_green', n.following ? 'Follower' : 'Follower (waiting)');
  if (n.attitude === 'FLEE' || n.attitude === 'FLEE_TEMP') return c('c_light_blue', 'Fleeing');
  return c('c_light_gray', 'Neutral');
}

export function factionName(sys: NpcSystem, n: Npc): string {
  return sys.nd.factions[n.faction]?.name ?? (n.isAlly() ? 'Your Followers' : 'No faction');
}

// ------------------------------------------------------------------ dialogue

/** Open the dialogue window for a conversation that has been started (Dialogue.start()). */
export function openDialogue(ctx: NpcUiCtx, d: Dialogue, onClose?: () => void): UiWindow {
  const { game, renderer, sys } = ctx;
  const n = d.npc;
  let sel = 0;
  const win = openWindow({
    title: `Dialogue: ${n.displayName()}`,
    width: 'min(96vw, 110ch)',
    height: '82vh',
    footer: `${c('c_light_green', 'a-z')} respond  ${c('c_light_green', '↑↓/Enter')} select  ${c('c_light_green', '?')} show unavailable  ${c('c_light_green', 'Esc')} leave`,
    onKey: (e) => {
      const v = d.view();
      if (e.key === 'Escape') {
        finish();
        return true;
      }
      if (e.key === '?') {
        d.showHidden = !d.showHidden;
        d.refresh();
        render();
        return true;
      }
      if (e.key === 'ArrowDown') (sel = Math.min(v.responses.length - 1, sel + 1)), render();
      else if (e.key === 'ArrowUp') (sel = Math.max(0, sel - 1)), render();
      else if (e.key === 'Enter') pick(sel);
      else {
        const i = LETTERS.indexOf(e.key);
        if (i >= 0 && i < v.responses.length) pick(i);
      }
      return true;
    },
    onClose: () => onClose?.(),
  });
  win.el.classList.add('npc-dialogue');
  const top = document.createElement('div');
  top.style.cssText = 'display:flex;gap:12px;align-items:flex-end;border-bottom:1px solid var(--c-dark_gray);padding-bottom:4px;margin-bottom:4px';
  const pic = portraitCanvas(atlasOf(renderer), n, (id) => game.data.items[id]?.looks_like as string | undefined, 3);
  if (pic) {
    pic.style.border = '1px solid var(--c-dark_gray)';
    pic.style.background = '#101010';
    top.appendChild(pic);
  }
  const info = document.createElement('div');
  top.appendChild(info);
  const cols = document.createElement('div');
  cols.className = 'cols';
  cols.style.cssText = 'height:calc(100% - 130px)';
  const hist = document.createElement('div');
  hist.style.cssText = 'overflow:auto;height:100%;padding-right:6px;border-right:1px solid var(--c-dark_gray)';
  const resp = document.createElement('div');
  resp.style.cssText = 'overflow:auto;height:100%';
  cols.append(hist, resp);
  win.body.style.overflow = 'hidden';
  win.body.append(top, cols);

  function finish() {
    const after = [...d.after];
    d.after.length = 0;
    win.close();
    // Effects that open their own windows (trade) run once the dialogue is gone.
    for (const f of after) f();
  }

  function pick(i: number) {
    const v = d.view();
    const r = v.responses[i];
    if (!r) return;
    if (!r.available && !d.view().responses[i]) return;
    const res = d.choose(r.index);
    if (res.trial) {
      const t = res.trial;
      d.log.push({ who: 'info', text: `${t.kind === 'LIE' ? 'Lie' : t.kind === 'PERSUADE' ? 'Persuade' : t.kind === 'INTIMIDATE' ? 'Intimidate' : t.kind}: ${t.success ? 'success' : 'failure'} (${t.chance}%)` });
    }
    sel = 0;
    if (d.done) {
      const line = d.view().line;
      if (line && d.current === 'TALK_DONE') game.message(`${n.name}: ${line}`, 'c_white');
      finish();
      return;
    }
    // Mid-conversation trades (start_trade that returns to a topic) open over the dialogue.
    const after = [...d.after];
    d.after.length = 0;
    for (const f of after) f();
    render();
  }

  function render() {
    const v = d.view();
    info.innerHTML = [
      c('c_white', n.displayName()),
      `${c('c_light_gray', 'Faction:')} ${c('c_light_cyan', factionName(sys, n))}   ${attitudeText(n)}`,
      `${c('c_light_gray', 'Wielding:')} ${c('c_white', n.inv.wielded?.name() ?? 'nothing')}`,
      c('c_dark_gray', `trust ${n.op.trust}  fear ${n.op.fear}  value ${n.op.value}  anger ${n.op.anger}${n.op.owed ? `  owes you ${money(n.op.owed)}` : ''}`),
    ].join('\n');
    hist.innerHTML = d.log
      .slice(-60)
      .map((l) => (l.who === 'npc' ? (l.text.startsWith('"') ? `${c('c_light_green', n.name + ':')} ${colorize(l.text)}` : colorize(l.text)) : l.who === 'u' ? `${c('c_light_cyan', 'You:')} ${colorize(l.text)}` : c('c_yellow', l.text)))
      .join('\n\n');
    hist.scrollTop = hist.scrollHeight;
    sel = Math.min(sel, Math.max(0, v.responses.length - 1));
    resp.innerHTML = v.responses
      .map((r, i) => {
        const key = LETTERS[i] ?? ' ';
        const txt = r.available ? `<span style="color:var(--c-${r.color.replace(/^c_/, '')})">${colorize(r.text)}</span>` : c('c_dark_gray', r.text.replace(/<[^>]+>/g, ''));
        return `<div class="menu-entry${i === sel ? ' sel' : ''}${r.available ? '' : ' disabled'}" data-i="${i}" style="white-space:pre-wrap"><span class="hotkey">${key}</span>: ${txt}</div>`;
      })
      .join('');
    resp.querySelectorAll<HTMLElement>('.menu-entry').forEach((el) => {
      const i = Number(el.dataset.i);
      el.onclick = () => pick(i);
      el.onmouseenter = () => {
        if (sel !== i) (sel = i), render();
      };
    });
  }
  render();
  return win;
}

// ------------------------------------------------------------------ trade

export function openTrade(ctx: NpcUiCtx, n: Npc, cost = 0, onDone?: (traded: boolean) => void): UiWindow {
  const { game, sys } = ctx;
  const p = game.player;
  const s = new TradeSession(game.data, sys.nd, p, n, cost);
  let side: 0 | 1 = s.theirs.length ? 1 : 0;
  const cursor = [0, 0];
  let traded = false;
  let note = '';
  const win = openWindow({
    title: `Trade with ${n.displayName()}`,
    width: 'min(98vw, 130ch)',
    height: '84vh',
    footer: `${c('c_light_green', 'Tab/←→')} switch side  ${c('c_light_green', 'a-z')} mark  ${c('c_light_green', '+ -')} amount  ${c('c_light_green', 'Enter')} trade  ${c('c_light_green', 'Esc')} cancel`,
    onKey: (e) => {
      const list = side === 0 ? s.yours : s.theirs;
      if (e.key === 'Tab' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') side = side === 0 ? 1 : 0;
      else if (e.key === 'ArrowDown') cursor[side] = Math.min(list.length - 1, cursor[side] + 1);
      else if (e.key === 'ArrowUp') cursor[side] = Math.max(0, cursor[side] - 1);
      else if (e.key === '+' || e.key === '=') {
        const en = list[cursor[side]];
        if (en) s.setCount(en, en.count + 1);
      } else if (e.key === '-') {
        const en = list[cursor[side]];
        if (en) s.setCount(en, en.count - 1);
      } else if (e.key === 'Enter') {
        doTrade();
        return true;
      } else if (e.key === 'Escape') {
        win.close();
        return true;
      } else {
        const i = LETTERS.indexOf(e.key);
        if (i >= 0 && i < list.length) {
          cursor[side] = i;
          s.toggle(list[i]);
          sfx.ui('menu_select');
        } else return true;
      }
      render();
      return true;
    },
    onClose: () => onDone?.(traded),
  });
  const cols = document.createElement('div');
  cols.className = 'cols';
  cols.style.cssText = 'height:calc(100% - 3.6em)';
  const left = document.createElement('div');
  const right = document.createElement('div');
  for (const el of [left, right]) el.style.cssText = 'overflow:auto;height:100%';
  left.style.borderRight = '1px solid var(--c-dark_gray)';
  cols.append(left, right);
  const bar = document.createElement('div');
  bar.style.cssText = 'border-top:1px solid var(--c-dark_gray);padding-top:2px;white-space:pre';
  win.body.style.overflow = 'hidden';
  win.body.append(cols, bar);

  function doTrade() {
    const ok = s.canAccept();
    if (!ok.ok) {
      note = ok.reason ?? 'No deal.';
      sfx.ui('menu_error');
      render();
      return;
    }
    if (s.yourValue() === 0 && s.theirValue() === 0 && cost <= 0) {
      win.close();
      return;
    }
    s.commit((it) => game.map.addItem(p.tileX, p.tileY, p.z, it));
    traded = true;
    game.message(`You trade with ${n.name}.`, 'c_light_green');
    win.close();
  }

  function rows(list: TradeEntry[], active: boolean, which: 0 | 1): string {
    let html = '';
    let lastHeader = '';
    list.forEach((e, i) => {
      const header = e.source === 'worn' ? 'WORN' : e.source === 'wielded' ? 'WIELDED' : e.source === 'stock' ? 'SHOP STOCK' : e.source === 'npc' ? 'CARRIED' : 'INVENTORY';
      if (header !== lastHeader) {
        html += `<div class="menu-header">${header}</div>`;
        lastHeader = header;
      }
      const mark = e.count > 0 ? c('c_light_green', e.count === e.max ? '+' : '#') : ' ';
      const cnt = e.max > 1 ? c('c_light_gray', ` ${e.count}/${e.max}`) : '';
      const sel = active && i === cursor[which];
      const each = !e.item.countByCharges && e.max > 1;
      html += `<div class="menu-entry${sel ? ' sel' : ''}" data-s="${which}" data-i="${i}"><span class="hotkey">${LETTERS[i] ?? ' '}</span> ${mark} ${esc(e.item.name())}${cnt}<span style="float:right">${c('c_yellow', money(each ? e.price / e.max : e.price))}${each ? c('c_dark_gray', ' ea') : ''}</span></div>`;
    });
    return html || c('c_dark_gray', '(nothing to trade)');
  }

  function render() {
    left.innerHTML = `<div style="color:var(--c-${side === 0 ? 'white' : 'light_gray'})">${c('c_light_cyan', 'You')}  ${c('c_dark_gray', `offering ${money(s.yourValue())}`)}</div>` + rows(s.yours, side === 0, 0);
    right.innerHTML = `<div>${c('c_light_cyan', n.displayName())}  ${c('c_dark_gray', `taking ${money(s.theirValue())}`)}</div>` + rows(s.theirs, side === 1, 1);
    for (const el of [left, right])
      el.querySelectorAll<HTMLElement>('.menu-entry').forEach((row) => {
        row.onclick = () => {
          const w = Number(row.dataset.s) as 0 | 1, i = Number(row.dataset.i);
          side = w;
          cursor[w] = i;
          s.toggle((w === 0 ? s.yours : s.theirs)[i]);
          render();
        };
      });
    const bal = s.balance();
    const acc = s.canAccept();
    const balText = bal >= 0 ? c('c_light_green', `${n.name} will owe you ${money(bal)}`) : c('c_light_red', `You will owe ${n.name} ${money(-bal)}`);
    const cur = sys.nd.factions[n.faction]?.currency;
    bar.innerHTML = `${balText}   ${acc.ok ? c('c_green', 'Deal is acceptable') : c('c_red', 'Not enough')}${cost > 0 ? `   ${c('c_yellow', `(price to pay: ${money(cost)})`)}` : ''}${cur && game.data.items[cur] ? `   ${c('c_dark_gray', `currency: ${game.data.items[cur].name}`)}` : ''}\n${c('c_light_red', note)}`;
    (left.querySelector('.sel') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    (right.querySelector('.sel') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }
  render();
  return win;
}

// ------------------------------------------------------------------ missions

const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

export function openMissionLog(ctx: NpcUiCtx): UiWindow {
  const { game, sys } = ctx;
  const p = game.player;
  const all = [...sys.missions.all.values()].filter((m) => m.status !== 'available');
  let tab = 0;
  const tabs = ['CURRENT', 'COMPLETED', 'FAILED'] as const;
  const win = openWindow({
    title: 'Missions',
    width: 'min(92vw, 100ch)',
    height: '70vh',
    footer: `${c('c_light_green', 'Tab/←→')} switch tab  ${c('c_light_green', 'Esc')} close`,
    onKey: (e) => {
      if (e.key === 'Tab' || e.key === 'ArrowRight') tab = (tab + 1) % 3;
      else if (e.key === 'ArrowLeft') tab = (tab + 2) % 3;
      else return false;
      render();
      return true;
    },
  });
  function render() {
    const status = tab === 0 ? 'active' : tab === 1 ? 'succeeded' : 'failed';
    const list = all.filter((m) => m.status === status);
    let html = `<div class="tabs">${tabs.map((t, i) => `<span class="tab${i === tab ? ' on' : ''}"> ${t} </span>`).join(' ')}</div>\n`;
    if (!list.length) html += c('c_dark_gray', tab === 0 ? 'You have no active missions.' : 'Nothing here.');
    for (const m of list) {
      const def = sys.missions.def(m);
      const giver = m.npcUid >= 0 ? sys.npcByUid(m.npcUid) : undefined;
      html += `${c('c_white', def?.name ?? m.id)}${giver ? c('c_light_gray', `  (from ${giver.displayName()})`) : ''}\n`;
      html += `  ${c('c_light_cyan', sys.missions.goalText(m))}\n`;
      if (m.target) {
        const ox = Math.floor(p.x / CHUNK), oy = Math.floor(p.y / CHUNK);
        const dx = m.target.x - ox, dy = m.target.y - oy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const dir = d === 0 ? 'here' : `${d} OMT to the ${DIRS[Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360 / 45) % 8]}`;
        html += `  ${c('c_light_gray', 'Target:')} ${c('c_yellow', dir)}\n`;
      }
      if (m.deadline !== undefined) html += `  ${c('c_light_gray', 'Deadline:')} ${c('c_light_red', `${Math.max(0, Math.round((m.deadline - game.clock.seconds) / 3600))} hours`)}\n`;
      if (def?.description) html += `  ${c('c_dark_gray', esc(sys.missions.host.dialogueFor(giver)?.parseTags(def.description) ?? def.description))}\n`;
      html += '\n';
    }
    win.body.innerHTML = html;
  }
  render();
  return win;
}

// ------------------------------------------------------------------ chat menu (C)

/** CDDA game::chat: talk to someone nearby, or give orders to your followers. */
export function openChatMenu(ctx: NpcUiCtx, talk: (n: Npc) => void): void {
  const { game, sys } = ctx;
  const p = game.player;
  const near = sys.npcs
    .filter((n) => !n.dead && n.z === p.z && Math.hypot(n.x - p.x, n.y - p.y) <= 15)
    .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  const allies = near.filter((n) => n.isAlly());
  type Choice = { kind: 'talk'; n: Npc } | { kind: 'wait' } | { kind: 'follow' } | { kind: 'yell' };
  const entries: { label: string; value: Choice; header?: string }[] = near.map((n) => ({
    label: `${c(n.isEnemy() ? 'c_red' : n.isAlly() ? 'c_light_green' : 'c_white', n.displayName())} ${c('c_dark_gray', `(${Math.round(Math.hypot(n.x - p.x, n.y - p.y))} tiles)`)}`,
    value: { kind: 'talk', n } as Choice,
    header: 'Talk to…',
  }));
  if (allies.length) {
    entries.push({ label: c('c_white', 'Tell your allies to wait here'), value: { kind: 'wait' }, header: 'Orders' });
    entries.push({ label: c('c_white', 'Tell your allies to follow you'), value: { kind: 'follow' }, header: 'Orders' });
  }
  entries.push({ label: c('c_white', 'Yell'), value: { kind: 'yell' }, header: 'Other' });
  openMenu<Choice>({
    title: 'Who do you want to talk to or yell at?',
    entries,
    onSelect: (ch) => {
      if (ch.kind === 'talk') setTimeout(() => talk(ch.n), 0);
      else if (ch.kind === 'wait') {
        for (const n of allies) {
          n.following = false;
          n.guardPos = { x: n.tileX, y: n.tileY, z: n.z };
        }
        game.message('You tell your allies to wait here.');
      } else if (ch.kind === 'follow') {
        for (const n of allies) {
          n.following = true;
          n.guardPos = null;
          n.attitude = 'FOLLOW';
        }
        game.message('You tell your allies to follow you.');
      } else {
        game.message('You yell!');
        import('../game/sound').then(({ emitSound }) => emitSound(game, { x: p.tileX, y: p.tileY, z: p.z }, 30, 'yelling', { category: 'speech', source: p, ambient: true }));
      }
    },
  });
}

/** CDDA query_yn before attacking someone who isn't hostile. */
export function confirmAttackNpc(n: Npc, yes: () => void): void {
  void confirm(`Really attack ${n.name}?  ${n.isAlly() ? 'They are your ally!' : 'They are not hostile.'}`).then((ok) => ok && yes());
}

/** npc_gets_item: pick one of your items. */
export function pickItemMenu(title: string, items: Item[], onPick: (it: Item | null) => void): void {
  if (!items.length) return onPick(null);
  let chosen = false;
  openMenu<Item>({
    title,
    entries: items.map((it) => ({ label: esc(it.name()), value: it })),
    onSelect: (it) => {
      chosen = true;
      onPick(it);
    },
    onClose: () => !chosen && onPick(null),
  });
}
