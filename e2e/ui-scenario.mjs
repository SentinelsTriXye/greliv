/**
 * Scénario complet piloté dans de vrais navigateurs (Playwright) : 4 sessions simultanées
 * (client, commerçant, livreur, administrateur) jouent une commande de bout en bout en cliquant
 * sur les boutons de l'interface. Usage :  BASE_URL=http://localhost:4000 node e2e/ui-scenario.mjs [dossier-captures]
 * Prérequis : serveur démarré avec des données fraîches (npm run db:reset), Playwright installé.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const OUT = process.argv[2] || '.';
const browser = await chromium.launch();
const errors = [];
async function open(name, viewport) {
  const ctx = await browser.newContext({ viewport, locale: 'fr-FR', timezoneId: 'Europe/Paris', deviceScaleFactor: Number(process.env.SCALE || 1) });
  // Certains réseaux n'autorisent que tile.openstreetmap.org (sans sous-domaine a/b/c)
  if (process.env.TILE_PROXY) await ctx.route(/https:\/\/[abc]\.tile\.openstreetmap\.org\//, async (route) => {
    try { route.fulfill({ response: await ctx.request.get(route.request().url().replace(/\/\/[abc]\./, '//'), { headers: { 'User-Agent': 'greliv-e2e/1.0' } }) }); } catch { route.abort(); }
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('console', (m) => { if (m.type() === 'error' && !/tile\.openstreetmap|ERR_|Failed to load resource/.test(m.text())) errors.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  return page;
}
// CLEAN=1 : attend la fin des animations et la disparition des messages avant chaque capture (visuels de communication)
const shot = async (page, name) => { if (process.env.CLEAN) await page.waitForTimeout(5200); return page.screenshot({ path: `${OUT}/${name}.png` }); };
const step = (s) => console.log('→', s);
const phone = { width: 390, height: 844 }, desk = process.env.TABLET ? { width: 1180, height: 820 } : { width: 1320, height: 860 };

const client = await open('client', phone), merchant = await open('commerçant', desk), courier = await open('livreur', phone), admin = await open('admin', desk);

step('Client : connexion, choix du restaurant, personnalisation, panier');
await client.goto(`${BASE}/client`);
await shot(client, '01-connexion');
await client.getByRole('button', { name: 'Camille (cliente)' }).click();
await client.getByText('Pizzeria Belledonne').waitFor();
await shot(client, '02-client-accueil');
await client.getByText('Pizzeria Belledonne').click();
await client.getByText('Margherita').first().click();
await client.getByRole('button', { name: /Grande/ }).click();
await client.getByRole('button', { name: /Burrata/ }).click();
await shot(client, '03-client-produit');
await client.getByRole('button', { name: /^Ajouter ·/ }).click();
await client.getByText('Tiramisu maison').click();
await client.getByRole('button', { name: /^Ajouter ·/ }).click();
await client.getByRole('button', { name: /Voir le panier/ }).click();
await client.getByText('Frais de livraison').waitFor();
await client.getByPlaceholder(/laisser devant/).fill('Sonner deux fois, merci !');
await shot(client, '04-client-panier');
await client.getByRole('button', { name: /Commander et payer ·/ }).click();
await client.getByText('Numéro de carte').waitFor();
await shot(client, '05-client-paiement');
await client.getByRole('button', { name: /^Payer / }).click();
await client.getByText('Code de livraison').waitFor({ state: 'hidden' }).catch(() => {});
await client.getByText('Suivi', { exact: true }).waitFor();

step('Commerçant : réception et acceptation');
await merchant.goto(`${BASE}/commercant`);
await merchant.getByRole('button', { name: 'Pizzeria Belledonne' }).click();
await merchant.getByRole('button', { name: 'Accepter' }).waitFor();
await shot(merchant, '06-commercant-nouvelle-commande');

step('Livreur : connexion et disponibilité');
await courier.goto(`${BASE}/livreur`);
await courier.getByRole('button', { name: 'Léa · vélo' }).click();
await courier.getByRole('button', { name: 'Me rendre disponible' }).click();
await courier.getByRole('heading', { name: /En attente de courses/ }).waitFor();

await merchant.getByRole('button', { name: '20 min' }).click();
await merchant.getByRole('button', { name: 'Accepter' }).click();

step('Livreur : proposition de course');
await courier.getByRole('heading', { name: /Nouvelle course/ }).waitFor();
await shot(courier, '07-livreur-proposition');
await courier.getByRole('button', { name: 'Accepter la course' }).click();
await courier.getByText(/Récupérer chez Pizzeria Belledonne/).waitFor();
await courier.waitForTimeout(2500);
await shot(courier, '08-livreur-vers-restaurant');

step('Commerçant : voit le livreur, signale la commande prête');
await merchant.locator('.kanban').getByText(/vient récupérer la commande/).waitFor();
await shot(merchant, '09-commercant-preparation');
await merchant.getByRole('button', { name: 'Commande prête' }).click();

step('Client : suivi en direct');
await client.locator('.page').getByText(/Votre livreur ·/).waitFor();
await client.waitForTimeout(1500);
await shot(client, '10-client-suivi');
const code = (await client.locator('.code').innerText()).trim();

step('Livreur : retrait puis livraison avec le code du client');
await courier.getByRole('button', { name: "J'ai récupéré la commande" }).click();
await courier.getByText(/Livrer Camille/).waitFor();
await courier.waitForTimeout(3000);
await shot(courier, '11-livreur-vers-client');
await courier.getByPlaceholder('••••').fill('0000' === code ? '1111' : '0000');
await courier.getByRole('button', { name: 'Valider la livraison' }).click();
await courier.getByText('Code de livraison incorrect').waitFor();
await courier.getByPlaceholder('••••').fill(code);
await courier.getByRole('button', { name: 'Valider la livraison' }).click();
await courier.getByRole('heading', { name: /En attente de courses/ }).waitFor();
await courier.getByRole('link', { name: /Gains/ }).click();
await courier.getByText('Mes gains').waitFor();
await courier.waitForTimeout(500);
await shot(courier, '12-livreur-gains');

step('Client : commande livrée, notation');
await client.getByText('Commande livrée 🎉').first().waitFor();
await client.getByRole('button', { name: '5 étoiles' }).first().click();
await client.getByRole('button', { name: '5 étoiles' }).nth(1).click();
await client.getByRole('button', { name: 'Envoyer ma note' }).click();
await client.getByText('Merci pour votre avis').first().waitFor();
await shot(client, '13-client-livree');

step('Commerçant : catalogue, activité');
await merchant.getByRole('link', { name: /Catalogue/ }).click();
await merchant.getByRole('button', { name: '+ Ajouter un produit' }).click();
await merchant.getByLabel('Nom').fill('Pizza du test');
await merchant.getByLabel('Prix (€)').fill('11,50');
await merchant.getByRole('button', { name: 'Enregistrer' }).click();
await merchant.getByText('Pizza du test').waitFor();
await shot(merchant, '14-commercant-catalogue');
await merchant.getByRole('link', { name: /Activité/ }).click();
await merchant.getByText('Produits les plus vendus').waitFor();
await shot(merchant, '15-commercant-activite');

step('Administrateur : tableau de bord, carte, validation, paramètres');
await admin.goto(`${BASE}/admin`);
await admin.getByRole('button', { name: 'Administrateur' }).click();
await admin.getByText('Fonctionnement · 30 jours').waitFor();
await shot(admin, '16-admin-tableau-de-bord');
await admin.getByRole('link', { name: /Établissements/ }).click();
await admin.getByRole('button', { name: 'Valider' }).click();
await admin.getByText('Crêperie du Néron validé.').waitFor();
await admin.getByRole('link', { name: /Livreurs/ }).click();
await admin.getByRole('button', { name: 'Vérifier le compte' }).click();
await admin.getByText('Noah Petit vérifié.').waitFor();
await admin.getByRole('link', { name: /Commandes/ }).click();
await admin.getByRole('button', { name: 'Toutes' }).click();
await admin.getByRole('button', { name: 'Détail' }).first().click();
await admin.getByText('Total client').waitFor();
await shot(admin, '17-admin-commande');
await admin.keyboard.press('Escape');
await admin.getByRole('link', { name: /Carte en direct/ }).click();
await admin.getByText('Carte en direct · Grenoble').waitFor();
await admin.waitForTimeout(1200);
await shot(admin, '18-admin-carte');
await admin.getByRole('link', { name: /Paramètres/ }).click();
await admin.getByRole('button', { name: 'Enregistrer' }).click();
await admin.getByText(/Paramètres enregistrés/).waitFor();
await shot(admin, '19-admin-parametres');

await browser.close();
if (errors.length) { console.error('\nErreurs console :\n' + errors.join('\n')); process.exit(1); }
console.log('\n✅ Scénario interface validé de bout en bout, sans erreur console.');
