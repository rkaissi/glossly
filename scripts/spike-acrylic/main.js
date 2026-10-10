// Acrylic spike (Step 13): a transparent overlay-like window over red and blue stripes, checked by
// reading screen pixels. Run: node_modules/electron/dist/electron.exe scripts/spike-acrylic
// (log in %TEMP%/glossly-spike-acrylic.log). opaque.js and sizes.js are the earlier rounds;
// run one with: electron.exe scripts/spike-acrylic/opaque.js
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const fs = require('fs'); const path = require('path'); const { execFileSync, execFile } = require('child_process');
const LOG = path.join(require('os').tmpdir(), 'glossly-spike-acrylic.log');
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); fs.appendFileSync(LOG, s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripes = 'data:text/html,' + encodeURIComponent(`<body style="margin:0;height:100vh;background:repeating-linear-gradient(90deg,#f00 0 12px,#00f 12px 24px)"></body>`);
const dotPage = 'data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent"><div style="position:absolute;left:6px;top:11px;width:18px;height:18px;border-radius:50%;background:rgba(255,255,255,.9)"></div></body>`);
let shot;
async function capture() { const d = screen.getPrimaryDisplay(); const sf = d.scaleFactor;
  const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) } });
  shot = { bmp: src[0].thumbnail.toBitmap(), W: src[0].thumbnail.getSize().width, sf }; }
const P = (x, y) => { const X = Math.round(x * shot.sf), Y = Math.round(y * shot.sf); const i = (Y * shot.W + X) * 4; return [shot.bmp[i + 2], shot.bmp[i + 1], shot.bmp[i]]; };
function stats(b) { const y = b.y + b.height / 2; const v = []; for (let x = b.x + 6; x < b.x + b.width - 6; x += 2) v.push(P(x, y));
  return { avgG: Math.round(v.reduce((s, c) => s + c[1], 0) / v.length), redSpread: Math.max(...v.map((c) => c[0])) - Math.min(...v.map((c) => c[0])) }; }
async function m(label, w) { await sleep(600); await capture(); const b = w.getContentBounds();
  log(label, { glass: stats(b), tl: P(b.x + 0.4, b.y + 0.4), tl2: P(b.x + 1.6, b.y + 1.6), below: P(b.x + b.width / 2, b.y + b.height + 2), dotCenter: P(b.x + 15, b.y + 20), dotEdge: P(b.x + 2, b.y + 2) }); }
const hwnd = (w) => { const buf = w.getNativeWindowHandle(); return Number(buf.readBigUInt64LE(0)); };
const nc = (w, v) => new Promise((res) => execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'ncact.ps1'), String(hwnd(w)), String(v)], (e, out) => res(e ? 'err ' + e.message : out.trim())));
const dwm = (w, attr, val) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'dwm.ps1'), String(hwnd(w)), String(attr), String(val)]).toString().trim();
app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
  const bg = new BrowserWindow({ show: false, frame: false, focusable: false, skipTaskbar: true, x: 200, y: 200, width: 700, height: 420, alwaysOnTop: true });
  bg.setAlwaysOnTop(true, 'floating'); await bg.loadURL(stripes); bg.showInactive();
  const w = new BrowserWindow({ show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, hasShadow: false,
    width: 240, height: 48, x: 260, y: 260, backgroundMaterial: 'acrylic', backgroundColor: '#00000000' });
  w.setAlwaysOnTop(true, 'pop-up-menu'); await w.loadURL(dotPage);
  w.showInactive(); await m('T acrylic', w);
  log('dwm round', dwm(w, 33, 2)); await m('T acrylic + DWMWCP_ROUND', w);
  w.setHasShadow(true); await m('T + hasShadow', w);
  w.setHasShadow(false);
  w.setBackgroundMaterial('none'); w.setBounds({ x: 260, y: 260, width: 40, height: 40 }); await m('T none 40x40 (dot)', w);
  w.setIgnoreMouseEvents(true, { forward: true }); await m('T none click-through', w);
  w.setIgnoreMouseEvents(false);
  w.setBackgroundMaterial('acrylic'); w.setBounds({ x: 260, y: 260, width: 240, height: 48 }); await m('T back to acrylic', w);
  w.hide(); w.setBounds({ x: 260, y: 260, width: 300, height: 48 }); w.showInactive(); await m('T hide, resize, show', w);
  // Real activation, then losing it to the background window.
  w.setFocusable(true); w.setSkipTaskbar(true); w.focus(); await m('T focused', w);
  log('focused?', w.isFocused());
  bg.setFocusable(true); bg.focus(); await m('T lost focus (still visible)', w);
  log('focused after?', w.isFocused());
  w.hide(); w.setFocusable(false); w.setSkipTaskbar(true); w.showInactive(); await m('T hidden, unfocusable, shown again', w);
  log(await nc(w, 1)); await m('T + WM_NCACTIVATE(1)', w);
  log(await nc(w, 0)); await m('T + WM_NCACTIVATE(0)', w);
  log(await nc(w, 1)); await m('T + WM_NCACTIVATE(1) again', w);
  w.setBackgroundMaterial('none'); w.setBackgroundColor('#00000000'); w.setBounds({ x: 260, y: 260, width: 40, height: 40 }); await m('T none + clear bg (dot)', w);
  log('dwm none corners', dwm(w, 33, 1)); await m('T dot, DWMWCP_DONOTROUND', w);
  w.setBackgroundMaterial('acrylic'); log(dwm(w, 33, 2)); w.setBounds({ x: 260, y: 260, width: 240, height: 48 }); await m('T acrylic again after dot', w);
  bg.setFocusable(false);
  w.destroy(); bg.destroy(); app.quit();
});
