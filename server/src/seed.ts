import bcrypt from 'bcryptjs';
import { q, one, pt } from './db.js';
import { roadDistance } from './geo.js';

/**
 * Données de démonstration. TOUS les établissements, personnes et commandes ci-dessous sont FICTIFS
 * (marqués is_demo et affichés avec un badge « Démo » dans l'application).
 */
const PASSWORD = 'demo1234';
const allDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['11:00', '14:30'], ['18:00', '23:00']]]));
const shopDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [['08:30', '19:30']]]));

const size = (extra = 300) => ({ id: 'taille', name: 'Taille', required: true, max: 1, choices: [{ id: 'normale', name: 'Normale', price_cents: 0 }, { id: 'grande', name: 'Grande', price_cents: extra }] });
const extras = (list: [string, number][]) => ({ id: 'supplements', name: 'Suppléments', required: false, max: list.length, choices: list.map(([name, price_cents]) => ({ id: name.toLowerCase().replace(/\W+/g, '-'), name, price_cents })) });
const cooking = { id: 'cuisson', name: 'Cuisson', required: true, max: 1, choices: ['Saignant', 'À point', 'Bien cuit'].map((n) => ({ id: n.toLowerCase().replace(/\W+/g, '-'), name: n, price_cents: 0 })) };

type P = [category: string, name: string, description: string, price: number, emoji: string, options?: any[], stock?: number | null];
const SHOPS: { name: string; category: string; emoji: string; description: string; address: string; lat: number; lng: number; prep: number; hours: any; products: P[] }[] = [
  { name: 'Pizzeria Belledonne', category: 'Pizza', emoji: '🍕', description: 'Pizzas au feu de bois, pâte maison levée 48 h.', address: '12 rue de la Démo, 38000 Grenoble', lat: 45.1903, lng: 5.7272, prep: 15, hours: allDay, products: [
    ['Pizzas', 'Margherita', 'Tomate San Marzano, mozzarella fior di latte, basilic.', 1050, '🍕', [size(), extras([['Burrata', 250], ['Jambon cru', 200], ['Olives', 100]])]],
    ['Pizzas', 'Chartreuse', 'Crème, reblochon, lardons fumés, pommes de terre, oignons.', 1390, '🧀', [size()]],
    ['Pizzas', 'Végétarienne du Vercors', 'Légumes grillés, chèvre frais, miel de montagne.', 1290, '🥬', [size(), extras([['Roquette', 100], ['Œuf', 100]])]],
    ['Pizzas', 'Diavola', 'Tomate, mozzarella, spianata piquante, piment.', 1250, '🌶️', [size()]],
    ['Desserts', 'Tiramisu maison', 'Mascarpone, café, cacao.', 590, '🍰', [], 8],
    ['Boissons', 'Limonade artisanale 33 cl', 'Citron ou framboise.', 350, '🥤'],
  ] },
  { name: 'Burger des Alpes', category: 'Burger', emoji: '🍔', description: 'Burgers gourmets, bœuf local et frites fraîches.', address: '5 place de l\'Exemple, 38000 Grenoble', lat: 45.1889, lng: 5.7228, prep: 12, hours: allDay, products: [
    ['Burgers', 'Le Montagnard', 'Bœuf 150 g, raclette fondue, oignons confits, sauce maison.', 1290, '🍔', [cooking, extras([['Bacon', 150], ['Double steak', 350], ['Œuf', 100]])]],
    ['Burgers', 'Le Classique', 'Bœuf 150 g, cheddar, salade, tomate, cornichons.', 1090, '🍔', [cooking]],
    ['Burgers', 'Le Veggie', 'Galette de légumes, avocat, cheddar, sauce yaourt.', 1150, '🥑'],
    ['Accompagnements', 'Frites maison', 'Pommes de terre fraîches, sel de Guérande.', 390, '🍟', [size(150)]],
    ['Accompagnements', 'Nuggets x6', 'Poulet fermier pané.', 590, '🍗'],
    ['Boissons', 'Milkshake vanille', 'Glace artisanale.', 490, '🥛'],
  ] },
  { name: 'Sushi Chartreuse', category: 'Japonais', emoji: '🍣', description: 'Sushis et poké bowls préparés à la commande.', address: '27 avenue Fictive, 38000 Grenoble', lat: 45.1915, lng: 5.7160, prep: 18, hours: allDay, products: [
    ['Plateaux', 'Plateau Découverte (18 pièces)', 'Makis, california, nigiris saumon.', 1890, '🍱'],
    ['Plateaux', 'Plateau Saumon (12 pièces)', 'Nigiris, sashimis et makis saumon.', 1590, '🍣'],
    ['Poké', 'Poké saumon avocat', 'Riz vinaigré, saumon, avocat, edamame, sésame.', 1350, '🥗', [extras([['Supplément saumon', 300], ['Mangue', 150]])]],
    ['Poké', 'Poké tofu', 'Riz, tofu mariné, concombre, carotte, chou rouge.', 1190, '🥢'],
    ['Entrées', 'Gyozas poulet x5', 'Raviolis grillés.', 590, '🥟'],
    ['Boissons', 'Thé vert glacé', 'Maison, non sucré.', 350, '🍵'],
  ] },
  { name: 'Tacos Vercors', category: 'Tacos', emoji: '🌯', description: 'Tacos généreux façon grenobloise, sauce fromagère maison.', address: '8 rue Imaginaire, 38000 Grenoble', lat: 45.1880, lng: 5.7130, prep: 10, hours: allDay, products: [
    ['Tacos', 'Tacos 1 viande', 'Viande au choix, frites, sauce fromagère.', 790, '🌯', [{ id: 'viande', name: 'Viande', required: true, max: 1, choices: ['Poulet', 'Viande hachée', 'Cordon bleu', 'Falafel'].map((n) => ({ id: n.toLowerCase().replace(/\W+/g, '-'), name: n, price_cents: 0 })) }, extras([['Gratiné', 100], ['Chèvre miel', 150]])]],
    ['Tacos', 'Tacos 2 viandes', 'Deux viandes au choix, frites, sauce fromagère.', 990, '🌯'],
    ['Bowls', 'Bowl poulet', 'Riz, poulet mariné, crudités, sauce blanche.', 950, '🥙'],
    ['Desserts', 'Tiramisu spéculoos', 'Fait maison.', 390, '🍮', [], 5],
    ['Boissons', 'Canette 33 cl', 'Soda au choix.', 200, '🥤'],
  ] },
  { name: 'Le Bol Dauphinois', category: 'Cuisine locale', emoji: '🥘', description: 'Spécialités du Dauphiné : gratin, ravioles, noix de Grenoble.', address: '3 quai Inventé, 38000 Grenoble', lat: 45.1929, lng: 5.7318, prep: 20, hours: allDay, products: [
    ['Plats', 'Gratin dauphinois & saucisson chaud', 'Le vrai, sans fromage, crème et ail.', 1450, '🥘'],
    ['Plats', 'Ravioles du Royans à la crème', 'Gratinées, salade verte.', 1350, '🧀', [extras([['Supplément noix', 100], ['Morilles', 400]])]],
    ['Plats', 'Salade grenobloise', 'Noix, bleu du Vercors, poire, mesclun.', 1190, '🥗'],
    ['Desserts', 'Tarte aux noix de Grenoble', 'Caramel, noix AOP.', 550, '🥧', [], 6],
    ['Boissons', 'Jus de pomme de Savoie 25 cl', 'Artisanal.', 380, '🧃'],
  ] },
  { name: 'Boulangerie de l\'Isère', category: 'Boulangerie', emoji: '🥐', description: 'Pains, viennoiseries et sandwichs du jour.', address: '41 cours Factice, 38000 Grenoble', lat: 45.1846, lng: 5.7235, prep: 8, hours: shopDay, products: [
    ['Sandwichs', 'Jambon-beurre', 'Baguette tradition, jambon blanc, beurre AOP.', 520, '🥖'],
    ['Sandwichs', 'Poulet crudités', 'Pain aux céréales, poulet rôti, crudités.', 590, '🥪'],
    ['Viennoiseries', 'Croissant pur beurre', 'Cuit du matin.', 130, '🥐', [], 30],
    ['Viennoiseries', 'Pain au chocolat', 'Deux barres, évidemment.', 140, '🍫', [], 30],
    ['Pâtisseries', 'Éclair au chocolat', 'Crème pâtissière maison.', 350, '🍰', [], 10],
    ['Boissons', 'Café à emporter', 'Arabica.', 180, '☕'],
  ] },
  { name: 'Épicerie La Noix Dorée', category: 'Épicerie', emoji: '🛒', description: 'Produits locaux et dépannage du quotidien.', address: '19 boulevard Fantôme, 38100 Grenoble', lat: 45.1790, lng: 5.7300, prep: 10, hours: shopDay, products: [
    ['Frais', 'Œufs fermiers x6', 'Plein air, Isère.', 320, '🥚', [], 20],
    ['Frais', 'Bleu du Vercors-Sassenage 200 g', 'AOP.', 590, '🧀', [], 12],
    ['Épicerie', 'Noix de Grenoble AOP 500 g', 'Récolte de l\'année.', 690, '🌰', [], 15],
    ['Épicerie', 'Pâtes artisanales 500 g', 'Blé dur français.', 290, '🍝'],
    ['Boissons', 'Eau minérale 1,5 L', 'Plate.', 110, '💧'],
    ['Hygiène', 'Papier toilette x6', 'Recyclé.', 350, '🧻', [], 0],
  ] },
  { name: 'Fleurs du Drac', category: 'Fleuriste', emoji: '💐', description: 'Bouquets de saison composés à la main.', address: '2 allée Supposée, 38000 Grenoble', lat: 45.1862, lng: 5.7190, prep: 15, hours: shopDay, products: [
    ['Bouquets', 'Bouquet de saison', 'Composition du fleuriste.', 2490, '💐', [size(1000)]],
    ['Bouquets', 'Roses rouges x10', 'Tiges longues.', 2990, '🌹', [], 6],
    ['Plantes', 'Monstera en pot', 'Pot de 17 cm.', 1990, '🪴', [], 4],
    ['Cadeaux', 'Carte message', 'Écrite à la main selon vos instructions.', 150, '💌'],
  ] },
];

const PEOPLE = {
  clients: [['Camille Martin', 'client@greliv.test', '06 00 00 00 01', { label: '14 Boulevard Gambetta, 38000 Grenoble', details: '2e étage, interphone MARTIN', lat: 45.1862, lng: 5.7226 }],
    ['Jules Bernard', 'client2@greliv.test', '06 00 00 00 02', { label: 'Avenue Maréchal Randon, Île Verte, 38000 Grenoble', details: '', lat: 45.1975, lng: 5.7370 }]] as const,
  couriers: [['Léa Dubois', 'livreur.velo@greliv.test', 'bike', 'verified'], ['Hugo Moreau', 'livreur.scooter@greliv.test', 'scooter', 'verified'],
    ['Inès Laurent', 'livreur.voiture@greliv.test', 'car', 'verified'], ['Noah Petit', 'livreur.attente@greliv.test', 'ebike', 'pending']] as const,
};

export async function seed() {
  if (await one(`SELECT 1 FROM users WHERE role = 'admin'`)) { console.log('[seed] données déjà présentes — rien à faire (utilisez db:reset pour repartir de zéro)'); return; }
  const hash = await bcrypt.hash(PASSWORD, 10);
  const user = async (role: string, name: string, email: string, phone: string | null = null, addr: any = null) =>
    (await one('INSERT INTO users(role, email, password_hash, name, phone, default_address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [role, email, hash, name, phone, addr ? JSON.stringify(addr) : null])).id as string;

  await user('admin', 'Administration GreLiv', 'admin@greliv.test');
  const clients: { id: string; addr: any }[] = [];
  for (const [name, email, phone, addr] of PEOPLE.clients) clients.push({ id: await user('client', name, email, phone, addr), addr });
  const couriers: string[] = [];
  for (const [i, [name, email, vehicle, status]] of PEOPLE.couriers.entries()) {
    const id = await user('courier', name, email, `06 00 00 01 0${i}`);
    await q(`UPDATE users SET geo_consent_at = now() WHERE id = $1`, [id]);
    await q('INSERT INTO couriers(user_id, vehicle, status) VALUES ($1,$2,$3)', [id, vehicle, status]);
    if (status === 'verified') couriers.push(id);
  }
  const shops: { id: string; lat: number; lng: number; products: { id: string; name: string; price: number }[] }[] = [];
  for (const [i, s] of SHOPS.entries()) {
    const owner = await user('merchant', `Gérant·e ${s.name}`, `resto${i + 1}@greliv.test`, `04 00 00 00 0${i + 1}`);
    const m = await one(`INSERT INTO merchants(owner_id, name, category, description, emoji, address, location, phone, status, opening_hours, prep_minutes, is_demo)
      VALUES ($1,$2,$3,$4,$5,$6,${pt(7, 8)},$9,'approved',$10,$11,true) RETURNING id`,
      [owner, s.name, s.category, s.description, s.emoji, s.address, s.lng, s.lat, `04 00 00 00 0${i + 1}`, JSON.stringify(s.hours), s.prep]);
    const products: { id: string; name: string; price: number }[] = [];
    for (const [pos, [category, name, description, price, emoji, options = [], stock = null]] of s.products.entries()) {
      const p = await one(`INSERT INTO products(merchant_id, category, name, description, price_cents, emoji, options, stock, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [m.id, category, name, description, price, emoji, JSON.stringify(options), stock, pos]);
      if (!options.some((o: any) => o.required)) products.push({ id: p.id, name, price });
    }
    shops.push({ id: m.id, lat: s.lat, lng: s.lng, products });
  }
  // Un établissement en attente de validation, pour tester le parcours administrateur
  const pendingOwner = await user('merchant', 'Gérant·e Crêperie du Néron', 'resto.attente@greliv.test');
  await q(`INSERT INTO merchants(owner_id, name, category, description, emoji, address, location, status, opening_hours, is_demo)
    VALUES ($1,'Crêperie du Néron','Crêperie','Crêpes et galettes bretonnes.','🥞','6 rue Hypothétique, 38000 Grenoble',${pt(2, 3)},'pending',$4,true)`, [pendingOwner, 5.7205, 45.1935, JSON.stringify(allDay)]);

  // Historique fictif sur 14 jours pour alimenter les tableaux de bord
  let n = 0;
  const rnd = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
  for (let day = 13; day >= 1; day--) {
    for (let k = 0; k < rnd(3, 7); k++) {
      const shop = shops[rnd(0, shops.length - 1)], client = clients[rnd(0, 1)], courier = couriers[rnd(0, couriers.length - 1)];
      const items = Array.from({ length: rnd(1, 3) }, () => ({ ...shop.products[rnd(0, shop.products.length - 1)], qty: rnd(1, 2) }));
      const subtotal = items.reduce((a, i) => a + i.price * i.qty, 0);
      const dist = roadDistance(shop, client.addr);
      const fee = Math.min(799, Math.max(199, Math.round(199 + (dist / 1000) * 60)));
      const pay = Math.max(350, Math.round(250 + (dist / 1000) * 90 + 30));
      const created = new Date(Date.now() - day * 86400000); created.setHours(rnd(11, 21), rnd(0, 59));
      const delivered = new Date(created.getTime() + rnd(22, 45) * 60000);
      const o = await one(`INSERT INTO orders(client_id, merchant_id, courier_id, status, address, address_details, location, distance_m, subtotal_cents, delivery_fee_cents,
          total_cents, commission_cents, courier_pay_cents, prep_minutes, ready_at, delivery_code, payment_provider, payment_ref, payment_status, idempotency_key,
          merchant_rating, courier_rating, courier_km, created_at, accepted_at, picked_up_at, delivered_at)
        VALUES ($1,$2,$3,'delivered',$4,$5,${pt(6, 7)},$8,$9,$10,$11,$12,$13,15,$14,'0000','mock',$15,'paid',$16,$17,$18,$19,$20,$20,$14,$21) RETURNING id`,
        [client.id, shop.id, courier, client.addr.label, client.addr.details, client.addr.lng, client.addr.lat, dist, subtotal, fee, subtotal + fee,
          Math.round(subtotal * 0.25), pay, new Date(created.getTime() + 15 * 60000), `seed_${n}`, `seed_${n++}`, rnd(3, 5), rnd(4, 5), (dist * 1.6) / 1000, created, delivered]);
      for (const it of items) await q('INSERT INTO order_items(order_id, product_id, name, unit_price_cents, quantity) VALUES ($1,$2,$3,$4,$5)', [o.id, it.id, it.name, it.price, it.qty]);
      for (const st of ['placed', 'accepted', 'preparing', 'courier_assigned', 'courier_en_route', 'picked_up', 'delivering']) await q('INSERT INTO order_events(order_id, status, at) VALUES ($1,$2,$3)', [o.id, st, created]);
      await q(`INSERT INTO order_events(order_id, status, at) VALUES ($1,'delivered',$2)`, [o.id, delivered]);
      await q(`INSERT INTO transactions(order_id, type, amount_cents, beneficiary_id, provider, status, created_at) VALUES
        ($1,'payment',$2,$3,'mock','succeeded',$7), ($1,'merchant_payout',$4,NULL,'mock','simulated',$8), ($1,'courier_payout',$5,$6,'mock','simulated',$8)`,
        [o.id, subtotal + fee, client.id, subtotal - Math.round(subtotal * 0.25), pay, courier, created, delivered]);
    }
  }
  console.log(`[seed] ${SHOPS.length} établissements fictifs, ${n} commandes d'historique, comptes de démonstration créés (mot de passe : ${PASSWORD})`);
}
