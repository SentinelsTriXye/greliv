import { Router } from 'express';
import { z } from 'zod';
import { q, one, pt } from '../db.js';
import { h, auth, bad, forbidden, notFound } from '../http.js';
import { haversine } from '../geo.js';
import { send, notify } from '../realtime.js';
import { loadOrder, shapeOrder, transition, addEvent, emitOrder, completeDelivery, ACTIVE_COURIER } from '../orders.js';
import { currentOffer, acceptOffer, refuseOffer, tick } from '../dispatch.js';

export const courier = Router();
courier.use(auth('courier'));

const me = (id: string) => one(`SELECT c.*, u.geo_consent_at, ST_Y(c.location::geometry) lat, ST_X(c.location::geometry) lng FROM couriers c JOIN users u ON u.id = c.user_id WHERE c.user_id = $1`, [id]);
const activeOrderId = async (id: string) => (await one('SELECT id FROM orders WHERE courier_id = $1 AND status = ANY($2::text[])', [id, ACTIVE_COURIER]))?.id as string | undefined;

courier.patch('/me', h(async (req, res) => {
  const b = z.object({ available: z.boolean().optional(), vehicle: z.enum(['bike', 'ebike', 'scooter', 'car']).optional() }).parse(req.body);
  const c = await me(req.user.id);
  if (b.available) {
    if (c.status !== 'verified') throw forbidden('Votre compte doit être vérifié par l\'équipe avant de recevoir des courses.');
    if (!c.geo_consent_at) throw forbidden('Vous devez autoriser la géolocalisation pour vous rendre disponible.');
  }
  if (b.vehicle && (await activeOrderId(req.user.id))) throw bad('Impossible de changer de véhicule pendant une course.');
  await q('UPDATE couriers SET available = coalesce($2, available), vehicle = coalesce($3, vehicle) WHERE user_id = $1', [req.user.id, b.available ?? null, b.vehicle ?? null]);
  if (b.available === false) {
    // Hors service : on cesse de conserver la position (sauf course en cours) et on libère la proposition
    if (!(await activeOrderId(req.user.id))) await q('UPDATE couriers SET location = NULL, location_updated_at = NULL WHERE user_id = $1', [req.user.id]);
    const f = await one(`SELECT id FROM offers WHERE courier_id = $1 AND status = 'pending'`, [req.user.id]);
    if (f) await refuseOffer(f.id, req.user.id);
  }
  send([], { type: 'admin.refresh', kind: 'courier' }, { admins: true });
  res.json({ ok: true });
}));

courier.post('/location', h(async (req, res) => {
  const b = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).parse(req.body);
  const c = await me(req.user.id);
  if (!c.geo_consent_at) throw forbidden('Consentement à la géolocalisation requis.');
  const orderId = await activeOrderId(req.user.id);
  if (!c.available && !orderId) return res.json({ ok: true, ignored: true }); // pas de suivi hors service
  await q(`UPDATE couriers SET location = ${pt(2, 3)}, location_updated_at = now() WHERE user_id = $1`, [req.user.id, b.lng, b.lat]);
  if (orderId) {
    const step = c.lat != null ? haversine({ lat: c.lat, lng: c.lng }, b) : 0;
    if (step > 3 && step < 1500) await q('UPDATE orders SET courier_km = courier_km + $2 WHERE id = $1', [orderId, step / 1000]);
    const o = await one('SELECT o.client_id, m.owner_id FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE o.id = $1', [orderId]);
    send([o.client_id, o.owner_id], { type: 'position', orderId, courierId: req.user.id, ...b }, { admins: true });
  } else {
    send([], { type: 'position', courierId: req.user.id, ...b }, { admins: true });
    if (!c.location_updated_at) tick(); // premier point GPS : tenter une attribution sans attendre
  }
  res.json({ ok: true });
}));

courier.get('/state', h(async (req, res) => {
  const orderId = await activeOrderId(req.user.id);
  res.json({
    offer: orderId ? null : await currentOffer(req.user.id),
    order: orderId ? shapeOrder(await loadOrder(orderId), req.user) : null,
  });
}));

courier.post('/offers/:id/accept', h(async (req, res) => {
  const orderId = await acceptOffer(req.params.id, req.user.id);
  res.json(shapeOrder(await loadOrder(orderId), req.user));
}));
courier.post('/offers/:id/refuse', h(async (req, res) => {
  await refuseOffer(req.params.id, req.user.id);
  res.json({ ok: true });
}));

courier.post('/orders/:id/pickup', h(async (req, res) => {
  const o = await one('SELECT id, number, ready_at, client_id FROM orders WHERE id = $1 AND courier_id = $2', [req.params.id, req.user.id]);
  if (!o) throw notFound('Course introuvable.');
  if (!o.ready_at) throw bad('La commande n\'est pas encore prête. Patientez jusqu\'à ce que l\'établissement la remette.', 'not_ready');
  await transition(o.id, ['courier_assigned', 'courier_en_route'], 'picked_up', 'picked_up_at = now()', [], req.user.id);
  await q(`UPDATE orders SET status = 'delivering' WHERE id = $1 AND status = 'picked_up'`, [o.id]);
  await addEvent(o.id, 'delivering', req.user.id);
  await emitOrder(o.id);
  await notify(o.client_id, 'Commande récupérée', 'Votre livreur est en route vers vous. Préparez votre code de livraison.', { orderId: o.id });
  res.json(shapeOrder(await loadOrder(o.id), req.user));
}));

courier.post('/orders/:id/deliver', h(async (req, res) => {
  const b = z.object({ code: z.string().max(10).optional(), proofUrl: z.string().regex(/^\/uploads\/[\w.-]+$/).optional() }).parse(req.body);
  const o = await one('SELECT id, delivery_code FROM orders WHERE id = $1 AND courier_id = $2', [req.params.id, req.user.id]);
  if (!o) throw notFound('Course introuvable.');
  if (!b.code && !b.proofUrl) throw bad('Saisissez le code du client ou ajoutez une photo de remise.');
  if (b.code && b.code.trim() !== o.delivery_code) throw bad('Code de livraison incorrect.', 'bad_code');
  await completeDelivery(o.id, req.user.id, b.code ? null : b.proofUrl!);
  res.json(shapeOrder(await loadOrder(o.id), req.user));
}));

courier.get('/stats', h(async (req, res) => {
  const D = `(delivered_at AT TIME ZONE 'Europe/Paris')`;
  const NOW = `(now() AT TIME ZONE 'Europe/Paris')`;
  const agg = (cond: string) => one(`SELECT count(*)::int deliveries, coalesce(sum(courier_pay_cents),0)::int earnings_cents, coalesce(round(sum(courier_km)::numeric, 1),0) km
    FROM orders WHERE courier_id = $1 AND status = 'delivered' AND ${cond}`, [req.user.id]);
  const [day, week, month, total] = await Promise.all([
    agg(`${D}::date = ${NOW}::date`), agg(`date_trunc('week', ${D}) = date_trunc('week', ${NOW})`),
    agg(`date_trunc('month', ${D}) = date_trunc('month', ${NOW})`), agg('true'),
  ]);
  const series = await q(`SELECT to_char(d, 'YYYY-MM-DD') AS day, count(o.id)::int deliveries, coalesce(sum(o.courier_pay_cents),0)::int earnings_cents
    FROM generate_series(${NOW}::date - 6, ${NOW}::date, '1 day') d
    LEFT JOIN orders o ON (o.delivered_at AT TIME ZONE 'Europe/Paris')::date = d::date AND o.courier_id = $1 AND o.status = 'delivered' GROUP BY d ORDER BY d`, [req.user.id]);
  res.json({ day, week, month, total, series });
}));
