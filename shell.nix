# Dev shell: node for the Vite/Three.js build, chromium for headless screenshot tests,
# ffmpeg for the audio transcoder (tools/audio). Xvfb + xdotool let tools/drive.ts --headful
# run a real (windowed) Chromium on a virtual display, where pointer lock and OS-level key
# events (xdotool) behave exactly like a player's browser.
{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  packages = [ pkgs.nodejs_22 pkgs.chromium pkgs.python3 pkgs.imagemagick pkgs.ffmpeg-headless pkgs.xorg-server pkgs.xdotool pkgs.setxkbmap ];
  shellHook = ''
    export CHROME_PATH=${pkgs.chromium}/bin/chromium
    export PUPPETEER_SKIP_DOWNLOAD=1
  '';
}
