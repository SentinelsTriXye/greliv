#!/usr/bin/env node
// Point d'entrée : node src/index.js [--once]
// Variables : CONFIG (chemin de config.json), DATA (chemin du fichier d'état), PORT (tableau de bord)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot, lireConfig } from './bot.js';
import { Stockage } from './stockage.js';
import { demarrerTableau } from './tableau.js';

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fichierConfig = path.resolve(process.env.CONFIG ?? path.join(racine, 'config.json'));
const fichierEtat = path.resolve(process.env.DATA ?? path.join(racine, 'data', 'etat.json'));

const heure = () => new Date().toLocaleString('fr-FR');
const journal = {
  info: (m) => console.log(`${heure()}  ${m}`),
  warn: (m) => console.warn(`${heure()}  ⚠ ${m}`),
  error: (m) => console.error(`${heure()}  ✖ ${m}`),
};

let config;
try {
  config = lireConfig(fichierConfig);
} catch (e) {
  journal.error(
    e.code === 'ENOENT'
      ? `Fichier introuvable : ${fichierConfig}\nCopiez config.example.json en config.json puis adaptez vos recherches.`
      : `Configuration invalide : ${e.message}`,
  );
  process.exit(1);
}

const stockage = new Stockage(fichierEtat, { maxArticles: config.max_articles_memorises ?? 3000 });
const bot = new Bot({ fichierConfig, stockage, journal });

if (process.argv.includes('--once')) {
  await bot.cycle();
  process.exit(0);
}

const arret = new AbortController();
let serveur;
const tableau = config.tableau_de_bord ?? {};
if (tableau.actif !== false) {
  serveur = demarrerTableau({
    stockage,
    lireConfig: () => bot.config,
    port: Number(process.env.PORT ?? tableau.port ?? 8080),
    motDePasse: process.env.DASHBOARD_PASSWORD ?? tableau.mot_de_passe,
    journal,
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    journal.info('Arrêt demandé…');
    arret.abort();
    serveur?.close();
  });
}
process.on('unhandledRejection', (e) => journal.error(`Erreur non gérée : ${e?.stack ?? e}`));

await bot.tourner(arret.signal);
