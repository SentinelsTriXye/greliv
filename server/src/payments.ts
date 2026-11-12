import Stripe from 'stripe';
import { config, paymentProvider } from './config.js';
import { q, one } from './db.js';
import { bad } from './http.js';

/**
 * Paiements. Deux prestataires :
 *  - « stripe » : PaymentIntents (carte, Apple Pay, Google Pay via Payment Element) + Stripe Connect
 *    (encaissement par la plateforme puis virements séparés au commerçant et au livreur).
 *  - « mock »   : simulateur local pour la démonstration, activé quand STRIPE_SECRET_KEY est vide.
 * Aucune donnée de carte n'est stockée : avec Stripe, la carte ne transite jamais par nos serveurs.
 */
export const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;

export async function createPayment(order: { id: string; number: number; total_cents: number }) {
  if (!stripe) return { ref: `mock_${order.id}`, clientSecret: null as string | null };
  const pi = await stripe.paymentIntents.create(
    {
      amount: order.total_cents, currency: 'eur',
      automatic_payment_methods: { enabled: true }, // carte + Apple Pay + Google Pay
      description: `Commande #${order.number}`,
      metadata: { orderId: order.id },
      transfer_group: order.id,
    },
    { idempotencyKey: `pi_${order.id}` },
  );
  return { ref: pi.id, clientSecret: pi.client_secret };
}

export async function stripeIntentSucceeded(ref: string): Promise<boolean> {
  if (!stripe) return false;
  const pi = await stripe.paymentIntents.retrieve(ref);
  return pi.status === 'succeeded';
}

/** Simulateur : valide une carte de test sans jamais la conserver. */
export function checkMockCard(card?: { number?: string; exp?: string; cvc?: string }) {
  const num = (card?.number || '').replace(/\s+/g, '');
  if (!/^\d{13,19}$/.test(num)) throw bad('Numéro de carte invalide.', 'card_invalid');
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  if (sum % 10 !== 0) throw bad('Numéro de carte invalide.', 'card_invalid');
  const m = (card?.exp || '').match(/^(\d{2})\s*\/\s*(\d{2})$/);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) throw bad('Date d\'expiration invalide (MM/AA).', 'card_invalid');
  const end = new Date(2000 + Number(m[2]), Number(m[1]), 1);
  if (end < new Date()) throw bad('Carte expirée.', 'card_expired');
  if (!/^\d{3,4}$/.test(card?.cvc || '')) throw bad('Cryptogramme invalide.', 'card_invalid');
  if (num === '4000000000000002') throw bad('Paiement refusé par la banque (carte de test « refus »).', 'card_declined');
}

/** Rembourse tout ou partie d'une commande payée et journalise la transaction. */
export async function refundOrder(orderId: string, amountCents?: number) {
  const o = await one('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!o || !['paid', 'partially_refunded'].includes(o.payment_status)) return 0;
  const remaining = o.total_cents - o.refunded_cents;
  const amount = Math.min(amountCents ?? remaining, remaining);
  if (amount <= 0) return 0;
  let ref = `mock_refund_${Date.now()}`;
  if (o.payment_provider === 'stripe' && stripe) {
    const r = await stripe.refunds.create({ payment_intent: o.payment_ref, amount });
    ref = r.id;
  }
  const total = o.refunded_cents + amount;
  await q('UPDATE orders SET refunded_cents = $2, payment_status = $3 WHERE id = $1', [orderId, total, total >= o.total_cents ? 'refunded' : 'partially_refunded']);
  await q(`INSERT INTO transactions(order_id, type, amount_cents, beneficiary_id, provider, provider_ref) VALUES ($1,'refund',$2,$3,$4,$5)`,
    [orderId, -amount, o.client_id, o.payment_provider, ref]);
  return amount;
}

/** À la livraison : reversement au commerçant (sous-total − commission) et rémunération du livreur. */
export async function payOut(orderId: string) {
  const o = await one(`SELECT o.*, m.owner_id, m.stripe_account_id AS merchant_acct, c.stripe_account_id AS courier_acct
    FROM orders o JOIN merchants m ON m.id = o.merchant_id LEFT JOIN couriers c ON c.user_id = o.courier_id WHERE o.id = $1`, [orderId]);
  if (!o) return;
  const already = await one(`SELECT 1 FROM transactions WHERE order_id = $1 AND type = 'merchant_payout'`, [orderId]);
  if (already) return;
  const legs = [
    { type: 'merchant_payout', amount: o.subtotal_cents - o.commission_cents, user: o.owner_id, acct: o.merchant_acct },
    { type: 'courier_payout', amount: o.courier_pay_cents, user: o.courier_id, acct: o.courier_acct },
  ];
  for (const leg of legs) {
    if (leg.amount <= 0 || !leg.user) continue;
    let status = 'simulated', ref: string | null = null;
    if (o.payment_provider === 'stripe' && stripe) {
      if (leg.acct) {
        try {
          const t = await stripe.transfers.create({ amount: leg.amount, currency: 'eur', destination: leg.acct, transfer_group: o.id, metadata: { orderId: o.id, type: leg.type } }, { idempotencyKey: `${leg.type}_${o.id}` });
          status = 'succeeded'; ref = t.id;
        } catch (e: any) { status = 'failed'; ref = e.message?.slice(0, 200); }
      } else status = 'pending_onboarding'; // compte Connect non relié : à régulariser
    }
    await q(`INSERT INTO transactions(order_id, type, amount_cents, beneficiary_id, provider, provider_ref, status) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [o.id, leg.type, leg.amount, leg.user, o.payment_provider, ref, status]);
  }
}

/** Lien d'inscription Stripe Connect (Express) pour un commerçant ou un livreur. */
export async function connectOnboardingUrl(user: { id: string; email: string; role: string }): Promise<string | null> {
  if (!stripe) return null;
  const table = user.role === 'merchant' ? 'merchants' : 'couriers';
  const col = user.role === 'merchant' ? 'owner_id' : 'user_id';
  const row = await one(`SELECT stripe_account_id FROM ${table} WHERE ${col} = $1`, [user.id]);
  let acct = row?.stripe_account_id;
  if (!acct) {
    const a = await stripe.accounts.create({ type: 'express', country: 'FR', email: user.email, capabilities: { transfers: { requested: true } } });
    acct = a.id;
    await q(`UPDATE ${table} SET stripe_account_id = $2 WHERE ${col} = $1`, [user.id, acct]);
  }
  const back = `${config.publicUrl}/${user.role === 'merchant' ? 'commercant' : 'livreur'}`;
  const link = await stripe.accountLinks.create({ account: acct, type: 'account_onboarding', refresh_url: back, return_url: back });
  return link.url;
}
export { paymentProvider };
