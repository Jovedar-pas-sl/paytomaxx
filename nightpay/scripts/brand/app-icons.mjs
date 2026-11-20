#!/usr/bin/env node
/* global Image, document, process, Buffer, console */
// Genera los iconos propios de cada app (Panel, Personal, TPV) a partir de los
// originales crema de scripts/brand/app-icons-src (símbolo tinta + punto lima
// sobre crema). Solo recolorea: cada píxel se descompone en mezcla de crema,
// tinta y lima y se vuelve a componer con la paleta de la app.
// shortcut: no hay logo vectorial todavía; cuando exista, rehacer esto desde él
// (y borrar app-icons-src). Se ejecuta con Chromium de Playwright (canvas):
//   node scripts/brand/app-icons.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { chromium } = createRequire(join(root, 'apps/e2e/package.json'))('@playwright/test');

const CREAM = '#EFE9DF';
const INK = '#1F2C36';
const LIME = '#C7D301';
const FILES = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

/** bg: fondo; symbol: el símbolo; dot: el punto. Panel queda igual que el original. */
export const VARIANTS = {
  admin: { bg: CREAM, symbol: INK, dot: LIME },
  operator: { bg: INK, symbol: CREAM, dot: LIME },
  tpv: { bg: LIME, symbol: INK, dot: CREAM },
};

/** Se ejecuta dentro de la página: recolorea un PNG (data URL) y devuelve otro. */
function recolor(dataUrl, palette, src) {
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [C, I, L] = [src.cream, src.ink, src.lime].map(hex);
  const [nb, ns, nd] = [palette.bg, palette.symbol, palette.dot].map(hex);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.width;
      cv.height = img.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, cv.width, cv.height);
      // p - C = wi (I - C) + wl (L - C): mínimos cuadrados con 2 incógnitas.
      const a = I.map((v, k) => v - C[k]);
      const b = L.map((v, k) => v - C[k]);
      const aa = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
      const bb = b[0] * b[0] + b[1] * b[1] + b[2] * b[2];
      const ab = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const det = aa * bb - ab * ab;
      for (let o = 0; o < d.data.length; o += 4) {
        const q = [0, 1, 2].map((k) => d.data[o + k] - C[k]);
        const qa = q[0] * a[0] + q[1] * a[1] + q[2] * a[2];
        const qb = q[0] * b[0] + q[1] * b[1] + q[2] * b[2];
        let wi = Math.max(0, (qa * bb - qb * ab) / det);
        let wl = Math.max(0, (qb * aa - qa * ab) / det);
        const sum = wi + wl;
        if (sum > 1) {
          wi /= sum;
          wl /= sum;
        }
        const wc = 1 - wi - wl;
        for (let k = 0; k < 3; k++) d.data[o + k] = Math.round(wc * nb[k] + wi * ns[k] + wl * nd[k]);
      }
      ctx.putImageData(d, 0, 0);
      resolve(cv.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage();
const src = { cream: CREAM, ink: INK, lime: LIME };
for (const [app, palette] of Object.entries(VARIANTS)) {
  const outDir = join(root, 'apps', app, 'public', 'icons');
  mkdirSync(outDir, { recursive: true });
  for (const f of FILES) {
    const bytes = readFileSync(join(here, 'app-icons-src', f));
    if (app === 'admin') {
      writeFileSync(join(outDir, f), bytes); // el Panel conserva el original tal cual
      continue;
    }
    const url = `data:image/png;base64,${bytes.toString('base64')}`;
    const out = await page.evaluate(`(${recolor})(${JSON.stringify(url)}, ${JSON.stringify(palette)}, ${JSON.stringify(src)})`);
    writeFileSync(join(outDir, f), Buffer.from(out.split(',')[1], 'base64'));
  }
  console.log('icons ->', app);
}
await browser.close();
