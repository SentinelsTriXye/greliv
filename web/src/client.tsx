import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Route, Routes, useNavigate, useParams, Link } from 'react-router-dom';
import { Space, useSession, useLive, useEvent } from './session';
import { eur, km, hhmm, dateFr, FLOW, FLOW_LABEL, VEHICLES, PAY_METHODS, request } from './lib';
import { Modal, MapView, AddressPicker, Chat, StatusBadge, Empty, Stars, ActionButton, type Address, type MapMarker } from './ui';
import { PaymentSheet } from './pay';

type CartItem = { key: string; productId: string; name: string; unit_price_cents: number; quantity: number; options: Record<string, string[]>; optionsLabel: string; note: string };
type Cart = { merchantId: string; merchantName: string; items: CartItem[] } | null;
type Store = { address: Address | null; setAddress: (a: Address) => void; cart: Cart; setCart: (c: Cart) => void; config: any };
const StoreCtx = createContext<Store>(null as any);
const useStore = () => useContext(StoreCtx);

export default function ClientApp() {
  return <Space role="client"><ClientShell /></Space>;
}

function ClientShell() {
  const { user, api } = useSession();
  const [address, setAddr] = useState<Address | null>(user.default_address || null);
  const [cart, setCartState] = useState<Cart>(() => { try { return JSON.parse(localStorage.getItem(`greliv:cart:${user.id}`) || 'null'); } catch { return null; } });
  const [config, setConfig] = useState<any>({});
  useEffect(() => { request(null, 'GET', '/config').then(setConfig).catch(() => {}); }, []);
  const setCart = (c: Cart) => { const v = c && c.items.length ? c : null; setCartState(v); localStorage.setItem(`greliv:cart:${user.id}`, JSON.stringify(v)); };
  const setAddress = (a: Address) => { setAddr(a); api('PATCH', '/me', { default_address: { label: a.label, details: a.details || '', lat: a.lat, lng: a.lng } }).catch(() => {}); };
  const { data: active } = useLive<any[]>('/orders?scope=active', ['order', 'order.new']);
  const count = cart?.items.reduce((a, i) => a + i.quantity, 0) || 0;
  return (
    <StoreCtx.Provider value={{ address, setAddress, cart, setCart, config }}>
      <div className="phone">
        <Routes>
          <Route index element={<Home active={active || []} />} />
          <Route path="m/:id" element={<MerchantPage />} />
          <Route path="panier" element={<CartPage />} />
          <Route path="commande/:id" element={<OrderPage />} />
          <Route path="commandes" element={<OrdersPage />} />
          <Route path="compte" element={<AccountPage />} />
        </Routes>
        <nav className="tabbar">
          <NavLink to="/client" end><span className="ico">🏠</span>Accueil</NavLink>
          <NavLink to="/client/commandes"><span className="ico">🧾</span>Commandes{!!active?.length && <span className="dot">{active.length}</span>}</NavLink>
          <NavLink to="/client/panier"><span className="ico">🛒</span>Panier{count > 0 && <span className="dot">{count}</span>}</NavLink>
          <NavLink to="/client/compte"><span className="ico">👤</span>Compte</NavLink>
        </nav>
      </div>
    </StoreCtx.Provider>
  );
}

function AddressModal({ onClose }: { onClose: () => void }) {
  const { address, setAddress } = useStore();
  const [a, setA] = useState<Address | null>(address);
  return (
    <Modal title="Adresse de livraison" onClose={onClose}>
      <AddressPicker value={a} onChange={setA} />
      <label className="field">Complément (étage, interphone, code…)
        <input className="input" value={a?.details || ''} onChange={(e) => a && setA({ ...a, details: e.target.value })} disabled={!a} maxLength={200} />
      </label>
      <button className="btn btn-primary btn-lg" disabled={!a} onClick={() => { setAddress(a!); onClose(); }}>Livrer à cette adresse</button>
    </Modal>
  );
}

// ── Accueil ────────────────────────────────────────────────────────────
function Home({ active }: { active: any[] }) {
  const { user } = useSession();
  const { address } = useStore();
  const nav = useNavigate();
  const [pick, setPick] = useState(!address);
  const [cat, setCat] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'list' | 'map'>('list');
  const { data: merchants, error } = useLive<any[]>(address ? `/merchants?lat=${address.lat}&lng=${address.lng}` : null, []);
  const cats = useMemo(() => [...new Set((merchants || []).map((m) => m.category))], [merchants]);
  const shown = (merchants || []).filter((m) => (!cat || m.category === cat) && (!search || (m.name + m.category + m.description).toLowerCase().includes(search.toLowerCase())));
  const markers: MapMarker[] = [
    ...shown.map((m) => ({ id: m.id, kind: 'shop' as const, emoji: m.emoji, lat: m.lat, lng: m.lng, label: m.name, onClick: () => nav(`/client/m/${m.id}`) })),
    ...(address ? [{ id: 'home', kind: 'client' as const, emoji: '🏠', lat: address.lat, lng: address.lng, label: 'Vous' }] : []),
  ];
  return (
    <>
      <div className="hero">
        <div className="row between">
          <div className="brand"><img src="/icon.svg" alt="" /> GreLiv</div>
          <span className="small" style={{ opacity: .85 }}>Bonjour {user.name.split(' ')[0]} 👋</span>
        </div>
        <button className="btn btn-block" style={{ marginTop: 14, background: 'rgba(255,255,255,.16)', color: '#fff', justifyContent: 'flex-start' }} onClick={() => setPick(true)}>
          📍 <span className="ellipsis grow" style={{ textAlign: 'left' }}>{address ? address.label : 'Indiquer mon adresse de livraison'}</span> ▾
        </button>
        <input className="input" style={{ marginTop: 10, border: 0 }} placeholder="🔍  Un restaurant, un plat, un commerce…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="page">
        {active.map((o) => (
          <Link key={o.id} to={`/client/commande/${o.id}`} className="card tap rise row" style={{ background: 'var(--night)', color: '#fff' }}>
            <span style={{ fontSize: 28 }}>{o.merchant.emoji}</span>
            <div className="grow"><div className="bold">Commande #{o.number} en cours</div><div className="small" style={{ opacity: .8 }}>{FLOW_LABEL[o.status]}{o.eta_minutes ? ` · ~${o.eta_minutes} min` : ''}</div></div>
            <span className="badge orange">Suivre →</span>
          </Link>
        ))}
        {!address ? <Empty emoji="📍">Indiquez votre adresse à Grenoble pour découvrir les établissements qui livrent chez vous.<br /><br /><button className="btn btn-primary" onClick={() => setPick(true)}>Choisir mon adresse</button></Empty> : <>
          <div className="chips">
            <button className={`chip ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>Tout</button>
            {cats.map((c) => <button key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>)}
          </div>
          <div className="row between">
            <h2>{shown.length} établissement{shown.length > 1 ? 's' : ''} à proximité</h2>
            <button className="btn btn-sm" onClick={() => setView(view === 'list' ? 'map' : 'list')}>{view === 'list' ? '🗺️ Carte' : '📋 Liste'}</button>
          </div>
          {error && <Empty emoji="📡">{error}</Empty>}
          {!merchants && !error && <div className="spinner" />}
          {view === 'map' && <MapView className="tall" markers={markers} fitKey={`${address.lat}${shown.length}`} />}
          {merchants && shown.length === 0 && <Empty emoji="🔎">Aucun établissement ne correspond à votre recherche dans votre zone.</Empty>}
          {view === 'list' && shown.map((m, i) => (
            <div key={m.id} className="card tap rise" style={{ animationDelay: `${i * 40}ms`, opacity: m.open ? 1 : .6 }} onClick={() => nav(`/client/m/${m.id}`)}>
              <div className="emoji-tile cover">{m.cover_url ? <img src={m.cover_url} alt="" /> : m.emoji}</div>
              <div className="row between" style={{ marginTop: 10 }}>
                <h3 className="ellipsis">{m.name}</h3>
                <div className="row" style={{ gap: 6 }}>{m.is_demo && <span className="badge">Démo</span>}{m.open ? <span className="badge blue">{m.eta_minutes - 5}–{m.eta_minutes + 5} min</span> : <span className="badge red">Fermé</span>}</div>
              </div>
              <div className="small muted">{m.category} · {m.rating ? `⭐ ${String(m.rating).replace('.', ',')} (${m.rating_count})` : 'Nouveau'} · {km(m.distance_m)} · Livraison {eur(m.delivery_fee_cents)}</div>
            </div>
          ))}
          <p className="small muted center">Les établissements marqués « Démo » sont fictifs et servent à la démonstration.</p>
        </>}
      </div>
      {pick && <AddressModal onClose={() => setPick(false)} />}
    </>
  );
}

// ── Établissement et produits ──────────────────────────────────────────
function MerchantPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { cart } = useStore();
  const { data: m, error } = useLive<any>(`/merchants/${id}`, []);
  const [product, setProduct] = useState<any>(null);
  if (error) return <div className="page"><Empty emoji="😕">{error}</Empty></div>;
  if (!m) return <div className="spinner" />;
  const cats = [...new Set<string>(m.products.map((p: any) => p.category))];
  const mine = cart?.merchantId === m.id ? cart : null;
  const total = mine?.items.reduce((a, i) => a + i.unit_price_cents * i.quantity, 0) || 0;
  return (
    <>
      <div className="topbar"><button className="icon-btn" onClick={() => nav('/client')} aria-label="Retour">←</button><h3 className="ellipsis grow">{m.name}</h3>{m.is_demo && <span className="badge">Démo · fictif</span>}</div>
      <div className="page" style={{ paddingTop: 0 }}>
        <div className="emoji-tile cover">{m.cover_url ? <img src={m.cover_url} alt="" /> : m.emoji}</div>
        <div>
          <h1>{m.name}</h1>
          <p className="muted">{m.description}</p>
          <p className="small muted" style={{ marginTop: 4 }}>{m.category} · {m.rating ? `⭐ ${String(m.rating).replace('.', ',')} (${m.rating_count} avis)` : 'Nouveau'} · {m.address}</p>
          {!m.open && <div className="badge red" style={{ marginTop: 8 }}>Actuellement fermé — commande impossible</div>}
        </div>
        {cats.map((c) => (
          <div key={c} className="col">
            <h2>{c}</h2>
            {m.products.filter((p: any) => p.category === c).map((p: any) => (
              <div key={p.id} className={`card row ${p.available && m.open ? 'tap' : ''}`} style={{ opacity: p.available ? 1 : .5 }} onClick={() => p.available && m.open && setProduct(p)}>
                <div className="grow">
                  <div className="bold">{p.name}</div>
                  <div className="small muted">{p.description}</div>
                  <div className="row" style={{ marginTop: 6 }}><span className="bold num">{eur(p.price_cents)}</span>{!p.available && <span className="badge red">Rupture</span>}{p.options.length > 0 && <span className="badge">Personnalisable</span>}</div>
                </div>
                <div className="emoji-tile" style={{ width: 76, height: 76 }}>{p.image_url ? <img src={p.image_url} alt={p.name} /> : p.emoji}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {mine && <button className="btn btn-orange btn-lg sticky-cta" onClick={() => nav('/client/panier')}>Voir le panier · {mine.items.reduce((a, i) => a + i.quantity, 0)} article(s) · {eur(total)}</button>}
      {product && <ProductModal merchant={m} product={product} onClose={() => setProduct(null)} />}
    </>
  );
}

function ProductModal({ merchant, product, onClose }: { merchant: any; product: any; onClose: () => void }) {
  const { cart, setCart } = useStore();
  const { toast } = useSession();
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const toggle = (g: any, cid: string) => setSel((s) => {
    const cur = s[g.id] || [];
    if ((g.max || 1) === 1) return { ...s, [g.id]: cur.includes(cid) && !g.required ? [] : [cid] };
    if (cur.includes(cid)) return { ...s, [g.id]: cur.filter((x) => x !== cid) };
    return cur.length >= g.max ? s : { ...s, [g.id]: [...cur, cid] };
  });
  const chosen = product.options.flatMap((g: any) => (sel[g.id] || []).map((cid) => g.choices.find((c: any) => c.id === cid)));
  const unit = product.price_cents + chosen.reduce((a: number, c: any) => a + (c.price_cents || 0), 0);
  const missing = product.options.find((g: any) => g.required && !(sel[g.id] || []).length);
  function add() {
    let base = cart;
    if (base && base.merchantId !== merchant.id) {
      if (!confirm(`Votre panier contient des articles de ${base.merchantName}. Le vider pour commander chez ${merchant.name} ?`)) return;
      base = null;
    }
    const key = `${product.id}|${JSON.stringify(sel)}|${note}`;
    const items = [...(base?.items || [])];
    const i = items.findIndex((x) => x.key === key);
    if (i >= 0) items[i] = { ...items[i], quantity: items[i].quantity + qty };
    else items.push({ key, productId: product.id, name: product.name, unit_price_cents: unit, quantity: qty, options: sel, optionsLabel: chosen.map((c: any) => c.name).join(', '), note });
    setCart({ merchantId: merchant.id, merchantName: merchant.name, items });
    toast(`${qty} × ${product.name} ajouté au panier`, 'success');
    onClose();
  }
  return (
    <Modal title={product.name} onClose={onClose}>
      <div className="emoji-tile cover">{product.image_url ? <img src={product.image_url} alt="" /> : product.emoji}</div>
      <p className="muted">{product.description}</p>
      {product.options.map((g: any) => (
        <div key={g.id} className="col" style={{ gap: 8 }}>
          <div className="row between"><h3>{g.name}</h3><span className={`badge ${g.required ? 'orange' : ''}`}>{g.required ? 'Obligatoire' : g.max > 1 ? `Jusqu'à ${g.max}` : 'Facultatif'}</span></div>
          {g.choices.map((c: any) => {
            const on = (sel[g.id] || []).includes(c.id);
            return <button key={c.id} className="chip row between" style={{ borderRadius: 14, borderColor: on ? 'var(--blue)' : undefined, background: on ? 'var(--blue-soft)' : undefined, color: 'var(--ink)' }} onClick={() => toggle(g, c.id)}>
              <span>{on ? '✅' : '◻️'} {c.name}</span><span className="muted num">{c.price_cents ? `+ ${eur(c.price_cents)}` : 'Inclus'}</span>
            </button>;
          })}
        </div>
      ))}
      <label className="field">Une précision pour la préparation ?<input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Ex. sans oignons" /></label>
      <div className="row between">
        <div className="row"><button className="icon-btn" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Moins">−</button><b className="num" style={{ width: 24, textAlign: 'center' }}>{qty}</b><button className="icon-btn" onClick={() => setQty(Math.min(30, qty + 1))} aria-label="Plus">+</button></div>
        <button className="btn btn-orange btn-lg grow" disabled={!!missing} onClick={add}>{missing ? `Choisissez : ${missing.name}` : `Ajouter · ${eur(unit * qty)}`}</button>
      </div>
    </Modal>
  );
}

// ── Panier et paiement ─────────────────────────────────────────────────
function CartPage() {
  const { api, toast } = useSession();
  const { cart, setCart, address, config } = useStore();
  const nav = useNavigate();
  const [instructions, setInstructions] = useState('');
  const [method, setMethod] = useState('card');
  const [quote, setQuote] = useState<any>(null);
  const [quoteError, setQuoteError] = useState('');
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [payment, setPayment] = useState<any>(null);
  const payload = useMemo(() => cart && address ? { merchantId: cart.merchantId, items: cart.items.map((i) => ({ productId: i.productId, quantity: i.quantity, options: i.options, note: i.note || undefined })), lat: address.lat, lng: address.lng } : null, [cart, address]);
  const sig = JSON.stringify(payload);
  // Clé d'idempotence : identique tant que le panier ne change pas → un double clic ne crée jamais deux commandes
  const idem = useMemo(() => crypto.randomUUID(), [sig, instructions, method]); // eslint-disable-line
  useEffect(() => {
    if (!payload) return;
    let dead = false;
    api('POST', '/orders/quote', payload).then((q) => { if (!dead) { setQuote(q); setQuoteError(''); } }).catch((e) => { if (!dead) { setQuote(null); setQuoteError(e.message); } });
    return () => { dead = true; };
  }, [sig]); // eslint-disable-line

  if (!cart) return <div className="page"><h1>Panier</h1><Empty emoji="🛒">Votre panier est vide.<br /><br /><Link className="btn btn-primary" to="/client">Découvrir les établissements</Link></Empty></div>;
  const change = (key: string, d: number) => setCart({ ...cart, items: cart.items.map((i) => i.key === key ? { ...i, quantity: i.quantity + d } : i).filter((i) => i.quantity > 0) });
  async function checkout() {
    setBusy(true);
    try {
      const r = await api('POST', '/orders', { ...payload, address: address!.label, addressDetails: address!.details || '', instructions, paymentMethod: method, idempotencyKey: idem });
      if (r.order.status !== 'awaiting_payment') return done(r.order);
      setPayment(r);
    } catch (e: any) { toast(e.message, 'error'); }
    setBusy(false);
  }
  function done(order: any) { setCart(null); setPayment(null); toast('Paiement confirmé — commande envoyée !', 'success'); nav(`/client/commande/${order.id}`); }
  return (
    <div className="page">
      <h1>Panier</h1>
      <p className="muted" style={{ marginTop: -10 }}>{cart.merchantName}</p>
      <div className="card col">
        {cart.items.map((i) => (
          <div key={i.key} className="row">
            <div className="grow"><div className="bold">{i.name}</div>{(i.optionsLabel || i.note) && <div className="small muted">{[i.optionsLabel, i.note && `« ${i.note} »`].filter(Boolean).join(' · ')}</div>}<div className="small num">{eur(i.unit_price_cents * i.quantity)}</div></div>
            <button className="icon-btn" style={{ boxShadow: 'none', background: 'var(--bg)' }} onClick={() => change(i.key, -1)} aria-label="Retirer">{i.quantity === 1 ? '🗑️' : '−'}</button>
            <b className="num">{i.quantity}</b>
            <button className="icon-btn" style={{ boxShadow: 'none', background: 'var(--bg)' }} onClick={() => change(i.key, 1)} aria-label="Ajouter">+</button>
          </div>
        ))}
        <Link to={`/client/m/${cart.merchantId}`} className="small bold">+ Ajouter d'autres articles</Link>
      </div>
      <div className="card col">
        <div className="row between"><h3>Livraison</h3><button className="btn btn-sm" onClick={() => setPick(true)}>Modifier</button></div>
        {address ? <p>📍 {address.label}{address.details && <span className="muted"> — {address.details}</span>}</p> : <p className="muted">Aucune adresse sélectionnée.</p>}
        <label className="field">Instructions pour l'établissement et le livreur<textarea className="input" rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={500} placeholder="Ex. laisser devant la porte, sonner chez Martin…" /></label>
      </div>
      <div className="card col">
        <h3>Moyen de paiement</h3>
        <div className="row wrap">{Object.entries(PAY_METHODS).map(([k, label]) => <button key={k} className={`chip ${method === k ? 'on' : ''}`} onClick={() => setMethod(k)}>{k === 'card' ? '💳' : k === 'apple_pay' ? '🍏' : '🅖'} {label}</button>)}</div>
        {config.paymentProvider === 'mock' && <p className="small muted">Environnement de test : aucun débit réel.</p>}
      </div>
      <div className="card col" style={{ gap: 8 }}>
        <h3>Récapitulatif</h3>
        {quoteError && <div className="badge red" style={{ whiteSpace: 'normal', padding: '8px 12px' }} role="alert">{quoteError}</div>}
        {quote && <>
          <div className="row between"><span>Articles</span><span className="num">{eur(quote.subtotal_cents)}</span></div>
          <div className="row between"><span>Frais de livraison <span className="muted small">({km(quote.distance_m)})</span></span><span className="num">{eur(quote.delivery_fee_cents)}</span></div>
          <div className="divider" />
          <div className="row between bold" style={{ fontSize: 18 }}><span>Total</span><span className="num">{eur(quote.total_cents)}</span></div>
          <p className="small muted">Livraison estimée en {quote.eta_minutes} min environ.</p>
        </>}
        {!quote && !quoteError && address && <div className="spinner" style={{ margin: '10px auto' }} />}
      </div>
      <button className="btn btn-orange btn-lg" disabled={!quote || busy} onClick={checkout}>{quote ? `Commander et payer · ${eur(quote.total_cents)}` : 'Commander et payer'}</button>
      {pick && <AddressModal onClose={() => setPick(false)} />}
      {payment && <PaymentSheet order={payment.order} clientSecret={payment.clientSecret} publishableKey={config.stripePublishableKey} method={method} onPaid={done} onClose={() => setPayment(null)} />}
    </div>
  );
}

// ── Suivi de commande ──────────────────────────────────────────────────
function OrderPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { api, toast } = useSession();
  const { data: o, error, reload } = useLive<any>(`/orders/${id}`, ['order', 'message']);
  const [courierPos, setCourierPos] = useState<{ lat: number; lng: number } | null>(null);
  const [route, setRoute] = useState<[number, number][] | null>(null);
  const [chat, setChat] = useState<'courier' | 'merchant' | null>(null);
  const [claim, setClaim] = useState(false);
  const lastRoute = useRef(0);
  useEvent((e) => { if (e.type === 'position' && e.orderId === id) setCourierPos({ lat: e.lat, lng: e.lng }); });
  useEffect(() => { const t = setInterval(reload, 15_000); return () => clearInterval(t); }, [reload]); // rafraîchit l'heure d'arrivée estimée

  const live = o && !['delivered', 'cancelled'].includes(o.status);
  const cPos = live && o?.courier ? courierPos || (o.courier.lat != null ? { lat: o.courier.lat, lng: o.courier.lng } : null) : null;
  const toClient = o && ['picked_up', 'delivering'].includes(o.status);
  useEffect(() => {
    if (!o || !live) { setRoute(null); return; }
    if (Date.now() - lastRoute.current < 8000 && route) return;
    lastRoute.current = Date.now();
    const from = cPos || o.merchant, to = toClient || !cPos ? o.dropoff : o.merchant;
    api('POST', '/geo/route', { from: { lat: from.lat, lng: from.lng }, to: { lat: to.lat, lng: to.lng }, vehicle: o.courier?.vehicle || 'bike' }).then((r) => setRoute(r.geometry)).catch(() => {});
  }, [o?.status, cPos?.lat, cPos?.lng]); // eslint-disable-line

  if (error) return <div className="page"><Empty emoji="😕">{error}</Empty></div>;
  if (!o) return <div className="spinner" />;
  const markers: MapMarker[] = [
    { id: 'm', kind: 'shop', emoji: o.merchant.emoji, lat: o.merchant.lat, lng: o.merchant.lng, label: o.merchant.name },
    { id: 'c', kind: 'client', emoji: '🏠', lat: o.dropoff.lat, lng: o.dropoff.lng, label: 'Votre adresse' },
    ...(cPos ? [{ id: 'k', kind: 'courier' as const, emoji: VEHICLES[o.courier.vehicle].emoji, ...cPos, label: o.courier.name }] : []),
  ];
  const at = (s: string) => o.events.find((e: any) => e.status === s)?.at;
  const idx = FLOW.indexOf(o.status);
  return (
    <>
      <div className="topbar"><button className="icon-btn" onClick={() => nav('/client/commandes')} aria-label="Retour">←</button><h3 className="grow">Commande #{o.number}</h3><StatusBadge status={o.status} /></div>
      <div className="page" style={{ paddingTop: 0 }}>
        {live && <MapView className="tall" markers={markers} route={route} fitKey={`${o.status}${!!cPos}`} />}
        {o.status === 'cancelled' && (
          <div className="card" style={{ background: 'var(--red-soft)' }}><h3>Commande annulée</h3><p>{o.cancel_reason}</p>
            {o.refunded_cents > 0 && <p className="bold">Remboursement de {eur(o.refunded_cents)} effectué sur votre moyen de paiement.</p>}</div>
        )}
        {live && (
          <div className="card row rise" style={{ background: 'var(--night)', color: '#fff' }}>
            <div className="grow"><div className="small" style={{ opacity: .8 }}>{FLOW_LABEL[o.status]}{o.ready_at && idx < 5 ? ' · commande prête' : ''}</div>
              <div style={{ fontSize: 26, fontWeight: 800 }}>{o.eta_minutes ? `Arrivée dans ~${o.eta_minutes} min` : 'En attente…'}</div></div>
            <span style={{ fontSize: 34 }}>{o.courier ? VEHICLES[o.courier.vehicle].emoji : o.merchant.emoji}</span>
          </div>
        )}
        {live && idx >= 3 && (
          <div className="card center"><p className="small muted">Code de livraison à communiquer au livreur</p><div className="code">{o.delivery_code}</div></div>
        )}
        {o.status === 'delivered' && !o.merchant_rating && <RateCard order={o} onDone={reload} />}
        {o.status === 'delivered' && o.merchant_rating && <div className="card center">Merci pour votre avis ! {'⭐'.repeat(o.merchant_rating)}</div>}
        {o.courier && live && (
          <div className="card row">
            <div className="emoji-tile" style={{ width: 48, height: 48, fontSize: 22 }}>{VEHICLES[o.courier.vehicle].emoji}</div>
            <div className="grow"><div className="bold">{o.courier.name.split(' ')[0]}</div><div className="small muted">Votre livreur · {VEHICLES[o.courier.vehicle].label}</div></div>
            <button className="icon-btn" onClick={() => setChat('courier')} aria-label="Écrire au livreur">💬</button>
            {o.courier.phone && <a className="icon-btn" href={`tel:${o.courier.phone.replace(/\s/g, '')}`} aria-label="Appeler le livreur">📞</a>}
          </div>
        )}
        <div className="card row">
          <div className="emoji-tile" style={{ width: 48, height: 48, fontSize: 22 }}>{o.merchant.emoji}</div>
          <div className="grow"><div className="bold">{o.merchant.name}</div><div className="small muted">{o.merchant.address}</div></div>
          <button className="icon-btn" onClick={() => setChat('merchant')} aria-label="Écrire à l'établissement">💬</button>
          {o.merchant.phone && <a className="icon-btn" href={`tel:${o.merchant.phone.replace(/\s/g, '')}`} aria-label="Appeler l'établissement">📞</a>}
        </div>
        {o.status !== 'cancelled' && (
          <div className="card"><h3 style={{ marginBottom: 12 }}>Suivi</h3>
            <div className="timeline">{FLOW.map((s, i) => (
              <div key={s} className={`step ${i < idx || o.status === 'delivered' ? 'done' : i === idx ? 'current' : 'todo'}`}>
                <div className="bullet">{i < idx || o.status === 'delivered' ? '✓' : ''}</div>
                <div className="grow row between"><span className={i === idx ? 'bold' : ''}>{FLOW_LABEL[s]}</span>{at(s) && <span className="small muted num">{hhmm(at(s))}</span>}</div>
              </div>
            ))}</div>
          </div>
        )}
        <div className="card col" style={{ gap: 8 }}>
          <h3>Détail</h3>
          {o.items.map((i: any) => <div key={i.id} className="row between"><span>{i.quantity} × {i.name}{i.options.length > 0 && <span className="small muted"> ({i.options.map((x: any) => x.choice).join(', ')})</span>}</span><span className="num">{eur(i.unit_price_cents * i.quantity)}</span></div>)}
          <div className="divider" />
          <div className="row between"><span>Livraison</span><span className="num">{eur(o.delivery_fee_cents)}</span></div>
          <div className="row between bold"><span>Total payé · {PAY_METHODS[o.payment_method]}</span><span className="num">{eur(o.total_cents)}</span></div>
          <p className="small muted">📍 {o.dropoff.address}{o.dropoff.details && ` — ${o.dropoff.details}`}</p>
        </div>
        {o.status === 'placed' && <ActionButton className="btn btn-danger" onAction={async () => { if (confirm('Annuler cette commande ? Vous serez intégralement remboursé.')) { await api('POST', `/orders/${o.id}/cancel`); toast('Commande annulée et remboursée.', 'success'); reload(); } }}>Annuler la commande</ActionButton>}
        <button className="btn btn-ghost" onClick={() => setClaim(true)}>Un problème avec cette commande ?</button>
      </div>
      {chat && <Modal title={chat === 'courier' ? 'Votre livreur' : o.merchant.name} onClose={() => setChat(null)}><Chat orderId={o.id} thread={chat} readOnly={!live && chat === 'courier'} /></Modal>}
      {claim && <ClaimModal orderId={o.id} onClose={() => setClaim(false)} />}
    </>
  );
}

function RateCard({ order, onDone }: { order: any; onDone: () => void }) {
  const { api, toast } = useSession();
  const [m, setM] = useState(0); const [c, setC] = useState(0); const [comment, setComment] = useState('');
  return (
    <div className="card col center rise">
      <h2>Commande livrée 🎉</h2>
      <p className="muted">Comment était {order.merchant.name} ?</p><Stars value={m} onChange={setM} />
      {order.courier && <><p className="muted">Et votre livreur, {order.courier.name.split(' ')[0]} ?</p><Stars value={c} onChange={setC} /></>}
      <input className="input" placeholder="Un commentaire ? (facultatif)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} />
      <ActionButton className="btn btn-primary btn-block" disabled={!m} onAction={async () => { await api('POST', `/orders/${order.id}/rate`, { merchantRating: m, courierRating: c || undefined, comment: comment || undefined }); toast('Merci pour votre avis !', 'success'); onDone(); }}>Envoyer ma note</ActionButton>
    </div>
  );
}

export function ClaimModal({ orderId, onClose, categories = ['Article manquant ou erroné', 'Commande non reçue', 'Qualité / température', 'Retard important', 'Problème avec le livreur', 'Autre'] }: { orderId?: string; onClose: () => void; categories?: string[] }) {
  const { api, toast } = useSession();
  const [category, setCategory] = useState(categories[0]); const [message, setMessage] = useState('');
  return (
    <Modal title="Contacter l'assistance" onClose={onClose}>
      <label className="field">Motif<select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((c) => <option key={c}>{c}</option>)}</select></label>
      <label className="field">Décrivez le problème<textarea className="input" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} /></label>
      <ActionButton className="btn btn-primary btn-lg" disabled={message.trim().length < 5} onAction={async () => { await api('POST', '/tickets', { orderId, category, message }); toast('Demande envoyée. Notre équipe vous répond au plus vite.', 'success'); onClose(); }}>Envoyer</ActionButton>
    </Modal>
  );
}

// ── Historique ─────────────────────────────────────────────────────────
function OrdersPage() {
  const { data } = useLive<any[]>('/orders', ['order', 'order.new']);
  return (
    <div className="page">
      <h1>Mes commandes</h1>
      {!data && <div className="spinner" />}
      {data?.length === 0 && <Empty emoji="🧾">Vous n'avez pas encore commandé.</Empty>}
      {data?.map((o) => (
        <Link key={o.id} to={`/client/commande/${o.id}`} className="card tap row" style={{ color: 'inherit' }}>
          <div className="emoji-tile" style={{ width: 52, height: 52, fontSize: 24 }}>{o.merchant.emoji}</div>
          <div className="grow"><div className="bold ellipsis">{o.merchant.name}</div><div className="small muted">#{o.number} · {dateFr(o.created_at)} · {o.items.reduce((a: number, i: any) => a + i.quantity, 0)} article(s)</div><StatusBadge status={o.status} /></div>
          <div className="bold num">{eur(o.total_cents)}</div>
        </Link>
      ))}
    </div>
  );
}

// ── Compte ─────────────────────────────────────────────────────────────
function AccountPage() {
  const { user, api, logout, reloadUser, toast } = useSession();
  const [name, setName] = useState(user.name); const [phone, setPhone] = useState(user.phone || '');
  const { data: notifs } = useLive<any[]>('/me/notifications', ['notification']);
  const { data: tickets } = useLive<any[]>('/tickets', ['notification']);
  return (
    <div className="page">
      <h1>Mon compte</h1>
      <div className="card col">
        <label className="field">Nom<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">Téléphone<input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        <p className="small muted">{user.email}</p>
        <ActionButton onAction={async () => { await api('PATCH', '/me', { name, phone }); await reloadUser(); toast('Profil mis à jour.', 'success'); }}>Enregistrer</ActionButton>
      </div>
      <div className="card col">
        <div className="row between"><h3>Notifications</h3>{'Notification' in window && Notification.permission === 'default' && <button className="btn btn-sm" onClick={() => Notification.requestPermission().then((p) => toast(p === 'granted' ? 'Notifications activées.' : 'Notifications refusées.'))}>Activer sur cet appareil</button>}</div>
        {notifs?.length === 0 && <p className="muted small">Aucune notification.</p>}
        {notifs?.slice(0, 8).map((n) => <div key={n.id}><div className="bold small">{n.title}</div><div className="small muted">{n.body} · {dateFr(n.created_at)}</div></div>)}
      </div>
      {!!tickets?.length && (
        <div className="card col"><h3>Mes demandes d'assistance</h3>
          {tickets.map((t) => <div key={t.id}><div className="row between"><span className="bold small">{t.category}{t.order_number && ` · #${t.order_number}`}</span><span className={`badge ${t.status === 'open' ? 'orange' : 'green'}`}>{t.status === 'open' ? 'En cours' : 'Traitée'}</span></div>
            <div className="small muted">{t.resolution || t.message}{t.refund_cents > 0 && ` — remboursement ${eur(t.refund_cents)}`}</div></div>)}
        </div>
      )}
      <PrivacyCard />
      <button className="btn btn-ghost" onClick={logout}>Se déconnecter</button>
    </div>
  );
}

export function PrivacyCard() {
  const { api, logout, toast } = useSession();
  return (
    <div className="card col">
      <h3>Mes données personnelles (RGPD)</h3>
      <p className="small muted">Vos données servent uniquement à traiter vos commandes. Aucune donnée bancaire n'est conservée par l'application.</p>
      <ActionButton className="btn btn-sm" onAction={async () => {
        const blob = new Blob([JSON.stringify(await api('GET', '/me/export'), null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'mes-donnees-greliv.json'; a.click(); URL.revokeObjectURL(a.href);
      }}>Exporter mes données</ActionButton>
      <ActionButton className="btn btn-sm btn-danger" onAction={async () => { if (confirm('Supprimer définitivement votre compte et anonymiser vos données ?')) { await api('DELETE', '/me'); toast('Compte supprimé.'); logout(); } }}>Supprimer mon compte</ActionButton>
    </div>
  );
}
