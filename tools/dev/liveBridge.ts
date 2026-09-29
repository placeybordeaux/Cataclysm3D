import type { Plugin, ViteDevServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Dev-only bridge between a human's running game tab and the developer (or an agent) at the
// terminal. The tab (src/dev/bridge.ts) pushes a state summary every couple of seconds and
// answers requests over Vite's HMR websocket; this plugin exposes them as local HTTP:
//
//   GET  /__cdda/state         -> latest state JSON (also mirrored to .scratch/live/state.json)
//   POST /__cdda/shot          -> screenshot of the 3D canvas -> .scratch/live/shot.png
//   POST /__cdda/eval  <js>    -> evaluate JS in the tab (`cdda`, `game` in scope), JSON result
//
// Only active under `vite` (serve), which listens on localhost. tools/live.ts is the CLI.

const OUT = resolve('.scratch/live');

export function liveBridge(): Plugin {
  let seq = 0;
  const waiting = new Map<number, (reply: { result?: unknown; error?: string; image?: string }) => void>();
  let lastState: unknown = null;

  const ask = (server: ViteDevServer, type: string, data: Record<string, unknown>, timeoutMs = 15000) =>
    new Promise<{ result?: unknown; error?: string; image?: string }>((res) => {
      const id = ++seq;
      const t = setTimeout(() => {
        waiting.delete(id);
        res({ error: 'no reply from the game tab (is it open and running in dev mode?)' });
      }, timeoutMs);
      waiting.set(id, (r) => {
        clearTimeout(t);
        res(r);
      });
      server.ws.send(type, { id, ...data });
    });

  const body = (req: import('node:http').IncomingMessage) =>
    new Promise<string>((res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => res(b));
    });

  return {
    name: 'cdda-live-bridge',
    apply: 'serve',
    configureServer(server) {
      mkdirSync(OUT, { recursive: true });
      server.ws.on('cdda:state', (data) => {
        lastState = data;
        writeFileSync(resolve(OUT, 'state.json'), JSON.stringify(data, null, 2));
      });
      server.ws.on('cdda:reply', (data: { id: number; result?: unknown; error?: string; image?: string }) => {
        waiting.get(data.id)?.(data);
        waiting.delete(data.id);
      });
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/__cdda/')) return next();
        const send = (code: number, obj: unknown) => {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(obj, null, 2));
        };
        const route = req.url.slice('/__cdda/'.length).split('?')[0];
        if (route === 'state') return send(lastState ? 200 : 404, lastState ?? { error: 'no state yet (open the game tab)' });
        if (route === 'eval') {
          const r = await ask(server, 'cdda:eval', { code: await body(req) });
          return send(r.error ? 500 : 200, r.error ? { error: r.error } : { result: r.result });
        }
        if (route === 'shot') {
          const r = await ask(server, 'cdda:shot', {});
          if (r.error || !r.image) return send(500, { error: r.error ?? 'no image' });
          const file = resolve(OUT, 'shot.png');
          writeFileSync(file, Buffer.from(r.image.replace(/^data:image\/png;base64,/, ''), 'base64'));
          return send(200, { file });
        }
        send(404, { error: `unknown route ${route}` });
      });
    },
  };
}
