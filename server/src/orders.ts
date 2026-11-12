import { randomInt } from 'node:crypto';
import { q, one, tx, pt, getSettings, type Settings } from './db.js';
import { bad, notFound, type AuthUser } from './http.js';
import { roadDistance, travelSeconds, inServiceArea, approxAddress, type Vehicle, type LatLng } from './geo.js';
import { send, notify } from './realtime.js';
import { createPayment, refundOrder, payOut, paymentProvider } from './payments.js';

export const ACTIVE_COURIER = ['courier_assigned', 'courier_en_route', 'picked_up', 'delivering'];
export const FINAL = ['delivered', 'cancelled'];

// ── Horaires ───────────────────────────────────────────────────────────
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function withinHours(hours: Record<string, [string, string][]>, date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const day = get('weekday').toLowerCase().slice(0, 3);
  const now = `${get('hour').replace('24', '00')}:${get('minute')}`;
  return (hours?.[DAYS.includes(day) ? day : 'mon'] || []).some(([a, b]) => now >= a && now <= b);
}
export function merchantOpen(m: any, s: Settings): boolean {
  return m.status === 'approved' && m.is_online && (!s.service.enforce_hours || withinHours(m.opening_hours));
}

// ── Tarification ───────────────────────────────────────────────────────
export function deliveryFee(distance_m: number, s: Settings): number {
  const f = s.delivery_fee;
  return Math.min(f.max_cents, Math.max(f.min_cents, Math.round(f.base_cents + (distance_m / 1000) * f.per_km_cents)));
}
export function courierPay(delivery_m: number, approach_m: number, s: Settings): number {
  const p = s.courier_pay;
  return Math.max(p.min_cents, Math.round(p.base_cents + (delivery_m / 1000) * p.per_km_cents + (approach_m / 1000) * p.approach_per_km_cents));
}

// ── Devis (toujours recalculé côté serveur) ────────────────────────────
export type ItemInput = { productId: string; quantity: number; options?: Record<string, string[]>; note?: string };
export async function computeQuote(merchantId: string, items: ItemInput[], dest: LatLng) {
  const s = await getSettings();
  const m = await one(`SELECT *, ST_Y(location::geometry) lat, ST_X(location::geometry) lng FROM merchants WHERE id = $1`, [merchantId]);
  if (!m || m.status !== 'approved') throw notFound('Établissement introuvable.');
  if (!merchantOpen(m, s)) throw bad('Cet établissement est actuellement fermé.', 'closed');
  if (!items.length) throw bad('Votre panier est vide.');
  if (!inServiceArea(dest)) throw bad('Cette adresse est en dehors de la zone desservie (Grenoble et agglomération).', 'out_of_zone');
  const distance_m = roadDistance(m, dest);
  if (distance_m > s.service.max_delivery_km * 1000) throw bad(`Cet établissement ne livre pas à cette adresse (plus de ${s.service.max_delivery_km} km).`, 'too_far');

  const products = await q('SELECT * FROM products WHERE merchant_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])', [merchantId, items.map((i) => i.productId)]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const wanted = new Map<string, number>();
  const lines = items.map((it) => {
    const p = byId.get(it.productId);
    if (!p) throw bad('Un produit de votre panier n\'existe plus.', 'product_gone');
    wanted.set(p.id, (wanted.get(p.id) || 0) + it.quantity);
    if (!p.available || (p.stock !== null && p.stock < wanted.get(p.id)!)) throw bad(`« ${p.name} » n'est plus disponible en quantité suffisante.`, 'out_of_stock');
    let unit = p.price_cents;
    const chosen: { group: string; choice: string; price_cents: number }[] = [];
    for (const g of p.options as any[]) {
      const sel = it.options?.[g.id] || [];
      if (g.required && sel.length === 0) throw bad(`Choisissez une option « ${g.name} » pour ${p.name}.`);
      if (sel.length > (g.max || 1)) throw bad(`Trop d'options « ${g.name} » pour ${p.name}.`);
      for (const cid of sel) {
        const c = g.choices.find((x: any) => x.id === cid);
        if (!c) throw bad(`Option invalide pour ${p.name}.`);
        unit += c.price_cents || 0;
        chosen.push({ group: g.name, choice: c.name, price_cents: c.price_cents || 0 });
      }
    }
    return { product_id: p.id, name: p.name, unit_price_cents: unit, quantity: it.quantity, options: chosen, note: (it.note || '').slice(0, 200) };
  });
  const subtotal_cents = lines.reduce((a, l) => a + l.unit_price_cents * l.quantity, 0);
  if (subtotal_cents < s.service.min_order_cents) throw bad(`Minimum de commande : ${(s.service.min_order_cents / 100).toFixed(2)} €.`, 'min_order');
  const delivery_fee_cents = deliveryFee(distance_m, s);
  const rate = m.commission_rate ?? s.commission.rate;
  return {
    merchant: m, lines, distance_m, subtotal_cents, delivery_fee_cents,
    total_cents: subtotal_cents + delivery_fee_cents,
    commission_cents: Math.round(subtotal_cents * rate),
    eta_minutes: Math.round(m.prep_minutes + 5 + travelSeconds(distance_m, 'bike') / 60),
  };
}

export async function createOrder(client: AuthUser, input: {
  merchantId: string; items: ItemInput[]; address: string; addressDetails?: string; lat: number; lng: number;
  instructions?: string; paymentMethod: string; idempotencyKey: string;
}) {
  // Anti-doublon : la même clé d'idempotence renvoie la commande déjà créée
  const existing = await one('SELECT id FROM orders WHERE client_id = $1 AND idempotency_key = $2', [client.id, input.idempotencyKey]);
  if (existing) return { orderId: existing.id as string, duplicate: true };
  const quote = await computeQuote(input.merchantId, input.items, input);
  const code = String(randomInt(0, 10000)).padStart(4, '0');
  const orderId = await tx(async (c) => {
    const o = await one(
      `INSERT INTO orders(client_id, merchant_id, instructions, address, address_details, location, distance_m, subtotal_cents,
         delivery_fee_cents, total_cents, commission_cents, delivery_code, payment_method, payment_provider, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,${pt(6, 7)},$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (client_id, idempotency_key) DO NOTHING RETURNING id`,
      [client.id, input.merchantId, (input.instructions || '').slice(0, 500), input.address, (input.addressDetails || '').slice(0, 200),
        input.lng, input.lat, quote.distance_m, quote.subtotal_cents, quote.delivery_fee_cents, quote.total_cents,
        quote.commission_cents, code, input.paymentMethod, paymentProvider, input.idempotencyKey], c);
    if (!o) return null;
    for (const l of quote.lines) {
      await c.query('INSERT INTO order_items(order_id, product_id, name, unit_price_cents, quantity, options, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [o.id, l.product_id, l.name, l.unit_price_cents, l.quantity, JSON.stringify(l.options), l.note]);
    }
    return o.id as string;
  });
  if (!orderId) {
    const again = await one('SELECT id FROM orders WHERE client_id = $1 AND idempotency_key = $2', [client.id, input.idempotencyKey]);
    return { orderId: again.id as string, duplicate: true };
  }
  const row = await one('SELECT id, number, total_cents FROM orders WHERE id = $1', [orderId]);
  const pay = await createPayment(row);
  await q('UPDATE orders SET payment_ref = $2 WHERE id = $1', [orderId, pay.ref]);
  return { orderId, duplicate: false, clientSecret: pay.clientSecret };
}

// ── Lecture ────────────────────────────────────────────────────────────
const ORDER_SQL = `
  SELECT o.*, ST_Y(o.location::geometry) lat, ST_X(o.location::geometry) lng,
    m.name merchant_name, m.address merchant_address, m.phone merchant_phone, m.emoji merchant_emoji, m.owner_id merchant_owner_id,
    m.prep_minutes merchant_prep, ST_Y(m.location::geometry) merchant_lat, ST_X(m.location::geometry) merchant_lng,
    cu.name client_name, cu.phone client_phone,
    ku.name courier_name, ku.phone courier_phone, c.vehicle courier_vehicle,
    ST_Y(c.location::geometry) courier_lat, ST_X(c.location::geometry) courier_lng,
    (SELECT coalesce(json_agg(json_build_object('id', i.id, 'name', i.name, 'unit_price_cents', i.unit_price_cents, 'quantity', i.quantity, 'options', i.options, 'note', i.note)), '[]') FROM order_items i WHERE i.order_id = o.id) items,
    (SELECT coalesce(json_agg(json_build_object('status', e.status, 'at', e.at) ORDER BY e.id), '[]') FROM order_events e WHERE e.order_id = o.id) events
  FROM orders o
  JOIN merchants m ON m.id = o.merchant_id
  JOIN users cu ON cu.id = o.client_id
  LEFT JOIN users ku ON ku.id = o.courier_id
  LEFT JOIN couriers c ON c.user_id = o.courier_id`;

export const loadOrder = (id: string) => one(`${ORDER_SQL} WHERE o.id = $1`, [id]);
export const loadOrders = (where: string, params: any[], limit = 100) =>
  q(`${ORDER_SQL} WHERE ${where} ORDER BY o.created_at DESC LIMIT ${limit}`, params);

function etaMinutes(o: any): number | null {
  if (FINAL.includes(o.status) || o.status === 'awaiting_payment') return null;
  const v: Vehicle = o.courier_vehicle || 'bike';
  const dest = { lat: o.lat, lng: o.lng }, shop = { lat: o.merchant_lat, lng: o.merchant_lng };
  const courier = o.courier_lat != null ? { lat: o.courier_lat, lng: o.courier_lng } : null;
  if (['picked_up', 'delivering'].includes(o.status)) {
    return Math.max(1, Math.ceil((travelSeconds(courier ? roadDistance(courier, dest) : o.distance_m, v) + 45) / 60));
  }
  const prepS = (o.prep_minutes ?? o.merchant_prep) * 60;
  const prepLeft = o.ready_at ? 0 : Math.max(0, prepS - (o.accepted_at ? (Date.now() - new Date(o.accepted_at).getTime()) / 1000 : 0));
  const approach = courier && o.courier_id ? travelSeconds(roadDistance(courier, shop), v) : 300;
  return Math.max(2, Math.ceil((Math.max(prepLeft, approach) + 120 + travelSeconds(o.distance_m, v)) / 60));
}

/** Projection d'une commande selon le rôle du lecteur (minimisation des données personnelles). */
export function shapeOrder(o: any, viewer: { id: string; role: string }) {
  const isClient = viewer.role === 'client', isCourier = viewer.role === 'courier', isAdmin = viewer.role === 'admin', isMerchant = viewer.role === 'merchant';
  const exact = !isCourier || ['picked_up', 'delivering', 'delivered'].includes(o.status);
  const out: any = {
    id: o.id, number: o.number, status: o.status, created_at: o.created_at, items: o.items, events: o.events,
    instructions: o.instructions, subtotal_cents: o.subtotal_cents, prep_minutes: o.prep_minutes, ready_at: o.ready_at,
    accepted_at: o.accepted_at, picked_up_at: o.picked_up_at, delivered_at: o.delivered_at, cancelled_at: o.cancelled_at,
    cancel_reason: o.cancel_reason, cancelled_by: o.cancelled_by, distance_m: o.distance_m, eta_minutes: etaMinutes(o),
    merchant: { id: o.merchant_id, name: o.merchant_name, emoji: o.merchant_emoji, address: o.merchant_address, phone: o.merchant_phone, lat: o.merchant_lat, lng: o.merchant_lng },
    client: { name: isCourier || isMerchant ? o.client_name.split(' ')[0] : o.client_name, phone: isMerchant ? null : o.client_phone },
    courier: o.courier_id ? { id: o.courier_id, name: o.courier_name, phone: isMerchant ? null : o.courier_phone, vehicle: o.courier_vehicle, lat: o.courier_lat, lng: o.courier_lng } : null,
    merchant_rating: o.merchant_rating, merchant_comment: o.merchant_comment, courier_rating: o.courier_rating,
  };
  if (!isMerchant) {
    out.dropoff = exact
      ? { exact: true, address: o.address, details: o.address_details, lat: o.lat, lng: o.lng }
      : { exact: false, address: approxAddress(o.address), details: '', lat: Math.round(o.lat * 500) / 500, lng: Math.round(o.lng * 500) / 500 };
  }
  if (isClient || isAdmin) Object.assign(out, { delivery_fee_cents: o.delivery_fee_cents, total_cents: o.total_cents, payment_method: o.payment_method, payment_status: o.payment_status, refunded_cents: o.refunded_cents, payment_provider: o.payment_provider, delivery_code: o.delivery_code, proof_url: o.proof_url });
  if (isMerchant || isAdmin) Object.assign(out, { commission_cents: o.commission_cents, merchant_net_cents: o.subtotal_cents - o.commission_cents });
  if (isCourier || isAdmin) Object.assign(out, { courier_pay_cents: o.courier_pay_cents, courier_km: o.courier_km });
  if (isAdmin) out.client.email = undefined;
  return out;
}

export function canView(o: any, u: AuthUser) {
  return u.role === 'admin' || o.client_id === u.id || o.merchant_owner_id === u.id || o.courier_id === u.id;
}

// ── Écriture / machine à états ─────────────────────────────────────────
export async function addEvent(orderId: string, status: string, actorId?: string | null) {
  await q('INSERT INTO order_events(order_id, status, actor_id) VALUES ($1,$2,$3)', [orderId, status, actorId ?? null]);
}

/** Diffuse l'état courant d'une commande à toutes les parties prenantes connectées. */
export async function emitOrder(orderId: string, type = 'order') {
  const o = await one('SELECT o.id, o.status, o.number, o.client_id, o.courier_id, m.owner_id FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE o.id = $1', [orderId]);
  if (o) send([o.client_id, o.owner_id, o.courier_id], { type, orderId: o.id, status: o.status, number: o.number }, { admins: true });
  return o;
}

/**
 * Transition atomique : n'aboutit que si la commande est encore dans l'un des statuts attendus.
 * C'est ce qui garantit la cohérence des statuts face aux doubles clics et aux requêtes concurrentes.
 */
export async function transition(orderId: string, from: string[], to: string, extraSql = '', params: any[] = [], actorId?: string) {
  const row = await one(`UPDATE orders SET status = $2 ${extraSql ? ', ' + extraSql : ''} WHERE id = $1 AND status = ANY($3::text[]) RETURNING id`, [orderId, to, from, ...params]);
  if (!row) throw bad('Cette action n\'est plus possible : le statut de la commande a changé.', 'bad_status');
  await addEvent(orderId, to, actorId);
}

/** Paiement confirmé → la commande est transmise au commerçant. Idempotent. */
export async function markPaid(orderId: string, method?: string) {
  const row = await one(`UPDATE orders SET status = 'placed', payment_status = 'paid', payment_method = coalesce($2, payment_method)
    WHERE id = $1 AND status = 'awaiting_payment' RETURNING *`, [orderId, method ?? null]);
  if (!row) return false;
  await addEvent(orderId, 'placed', row.client_id);
  await q(`INSERT INTO transactions(order_id, type, amount_cents, beneficiary_id, provider, provider_ref) VALUES ($1,'payment',$2,$3,$4,$5)`,
    [orderId, row.total_cents, row.client_id, row.payment_provider, row.payment_ref]);
  await q(`UPDATE products p SET stock = GREATEST(0, p.stock - i.qty)
    FROM (SELECT product_id, sum(quantity)::int qty FROM order_items WHERE order_id = $1 GROUP BY product_id) i
    WHERE p.id = i.product_id AND p.stock IS NOT NULL`, [orderId]);
  const o = await emitOrder(orderId, 'order.new');
  await notify(o.owner_id, `Nouvelle commande #${row.number}`, 'Acceptez-la pour lancer la préparation.', { orderId, kind: 'new_order' });
  await notify(row.client_id, 'Commande envoyée', 'Paiement confirmé. En attente de validation par l\'établissement.', { orderId });
  return true;
}

export async function cancelOrder(orderId: string, from: string[], by: 'client' | 'merchant' | 'admin' | 'system', reason: string, actorId?: string) {
  await transition(orderId, from, 'cancelled', 'cancelled_at = now(), cancel_reason = $4, cancelled_by = $5', [reason.slice(0, 300), by], actorId);
  const offers = await q(`UPDATE offers SET status = 'cancelled' WHERE order_id = $1 AND status = 'pending' RETURNING courier_id`, [orderId]);
  send(offers.map((f) => f.courier_id), { type: 'offer' });
  const refunded = await refundOrder(orderId);
  const o = await emitOrder(orderId);
  const tail = refunded ? ` Vous êtes remboursé de ${(refunded / 100).toFixed(2).replace('.', ',')} €.` : '';
  if (by !== 'client') await notify(o.client_id, `Commande #${o.number} annulée`, `${reason}.${tail}`, { orderId });
  else await notify(o.client_id, `Commande #${o.number} annulée`, `Annulation confirmée.${tail}`, { orderId });
  if (by !== 'merchant') await notify(o.owner_id, `Commande #${o.number} annulée`, reason, { orderId });
  if (o.courier_id) await notify(o.courier_id, `Course #${o.number} annulée`, reason, { orderId });
}

export async function completeDelivery(orderId: string, courierId: string, proofUrl: string | null) {
  await transition(orderId, ['delivering'], 'delivered', 'delivered_at = now(), proof_url = $4', [proofUrl], courierId);
  await q('UPDATE couriers SET total_km = total_km + (SELECT courier_km FROM orders WHERE id = $1) WHERE user_id = $2', [orderId, courierId]);
  await payOut(orderId);
  const o = await emitOrder(orderId);
  await notify(o.client_id, 'Commande livrée 🎉', 'Bon appétit ! Pensez à noter votre commande.', { orderId });
  await notify(o.owner_id, `Commande #${o.number} livrée`, 'Le client a bien reçu sa commande.', { orderId });
}
