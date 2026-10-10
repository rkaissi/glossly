// Acrylic spike: does backgroundMaterial work on a focusable:false, never-active overlay?
const { app, BrowserWindow, desktopCapturer, screen, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');


const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(s); fs.appendFileSync(path.join(require('os').tmpdir(), 'glossly-spike-opaque.log'), s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stripes = 'data:text/html,' + encodeURIComponent(`<body style="margin:0;height:100vh;background:repeating-linear-gradient(90deg,#f00 0 12px,#00f 12px 24px)"></body>`);
const clear = 'data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent;font:13px Segoe UI;color:#888;padding:8px">glass</body>`);
const css = 'data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent"><div style="position:absolute;inset:0;border-radius:12px;background:rgba(255,255,255,.72);backdrop-filter:blur(20px)"></div></body>`);

let shot = null;
async function capture() {
  const d = screen.getPrimaryDisplay();
  const sf = d.scaleFactor;
  const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) } });
  shot = { img: src[0].thumbnail, sf };
}
function px(x, y) {
  // DIP -> physical; returns [r,g,b]
  const { img, sf } = shot;
  const X = Math.round(x * sf), Y = Math.round(y * sf);
  const c = img.crop({ x: X, y: Y, width: 1, height: 1 }).toBitmap();
  return [c[2], c[1], c[0]];
}
function rowStats(b) {
  const y = b.y + Math.round(b.height / 2);
  const vals = [];
  for (let x = b.x + 6; x < b.x + b.width - 6; x += 2) vals.push(px(x, y));
  const avg = [0, 1, 2].map((i) => Math.round(vals.reduce((s, v) => s + v[i], 0) / vals.length));
  const spread = Math.max(...vals.map((v) => v[0])) - Math.min(...vals.map((v) => v[0]));
  return { avg, redSpread: spread };
}
function corners(b) {
  return { tl: px(b.x + 0.5, b.y + 0.5), inside: px(b.x + 8, b.y + 8) };
}

async function overlay(opts, url = clear) {
  const w = new BrowserWindow({
    show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, hasShadow: false,
    width: 240, height: 48, x: 260, y: 260, ...opts,
  });
  w.setAlwaysOnTop(true, 'pop-up-menu');
  w.setMenu(null);
  await w.loadURL(url);
  return w;
}

async function measure(label, w) {
  await sleep(700);
  await capture();
  const b = w.getBounds();
  log(label, { bounds: b, row: rowStats(b), ...corners(b) });
}

app.whenReady().then(async () => {
  fs.writeFileSync(path.join(require('os').tmpdir(), 'glossly-spike-opaque.log'), '');
  log('electron', process.versions.electron, 'os', require('os').release(), 'dark', nativeTheme.shouldUseDarkColors);
  const bg = new BrowserWindow({ show: false, frame: false, focusable: false, skipTaskbar: true, x: 200, y: 200, width: 700, height: 420, alwaysOnTop: true });
  bg.setAlwaysOnTop(true, 'floating');
  await bg.loadURL(stripes);
  bg.showInactive();
  await sleep(500);
  await capture();
  log('bg alone', rowStats({ x: 260, y: 260, width: 240, height: 48 }));

  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    // A: acrylic, opaque window, never activated.
    const a = await overlay({ backgroundMaterial: 'acrylic', backgroundColor: '#00000000' });
    a.showInactive();
    await measure(`${theme} A acrylic inactive`, a);
    a.setBounds({ x: 260, y: 260, width: 420, height: 160 });
    await measure(`${theme} A after setBounds 420x160`, a);
    a.setIgnoreMouseEvents(true, { forward: true });
    await measure(`${theme} A click-through`, a);
    a.setIgnoreMouseEvents(false);
    a.setBounds({ x: 260, y: 260, width: 16, height: 16 });
    await sleep(100);
    log(`${theme} A min size`, a.getBounds());
    a.setBounds({ x: 260, y: 260, width: 240, height: 48 });
    // Briefly active (setFocusable + focus) to compare.
    a.setFocusable(true);
    a.focus();
    await measure(`${theme} A acrylic focused`, a);
    a.blur();
    a.setFocusable(false);
    await measure(`${theme} A after blur`, a);
    a.destroy();

    // B: acrylic with transparent:true (expected to not work).
    const b = await overlay({ backgroundMaterial: 'acrylic', transparent: true, backgroundColor: '#00000000', y: 340 });
    b.showInactive();
    await measure(`${theme} B acrylic+transparent`, b);
    b.destroy();

    // C: CSS glass fallback on a transparent window.
    const c = await overlay({ transparent: true, backgroundColor: '#00000000', y: 420 }, css);
    c.showInactive();
    await measure(`${theme} C css glass`, c);
    c.destroy();

    // D: mica on a normal framed window, inactive.
    const d = new BrowserWindow({ show: false, x: 300, y: 260, width: 360, height: 200, backgroundMaterial: 'mica', focusable: false, skipTaskbar: true, alwaysOnTop: true });
    d.setAlwaysOnTop(true, 'pop-up-menu');
    await d.loadURL(clear);
    d.showInactive();
    await measure(`${theme} D mica inactive`, d);
    d.destroy();
  }
  bg.destroy();
  app.quit();
});
