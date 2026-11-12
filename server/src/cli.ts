import { migrate, pool } from './db.js';
import { seed } from './seed.js';

const cmd = process.argv[2];
if (cmd === 'reset') {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  console.log('[db] schéma réinitialisé');
}
await migrate();
if (cmd === 'seed' || cmd === 'reset') await seed();
await pool.end();
