import { Router } from 'express';
import { z } from 'zod';
import { q, one } from '../db.js';
import { h, auth, bad, notFound, forbidden } from '../http.js';
import { notify, send } from '../realtime.js';
import { transition, addEvent, emitOrder, cancelOrder } from '../orders.js';
import { offerNext } from '../dispatch.js';

export const merchant = Router();
merchant.use(auth('merchant'));

async function myShop(userId: string) {
  const m = await one(`SELECT id, name, category, description, emoji, cover_url, address, phone, status, is_online, opening_hours, commission_rate,
    prep_minutes, is_demo, stripe_account_id IS NOT NULL AS payouts_ready, ST_Y(location::geometry) lat, ST_X(location::geometry) lng
    FROM merchants WHERE owner_id = $1`, [userId]);
  if (!m) throw notFound('Aucun établissement rattaché à ce compte.');
  return m;
}
async function myOrder(orderId: string, userId: string) {
  const o = await one('SELECT o.id, o.number, o.client_id, o.courier_id FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE o.id = $1 AND m.owner_id = $2', [orderId, userId]);
  if (!o) throw notFound('Commande introuvable.');
  return o;
}

merchant.get('/me', h(async (req, res) => {
  const m = await myShop(req.user.id);
  const s = await one(`SELECT value FROM settings WHERE key = 'commission'`);
  res.json({ ...m, effective_commission_rate: m.commission_rate ?? s.value.rate });
}));

const hoursSchema = z.record(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), z.array(z.tuple([z.string().regex(/^\d{2}:\d{2}$/), z.string().regex(/^\d{2}:\d{2}$/)])).max(3));
merchant.patch('/me', h(async (req, res) => {
  const b = z.object({
    name: z.string().min(2).max(80).optional(), description: z.string().max(400).optional(), category: z.string().min(2).max(40).optional(),
    phone: z.string().max(20).optional(), emoji: z.string().max(8).optional(), cover_url: z.string().max(300).nullable().optional(),
    is_online: z.boolean().optional(), prep_minutes: z.number().int().min(1).max(120).optional(), opening_hours: hoursSchema.optional(),
  }).parse(req.body);
  const m = await myShop(req.user.id);
  await q(`UPDATE merchants SET name = coalesce($2,name), description = coalesce($3,description), category = coalesce($4,category), phone = coalesce($5,phone),
      emoji = coalesce($6,emoji), cover_url = CASE WHEN $7::boolean THEN $8 ELSE cover_url END, is_online = coalesce($9,is_online),
      prep_minutes = coalesce($10,prep_minutes), opening_hours = coalesce($11,opening_hours) WHERE id = $1`,
    [m.id, b.name ?? null, b.description ?? null, b.category ?? null, b.phone ?? null, b.emoji ?? null, b.cover_url !== undefined, b.cover_url ?? null,
      b.is_online ?? null, b.prep_minutes ?? null, b.opening_hours ? JSON.stringify(b.opening_hours) : null]);
  res.json(await myShop(req.user.id));
}));

// ── Commandes ──────────────────────────────────────────────────────────
merchant.post('/orders/:id/accept', h(async (req, res) => {
  const { prepMinutes } = z.object({ prepMinutes: z.number().int().min(1).max(120) }).parse(req.body);
  const o = await myOrder(req.params.id, req.user.id);
  await transition(o.id, ['placed'], 'accepted', 'accepted_at = now(), prep_minutes = $4', [prepMinutes], req.user.id);
  await q(`UPDATE orders SET status = 'preparing' WHERE id = $1 AND status = 'accepted'`, [o.id]);
  await addEvent(o.id, 'preparing', req.user.id);
  await emitOrder(o.id);
  await notify(o.client_id, 'Commande acceptée', `Préparation en cours — environ ${prepMinutes} min.`, { orderId: o.id });
  await offerNext(o.id); // recherche immédiate d'un livreur
  res.json({ ok: true });
}));
merchant.post('/orders/:id/refuse', h(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(2).max(200) }).parse(req.body);
  const o = await myOrder(req.params.id, req.user.id);
  await cancelOrder(o.id, ['placed'], 'merchant', `Refusée par l'établissement : ${reason}`, req.user.id);
  res.json({ ok: true });
}));
merchant.post('/orders/:id/ready', h(async (req, res) => {
  const o = await myOrder(req.params.id, req.user.id);
  const r = await one(`UPDATE orders SET ready_at = now() WHERE id = $1 AND ready_at IS NULL AND status IN ('preparing','courier_assigned','courier_en_route') RETURNING id`, [o.id]);
  if (!r) throw bad('Cette commande ne peut pas être marquée prête.');
  await addEvent(o.id, 'ready', req.user.id);
  await emitOrder(o.id);
  if (o.courier_id) await notify(o.courier_id, `Commande #${o.number} prête`, 'Vous pouvez la récupérer.', { orderId: o.id });
  res.json({ ok: true });
}));

// ── Catalogue ──────────────────────────────────────────────────────────
const productSchema = z.object({
  name: z.string().min(2).max(80), description: z.string().max(300).default(''), category: z.string().min(1).max(40).default('Carte'),
  price_cents: z.number().int().min(0).max(100000), image_url: z.string().max(300).nullable().default(null), emoji: z.string().max(8).default('🍽️'),
  available: z.boolean().default(true), stock: z.number().int().min(0).max(9999).nullable().default(null),
  options: z.array(z.object({
    id: z.string().min(1).max(40), name: z.string().min(1).max(60), required: z.boolean().default(false), max: z.number().int().min(1).max(10).default(1),
    choices: z.array(z.object({ id: z.string().min(1).max(40), name: z.string().min(1).max(60), price_cents: z.number().int().min(0).max(10000).default(0) })).min(1).max(20),
  })).max(8).default([]),
});
merchant.get('/products', h(async (req, res) => {
  const m = await myShop(req.user.id);
  res.json(await q('SELECT id, category, name, description, price_cents, image_url, emoji, available, stock, options FROM products WHERE merchant_id = $1 AND deleted_at IS NULL ORDER BY category, position, name', [m.id]));
}));
merchant.post('/products', h(async (req, res) => {
  const m = await myShop(req.user.id);
  const b = productSchema.parse(req.body);
  const p = await one(`INSERT INTO products(merchant_id, category, name, description, price_cents, image_url, emoji, available, stock, options)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [m.id, b.category, b.name, b.description, b.price_cents, b.image_url, b.emoji, b.available, b.stock, JSON.stringify(b.options)]);
  res.status(201).json(p);
}));
merchant.patch('/products/:id', h(async (req, res) => {
  const m = await myShop(req.user.id);
  const cur = await one('SELECT category, name, description, price_cents, image_url, emoji, available, stock, options FROM products WHERE id = $1 AND merchant_id = $2 AND deleted_at IS NULL', [req.params.id, m.id]);
  if (!cur) throw notFound('Produit introuvable.');
  const b = productSchema.parse({ ...cur, ...req.body });
  await q(`UPDATE products SET category=$2, name=$3, description=$4, price_cents=$5, image_url=$6, emoji=$7, available=$8, stock=$9, options=$10 WHERE id=$1`,
    [req.params.id, b.category, b.name, b.description, b.price_cents, b.image_url, b.emoji, b.available, b.stock, JSON.stringify(b.options)]);
  res.json({ ok: true });
}));
merchant.delete('/products/:id', h(async (req, res) => {
  const m = await myShop(req.user.id);
  const r = await one('UPDATE products SET deleted_at = now() WHERE id = $1 AND merchant_id = $2 AND deleted_at IS NULL RETURNING id', [req.params.id, m.id]);
  if (!r) throw notFound('Produit introuvable.');
  res.json({ ok: true });
}));

// ── Statistiques ───────────────────────────────────────────────────────
merchant.get('/stats', h(async (req, res) => {
  const m = await myShop(req.user.id);
  const P = `(o.created_at AT TIME ZONE 'Europe/Paris')::date`;
  const TODAY = `(now() AT TIME ZONE 'Europe/Paris')::date`;
  const agg = (cond: string) => one(`SELECT count(*)::int orders, coalesce(sum(subtotal_cents),0)::int revenue_cents, coalesce(sum(commission_cents),0)::int commission_cents,
    coalesce(sum(subtotal_cents - commission_cents),0)::int net_cents FROM orders o WHERE merchant_id = $1 AND status = 'delivered' AND ${cond}`, [m.id]);
  const [today, week, month] = await Promise.all([agg(`${P} = ${TODAY}`), agg(`${P} > ${TODAY} - 7`), agg(`${P} > ${TODAY} - 30`)]);
  const series = await q(`SELECT to_char(d, 'YYYY-MM-DD') AS day, count(o.id)::int orders, coalesce(sum(o.subtotal_cents),0)::int revenue_cents
    FROM generate_series(${TODAY} - 13, ${TODAY}, '1 day') d LEFT JOIN orders o ON ${P} = d::date AND o.merchant_id = $1 AND o.status = 'delivered'
    GROUP BY d ORDER BY d`, [m.id]);
  const top = await q(`SELECT i.name, sum(i.quantity)::int qty FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE o.merchant_id = $1 AND o.status = 'delivered' GROUP BY i.name ORDER BY qty DESC LIMIT 5`, [m.id]);
  const received = await one(`SELECT count(*)::int n FROM orders o WHERE merchant_id = $1 AND status <> 'awaiting_payment' AND ${P} = ${TODAY}`, [m.id]);
  const rating = await one('SELECT round(avg(merchant_rating)::numeric,1) avg, count(merchant_rating)::int n FROM orders WHERE merchant_id = $1', [m.id]);
  res.json({ today: { ...today, received: received.n }, week, month, series, top, rating });
}));
export { forbidden, send };
