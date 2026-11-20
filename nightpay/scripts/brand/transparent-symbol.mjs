// Saca el símbolo de OxioPay sin el fondo crema (PNG con transparencia) a
// partir de apps/admin/public/icons/icon-512.png, para lo impreso (hojas del
// local): cada píxel se descompone en «crema + tinta» o «crema + lima» con su
// opacidad, así los bordes suavizados quedan limpios sobre cualquier blanco.
// Es un apaño sobre el PNG: cuando haya el vector (SVG) del símbolo, rehacerlo
// desde ahí y borrar este script.
// Uso (desde nightpay/): SHARP=... node scripts/brand/transparent-symbol.mjs
// sharp no es dependencia del proyecto: SHARP=<ruta a sharp/lib/index.js> o instalarlo suelto.
const sharp = (await import(process.env.SHARP ?? 'sharp')).default;

const SRC = 'apps/admin/public/icons/icon-512.png';
const OUT = 'apps/admin/public/brand/oxio-simbolo-512.png';
const CREAM = [239, 233, 223];
const COLORS = [[31, 44, 54], [199, 211, 1]]; // tinta, lima

const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const out = Buffer.alloc(data.length);
for (let i = 0; i < data.length; i += 4) {
  const p = [data[i], data[i + 1], data[i + 2]];
  let best = null;
  for (const c of COLORS) {
    const d = c.map((v, k) => v - CREAM[k]);
    const a = Math.min(1, Math.max(0, p.reduce((s, v, k) => s + (v - CREAM[k]) * d[k], 0) / d.reduce((s, v) => s + v * v, 0)));
    const err = p.reduce((s, v, k) => s + (CREAM[k] + a * d[k] - v) ** 2, 0);
    if (!best || err < best.err) best = { c, a, err };
  }
  const alpha = best.a < 0.02 ? 0 : best.a;
  out.set([...best.c, Math.round(alpha * 255)], i);
}
await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 9 }).toFile(OUT);
console.log('listo:', OUT);
