// Where the static assets (public/: data, atlas, audio, fonts) are served from. The production
// build uses a relative base (vite.config.ts) so dist/ works from any sub-path; under node (tests,
// tools) import.meta.env doesn't exist and the loaders are handed explicit bases anyway.
export const ASSET_BASE: string = import.meta.env?.BASE_URL ?? '/';
export const DATA_BASE = `${ASSET_BASE}data/`;
