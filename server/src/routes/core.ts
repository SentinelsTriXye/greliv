import { Router } from 'express';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { q, one, tx, pt, getSettings } from '../db.js';
import { h, auth, bad, forbidden, notFound, signToken, HttpError } from '../http.js';
import { config, paymentProvider } from '../config.js';
import { geocode, reverseGeocode, getRoute, GRENOBLE, roadDistance, travelSeconds } from '../geo.js';
import { send, notify } from '../realtime.js';
import { checkMockCard, stripeIntentSucceeded, connectOnboardingUrl, stripe } from '../payments.js';
import { computeQuote, createOrder, loadOrder, loadOrders, shapeOrder, canView, markPaid, cancelOrder, merchantOpen, deliveryFee, ACTIVE_COURIER } from '../orders.js';

export const core = Router();

const DEFAULT_HOURS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['11:00', '14:30'], ['18:30', '22:30']]]));
const latlng = { lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) };

core.get('/config', (_req, res) => res.json({
  brand: 'GreLiv', paymentProvider, stripePublishableKey: config.stripePublishableKey || null,
  center: GRENOBLE, pushEnabled: !!config.fcmServiceAccount,
}));

// ── Authentification ───────────────────────────────────────────────────
const registerSchema = z.object({
  role: z.enum(['client', 'merchant', 'courier']),
  email: z.string().email().max(200).transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8, '8 caractères minimum').max(100),
  name: z.string().min(2).max(80),
  phone: z.string().max(20).optional(),
  vehicle: z.enum(['bike', 'ebike', 'scooter', 'car']).optional(),
  shop: z.object({ name: z.string().min(2).max(80), category: z.string().min(2).max(40), address: z.string().min(5).max(200), ...latlng }).optional(),
});
core.post('/auth/register', h(async (req, res) => {
  const b = registerSchema.parse(req.body);
  if (b.role === 'merchant' && !b.shop) throw bad('Les informations de l\'établissement sont requises.');
  if (b.role === 'courier' && !b.vehicle) throw bad('Indiquez votre moyen de transport.');
  if (await one('SELECT 1 FROM users WHERE email = $1', [b.email])) throw new HttpError(409, 'Un compte existe déjà avec cette adresse e-mail.');
  const hash = await bcrypt.hash(b.password, 10);
  const user = await tx(async (c) => {
    const u = await one('INSERT INTO users(role, email, password_hash, name, phone) VALUES ($1,$2,$3,$4,$5) RETURNING id, role', [b.role, b.email, hash, b.name, b.phone || null], c);
    if (b.role === 'merchant') {
      await c.query(`INSERT INTO merchants(owner_id, name, category, address, location, phone, opening_hours) VALUES ($1,$2,$3,$4,${pt(5, 6)},$7,$8)`,
        [u.id, b.shop!.name, b.shop!.category, b.shop!.address, b.shop!.lng, b.shop!.lat, b.phone || null, JSON.stringify(DEFAULT_HOURS)]);
    }
    if (b.role === 'courier') await c.query('INSERT INTO couriers(user_id, vehicle) VALUES ($1,$2)', [u.id, b.vehicle]);
    return u;
  });
  if (b.role !== 'client') send([], { type: 'admin.refresh' }, { admins: true });
  res.status(201).json({ token: signToken(user) });
}));

core.post('/auth/login', h(async (req, res) => {
  const b = z.object({ email: z.string().transform((s) => s.toLowerCase().trim()), password: z.string(), role: z.string().optional() }).parse(req.body);
  const u = await one('SELECT id, role, password_hash, status FROM users WHERE email = $1', [b.email]);
  if (!u || !(await bcrypt.compare(b.password, u.password_hash))) throw new HttpError(401, 'E-mail ou mot de passe incorrect.');
  if (u.status !== 'active') throw forbidden('Ce compte est suspendu. Contactez l\'assistance.');
  if (b.role && b.role !== u.role) throw forbidden('Ce compte n\'appartient pas à cet espace. Utilisez l\'espace correspondant à votre profil.');
  res.json({ token: signToken(u) });
}));

core.get('/me', auth(), h(async (req, res) => {
  const u = await one('SELECT id, role, email, name, phone, default_address, geo_consent_at, created_at FROM users WHERE id = $1', [req.user.id]);
  if (u.role === 'courier') {
    u.courier = await one(`SELECT vehicle, status, available, total_km, stripe_account_id IS NOT NULL AS payouts_ready,
      (SELECT round(avg(courier_rating)::numeric, 1) FROM orders WHERE courier_id = $1) rating FROM couriers WHERE user_id = $1`, [u.id]);
  }
  res.json(u);
}));
core.patch('/me', auth(), h(async (req, res) => {
  const b = z.object({
    name: z.string().min(2).max(80).optional(), phone: z.string().max(20).optional(),
    default_address: z.object({ label: z.string().max(200), details: z.string().max(200).optional(), ...latlng }).optional(),
    geo_consent: z.boolean().optional(),
  }).parse(req.body);
  await q(`UPDATE users SET name = coalesce($2, name), phone = coalesce($3, phone), default_address = coalesce($4, default_address),
    geo_consent_at = CASE WHEN $5::boolean IS NULL THEN geo_consent_at WHEN $5 THEN coalesce(geo_consent_at, now()) ELSE NULL END WHERE id = $1`,
    [req.user.id, b.name ?? null, b.phone ?? null, b.default_address ? JSON.stringify(b.default_address) : null, b.geo_consent ?? null]);
  if (b.geo_consent === false && req.user.role === 'courier') await q('UPDATE couriers SET available = false, location = NULL WHERE user_id = $1', [req.user.id]);
  res.json({ ok: true });
}));
// RGPD : portabilité
core.get('/me/export', auth(), h(async (req, res) => {
  const user = await one('SELECT id, role, email, name, phone, default_address, geo_consent_at, created_at FROM users WHERE id = $1', [req.user.id]);
  const orders = (await loadOrders(req.user.role === 'courier' ? 'o.courier_id = $1' : 'o.client_id = $1', [req.user.id], 1000)).map((o) => shapeOrder(o, req.user));
  const tickets = await q('SELECT category, message, status, resolution, created_at FROM tickets WHERE author_id = $1', [req.user.id]);
  res.setHeader('Content-Disposition', 'attachment; filename="mes-donnees.json"');
  res.json({ exporte_le: new Date().toISOString(), compte: user, commandes: orders, demandes_assistance: tickets });
}));
// RGPD : droit à l'effacement (anonymisation ; les pièces comptables sont conservées sans identité)
core.delete('/me', auth('client', 'courier'), h(async (req, res) => {
  const active = await one(`SELECT 1 FROM orders WHERE (client_id = $1 OR courier_id = $1) AND status NOT IN ('delivered','cancelled','awaiting_payment')`, [req.user.id]);
  if (active) throw bad('Impossible de supprimer le compte pendant une commande en cours.');
  await q(`UPDATE users SET status = 'deleted', email = 'supprime-' || id || '@anonyme.invalid', name = 'Compte supprimé', phone = NULL,
    default_address = NULL, geo_consent_at = NULL, password_hash = '' WHERE id = $1`, [req.user.id]);
  await q('DELETE FROM notifications WHERE user_id = $1', [req.user.id]);
  await q('DELETE FROM devices WHERE user_id = $1', [req.user.id]);
  await q('UPDATE couriers SET available = false, location = NULL WHERE user_id = $1', [req.user.id]);
  res.json({ ok: true });
}));
core.post('/me/devices', auth(), h(async (req, res) => {
  const b = z.object({ token: z.string().min(10).max(500), platform: z.string().max(20).default('web') }).parse(req.body);
  await q('INSERT INTO devices(token, user_id, platform) VALUES ($1,$2,$3) ON CONFLICT (token) DO UPDATE SET user_id = $2', [b.token, req.user.id, b.platform]);
  res.json({ ok: true });
}));
core.get('/me/notifications', auth(), h(async (req, res) => {
  res.json(await q('SELECT id, title, body, data, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 40', [req.user.id]));
}));
core.post('/me/notifications/read', auth(), h(async (req, res) => {
  await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
}));

// ── Géographie ─────────────────────────────────────────────────────────
core.get('/geo/search', h(async (req, res) => res.json(await geocode(String(req.query.q || '')))));
core.get('/geo/reverse', h(async (req, res) => {
  const p = z.object(latlng).parse({ lat: Number(req.query.lat), lng: Number(req.query.lng) });
  res.json({ label: await reverseGeocode(p) });
}));
core.post('/geo/route', auth(), h(async (req, res) => {
  const b = z.object({ from: z.object(latlng), to: z.object(latlng), vehicle: z.enum(['bike', 'ebike', 'scooter', 'car']).default('bike') }).parse(req.body);
  res.json(await getRoute(b.from, b.to, b.vehicle));
}));

// ── Catalogue public ───────────────────────────────────────────────────
core.get('/merchants', h(async (req, res) => {
  const s = await getSettings();
  const lat = Number(req.query.lat) || GRENOBLE.lat, lng = Number(req.query.lng) || GRENOBLE.lng;
  const rows = await q(`SELECT m.id, m.name, m.category, m.description, m.emoji, m.cover_url, m.address, m.is_online, m.status, m.opening_hours,
      m.prep_minutes, m.is_demo, ST_Y(m.location::geometry) lat, ST_X(m.location::geometry) lng,
      (SELECT round(avg(merchant_rating)::numeric, 1) FROM orders WHERE merchant_id = m.id) rating,
      (SELECT count(merchant_rating)::int FROM orders WHERE merchant_id = m.id) rating_count
    FROM merchants m WHERE m.status = 'approved' AND ST_DWithin(m.location, ${pt(1, 2)}, $3) ORDER BY m.name`, [lng, lat, s.service.max_delivery_km * 1000]);
  const list = rows.map((m) => {
    const distance_m = roadDistance(m, { lat, lng });
    return { ...m, status: undefined, distance_m, open: merchantOpen(m, s), delivery_fee_cents: deliveryFee(distance_m, s), eta_minutes: Math.round(m.prep_minutes + 5 + travelSeconds(distance_m, 'bike') / 60) };
  }).filter((m) => m.distance_m <= s.service.max_delivery_km * 1000)
    .sort((a, b) => Number(b.open) - Number(a.open) || a.distance_m - b.distance_m);
  res.json(list);
}));
core.get('/merchants/:id', h(async (req, res) => {
  const s = await getSettings();
  const m = await one(`SELECT id, name, category, description, emoji, cover_url, address, phone, is_online, status, opening_hours, prep_minutes, is_demo,
    ST_Y(location::geometry) lat, ST_X(location::geometry) lng,
    (SELECT round(avg(merchant_rating)::numeric, 1) FROM orders WHERE merchant_id = merchants.id) rating,
    (SELECT count(merchant_rating)::int FROM orders WHERE merchant_id = merchants.id) rating_count
    FROM merchants WHERE id = $1 AND status = 'approved'`, [req.params.id]);
  if (!m) throw notFound('Établissement introuvable.');
  const products = await q(`SELECT id, category, name, description, price_cents, image_url, emoji, options,
    (available AND (stock IS NULL OR stock > 0)) AS available FROM products WHERE merchant_id = $1 AND deleted_at IS NULL ORDER BY position, name`, [m.id]);
  res.json({ ...m, open: merchantOpen(m, s), min_order_cents: s.service.min_order_cents, products });
}));

// ── Commandes (client) ─────────────────────────────────────────────────
const itemsSchema = z.array(z.object({
  productId: z.string().uuid(), quantity: z.number().int().min(1).max(30),
  options: z.record(z.array(z.string())).optional(), note: z.string().max(200).optional(),
})).min(1).max(40);

core.post('/orders/quote', auth('client'), h(async (req, res) => {
  const b = z.object({ merchantId: z.string().uuid(), items: itemsSchema, ...latlng }).parse(req.body);
  const { merchant, commission_cents, ...quote } = await computeQuote(b.merchantId, b.items, b);
  res.json(quote);
}));
core.post('/orders', auth('client'), h(async (req, res) => {
  const b = z.object({
    merchantId: z.string().uuid(), items: itemsSchema, address: z.string().min(5).max(200), addressDetails: z.string().max(200).optional(),
    ...latlng, instructions: z.string().max(500).optional(), paymentMethod: z.enum(['card', 'apple_pay', 'google_pay']),
    idempotencyKey: z.string().min(8).max(80),
  }).parse(req.body);
  const r = await createOrder(req.user, b);
  const o = await loadOrder(r.orderId);
  let clientSecret = (r as any).clientSecret ?? null;
  // Nouvel essai sur une commande déjà créée : on réutilise le même paiement Stripe
  if (!clientSecret && stripe && o.status === 'awaiting_payment' && o.payment_ref) clientSecret = (await stripe.paymentIntents.retrieve(o.payment_ref)).client_secret;
  res.status(r.duplicate ? 200 : 201).json({ order: shapeOrder(o, req.user), duplicate: r.duplicate, clientSecret, provider: o.payment_provider });
}));
core.post('/orders/:id/pay', auth('client'), h(async (req, res) => {
  const o = await one('SELECT * FROM orders WHERE id = $1 AND client_id = $2', [req.params.id, req.user.id]);
  if (!o) throw notFound();
  if (o.status === 'awaiting_payment') {
    if (o.payment_provider === 'stripe') {
      if (!(await stripeIntentSucceeded(o.payment_ref))) throw new HttpError(402, 'Le paiement n\'est pas encore confirmé.', 'payment_pending');
      await markPaid(o.id);
    } else {
      const b = z.object({ method: z.enum(['card', 'apple_pay', 'google_pay']), card: z.object({ number: z.string(), exp: z.string(), cvc: z.string() }).optional() }).parse(req.body);
      if (b.method === 'card') checkMockCard(b.card); // la carte est validée puis oubliée : rien n'est conservé
      await markPaid(o.id, b.method);
    }
  }
  res.json(shapeOrder(await loadOrder(o.id), req.user));
}));

core.get('/orders', auth(), h(async (req, res) => {
  const u = req.user;
  const scope = String(req.query.scope || 'all');
  let where = '', params: any[] = [u.id];
  if (u.role === 'client') where = `o.client_id = $1 AND o.status <> 'awaiting_payment'`;
  else if (u.role === 'merchant') where = `m.owner_id = $1 AND o.status <> 'awaiting_payment'`;
  else if (u.role === 'courier') where = 'o.courier_id = $1';
  else { where = `o.status <> 'awaiting_payment'`; params = []; }
  if (scope === 'active') where += ` AND o.status NOT IN ('delivered','cancelled')`;
  if (scope === 'history') where += ` AND o.status IN ('delivered','cancelled')`;
  res.json((await loadOrders(where, params, u.role === 'admin' ? 300 : 100)).map((o) => shapeOrder(o, u)));
}));
core.get('/orders/:id', auth(), h(async (req, res) => {
  const o = await loadOrder(req.params.id);
  if (!o || !canView(o, req.user)) throw notFound('Commande introuvable.');
  res.json(shapeOrder(o, req.user));
}));
core.post('/orders/:id/cancel', auth('client'), h(async (req, res) => {
  const o = await one('SELECT id FROM orders WHERE id = $1 AND client_id = $2', [req.params.id, req.user.id]);
  if (!o) throw notFound();
  // Le client peut annuler tant que l'établissement n'a pas accepté
  await cancelOrder(o.id, ['awaiting_payment', 'placed'], 'client', 'Annulée par le client', req.user.id);
  res.json(shapeOrder(await loadOrder(o.id), req.user));
}));
core.post('/orders/:id/rate', auth('client'), h(async (req, res) => {
  const b = z.object({ merchantRating: z.number().int().min(1).max(5), courierRating: z.number().int().min(1).max(5).optional(), comment: z.string().max(500).optional() }).parse(req.body);
  const r = await one(`UPDATE orders SET merchant_rating = $3, courier_rating = $4, merchant_comment = $5
    WHERE id = $1 AND client_id = $2 AND status = 'delivered' AND merchant_rating IS NULL RETURNING id`, [req.params.id, req.user.id, b.merchantRating, b.courierRating ?? null, b.comment || null]);
  if (!r) throw bad('Cette commande ne peut pas (ou plus) être notée.');
  res.json(shapeOrder(await loadOrder(r.id), req.user));
}));

// ── Messagerie de commande (client ↔ livreur, client ↔ établissement) ──
async function threadAccess(req: any) {
  const thread = z.enum(['courier', 'merchant']).parse(req.params.thread);
  const o = await loadOrder(req.params.id);
  if (!o || !canView(o, req.user)) throw notFound();
  const r = req.user.role;
  if ((r === 'merchant' && thread !== 'merchant') || (r === 'courier' && thread !== 'courier')) throw forbidden();
  return { o, thread };
}
core.get('/orders/:id/messages/:thread', auth(), h(async (req, res) => {
  const { o, thread } = await threadAccess(req);
  res.json(await q(`SELECT ms.id, ms.body, ms.created_at, ms.sender_id = $3 AS mine, u.role AS sender_role
    FROM messages ms JOIN users u ON u.id = ms.sender_id WHERE ms.order_id = $1 AND ms.thread = $2 ORDER BY ms.id`, [o.id, thread, req.user.id]));
}));
core.post('/orders/:id/messages/:thread', auth('client', 'merchant', 'courier'), h(async (req, res) => {
  const { o, thread } = await threadAccess(req);
  const body = z.string().min(1).max(500).parse(req.body.body);
  if (thread === 'courier' && !o.courier_id) throw bad('Aucun livreur n\'est encore attribué.');
  await q('INSERT INTO messages(order_id, thread, sender_id, body) VALUES ($1,$2,$3,$4)', [o.id, thread, req.user.id, body]);
  const other = req.user.role === 'client' ? (thread === 'courier' ? o.courier_id : o.merchant_owner_id) : o.client_id;
  send([o.client_id, thread === 'courier' ? o.courier_id : o.merchant_owner_id], { type: 'message', orderId: o.id, thread });
  await notify(other, `Message — commande #${o.number}`, body.slice(0, 120), { orderId: o.id, kind: 'message', thread });
  res.status(201).json({ ok: true });
}));

// ── Assistance / réclamations ──────────────────────────────────────────
core.post('/tickets', auth('client', 'merchant', 'courier'), h(async (req, res) => {
  const b = z.object({ orderId: z.string().uuid().optional(), category: z.string().min(2).max(60), message: z.string().min(5).max(1000) }).parse(req.body);
  if (b.orderId) { const o = await loadOrder(b.orderId); if (!o || !canView(o, req.user)) throw notFound(); }
  const t = await one('INSERT INTO tickets(author_id, order_id, category, message) VALUES ($1,$2,$3,$4) RETURNING id', [req.user.id, b.orderId ?? null, b.category, b.message]);
  send([], { type: 'admin.refresh', kind: 'ticket' }, { admins: true });
  res.status(201).json(t);
}));
core.get('/tickets', auth('client', 'merchant', 'courier'), h(async (req, res) => {
  res.json(await q(`SELECT t.id, t.category, t.message, t.status, t.resolution, t.refund_cents, t.created_at, o.number order_number
    FROM tickets t LEFT JOIN orders o ON o.id = t.order_id WHERE t.author_id = $1 ORDER BY t.created_at DESC`, [req.user.id]));
}));

// ── Fichiers (photos produits, preuves de remise) ──────────────────────
core.post('/uploads', auth('merchant', 'courier', 'admin'), h(async (req, res) => {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.dataUrl || ''));
  if (!m) throw bad('Image invalide (PNG, JPEG ou WebP).');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4 * 1024 * 1024) throw bad('Image trop volumineuse (4 Mo maximum).');
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const name = `${randomUUID()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(config.uploadDir, name), buf);
  res.status(201).json({ url: `/uploads/${name}` });
}));

// ── Stripe Connect ─────────────────────────────────────────────────────
core.post('/connect/onboard', auth('merchant', 'courier'), h(async (req, res) => {
  const url = await connectOnboardingUrl(req.user);
  res.json({ url, message: url ? null : 'Mode démonstration : les reversements sont simulés. Renseignez STRIPE_SECRET_KEY pour activer Stripe Connect.' });
}));
export { ACTIVE_COURIER };
