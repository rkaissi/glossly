// A plain window for live checks' local test pages, so checks never open Rayan's browsers
// (AGENTS.md). Its titles end in " - Glossly Test Viewer", which a dev build started with
// GLOSSLY_TEST_VIEWER=1 treats as a browser tab, so "(3) Discord | #general | Test Server"
// gets site detection like the real site would. No profile or history is kept.
//
// Like a browser, it has an address bar above the page (a read-only field in a view of its own),
// so the helper's page_address reads it the way it reads Chromium's (decision 84). It shows the
// page's file address, or the one given with --url (a made-up https address for a local page).
//
//   electron.exe scripts/test-viewer.cjs <page.html> [width height [x y]] [--url=https://...]   open (or switch the open window to) a page, sizes in DIP
//   electron.exe scripts/test-viewer.cjs close                                                close the viewer
//
// Run electron.exe from node_modules\electron\dist with ELECTRON_RUN_AS_NODE unset. One viewer
// runs at a time: a second start hands its page to the open window and exits.
const { app, BaseWindow, WebContentsView } = require('electron');
const { join, resolve } = require('node:path');
const os = require('node:os');

const SUFFIX = ' - Glossly Test Viewer';
const BAR_H = 36;
app.setPath('userData', join(os.tmpdir(), 'glossly-test-viewer'));

/** The arguments after this script's path (Electron's own flags filtered out, except --url). */
function parse(argv) {
  const i = argv.findIndex((a) => a.endsWith('test-viewer.cjs'));
  const rest = argv.slice(i + 1);
  const url = rest.find((a) => a.startsWith('--url='))?.slice('--url='.length);
  const [page, w, h, x, y] = rest.filter((a) => !a.startsWith('--'));
  return { page, url, w: Number(w) || 1000, h: Number(h) || 700, x: x === undefined ? undefined : Number(x), y: y === undefined ? undefined : Number(y) };
}

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const barHtml = (address) =>
  `<!doctype html><meta charset="utf-8"><title>Address</title><style>` +
  `body{margin:0;padding:4px 8px;background:#f1f3f4;font:13px "Segoe UI",sans-serif}` +
  `input{width:100%;box-sizing:border-box;height:28px;border:1px solid #dadce0;border-radius:14px;padding:0 12px;background:#fff;color:#202124}` +
  `</style><input readonly aria-label="Address and search bar" value="${escapeAttr(address)}">`;

const first = parse(process.argv);
if (!app.requestSingleInstanceLock({ argv: process.argv })) {
  app.exit(0);
} else {
  let win = null;
  let bar = null;
  let page = null;
  let shown = '';
  const layout = () => {
    const { width, height } = win.getContentBounds();
    bar.setBounds({ x: 0, y: 0, width, height: BAR_H });
    page.setBounds({ x: 0, y: BAR_H, width, height: Math.max(0, height - BAR_H) });
  };
  const showAddress = (address) => {
    if (address === shown) return;
    shown = address;
    void bar.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(barHtml(address))}`);
  };
  const show = (o) => {
    if (o.page === 'close') return app.quit();
    if (!win) {
      win = new BaseWindow({ width: o.w, height: o.h, ...(o.x !== undefined && { x: o.x, y: o.y }), autoHideMenuBar: true });
      bar = new WebContentsView();
      page = new WebContentsView();
      win.contentView.addChildView(bar);
      win.contentView.addChildView(page);
      page.webContents.on('page-title-updated', (_e, title) => win.setTitle(title + SUFFIX));
      win.on('resize', layout);
      win.on('closed', () => app.quit());
    } else {
      // BaseWindow wants a whole rectangle (a partial one throws), so keep the position unless one is given.
      const b = win.getBounds();
      win.setBounds({ x: o.x ?? b.x, y: o.y ?? b.y, width: o.w, height: o.h });
    }
    layout();
    page.webContents.once('did-finish-load', () => showAddress(o.url ?? page.webContents.getURL()));
    void page.webContents.loadFile(resolve(o.page));
  };
  app.on('second-instance', (_e, _argv, _cwd, data) => show(parse(data?.argv ?? [])));
  app.whenReady().then(() => (first.page ? show(first) : app.quit()));
  app.on('window-all-closed', () => app.quit());
}
