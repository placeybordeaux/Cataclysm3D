// "Leave site?" guard while a game is running: Ctrl+W (FPS players hold Ctrl), Ctrl+R or a
// stray click on the tab's close button would otherwise end the run without a save. Reloads
// the game does on purpose (quit to title, load a save, after death) go through reloadPage().

let armed = false;
let installed = false;

export function armUnloadGuard(): void {
  armed = true;
  if (installed) return;
  installed = true;
  window.addEventListener('beforeunload', (e) => {
    if (!armed) return;
    e.preventDefault();
    // Chrome still wants returnValue set to show the dialog.
    e.returnValue = '';
  });
}

export function disarmUnloadGuard(): void {
  armed = false;
}

/** Reload on purpose (no "Leave site?" prompt). */
export function reloadPage(): void {
  armed = false;
  location.reload();
}
