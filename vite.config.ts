import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so dist/ can be hosted under any sub-path (GitHub Pages, itch.io, ...).
  base: './',
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
} as any);
