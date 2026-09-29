# Dev shell: node for the Vite/Three.js build, chromium for headless screenshot tests.
{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  packages = [ pkgs.nodejs_22 pkgs.chromium pkgs.python3 pkgs.imagemagick ];
  shellHook = ''
    export CHROME_PATH=${pkgs.chromium}/bin/chromium
    export PUPPETEER_SKIP_DOWNLOAD=1
  '';
}
