import { useEffect, useRef, useState } from 'react';
import { loadStripe, type Stripe, type StripeElements } from '@stripe/stripe-js';
import { eur, PAY_METHODS } from './lib';
import { useSession } from './session';
import { Modal } from './ui';

/**
 * Feuille de paiement.
 *  - Stripe (clé configurée) : Payment Element — carte, Apple Pay et Google Pay selon l'appareil.
 *    Les données bancaires vont directement chez Stripe, jamais sur nos serveurs.
 *  - Mode démonstration : simulateur, aucun débit, carte de test 4242 4242 4242 4242.
 */
export function PaymentSheet({ order, clientSecret, publishableKey, method, onPaid, onClose }: {
  order: any; clientSecret: string | null; publishableKey: string | null; method: string; onPaid: (o: any) => void; onClose: () => void;
}) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [card, setCard] = useState({ number: '4242 4242 4242 4242', exp: '12/34', cvc: '123' });
  const stripeRef = useRef<{ stripe: Stripe; elements: StripeElements } | null>(null);
  const mount = useRef<HTMLDivElement>(null);
  const useStripe = !!(clientSecret && publishableKey);

  useEffect(() => {
    if (!useStripe) return;
    let dead = false;
    loadStripe(publishableKey!).then((stripe) => {
      if (!stripe || dead || !mount.current) return;
      const elements = stripe.elements({ clientSecret: clientSecret!, locale: 'fr', appearance: { theme: 'stripe', variables: { colorPrimary: '#1565D8', borderRadius: '14px' } } });
      elements.create('payment', { layout: 'tabs' }).mount(mount.current);
      stripeRef.current = { stripe, elements };
    });
    return () => { dead = true; };
  }, [useStripe]); // eslint-disable-line

  async function pay() {
    setBusy(true); setError('');
    try {
      if (useStripe) {
        const s = stripeRef.current;
        if (!s) throw new Error('Le module de paiement se charge encore…');
        const { error } = await s.stripe.confirmPayment({ elements: s.elements, redirect: 'if_required', confirmParams: { return_url: `${location.origin}/client/commande/${order.id}` } });
        if (error) throw new Error(error.message || 'Paiement refusé.');
        onPaid(await api('POST', `/orders/${order.id}/pay`, {}));
      } else {
        onPaid(await api('POST', `/orders/${order.id}/pay`, method === 'card' ? { method, card } : { method }));
      }
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }
  const fmtNumber = (v: string) => v.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim();
  const fmtExp = (v: string) => { const d = v.replace(/\D/g, '').slice(0, 4); return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; };

  return (
    <Modal title={`Payer ${eur(order.total_cents)}`} onClose={onClose}>
      {useStripe ? <div ref={mount} style={{ minHeight: 220 }} /> : <>
        <div className="badge orange" style={{ alignSelf: 'flex-start' }}>Mode démonstration · aucun débit réel</div>
        {method === 'card' ? <>
          <label className="field">Numéro de carte<input className="input num" inputMode="numeric" autoComplete="cc-number" value={card.number} onChange={(e) => setCard({ ...card, number: fmtNumber(e.target.value) })} /></label>
          <div className="row">
            <label className="field grow">Expiration<input className="input num" inputMode="numeric" placeholder="MM/AA" autoComplete="cc-exp" value={card.exp} onChange={(e) => setCard({ ...card, exp: fmtExp(e.target.value) })} /></label>
            <label className="field grow">Cryptogramme<input className="input num" inputMode="numeric" autoComplete="cc-csc" value={card.cvc} onChange={(e) => setCard({ ...card, cvc: e.target.value.replace(/\D/g, '').slice(0, 4) })} /></label>
          </div>
          <p className="small muted">Cartes de test : <b>4242 4242 4242 4242</b> (acceptée) · <b>4000 0000 0000 0002</b> (refusée). Les données saisies ne sont jamais enregistrées.</p>
        </> : (
          <div className="card center" style={{ background: 'var(--night)', color: '#fff' }}>
            <div style={{ fontSize: 34 }}>{method === 'apple_pay' ? '🍏' : '🅖'}</div>
            <p className="bold">{PAY_METHODS[method]} (simulation)</p>
            <p className="small" style={{ opacity: .8 }}>Avec Stripe activé, la feuille native {PAY_METHODS[method]} s'ouvre ici.</p>
          </div>
        )}
      </>}
      {error && <div className="badge red" style={{ whiteSpace: 'normal', padding: '8px 12px' }} role="alert">{error}</div>}
      <button className="btn btn-orange btn-lg btn-block" onClick={pay} disabled={busy}>{busy ? 'Paiement en cours…' : `Payer ${eur(order.total_cents)}`}</button>
      <p className="small muted center">🔒 Paiement sécurisé — traité par un prestataire agréé.</p>
    </Modal>
  );
}
