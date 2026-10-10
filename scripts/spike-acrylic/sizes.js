const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const fs = require('fs'); const path = require('path');
const LOG = path.join(require('os').tmpdir(), 'glossly-spike-sizes.log');
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); fs.appendFileSync(LOG, s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripes = 'data:text/html,' + encodeURIComponent(`<body style="margin:0;height:100vh;background:repeating-linear-gradient(90deg,#f00 0 12px,#00f 12px 24px)"></body>`);
const clear = 'data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent"></body>`);
let shot;
async function capture() { const d = screen.getPrimaryDisplay(); const sf = d.scaleFactor;
  const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) } });
  shot = { bmp: src[0].thumbnail.toBitmap(), W: src[0].thumbnail.getSize().width, sf }; }
const P = (X, Y) => { const i = (Y * shot.W + X) * 4; return [shot.bmp[i + 2], shot.bmp[i + 1], shot.bmp[i]]; };
const glass = (c) => c[1] > 60; // stripes have G=0; acrylic tint raises G
// Visible glass extent in physical px, scanning the middle row and middle column.
function extent(b) { const sf = shot.sf; const cy = Math.round((b.y + b.height / 2) * sf), cx = Math.round((b.x + 40) * sf);
  let x0 = null, x1 = null, y0 = null, y1 = null;
  for (let X = Math.round((b.x - 20) * sf); X < Math.round((b.x + b.width + 20) * sf); X++) if (glass(P(X, cy))) { if (x0 === null) x0 = X; x1 = X; }
  for (let Y = Math.round((b.y - 20) * sf); Y < Math.round((b.y + b.height + 20) * sf); Y++) if (glass(P(cx, Y))) { if (y0 === null) y0 = Y; y1 = Y; }
  return { phys: { x0, x1, y0, y1 }, dip: { x: +(x0 / sf).toFixed(1), y: +(y0 / sf).toFixed(1), w: +((x1 - x0 + 1) / sf).toFixed(1), h: +((y1 - y0 + 1) / sf).toFixed(1) } }; }
async function m(label, w) { await sleep(600); await capture(); log(label, { bounds: w.getBounds(), content: w.getContentBounds(), visible: extent(w.getBounds()) }); }
app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
  const bg = new BrowserWindow({ show: false, frame: false, focusable: false, skipTaskbar: true, x: 200, y: 200, width: 700, height: 420, alwaysOnTop: true });
  bg.setAlwaysOnTop(true, 'floating'); await bg.loadURL(stripes); bg.showInactive();
  for (const variant of ['opaque', 'transparent']) {
    const w = new BrowserWindow({ show: false, frame: false, resizable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, hasShadow: false,
      width: 240, height: 48, x: 260, y: 260, backgroundMaterial: 'acrylic', backgroundColor: '#00000000', ...(variant === 'transparent' && { transparent: true }) });
    w.setAlwaysOnTop(true, 'pop-up-menu'); await w.loadURL(clear);
    log('--', variant, 'before show', w.getBounds());
    w.showInactive(); await m(`${variant} shown`, w);
    w.setBounds({ x: 260, y: 260, width: 240, height: 48 }); await m(`${variant} setBounds again 240x48`, w);
    w.setContentBounds({ x: 260, y: 260, width: 300, height: 48 }); await m(`${variant} setContentBounds 300x48`, w);
    w.setBounds({ x: 260, y: 260, width: 40, height: 40 }); await m(`${variant} 40x40`, w);
    w.setBounds({ x: 260, y: 260, width: 240, height: 48 });
    w.hide(); await sleep(100); w.showInactive(); await m(`${variant} hide+show`, w);
    w.setFocusable(true); w.setSkipTaskbar(true); w.setBackgroundMaterial('acrylic'); await m(`${variant} setFocusable(true)+reapply`, w);
    w.hide(); w.setFocusable(false); w.setSkipTaskbar(true); w.setBackgroundMaterial('acrylic'); w.showInactive(); await m(`${variant} setFocusable(false)+reapply`, w);
    w.setFocusable(true); w.setFocusable(false); await m(`${variant} toggled, no reapply`, w);
    w.destroy();
  }
  bg.destroy(); app.quit();
});
