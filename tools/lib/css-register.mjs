// Node tools that import UI modules (balance_sim reaches src/ui through chargen) hit the
// `import './x.css'` lines Vite handles in the browser. This loader hook turns them into empty
// modules. Use: NODE_OPTIONS='--import ./tools/lib/css-register.mjs' tsx tools/balance_sim.ts
// (`npm run sim -- …` does this).
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function load(url, ctx, next) {
        if (url.endsWith('.css')) return { format: 'module', source: 'export default ""', shortCircuit: true };
        return next(url, ctx);
      }`,
    ),
);
