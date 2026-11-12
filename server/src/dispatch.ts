import { q, one, getSettings } from './db.js';
import { bad } from './http.js';
import { roadDistance, travelSeconds, MAX_RANGE_M, approxAddress, type Vehicle } from './geo.js';
import { send, notify } from './realtime.js';
import { courierPay, transition, addEvent, emitOrder, cancelOrder, ACTIVE_COURIER } from './orders.js';

/**
 * Attribution automatique des commandes.
 *
 * Pour chaque commande acceptée sans livreur, on cherche (PostGIS) les livreurs vérifiés, disponibles,
 * localisés récemment, sans course ni proposition en cours, dans un rayon qui s'élargit avec l'attente.
 * Chaque candidat reçoit un score = temps d'approche du restaurant + 35 % du temps de livraison avec
 * son véhicule ; les courses dépassant la portée du véhicule sont écartées. Le meilleur reçoit une
 * proposition à durée limitée. Refus ou absence de réponse → proposition au suivant (réattribution).
 *
 * L'état vit entièrement en base : un redémarrage du serveur ne perd aucune proposition.
 */
export async function offerNext(orderId: string) {
  const s = await getSettings();
  const o = await one(`SELECT o.id, o.number, o.distance_m, o.accepted_at, m.name merchant_name,
      ST_Y(m.location::geometry) mlat, ST_X(m.location::geometry) mlng
    FROM orders o JOIN merchants m ON m.id = o.merchant_id
    WHERE o.id = $1 AND o.status = 'preparing' AND o.courier_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.order_id = o.id AND f.status = 'pending')`, [orderId]);
  if (!o) return null;
  const waitedMin = (Date.now() - new Date(o.accepted_at).getTime()) / 60000;
  const radius = Math.min(s.dispatch.radius_km * 3, s.dispatch.radius_km + Math.floor(waitedMin)) * 1000;
  const candidates = await q(
    `SELECT c.user_id, c.vehicle, ST_Y(c.location::geometry) lat, ST_X(c.location::geometry) lng
     FROM couriers c JOIN users u ON u.id = c.user_id
     WHERE c.status = 'verified' AND c.available AND u.status = 'active'
       AND c.location IS NOT NULL AND c.location_updated_at > now() - interval '3 minutes'
       AND ST_DWithin(c.location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)
       AND NOT EXISTS (SELECT 1 FROM orders a WHERE a.courier_id = c.user_id AND a.status = ANY($5::text[]))
       AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.courier_id = c.user_id AND (f.status = 'pending'
             OR (f.order_id = $1 AND f.status IN ('refused','expired') AND f.created_at > now() - interval '2 minutes')))`,
    [orderId, o.mlng, o.mlat, radius, ACTIVE_COURIER]);
  const shop = { lat: o.mlat, lng: o.mlng };
  const scored = candidates
    .map((c) => {
      const approach = roadDistance(c, shop);
      const v = c.vehicle as Vehicle;
      return { ...c, approach, score: travelSeconds(approach, v) + 0.35 * travelSeconds(o.distance_m, v), ok: approach + o.distance_m <= MAX_RANGE_M[v] };
    })
    .filter((c) => c.ok)
    .sort((a, b) => a.score - b.score);
  const best = scored[0];
  if (!best) return null;
  const pay = courierPay(o.distance_m, best.approach, s);
  let offer;
  try {
    offer = await one(`INSERT INTO offers(order_id, courier_id, pay_cents, pickup_distance_m, expires_at)
      VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5)) RETURNING id`, [orderId, best.user_id, pay, best.approach, s.dispatch.offer_timeout_s]);
  } catch (e: any) {
    if (e.code === '23505') return null; // course concurrente : une proposition existe déjà
    throw e;
  }
  send([best.user_id], { type: 'offer', offerId: offer.id });
  await notify(best.user_id, 'Nouvelle course proposée', `${o.merchant_name} · ${(pay / 100).toFixed(2).replace('.', ',')} €`, { kind: 'offer', offerId: offer.id });
  return offer.id as string;
}

export async function currentOffer(courierId: string) {
  const f = await one(`SELECT f.id, f.expires_at, f.pay_cents, f.pickup_distance_m, o.distance_m, o.address, o.number,
      ST_Y(o.location::geometry) lat, ST_X(o.location::geometry) lng,
      m.name merchant_name, m.address merchant_address, m.emoji, ST_Y(m.location::geometry) mlat, ST_X(m.location::geometry) mlng,
      c.vehicle, (SELECT sum(quantity)::int FROM order_items i WHERE i.order_id = o.id) items_count
    FROM offers f JOIN orders o ON o.id = f.order_id JOIN merchants m ON m.id = o.merchant_id JOIN couriers c ON c.user_id = f.courier_id
    WHERE f.courier_id = $1 AND f.status = 'pending' AND f.expires_at > now()`, [courierId]);
  if (!f) return null;
  return {
    id: f.id, expires_at: f.expires_at, pay_cents: f.pay_cents, order_number: f.number, items_count: f.items_count,
    pickup_distance_m: f.pickup_distance_m, delivery_distance_m: f.distance_m, total_distance_m: f.pickup_distance_m + f.distance_m,
    eta_pickup_min: Math.max(1, Math.round(travelSeconds(f.pickup_distance_m, f.vehicle) / 60)),
    total_minutes: Math.max(2, Math.round(travelSeconds(f.pickup_distance_m + f.distance_m, f.vehicle) / 60)),
    merchant: { name: f.merchant_name, address: f.merchant_address, emoji: f.emoji, lat: f.mlat, lng: f.mlng },
    dropoff_approx: { label: approxAddress(f.address), lat: Math.round(f.lat * 500) / 500, lng: Math.round(f.lng * 500) / 500 },
  };
}

export async function acceptOffer(offerId: string, courierId: string) {
  const f = await one(`UPDATE offers SET status = 'accepted' WHERE id = $1 AND courier_id = $2 AND status = 'pending' AND expires_at > now() RETURNING *`, [offerId, courierId]);
  if (!f) throw bad('Cette proposition a expiré.', 'offer_expired');
  try {
    await transition(f.order_id, ['preparing'], 'courier_assigned', 'courier_id = $4, courier_pay_cents = $5', [courierId, f.pay_cents], courierId);
  } catch (e) {
    await q(`UPDATE offers SET status = 'cancelled' WHERE id = $1`, [offerId]);
    throw e;
  }
  // Le livreur part immédiatement vers l'établissement
  await q(`UPDATE orders SET status = 'courier_en_route' WHERE id = $1 AND status = 'courier_assigned'`, [f.order_id]);
  await addEvent(f.order_id, 'courier_en_route', courierId);
  const o = await emitOrder(f.order_id);
  const me = await one('SELECT name FROM users WHERE id = $1', [courierId]);
  await notify(o.client_id, 'Livreur attribué', `${me.name.split(' ')[0]} est en route vers l'établissement.`, { orderId: o.id });
  await notify(o.owner_id, `Commande #${o.number} : livreur en route`, `${me.name} vient récupérer la commande.`, { orderId: o.id });
  return f.order_id as string;
}

export async function refuseOffer(offerId: string, courierId: string) {
  const f = await one(`UPDATE offers SET status = 'refused' WHERE id = $1 AND courier_id = $2 AND status = 'pending' RETURNING order_id`, [offerId, courierId]);
  if (f) await offerNext(f.order_id); // réattribution immédiate
}

let running = false;
/** Boucle de fond : expirations, réattributions et délais de sécurité. */
export async function tick() {
  if (running) return;
  running = true;
  try {
    const s = await getSettings();
    const expired = await q(`UPDATE offers SET status = 'expired' WHERE status = 'pending' AND expires_at <= now() RETURNING courier_id`);
    if (expired.length) send(expired.map((e) => e.courier_id), { type: 'offer' });
    const waiting = await q(`SELECT o.id FROM orders o WHERE o.status = 'preparing' AND o.courier_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.order_id = o.id AND f.status = 'pending') ORDER BY o.accepted_at`);
    for (const w of waiting) await offerNext(w.id);
    // Établissement qui ne répond pas → annulation et remboursement automatiques
    const stale = await q(`SELECT o.id FROM orders o JOIN order_events e ON e.order_id = o.id AND e.status = 'placed'
      WHERE o.status = 'placed' AND e.at < now() - make_interval(mins => $1)`, [s.service.accept_timeout_min]);
    for (const o of stale) await cancelOrder(o.id, ['placed'], 'system', 'L\'établissement n\'a pas répondu à temps').catch(() => {});
    // Paiements jamais finalisés
    await q(`UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'system', cancel_reason = 'Paiement non finalisé', payment_status = 'failed'
      WHERE status = 'awaiting_payment' AND created_at < now() - interval '30 minutes'`);
  } catch (e) {
    console.error('[dispatch]', e);
  } finally {
    running = false;
  }
}
export function startDispatchLoop() { setInterval(tick, 4000).unref(); }
