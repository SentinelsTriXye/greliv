// node frames.mjs h|v out 12.5 30 ...  → captures de contrôle à des instants donnés
import { chromium } from 'playwright';
const [fmt, out, ...times] = process.argv.slice(2);
const b = await chromium.launch();
const pg = await b.newPage({ viewport: fmt === 'v' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 } });
pg.on('pageerror', (e) => console.log('ERR', e.message));
await pg.goto(`file://${process.cwd()}/promo.html?fmt=${fmt}`); await pg.evaluate(() => window.ready);
for (const t of times) { await pg.evaluate((x) => window.render(x), +t); await pg.screenshot({ path: `${out}/${fmt}_${t}.jpg`, type: 'jpeg', quality: 80 }); }
await b.close();
