/**
 * Test de bout en bout du parcours de commande, exécuté contre un serveur démarré
 * avec les données de démonstration :  npm run db:reset && npm run dev  puis  npm run test:e2e
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL || 'http://localhost:4000/api';
let passed = 0;
function ok(cond: any, label: string) {
  if (!cond) { console.error(`  ✗ ${label}`); process.exit(1); }
  passed++; console.log(`  ✓ ${label}`);
}
async function call(method: string, path: string, token?: string, body?: any) {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) as any };
}
const login = async (email: string) => (await call('POST', '/auth/login', undefined, { email, password: 'demo1234' })).data.token as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const card = { number: '4242 4242 4242 4242', exp: '12/34', cvc: '123' };

console.log('\n— Connexions');
const client = await login('client@greliv.test');
const admin = await login('admin@greliv.test');
const velo = await login('livreur.velo@greliv.test');
const scooter = await login('livreur.scooter@greliv.test');
ok(client && admin && velo && scooter, 'comptes de démonstration connectés');
ok((await call('POST', '/auth/login', undefined, { email: 'client@greliv.test', password: 'faux' })).status === 401, 'mot de passe erroné refusé');
ok((await call('GET', '/admin/overview', client)).status === 403, 'un client ne peut pas accéder à l\'administration');

const events: any[] = [];
const ws = new WebSocket(API.replace('http', 'ws').replace('/api', '/ws') + `?token=${client}`);
ws.on('message', (d) => events.push(JSON.parse(String(d))));
await new Promise((r) => ws.on('open', r));

console.log('\n— Catalogue et devis');
const dest = { lat: 45.1862, lng: 5.7226 };
const merchants = (await call('GET', `/merchants?lat=${dest.lat}&lng=${dest.lng}`)).data;
const pizzeria = merchants.find((m: any) => m.name === 'Pizzeria Belledonne');
ok(merchants.length >= 8 && pizzeria?.open, 'établissements proches listés et ouverts');
const shop = (await call('GET', `/merchants/${pizzeria.id}`)).data;
const marg = shop.products.find((p: any) => p.name === 'Margherita');
const tira = shop.products.find((p: any) => p.name === 'Tiramisu maison');
const items = [
  { productId: marg.id, quantity: 2, options: { taille: ['grande'], supplements: ['burrata'] }, note: 'Bien cuite' },
  { productId: tira.id, quantity: 1 },
];
ok((await call('POST', '/orders/quote', client, { merchantId: shop.id, items: [{ productId: marg.id, quantity: 1 }], ...dest })).status === 400, 'option obligatoire manquante refusée');
const quote = (await call('POST', '/orders/quote', client, { merchantId: shop.id, items, ...dest })).data;
ok(quote.subtotal_cents === 2 * (1050 + 300 + 250) + 590, `sous-total calculé côté serveur (${quote.subtotal_cents / 100} €)`);
ok(quote.delivery_fee_cents >= 199 && quote.total_cents === quote.subtotal_cents + quote.delivery_fee_cents, `frais de livraison affichés avant paiement (${quote.delivery_fee_cents / 100} €)`);

console.log('\n— Commande et paiement');
const body = { merchantId: shop.id, items, address: '14 Boulevard Gambetta, 38000 Grenoble', addressDetails: '2e étage', ...dest, instructions: 'Sonner deux fois', paymentMethod: 'card', idempotencyKey: randomUUID() };
const created = await call('POST', '/orders', client, body);
ok(created.status === 201 && created.data.order.status === 'awaiting_payment', 'commande créée en attente de paiement');
const dup = await call('POST', '/orders', client, body);
ok(dup.status === 200 && dup.data.duplicate && dup.data.order.id === created.data.order.id, 'double envoi : aucune commande en double');
const id = created.data.order.id;
ok((await call('POST', `/orders/${id}/pay`, client, { method: 'card', card: { ...card, number: '4000 0000 0000 0002' } })).status === 400, 'carte de test « refus » rejetée');
const paid = await call('POST', `/orders/${id}/pay`, client, { method: 'card', card });
ok(paid.data.status === 'placed' && paid.data.payment_status === 'paid', 'paiement accepté → commande passée');
const code = paid.data.delivery_code;
const stock = (await call('GET', `/merchants/${shop.id}`)).data.products.find((p: any) => p.id === tira.id);
ok(stock.available, 'stock décrémenté sans rupture');

console.log('\n— Établissement');
const resto = await login('resto1@greliv.test');
const inbox = (await call('GET', '/orders?scope=active', resto)).data;
ok(inbox.some((o: any) => o.id === id && o.items.length === 2 && o.instructions === 'Sonner deux fois'), 'commande reçue avec produits et instructions');
ok((await call('POST', `/merchant/orders/${id}/accept`, await login('resto2@greliv.test'), { prepMinutes: 10 })).status === 404, 'un autre établissement ne peut pas agir dessus');

console.log('\n— Livreurs et attribution');
for (const t of [velo, scooter]) { await call('PATCH', '/me', t, { geo_consent: true }); await call('PATCH', '/courier/me', t, { available: true }); }
await call('POST', '/courier/location', velo, { lat: pizzeria.lat + 0.002, lng: pizzeria.lng });      // ≈ 220 m
await call('POST', '/courier/location', scooter, { lat: pizzeria.lat + 0.012, lng: pizzeria.lng });  // ≈ 1,3 km
ok((await call('POST', `/merchant/orders/${id}/accept`, resto, { prepMinutes: 10 })).status === 200, 'commande acceptée (10 min de préparation)');
ok((await call('POST', `/merchant/orders/${id}/accept`, resto, { prepMinutes: 10 })).status === 400, 'double acceptation refusée (cohérence des statuts)');
const s1 = (await call('GET', '/courier/state', velo)).data;
ok(s1.offer && s1.offer.merchant.name === 'Pizzeria Belledonne' && s1.offer.pay_cents >= 350, `proposition envoyée au livreur le plus proche (${s1.offer?.pay_cents / 100} €)`);
ok(!(await call('GET', '/courier/state', scooter)).data.offer, 'le second livreur n\'est pas sollicité en même temps');
ok(!/^\d/.test(s1.offer.dropoff_approx.label), 'destination approximative seulement dans la proposition');
await call('POST', `/courier/offers/${s1.offer.id}/refuse`, velo);
const s2 = (await call('GET', '/courier/state', scooter)).data;
ok(s2.offer, 'refus → réattribution immédiate au livreur suivant');
const acc = await call('POST', `/courier/offers/${s2.offer.id}/accept`, scooter);
ok(acc.data.status === 'courier_en_route' && acc.data.dropoff.exact === false, 'course acceptée → en route vers l\'établissement, adresse exacte encore masquée');
const route = (await call('POST', '/geo/route', scooter, { from: { lat: pizzeria.lat + 0.012, lng: pizzeria.lng }, to: pizzeria, vehicle: 'scooter' })).data;
ok(route.geometry.length > 1 && route.distance_m > 0 && route.duration_s > 0, `itinéraire calculé (${route.distance_m} m, source : ${route.source})`);

console.log('\n— Retrait et livraison');
ok((await call('POST', `/courier/orders/${id}/pickup`, scooter)).status === 400, 'retrait impossible tant que la commande n\'est pas prête');
ok((await call('POST', `/merchant/orders/${id}/ready`, resto)).status === 200, 'commande signalée prête');
const seen = (await call('GET', `/orders/${id}`, resto)).data;
ok(seen.courier?.name === 'Hugo Moreau' && seen.courier.vehicle === 'scooter', 'l\'établissement voit quel livreur vient');
await call('POST', '/courier/location', scooter, { lat: pizzeria.lat, lng: pizzeria.lng });
const pu = await call('POST', `/courier/orders/${id}/pickup`, scooter);
ok(pu.data.status === 'delivering' && pu.data.dropoff.exact && pu.data.dropoff.address.startsWith('14 '), 'commande récupérée → adresse exacte du client affichée');
await call('POST', '/courier/location', scooter, { lat: (pizzeria.lat + dest.lat) / 2, lng: (pizzeria.lng + dest.lng) / 2 });
const track = (await call('GET', `/orders/${id}`, client)).data;
ok(track.courier.lat && track.eta_minutes > 0, `le client suit le livreur (arrivée estimée : ${track.eta_minutes} min)`);
ok((await call('POST', `/courier/orders/${id}/deliver`, scooter, { code: code === '0000' ? '1111' : '0000' })).status === 400, 'mauvais code de livraison refusé');
const done = await call('POST', `/courier/orders/${id}/deliver`, scooter, { code });
ok(done.data.status === 'delivered' && done.data.courier_km > 0, `livraison validée par code (${done.data.courier_km} km parcourus)`);
const final = (await call('GET', `/orders/${id}`, admin)).data;
ok(final.events.map((e: any) => e.status).filter((s: string) => s !== 'ready').join('>') === 'placed>accepted>preparing>courier_assigned>courier_en_route>picked_up>delivering>delivered', 'les 8 statuts se sont enchaînés dans l\'ordre');
const txs = (await call('GET', '/admin/transactions', admin)).data.filter((t: any) => t.order_number === final.number).map((t: any) => t.type).sort();
ok(txs.join(',') === 'courier_payout,merchant_payout,payment', 'paiement, reversement commerçant et rémunération livreur journalisés');
ok((await call('POST', `/orders/${id}/rate`, client, { merchantRating: 5, courierRating: 5, comment: 'Parfait' })).status === 200, 'notation établissement + livreur');
ok((await call('GET', '/courier/stats', scooter)).data.day.deliveries >= 1, 'gains du livreur mis à jour');

console.log('\n— Temps réel');
await sleep(300);
const types = new Set(events.map((e) => e.type));
ok(types.has('order') && types.has('position') && types.has('notification'), `événements WebSocket reçus par le client (${events.length})`);

console.log('\n— Annulation et remboursement');
const c2 = await call('POST', '/orders', client, { ...body, idempotencyKey: randomUUID() });
await call('POST', `/orders/${c2.data.order.id}/pay`, client, { method: 'apple_pay' });
const cancelled = await call('POST', `/orders/${c2.data.order.id}/cancel`, client);
ok(cancelled.data.status === 'cancelled' && cancelled.data.payment_status === 'refunded', 'annulation avant acceptation → remboursement intégral');
const c3 = await call('POST', '/orders', client, { ...body, idempotencyKey: randomUUID() });
await call('POST', `/orders/${c3.data.order.id}/pay`, client, { method: 'google_pay' });
await call('POST', `/merchant/orders/${c3.data.order.id}/accept`, resto, { prepMinutes: 5 });
ok((await call('POST', `/orders/${c3.data.order.id}/cancel`, client)).status === 400, 'le client ne peut plus annuler après acceptation');
const t = await call('POST', '/tickets', client, { orderId: c3.data.order.id, category: 'Autre', message: 'Je souhaite annuler cette commande.' });
ok(t.status === 201, 'réclamation créée');
await call('POST', `/admin/orders/${c3.data.order.id}/cancel`, admin, { reason: 'Demande du client' });
ok((await call('GET', `/orders/${c3.data.order.id}`, client)).data.payment_status === 'refunded', 'annulation par l\'administrateur → remboursement');
ok((await call('PATCH', `/admin/tickets/${t.data.id}`, admin, { resolution: 'Commande annulée et remboursée.' })).status === 200, 'réclamation clôturée');

for (const tk of [velo, scooter]) await call('PATCH', '/courier/me', tk, { available: false });
ws.close();
console.log(`\n✅ Scénario complet validé — ${passed} vérifications.\n`);
process.exit(0);
