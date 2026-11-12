// node render.mjs h|v  → rend toutes les images (30 i/s) en parallèle dans frames_<fmt>/
import { chromium } from 'playwright';
import fs from 'node:fs';
const fmt = process.argv[2], FPS = 30, WORKERS = 4;
const total = JSON.parse(fs.readFileSync('timeline.json')).total, N = Math.ceil(total * FPS);
const dir = `frames_${fmt}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
const b = await chromium.launch();
await Promise.all(Array.from({ length: WORKERS }, async (_, w) => {
  const pg = await b.newPage({ viewport: fmt === 'v' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 } });
  await pg.goto(`file://${process.cwd()}/promo.html?fmt=${fmt}`); await pg.evaluate(() => window.ready);
  for (let i = w; i < N; i += WORKERS) { await pg.evaluate((x) => window.render(x), i / FPS); await pg.screenshot({ path: `${dir}/${String(i).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 94 }); }
}));
await b.close(); console.log(fmt, N, 'images');
