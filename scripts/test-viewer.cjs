// A plain window for live checks' local test pages, so checks never open Rayan's browsers
// (AGENTS.md). Its titles end in " - Glossly Test Viewer", which a dev build started with
// GLOSSLY_TEST_VIEWER=1 treats as a browser tab, so "(3) Discord | #general | Test Server"
// gets site detection like the real site would. No profile or history is kept.
//
//   electron.exe scripts/test-viewer.cjs <page.html> [width height [x y]]   open (or switch the open window to) a page, sizes in DIP
//   electron.exe scripts/test-viewer.cjs close                              close the viewer
//
// Run electron.exe from node_modules\electron\dist with ELECTRON_RUN_AS_NODE unset. One viewer
// runs at a time: a second start hands its page to the open window and exits.
const { app, BrowserWindow } = require('electron');
const { join, resolve } = require('node:path');
const os = require('node:os');

const SUFFIX = ' - Glossly Test Viewer';
app.setPath('userData', join(os.tmpdir(), 'glossly-test-viewer'));

/** The arguments after this script's path (Electron's own flags filtered out). */
function parse(argv) {
  const i = argv.findIndex((a) => a.endsWith('test-viewer.cjs'));
  const [page, w, h, x, y] = argv.slice(i + 1).filter((a) => !a.startsWith('--'));
  return { page, w: Number(w) || 1000, h: Number(h) || 700, x: x === undefined ? undefined : Number(x), y: y === undefined ? undefined : Number(y) };
}

const first = parse(process.argv);
if (!app.requestSingleInstanceLock({ argv: process.argv })) {
  app.exit(0);
} else {
  let win = null;
  const show = (o) => {
    if (o.page === 'close') return app.quit();
    if (!win) {
      win = new BrowserWindow({ width: o.w, height: o.h, ...(o.x !== undefined && { x: o.x, y: o.y }), autoHideMenuBar: true });
      win.on('page-title-updated', (e, title) => {
        e.preventDefault();
        win.setTitle(title + SUFFIX);
      });
      win.on('closed', () => app.quit());
    } else {
      win.setBounds({ width: o.w, height: o.h, ...(o.x !== undefined && { x: o.x, y: o.y }) });
    }
    win.loadFile(resolve(o.page));
  };
  app.on('second-instance', (_e, _argv, _cwd, data) => show(parse(data?.argv ?? [])));
  app.whenReady().then(() => (first.page ? show(first) : app.quit()));
  app.on('window-all-closed', () => app.quit());
}
