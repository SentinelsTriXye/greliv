import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { urlVersParametres, parametresRecherche, normaliserArticle } from '../src/vinted.js';
import { filtrer, classer } from '../src/classement.js';
import { Stockage } from '../src/stockage.js';
import { Bot } from '../src/bot.js';
import { pageHtml } from '../src/tableau.js';

const silencieux = { info() {}, warn() {}, error() {} };

const brut = (id, titre, prix, extra = {}) => ({
  id,
  title: titre,
  price: { amount: String(prix), currency_code: 'EUR' },
  brand_title: 'Nike',
  size_title: '42',
  status: 'Très bon état',
  url: `https://www.vinted.fr/items/${id}`,
  photo: { url: `https://img/${id}.jpg`, high_resolution: { timestamp: Math.floor(Date.now() / 1000) } },
  user: { login: 'vendeur' },
  ...extra,
});

test("conversion d'une URL Vinted en paramètres API", () => {
  const p = urlVersParametres(
    'https://www.vinted.fr/catalog?search_text=nike&catalog[]=1&catalog[]=2&brand_ids[]=53&time=123&order=newest_first',
  );
  assert.deepEqual(p, { search_text: 'nike', catalog_ids: '1,2', brand_ids: '53', order: 'newest_first' });
  const q = parametresRecherche({ recherche: 'levis', prix_max: 20 });
  assert.equal(q.search_text, 'levis');
  assert.equal(q.price_to, '20');
  assert.equal(q.order, 'newest_first');
});

test('normalisation des deux formats de prix', () => {
  assert.equal(normaliserArticle(brut(1, 'a', 12.5), 'vinted.fr').prix, 12.5);
  assert.equal(normaliserArticle({ id: 2, title: 'b', price: '8.0' }, 'vinted.fr').prix, 8);
});

test('filtres : prix, mots exclus/inclus, tailles, accents', () => {
  const r = { prix_max: 50, mots_exclus: ['enfant'], mots_inclus: ['dunk'], tailles: ['42'] };
  const a = (titre, prix, taille = '42') => ({ titre, prix, taille, marque: '' });
  assert.equal(filtrer(a('Nike Dunk', 40), r).ok, true);
  assert.equal(filtrer(a('Nike Dunk', 60), r).ok, false);
  assert.equal(filtrer(a('Nike Dunk ENFANT', 40), r).ok, false);
  assert.equal(filtrer(a('Nike Air', 40), r).ok, false);
  assert.equal(filtrer(a('Nike Dunk', 40, '42.5'), r).ok, false);
  assert.equal(filtrer(a('Nike Dunk', 40, 'EU 42'), r).ok, true);
  assert.equal(filtrer(a('Pull déchiré', 5), { mots_exclus: ['dechire'] }).ok, false);
});

test("classement : niveau d'affaire et catégorie", () => {
  const r = { nom: 'X', categorie: 'Revente', prix_cible: 20 };
  assert.equal(classer({ prix: 12 }, r).affaire, 'excellente');
  assert.equal(classer({ prix: 19 }, r).affaire, 'bonne');
  assert.equal(classer({ prix: 25 }, r).affaire, 'normal');
  assert.equal(classer({ prix: 25 }, { nom: 'Y' }).categorie, 'Sans catégorie');
});

test('cycle complet : premier passage silencieux, puis alertes sur les nouveautés filtrées', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'vinted-'));
  const fichierConfig = path.join(dossier, 'config.json');
  fs.writeFileSync(
    fichierConfig,
    JSON.stringify({
      domaine: 'vinted.fr',
      pause_entre_recherches_secondes: 0,
      notifications: { discord_webhook: 'https://discord.test/hook' },
      categories: { Sneakers: { couleur: '#ff0000' } },
      recherches: [{ nom: 'Dunk', categorie: 'Sneakers', recherche: 'dunk', prix_max: 50, prix_cible: 40 }],
    }),
  );

  let catalogue = [brut(1, 'Dunk ancienne', 30)];
  const discord = [];
  let appelsAccueil = 0;
  const fetchImpl = async (url, opts = {}) => {
    if (url === 'https://www.vinted.fr/') {
      appelsAccueil++;
      return new Response('', { headers: { 'set-cookie': 'access_token_web=abc; Path=/' } });
    }
    if (url.startsWith('https://www.vinted.fr/api/v2/catalog/items')) {
      assert.match(opts.headers.Cookie, /access_token_web=abc/);
      assert.match(url, /search_text=dunk/);
      return Response.json({ items: catalogue });
    }
    if (url === 'https://discord.test/hook') {
      discord.push(JSON.parse(opts.body));
      return new Response(null, { status: 204 });
    }
    throw new Error('URL inattendue ' + url);
  };

  const stockage = new Stockage(path.join(dossier, 'etat.json'));
  const bot = new Bot({ fichierConfig, stockage, fetchImpl, journal: silencieux });

  await bot.cycle();
  assert.equal(discord.length, 0, 'pas de spam au premier passage');

  catalogue = [brut(2, 'Dunk neuve', 25), brut(3, 'Dunk trop chère', 90), ...catalogue];
  await bot.cycle();
  assert.equal(discord.length, 1);
  assert.equal(discord[0].embeds[0].title, 'Dunk neuve');
  assert.equal(discord[0].embeds[0].color, 0xff0000);
  assert.match(discord[0].content, /Excellente/);

  await bot.cycle();
  assert.equal(discord.length, 1, 'pas de doublon');
  assert.equal(appelsAccueil, 1, 'session réutilisée');

  const etat = JSON.parse(fs.readFileSync(path.join(dossier, 'etat.json'), 'utf8'));
  assert.equal(etat.articles[0].id, '2');
  assert.equal(etat.stats.Dunk.total, 1);

  const html = pageHtml(etat, bot.config, new URL('http://x/?tri=affaire'));
  assert.match(html, /Dunk neuve/);
  assert.match(html, /Sneakers/);
});

test('session renouvelée après un 401', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'vinted-'));
  const fichierConfig = path.join(dossier, 'config.json');
  fs.writeFileSync(fichierConfig, JSON.stringify({ recherches: [{ nom: 'A', recherche: 'a' }] }));
  let accueil = 0;
  let api = 0;
  const fetchImpl = async (url) => {
    if (url === 'https://www.vinted.fr/') {
      accueil++;
      return new Response('', { headers: { 'set-cookie': `t=${accueil}` } });
    }
    api++;
    return api === 1 ? new Response('', { status: 401 }) : Response.json({ items: [] });
  };
  const bot = new Bot({ fichierConfig, stockage: new Stockage(path.join(dossier, 'e.json')), fetchImpl, journal: silencieux });
  await bot.cycle();
  assert.equal(accueil, 2);
  assert.equal(bot.stockage.etat.stats.A.derniere_erreur, null);
});
