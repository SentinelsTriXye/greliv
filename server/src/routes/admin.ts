import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { q, one, tx, pt, getSettings, invalidateSettings } from '../db.js';
import { h, auth, bad, notFound, HttpError } from '../http.js';
import { notify, send } from '../realtime.js';
import { refundOrder } from '../payments.js';
import { cancelOrder, emitOrder, ACTIVE_COURIER } from '../orders.js';

export const admin = Router();
admin.use(auth('admin'));

const P = `(o.created_at AT TIME ZONE 'Europe/Paris')::date`;
const TODAY = `(now() AT TIME ZONE 'Europe/Paris')::date`;
// Revenu plateforme d'une commande livrée = commission + frais de livraison − rémunération livreur
const PLATFORM = `(o.commission_cents + o.delivery_fee_cents - o.courier_pay_cents)`;

admin.get('/overview', h(async (_req, res) => {
  const agg = (cond: string) => one(`SELECT count(*) FILTER (WHERE o.status <> 'awaiting_payment')::int orders,
      count(*) FILTER (WHERE o.status = 'delivered')::int delivered, count(*) FILTER (WHERE o.status = 'cancelled')::int cancelled,
      coalesce(sum(o.total_cents) FILTER (WHERE o.status = 'delivered'),0)::int gmv_cents,
      coalesce(sum(${PLATFORM}) FILTER (WHERE o.status = 'delivered'),0)::int platform_cents,
      coalesce(sum(o.refunded_cents),0)::int refunded_cents
    FROM orders o WHERE ${cond}`);
  const [today, week, month] = await Promise.all([agg(`${P} = ${TODAY}`), agg(`${P} > ${TODAY} - 7`), agg(`${P} > ${TODAY} - 30`)]);
  const live = await one(`SELECT
    (SELECT count(*)::int FROM orders WHERE status NOT IN ('delivered','cancelled','awaiting_payment')) active_orders,
    (SELECT count(*)::int FROM couriers WHERE available AND status = 'verified') couriers_online,
    (SELECT count(*)::int FROM merchants WHERE status = 'pending') pending_merchants,
    (SELECT count(*)::int FROM couriers WHERE status = 'pending') pending_couriers,
    (SELECT count(*)::int FROM tickets WHERE status = 'open') open_tickets,
    (SELECT count(*)::int FROM users WHERE role = 'client' AND status = 'active') clients,
    (SELECT count(*)::int FROM merchants WHERE status = 'approved') merchants`);
  const series = await q(`SELECT to_char(d, 'YYYY-MM-DD') AS day, count(o.id)::int orders, coalesce(sum(o.total_cents),0)::int gmv_cents, coalesce(sum(${PLATFORM}),0)::int platform_cents
    FROM generate_series(${TODAY} - 13, ${TODAY}, '1 day') d LEFT JOIN orders o ON ${P} = d::date AND o.status = 'delivered' GROUP BY d ORDER BY d`);
  const perf = await one(`SELECT round(avg(extract(epoch FROM (delivered_at - created_at)) / 60)::numeric, 0) avg_delivery_min,
      round(avg(merchant_rating)::numeric, 1) avg_merchant_rating, round(avg(courier_rating)::numeric, 1) avg_courier_rating,
      round(avg(distance_m)::numeric / 1000, 1) avg_km
    FROM orders WHERE status = 'delivered' AND created_at > now() - interval '30 days'`);
  const top = await q(`SELECT m.name, count(*)::int orders, sum(o.subtotal_cents)::int revenue_cents FROM orders o JOIN merchants m ON m.id = o.merchant_id
    WHERE o.status = 'delivered' AND o.created_at > now() - interval '30 days' GROUP BY m.name ORDER BY orders DESC LIMIT 5`);
  res.json({ today, week, month, live, series, perf, top });
}));

/** Carte en direct : établissements, livreurs en service, commandes en cours. */
admin.get('/live', h(async (_req, res) => {
  const merchants = await q(`SELECT id, name, emoji, is_online, ST_Y(location::geometry) lat, ST_X(location::geometry) lng FROM merchants WHERE status = 'approved'`);
  const couriers = await q(`SELECT c.user_id id, u.name, c.vehicle, ST_Y(c.location::geometry) lat, ST_X(c.location::geometry) lng,
      (SELECT o.number FROM orders o WHERE o.courier_id = c.user_id AND o.status = ANY($1::text[]) LIMIT 1) order_number
    FROM couriers c JOIN users u ON u.id = c.user_id
    WHERE c.location IS NOT NULL AND (c.available OR EXISTS (SELECT 1 FROM orders o WHERE o.courier_id = c.user_id AND o.status = ANY($1::text[])))`, [ACTIVE_COURIER]);
  const orders = await q(`SELECT o.id, o.number, o.status, o.courier_id, ST_Y(o.location::geometry) lat, ST_X(o.location::geometry) lng,
      ST_Y(m.location::geometry) mlat, ST_X(m.location::geometry) mlng, m.name merchant_name
    FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE o.status NOT IN ('delivered','cancelled','awaiting_payment')`);
  res.json({ merchants, couriers, orders });
}));

// ── Établissements ─────────────────────────────────────────────────────
admin.get('/merchants', h(async (_req, res) => {
  res.json(await q(`SELECT m.id, m.name, m.category, m.address, m.status, m.is_online, m.commission_rate, m.is_demo, m.created_at, u.email owner_email, u.name owner_name,
      (SELECT count(*)::int FROM orders o WHERE o.merchant_id = m.id AND o.status = 'delivered') orders,
      (SELECT round(avg(merchant_rating)::numeric,1) FROM orders o WHERE o.merchant_id = m.id) rating
    FROM merchants m JOIN users u ON u.id = m.owner_id ORDER BY (m.status = 'pending') DESC, m.name`));
}));
admin.post('/merchants', h(async (req, res) => {
  const b = z.object({
    name: z.string().min(2).max(80), category: z.string().min(2).max(40), address: z.string().min(5).max(200),
    lat: z.number(), lng: z.number(), ownerName: z.string().min(2).max(80), ownerEmail: z.string().email().transform((s) => s.toLowerCase()),
    password: z.string().min(8).max(100),
  }).parse(req.body);
  if (await one('SELECT 1 FROM users WHERE email = $1', [b.ownerEmail])) throw new HttpError(409, 'Un compte existe déjà avec cette adresse e-mail.');
  const hash = await bcrypt.hash(b.password, 10);
  const hours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['11:00', '14:30'], ['18:30', '22:30']]]));
  const id = await tx(async (c) => {
    const u = await one(`INSERT INTO users(role, email, password_hash, name) VALUES ('merchant',$1,$2,$3) RETURNING id`, [b.ownerEmail, hash, b.ownerName], c);
    const m = await one(`INSERT INTO merchants(owner_id, name, category, address, location, status, opening_hours) VALUES ($1,$2,$3,$4,${pt(5, 6)},'approved',$7) RETURNING id`,
      [u.id, b.name, b.category, b.address, b.lng, b.lat, JSON.stringify(hours)], c);
    return m.id;
  });
  res.status(201).json({ id });
}));
admin.patch('/merchants/:id', h(async (req, res) => {
  const b = z.object({ status: z.enum(['pending', 'approved', 'suspended']).optional(), commission_rate: z.number().min(0).max(0.6).nullable().optional() }).parse(req.body);
  const m = await one(`UPDATE merchants SET status = coalesce($2, status), commission_rate = CASE WHEN $3::boolean THEN $4 ELSE commission_rate END WHERE id = $1 RETURNING owner_id, name`,
    [req.params.id, b.status ?? null, b.commission_rate !== undefined, b.commission_rate ?? null]);
  if (!m) throw notFound();
  if (b.status === 'approved') await notify(m.owner_id, 'Établissement validé 🎉', `${m.name} est maintenant visible par les clients.`);
  if (b.status === 'suspended') await notify(m.owner_id, 'Établissement suspendu', 'Contactez l\'assistance pour en savoir plus.');
  res.json({ ok: true });
}));

// ── Livreurs ───────────────────────────────────────────────────────────
admin.get('/couriers', h(async (_req, res) => {
  res.json(await q(`SELECT u.id, u.name, u.email, u.phone, u.created_at, c.vehicle, c.status, c.available, c.total_km,
      (SELECT count(*)::int FROM orders o WHERE o.courier_id = u.id AND o.status = 'delivered') deliveries,
      (SELECT round(avg(courier_rating)::numeric,1) FROM orders o WHERE o.courier_id = u.id) rating
    FROM couriers c JOIN users u ON u.id = c.user_id WHERE u.status <> 'deleted' ORDER BY (c.status = 'pending') DESC, u.name`));
}));
admin.patch('/couriers/:id', h(async (req, res) => {
  const b = z.object({ status: z.enum(['pending', 'verified', 'suspended']) }).parse(req.body);
  const c = await one(`UPDATE couriers SET status = $2, available = CASE WHEN $2 = 'verified' THEN available ELSE false END WHERE user_id = $1 RETURNING user_id`, [req.params.id, b.status]);
  if (!c) throw notFound();
  if (b.status === 'verified') await notify(c.user_id, 'Compte vérifié 🎉', 'Vous pouvez maintenant vous rendre disponible et recevoir des courses.');
  if (b.status === 'suspended') await notify(c.user_id, 'Compte suspendu', 'Contactez l\'assistance pour en savoir plus.');
  send([c.user_id], { type: 'profile' });
  res.json({ ok: true });
}));

// ── Utilisateurs ───────────────────────────────────────────────────────
admin.get('/users', h(async (req, res) => {
  const search = `%${String(req.query.q || '').toLowerCase()}%`;
  res.json(await q(`SELECT u.id, u.role, u.name, u.email, u.phone, u.status, u.created_at,
      (SELECT count(*)::int FROM orders o WHERE o.client_id = u.id AND o.status <> 'awaiting_payment') orders
    FROM users u WHERE u.status <> 'deleted' AND (lower(u.name) LIKE $1 OR u.email LIKE $1) ORDER BY u.created_at DESC LIMIT 200`, [search]));
}));
admin.patch('/users/:id', h(async (req, res) => {
  const b = z.object({ status: z.enum(['active', 'suspended']) }).parse(req.body);
  if (req.params.id === req.user.id) throw bad('Vous ne pouvez pas suspendre votre propre compte.');
  const u = await one(`UPDATE users SET status = $2 WHERE id = $1 AND status <> 'deleted' RETURNING id, role`, [req.params.id, b.status]);
  if (!u) throw notFound();
  if (b.status === 'suspended' && u.role === 'courier') await q('UPDATE couriers SET available = false WHERE user_id = $1', [u.id]);
  res.json({ ok: true });
}));

// ── Paramètres (frais, commissions, rémunérations, attribution) ────────
const settingsSchema = z.object({
  delivery_fee: z.object({ base_cents: z.number().int().min(0).max(5000), per_km_cents: z.number().int().min(0).max(1000), min_cents: z.number().int().min(0).max(5000), max_cents: z.number().int().min(0).max(10000) }),
  commission: z.object({ rate: z.number().min(0).max(0.6) }),
  courier_pay: z.object({ base_cents: z.number().int().min(0).max(5000), per_km_cents: z.number().int().min(0).max(1000), approach_per_km_cents: z.number().int().min(0).max(1000), min_cents: z.number().int().min(0).max(5000) }),
  dispatch: z.object({ radius_km: z.number().min(0.5).max(30), offer_timeout_s: z.number().int().min(10).max(300) }),
  service: z.object({ max_delivery_km: z.number().min(1).max(30), enforce_hours: z.boolean(), min_order_cents: z.number().int().min(0).max(10000), accept_timeout_min: z.number().int().min(1).max(120) }),
});
admin.get('/settings', h(async (_req, res) => res.json(await getSettings())));
admin.put('/settings', h(async (req, res) => {
  const b = settingsSchema.parse(req.body);
  if (b.delivery_fee.min_cents > b.delivery_fee.max_cents) throw bad('Le minimum des frais de livraison dépasse le maximum.');
  for (const [k, v] of Object.entries(b)) await q('INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = $2', [k, JSON.stringify(v)]);
  invalidateSettings();
  res.json(await getSettings());
}));

// ── Annulations, remboursements, réclamations ──────────────────────────
admin.post('/orders/:id/cancel', h(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(2).max(200) }).parse(req.body);
  await cancelOrder(req.params.id, ['placed', 'accepted', 'preparing', 'courier_assigned', 'courier_en_route', 'picked_up', 'delivering'], 'admin', `Annulée par la plateforme : ${reason}`, req.user.id);
  res.json({ ok: true });
}));
admin.post('/orders/:id/refund', h(async (req, res) => {
  const { amountCents } = z.object({ amountCents: z.number().int().min(1) }).parse(req.body);
  const o = await one('SELECT id, number, client_id, total_cents, refunded_cents FROM orders WHERE id = $1', [req.params.id]);
  if (!o) throw notFound();
  if (amountCents > o.total_cents - o.refunded_cents) throw bad('Le montant dépasse le reste remboursable.');
  const done = await refundOrder(o.id, amountCents);
  if (!done) throw bad('Cette commande n\'est pas remboursable.');
  await emitOrder(o.id);
  await notify(o.client_id, `Remboursement — commande #${o.number}`, `${(done / 100).toFixed(2).replace('.', ',')} € vous ont été remboursés.`, { orderId: o.id });
  res.json({ refunded_cents: done });
}));
admin.get('/tickets', h(async (_req, res) => {
  res.json(await q(`SELECT t.id, t.category, t.message, t.status, t.resolution, t.refund_cents, t.created_at, t.resolved_at, t.order_id,
      u.name author_name, u.role author_role, u.email author_email, o.number order_number, o.total_cents, o.refunded_cents, o.payment_status
    FROM tickets t JOIN users u ON u.id = t.author_id LEFT JOIN orders o ON o.id = t.order_id ORDER BY (t.status = 'open') DESC, t.created_at DESC LIMIT 200`));
}));
admin.patch('/tickets/:id', h(async (req, res) => {
  const b = z.object({ resolution: z.string().min(2).max(500), refundCents: z.number().int().min(0).default(0) }).parse(req.body);
  const t = await one(`SELECT * FROM tickets WHERE id = $1 AND status = 'open'`, [req.params.id]);
  if (!t) throw notFound('Demande introuvable ou déjà traitée.');
  let refunded = 0;
  if (b.refundCents > 0) {
    if (!t.order_id) throw bad('Aucune commande associée à cette demande.');
    refunded = await refundOrder(t.order_id, b.refundCents);
    if (!refunded) throw bad('Cette commande n\'est pas remboursable.');
    await emitOrder(t.order_id);
  }
  await q(`UPDATE tickets SET status = 'resolved', resolution = $2, refund_cents = $3, resolved_at = now() WHERE id = $1`, [t.id, b.resolution, refunded]);
  await notify(t.author_id, 'Votre demande a été traitée', b.resolution + (refunded ? ` Remboursement : ${(refunded / 100).toFixed(2).replace('.', ',')} €.` : ''), { orderId: t.order_id });
  res.json({ ok: true, refunded_cents: refunded });
}));

admin.get('/transactions', h(async (_req, res) => {
  res.json(await q(`SELECT t.id, t.type, t.amount_cents, t.provider, t.provider_ref, t.status, t.created_at, o.number order_number, u.name beneficiary
    FROM transactions t LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN users u ON u.id = t.beneficiary_id ORDER BY t.created_at DESC LIMIT 300`));
}));
