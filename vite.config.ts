import { defineConfig } from 'vite';
import { liveBridge } from './tools/dev/liveBridge';

export default defineConfig({
  // Relative asset URLs so dist/ can be hosted under any sub-path (GitHub Pages, itch.io, ...).
  base: './',
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
  // Dev only: lets the terminal see/query the running game tab (see tools/dev/liveBridge.ts).
  plugins: [liveBridge()],
} as any);
