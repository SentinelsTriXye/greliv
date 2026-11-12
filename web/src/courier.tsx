import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { Space, useSession, useLive } from './session';
import { eur, km, dateFr, VEHICLES, haversine, fileToDataUrl, type LatLng } from './lib';
import { Modal, MapView, Chat, StatusBadge, Empty, Switch, Tile, ActionButton, BarChart, dayLabel, type MapMarker } from './ui';
import { ClaimModal, PrivacyCard } from './client';

type RouteData = { distance_m: number; duration_s: number; geometry: [number, number][]; steps: { instruction: string; distance_m: number }[]; source: string };
type Tracker = { pos: LatLng | null; mode: 'sim' | 'real'; setMode: (m: 'sim' | 'real') => void; state: any; reloadState: () => void; route: RouteData | null; remaining: { m: number; s: number } | null; gpsError: string };
const TrackerCtx = createContext<Tracker>(null as any);
const SIM_BOOST = 3; // le mode simulation roule 3× plus vite pour les démonstrations
const SIM_START: LatLng = { lat: 45.1878, lng: 5.7262 };

export default function CourierApp() {
  return <Space role="courier"><Shell /></Space>;
}

/** Moteur de géolocalisation : suit la position (GPS réel ou simulation), l'envoie au serveur et tient l'itinéraire à jour. */
function useTracker(): Tracker {
  const { user, api } = useSession();
  const { data: state, reload: reloadState } = useLive<any>('/courier/state', ['offer', 'order', 'profile', 'notification']);
  const [mode, setModeState] = useState<'sim' | 'real'>(() => (localStorage.getItem('greliv:gps') as any) || 'sim');
  const [pos, setPos] = useState<LatLng | null>(null);
  const [route, setRoute] = useState<RouteData | null>(null);
  const [gpsError, setGpsError] = useState('');
  const posRef = useRef<LatLng | null>(null); posRef.current = pos;
  const routeRef = useRef<RouteData | null>(null); routeRef.current = route;
  const simIdx = useRef(1);
  const order = state?.order;
  const vehicle = user.courier.vehicle;
  const active = !!user.geo_consent_at && (user.courier.available || !!order);
  const setMode = (m: 'sim' | 'real') => { localStorage.setItem('greliv:gps', m); setModeState(m); setPos(null); setGpsError(''); };

  // 1. Acquisition de la position
  useEffect(() => {
    if (!active) { setPos(null); return; }
    if (mode === 'real') {
      if (!navigator.geolocation) { setGpsError('GPS indisponible sur cet appareil.'); return; }
      const id = navigator.geolocation.watchPosition(
        (p) => { setGpsError(''); setPos({ lat: p.coords.latitude, lng: p.coords.longitude }); },
        (e) => setGpsError(e.code === 1 ? 'Autorisez la localisation dans votre navigateur pour recevoir des courses.' : 'Signal GPS indisponible, nouvelle tentative…'),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
      );
      return () => navigator.geolocation.clearWatch(id);
    }
    if (!posRef.current) {
      let start = SIM_START;
      try { start = JSON.parse(localStorage.getItem('greliv:simpos') || '') || SIM_START; } catch { /* défaut */ }
      setPos(start);
    }
    const t = setInterval(() => {
      const r = routeRef.current, p = posRef.current;
      if (!r || !p) return;
      let budget = (VEHICLES[vehicle].kmh / 3.6) * SIM_BOOST, cur = p;
      while (budget > 0 && simIdx.current < r.geometry.length) {
        const [lat, lng] = r.geometry[simIdx.current];
        const d = haversine(cur, { lat, lng });
        if (d <= budget) { cur = { lat, lng }; budget -= d; simIdx.current++; }
        else { const f = budget / d; cur = { lat: cur.lat + (lat - cur.lat) * f, lng: cur.lng + (lng - cur.lng) * f }; budget = 0; }
      }
      if (cur !== p) { setPos(cur); localStorage.setItem('greliv:simpos', JSON.stringify(cur)); }
    }, 1000);
    return () => clearInterval(t);
  }, [active, mode, vehicle]);

  // 2. Envoi régulier au serveur (toutes les 3 s)
  useEffect(() => {
    if (!active) return;
    const push = () => { const p = posRef.current; if (p) api('POST', '/courier/location', p).catch(() => {}); };
    const first = setTimeout(push, 400);
    const t = setInterval(push, 3000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [active, api, mode]);

  // 3. Itinéraire : vers l'établissement puis vers le client ; recalcul automatique en cas d'écart
  const phase = order ? (['picked_up', 'delivering'].includes(order.status) ? 'drop' : 'pick') : '';
  const target: LatLng | null = order ? (phase === 'drop' ? order.dropoff : order.merchant) : null;
  const hasPos = !!pos;
  useEffect(() => {
    if (!target || !hasPos) { setRoute(null); return; }
    let dead = false;
    const compute = () => {
      const p = posRef.current; if (!p) return;
      api('POST', '/geo/route', { from: p, to: { lat: target.lat, lng: target.lng }, vehicle })
        .then((r) => { if (!dead) { simIdx.current = 1; setRoute(r); } }).catch(() => {});
    };
    compute();
    const t = setInterval(() => {
      const r = routeRef.current, p = posRef.current;
      if (!r || !p || mode !== 'real') return;
      const off = Math.min(...r.geometry.map(([lat, lng]) => haversine(p, { lat, lng })));
      if (off > 60) compute(); // le livreur s'est écarté du trajet
    }, 10_000);
    return () => { dead = true; clearInterval(t); };
  }, [order?.id, phase, hasPos, vehicle, mode]); // eslint-disable-line

  let remaining: Tracker['remaining'] = null;
  if (route && pos) {
    const g = route.geometry;
    let best = 0, bestD = Infinity;
    g.forEach(([lat, lng], i) => { const d = haversine(pos, { lat, lng }); if (d < bestD) { bestD = d; best = i; } });
    let m = bestD;
    for (let i = best; i < g.length - 1; i++) m += haversine({ lat: g[i][0], lng: g[i][1] }, { lat: g[i + 1][0], lng: g[i + 1][1] });
    const geoLen = g.slice(1).reduce((a, c, i) => a + haversine({ lat: g[i][0], lng: g[i][1] }, { lat: c[0], lng: c[1] }), 0) || 1;
    const ratio = Math.min(1, m / geoLen);
    remaining = { m: Math.round(route.distance_m * ratio), s: Math.round(route.duration_s * ratio) };
  }
  return { pos, mode, setMode, state, reloadState, route, remaining, gpsError };
}

function Shell() {
  const tracker = useTracker();
  return (
    <TrackerCtx.Provider value={tracker}>
      <div className="phone">
        <Routes>
          <Route index element={<Ride />} />
          <Route path="gains" element={<Earnings />} />
          <Route path="historique" element={<History />} />
          <Route path="compte" element={<Account />} />
        </Routes>
        <nav className="tabbar">
          <NavLink to="/livreur" end><span className="ico">🗺️</span>Course{(tracker.state?.offer || tracker.state?.order) && <span className="dot">1</span>}</NavLink>
          <NavLink to="/livreur/gains"><span className="ico">💶</span>Gains</NavLink>
          <NavLink to="/livreur/historique"><span className="ico">📜</span>Historique</NavLink>
          <NavLink to="/livreur/compte"><span className="ico">👤</span>Compte</NavLink>
        </nav>
      </div>
    </TrackerCtx.Provider>
  );
}

// ── Écran principal : carte, disponibilité, proposition, course ────────
function Ride() {
  const { user, api, reloadUser, toast } = useSession();
  const { pos, mode, setMode, state, reloadState, route, remaining, gpsError } = useContext(TrackerCtx);
  const [consent, setConsent] = useState(false);
  const c = user.courier, order = state?.order, offer = state?.offer;
  const v = VEHICLES[c.vehicle];

  async function setAvailable(on: boolean) {
    if (on && !user.geo_consent_at) return setConsent(true);
    try { await api('PATCH', '/courier/me', { available: on }); await reloadUser(); toast(on ? 'Vous êtes disponible. En attente de courses…' : 'Vous êtes indisponible.', on ? 'success' : 'info'); }
    catch (e: any) { toast(e.message, 'error'); }
  }
  const phaseDrop = order && ['picked_up', 'delivering'].includes(order.status);
  const markers: MapMarker[] = [
    ...(pos ? [{ id: 'me', kind: 'courier' as const, emoji: v.emoji, ...pos, label: 'Vous' }] : []),
    ...(order ? [{ id: 'm', kind: 'shop' as const, emoji: order.merchant.emoji, lat: order.merchant.lat, lng: order.merchant.lng, label: order.merchant.name },
      { id: 'd', kind: 'client' as const, emoji: '🏠', lat: order.dropoff.lat, lng: order.dropoff.lng, label: order.dropoff.exact ? 'Client' : 'Zone de livraison (approximative)' }] : []),
    ...(offer ? [{ id: 'om', kind: 'shop' as const, emoji: offer.merchant.emoji, lat: offer.merchant.lat, lng: offer.merchant.lng, label: offer.merchant.name },
      { id: 'od', kind: 'client' as const, emoji: '🏠', lat: offer.dropoff_approx.lat, lng: offer.dropoff_approx.lng, label: 'Zone de livraison' }] : []),
  ];
  return (
    <>
      <div style={{ position: 'relative', height: order ? '42vh' : '52vh', minHeight: 260 }}>
        <MapView className="full" markers={markers} route={route?.geometry} fitKey={`${order?.id || ''}${order ? phaseDrop : ''}${offer?.id || ''}${!!pos}${route?.geometry.length || 0}`} follow={order ? null : pos} />
        <div className="card row" style={{ position: 'absolute', top: 12, left: 12, right: 12, zIndex: 400, padding: '10px 14px' }}>
          <div className="grow">
            <div className="bold">{c.available ? '🟢 Disponible' : '⚪ Indisponible'}</div>
            <div className="small muted">{v.emoji} {v.label} · {mode === 'sim' ? 'GPS simulé (démo)' : 'GPS réel'}</div>
          </div>
          <Switch on={c.available} onChange={setAvailable} label="Disponible" />
        </div>
      </div>
      <div className="page" style={{ marginTop: -22, background: 'var(--bg)', borderRadius: '24px 24px 0 0', zIndex: 450, position: 'relative' }}>
        {gpsError && <div className="badge red" style={{ whiteSpace: 'normal', padding: '8px 12px' }} role="alert">{gpsError}</div>}
        {c.status !== 'verified' && <div className="card" style={{ background: 'var(--orange-soft)' }}>⏳ {c.status === 'pending' ? 'Votre compte est en cours de vérification par notre équipe. Vous pourrez vous rendre disponible dès sa validation.' : 'Votre compte est suspendu. Contactez l\'assistance.'}</div>}
        {!order && (
          <div className="card col center">
            {c.available ? <><div style={{ fontSize: 40 }} className="rise">📡</div><h2>En attente de courses…</h2><p className="muted small">Restez à proximité des établissements. Une proposition s'affichera ici avec une alerte sonore.</p></>
              : <><div style={{ fontSize: 40 }}>😴</div><h2>Vous êtes hors service</h2><p className="muted small">Activez le statut « Disponible » pour recevoir des propositions de livraison.</p><button className="btn btn-orange btn-lg btn-block" onClick={() => setAvailable(true)} disabled={c.status !== 'verified'}>Me rendre disponible</button></>}
          </div>
        )}
        {order && <ActiveRide order={order} remaining={remaining} route={route} onChange={reloadState} />}
        <div className="card col" style={{ gap: 8 }}>
          <div className="row between"><h3>Source de position</h3><span className="badge">{pos ? `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}` : 'inactive'}</span></div>
          <div className="row"><button className={`chip grow ${mode === 'real' ? 'on' : ''}`} onClick={() => setMode('real')}>📡 GPS réel</button><button className={`chip grow ${mode === 'sim' ? 'on' : ''}`} onClick={() => setMode('sim')}>🎮 Simulation</button></div>
          <p className="small muted">{mode === 'sim' ? 'Démonstration : votre position est simulée dans Grenoble et avance automatiquement le long de l\'itinéraire (vitesse ×3).' : 'Votre position réelle est utilisée et partagée uniquement lorsque vous êtes disponible ou en course.'}</p>
        </div>
      </div>
      {offer && !order && <OfferModal offer={offer} onDone={reloadState} />}
      {consent && (
        <Modal title="Autoriser la géolocalisation" onClose={() => setConsent(false)}>
          <p>Pour vous proposer des courses proches et permettre au client de suivre sa livraison, GreLiv a besoin de votre position.</p>
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Position collectée <b>uniquement</b> lorsque vous êtes « Disponible » ou en course.</li>
            <li>Partagée avec le client et l'établissement pendant la livraison seulement.</li>
            <li>Seule la dernière position est conservée ; elle est effacée quand vous passez hors service.</li>
            <li>Vous pouvez retirer votre consentement à tout moment dans « Compte ».</li>
          </ul>
          <ActionButton className="btn btn-primary btn-lg" onAction={async () => { await api('PATCH', '/me', { geo_consent: true }); await api('PATCH', '/courier/me', { available: true }); await reloadUser(); setConsent(false); toast('Vous êtes disponible.', 'success'); }}>J'accepte et je me rends disponible</ActionButton>
          <button className="btn btn-ghost" onClick={() => setConsent(false)}>Refuser</button>
        </Modal>
      )}
    </>
  );
}

function OfferModal({ offer, onDone }: { offer: any; onDone: () => void }) {
  const { api, toast } = useSession();
  const total = useRef(Math.max(1, (new Date(offer.expires_at).getTime() - Date.now()) / 1000));
  const [left, setLeft] = useState(total.current);
  useEffect(() => {
    const t = setInterval(() => { const s = (new Date(offer.expires_at).getTime() - Date.now()) / 1000; setLeft(s); if (s <= 0) { clearInterval(t); onDone(); } }, 250);
    return () => clearInterval(t);
  }, [offer.id]); // eslint-disable-line
  const answer = (a: 'accept' | 'refuse') => async () => {
    try { await api('POST', `/courier/offers/${offer.id}/${a}`); toast(a === 'accept' ? 'Course acceptée — direction l\'établissement !' : 'Course refusée.', a === 'accept' ? 'success' : 'info'); }
    finally { onDone(); }
  };
  return (
    <div className="backdrop">
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="row between"><h2>Nouvelle course 🔔</h2><span className="badge orange num">{Math.max(0, Math.ceil(left))} s</span></div>
        <div className="progress"><i style={{ width: `${Math.max(0, (left / total.current) * 100)}%` }} /></div>
        <div className="center"><div style={{ fontSize: 44, fontWeight: 800, color: 'var(--orange)' }} className="num">{eur(offer.pay_cents)}</div><div className="muted small">Rémunération pour cette livraison</div></div>
        <div className="card col" style={{ boxShadow: 'none', background: 'var(--bg)', gap: 8 }}>
          <div className="row"><span style={{ fontSize: 24 }}>{offer.merchant.emoji}</span><div className="grow"><div className="bold">{offer.merchant.name}</div><div className="small muted">Retrait à {km(offer.pickup_distance_m)} · ~{offer.eta_pickup_min} min</div></div></div>
          <div className="row"><span style={{ fontSize: 24 }}>🏠</span><div className="grow"><div className="bold">Secteur : {offer.dropoff_approx.label}</div><div className="small muted">Livraison de {km(offer.delivery_distance_m)} · destination approximative</div></div></div>
          <div className="divider" />
          <div className="row between small"><span>Distance totale estimée</span><b>{km(offer.total_distance_m)} · ~{offer.total_minutes} min</b></div>
          <div className="row between small"><span>Contenu</span><b>{offer.items_count} article(s)</b></div>
        </div>
        <div className="row"><ActionButton className="btn btn-ghost btn-lg" onAction={answer('refuse')}>Refuser</ActionButton><ActionButton className="btn btn-orange btn-lg grow" onAction={answer('accept')}>Accepter la course</ActionButton></div>
      </div>
    </div>
  );
}

function ActiveRide({ order, remaining, route, onChange }: { order: any; remaining: Tracker['remaining']; route: RouteData | null; onChange: () => void }) {
  const { api, toast, user } = useSession();
  const [code, setCode] = useState('');
  const [chat, setChat] = useState(false);
  const [help, setHelp] = useState(false);
  const drop = ['picked_up', 'delivering'].includes(order.status);
  const target = drop ? order.dropoff : order.merchant;
  const arrived = remaining && remaining.m < 60;
  const travel = ['bike', 'ebike'].includes(user.courier.vehicle) ? 'bicycling' : 'driving';
  async function proof(e: any) {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const { url } = await api('POST', '/uploads', { dataUrl: await fileToDataUrl(file) });
      await api('POST', `/courier/orders/${order.id}/deliver`, { proofUrl: url });
      toast(`Livraison validée — ${eur(order.courier_pay_cents)} gagnés !`, 'success'); onChange();
    } catch (err: any) { toast(err.message, 'error'); }
  }
  return (
    <>
      <div className="card col rise" style={{ background: 'var(--night)', color: '#fff', gap: 8 }}>
        <div className="row between"><span className="badge orange">Étape {drop ? '2/2 · Livraison' : '1/2 · Retrait'}</span><span className="small" style={{ opacity: .8 }}>#{order.number} · {eur(order.courier_pay_cents)}</span></div>
        <h2>{drop ? `Livrer ${order.client.name}` : `Récupérer chez ${order.merchant.name}`}</h2>
        <p style={{ opacity: .85 }}>📍 {drop ? order.dropoff.address : order.merchant.address}{drop && order.dropoff.details && <><br />🚪 {order.dropoff.details}</>}</p>
        <div className="row" style={{ gap: 18 }}>
          <div><div className="small" style={{ opacity: .7 }}>Distance</div><b className="num" style={{ fontSize: 20 }}>{remaining ? km(remaining.m) : '…'}</b></div>
          <div><div className="small" style={{ opacity: .7 }}>Temps estimé</div><b className="num" style={{ fontSize: 20 }}>{remaining ? `${Math.max(1, Math.round(remaining.s / 60))} min` : '…'}</b></div>
          <div><div className="small" style={{ opacity: .7 }}>Parcourus</div><b className="num" style={{ fontSize: 20 }}>{(order.courier_km || 0).toFixed(1).replace('.', ',')} km</b></div>
        </div>
        {arrived && <div className="badge green" style={{ alignSelf: 'flex-start' }}>Vous êtes arrivé ✓</div>}
      </div>
      {route && route.steps.length > 0 && !arrived && (
        <div className="card col" style={{ gap: 6 }}>
          <div className="row between"><h3>Navigation</h3><a className="btn btn-sm" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${target.lat},${target.lng}&travelmode=${travel}`}>Ouvrir dans Maps ↗</a></div>
          {route.steps.slice(0, 3).map((s, i) => <div key={i} className={`row small ${i === 0 ? 'bold' : 'muted'}`}><span>{i === 0 ? '➡️' : '·'}</span><span className="grow">{s.instruction}</span><span className="num">{km(s.distance_m)}</span></div>)}
          {route.source === 'estimation' && <p className="small muted">Trajet estimé à vol d'oiseau (service d'itinéraires injoignable).</p>}
        </div>
      )}
      {!drop ? (
        <div className="card col">
          <div className="row between"><h3>Commande à récupérer</h3>{order.ready_at ? <span className="badge green">Prête ✓</span> : <span className="badge orange">En préparation</span>}</div>
          {order.items.map((i: any) => <div key={i.id} className="small"><b>{i.quantity} ×</b> {i.name}</div>)}
          <ActionButton className="btn btn-orange btn-lg btn-block" disabled={!order.ready_at} onAction={async () => { await api('POST', `/courier/orders/${order.id}/pickup`); toast('Commande récupérée — direction le client !', 'success'); onChange(); }}>{order.ready_at ? 'J\'ai récupéré la commande' : 'En attente de l\'établissement…'}</ActionButton>
          {order.merchant.phone && <a className="btn btn-sm btn-ghost" href={`tel:${order.merchant.phone.replace(/\s/g, '')}`}>📞 Appeler l'établissement</a>}
        </div>
      ) : (
        <div className="card col">
          <h3>Remise au client</h3>
          {order.instructions && <div className="badge orange" style={{ whiteSpace: 'normal', padding: '6px 10px' }}>📝 {order.instructions}</div>}
          <label className="field">Code de livraison communiqué par le client
            <input className="input code center" inputMode="numeric" maxLength={4} placeholder="••••" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
          <ActionButton className="btn btn-orange btn-lg btn-block" disabled={code.length !== 4} onAction={async () => { await api('POST', `/courier/orders/${order.id}/deliver`, { code }); toast(`Livraison validée — ${eur(order.courier_pay_cents)} gagnés !`, 'success'); onChange(); }}>Valider la livraison</ActionButton>
          <label className="btn btn-ghost btn-block" style={{ cursor: 'pointer' }}>📷 Client absent ? Photo de preuve de remise<input type="file" accept="image/*" capture="environment" hidden onChange={proof} /></label>
          <div className="row"><button className="btn btn-sm grow" onClick={() => setChat(true)}>💬 Écrire au client</button>{order.client.phone && <a className="btn btn-sm grow" href={`tel:${order.client.phone.replace(/\s/g, '')}`}>📞 Appeler</a>}</div>
        </div>
      )}
      <button className="btn btn-ghost" onClick={() => setHelp(true)}>🆘 Un problème pendant la course ?</button>
      {chat && <Modal title={`Client — ${order.client.name}`} onClose={() => setChat(false)}><Chat orderId={order.id} thread="courier" /></Modal>}
      {help && <ClaimModal orderId={order.id} onClose={() => setHelp(false)} categories={COURIER_ISSUES} />}
    </>
  );
}
const COURIER_ISSUES = ['Établissement fermé ou commande introuvable', 'Client injoignable', 'Accident ou panne', 'Adresse incorrecte', 'Problème de rémunération', 'Autre'];

// ── Gains ──────────────────────────────────────────────────────────────
function Earnings() {
  const { data: s } = useLive<any>('/courier/stats', ['order']);
  if (!s) return <div className="spinner" />;
  const block = (label: string, d: any) => <Tile label={label} value={eur(d.earnings_cents)} sub={`${d.deliveries} course(s) · ${String(d.km).replace('.', ',')} km`} />;
  return (
    <div className="page">
      <h1>Mes gains</h1>
      <div className="tiles" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {block('Aujourd\'hui', s.day)}{block('Cette semaine', s.week)}{block('Ce mois-ci', s.month)}
        <Tile label="Moyenne par course" value={s.total.deliveries ? eur(Math.round(s.total.earnings_cents / s.total.deliveries)) : '—'} sub={`${s.total.deliveries} course(s) au total`} />
      </div>
      <div className="card col"><h3>Gains des 7 derniers jours</h3>
        <BarChart label="Gains par jour" data={s.series.map((d: any) => ({ label: dayLabel(d.day), value: d.earnings_cents }))} format={eur} /></div>
      <p className="small muted center">Rémunération = forfait + distance de livraison + distance d'approche. Versée après chaque livraison validée.</p>
    </div>
  );
}

function History() {
  const { data } = useLive<any[]>('/orders?scope=history', ['order']);
  return (
    <div className="page">
      <h1>Historique des courses</h1>
      {!data && <div className="spinner" />}
      {data?.length === 0 && <Empty emoji="📜">Aucune course terminée pour le moment.</Empty>}
      {data?.map((o) => (
        <div key={o.id} className="card row">
          <div className="emoji-tile" style={{ width: 48, height: 48, fontSize: 22 }}>{o.merchant.emoji}</div>
          <div className="grow"><div className="bold ellipsis">{o.merchant.name}</div><div className="small muted">#{o.number} · {dateFr(o.delivered_at || o.created_at)} · {(o.courier_km || 0).toFixed(1).replace('.', ',')} km</div><StatusBadge status={o.status} /></div>
          <div className="bold num" style={{ color: o.status === 'delivered' ? 'var(--green)' : 'var(--muted)' }}>{o.status === 'delivered' ? `+ ${eur(o.courier_pay_cents)}` : '—'}</div>
        </div>
      ))}
    </div>
  );
}

function Account() {
  const { user, api, logout, reloadUser, toast } = useSession();
  const { state } = useContext(TrackerCtx);
  const [help, setHelp] = useState(false);
  const { data: tickets } = useLive<any[]>('/tickets', ['notification']);
  const c = user.courier;
  return (
    <div className="page">
      <h1>Mon compte</h1>
      <div className="card col">
        <div className="row"><div className="emoji-tile" style={{ width: 56, height: 56 }}>{VEHICLES[c.vehicle].emoji}</div><div className="grow"><div className="bold">{user.name}</div><div className="small muted">{user.email}</div>
          <div className="row" style={{ marginTop: 4 }}><span className={`badge ${c.status === 'verified' ? 'green' : 'orange'}`}>{c.status === 'verified' ? 'Compte vérifié' : c.status === 'pending' ? 'Vérification en cours' : 'Suspendu'}</span>{c.rating && <span className="badge">⭐ {String(c.rating).replace('.', ',')}</span>}</div></div></div>
        <label className="field">Moyen de transport (adapte les itinéraires et les courses proposées)
          <select className="input" value={c.vehicle} disabled={!!state?.order} onChange={async (e) => { try { await api('PATCH', '/courier/me', { vehicle: e.target.value }); await reloadUser(); toast('Véhicule mis à jour.', 'success'); } catch (err: any) { toast(err.message, 'error'); } }}>
            {Object.entries(VEHICLES).map(([k, v]) => <option key={k} value={k}>{v.emoji} {v.label}</option>)}
          </select></label>
        <p className="small muted">Distance totale parcourue : <b>{Number(c.total_km).toFixed(1).replace('.', ',')} km</b></p>
      </div>
      <div className="card col">
        <h3>Paiements</h3>
        <p className="small">{c.payouts_ready ? '✅ Compte de versement Stripe relié.' : 'Compte de versement non relié.'}</p>
        <ActionButton className="btn" onAction={async () => { const r = await api('POST', '/connect/onboard'); if (r.url) location.href = r.url; else toast(r.message); }}>Configurer mes versements (Stripe Connect)</ActionButton>
      </div>
      <div className="card col">
        <h3>Assistance</h3>
        <button className="btn btn-primary" onClick={() => setHelp(true)}>🆘 Signaler un problème</button>
        {tickets?.map((t) => <div key={t.id}><div className="row between"><span className="bold small">{t.category}</span><span className={`badge ${t.status === 'open' ? 'orange' : 'green'}`}>{t.status === 'open' ? 'En cours' : 'Traitée'}</span></div><div className="small muted">{t.resolution || t.message}</div></div>)}
      </div>
      <div className="card col">
        <h3>Géolocalisation</h3>
        <p className="small muted">{user.geo_consent_at ? `Consentement donné le ${dateFr(user.geo_consent_at)}.` : 'Vous n\'avez pas encore autorisé la géolocalisation.'}</p>
        {user.geo_consent_at && <ActionButton className="btn btn-sm btn-danger" disabled={!!state?.order} onAction={async () => { await api('PATCH', '/me', { geo_consent: false }); await reloadUser(); toast('Consentement retiré. Vous êtes hors service.'); }}>Retirer mon consentement</ActionButton>}
      </div>
      <PrivacyCard />
      <button className="btn btn-ghost" onClick={logout}>Se déconnecter</button>
      {help && <ClaimModal onClose={() => setHelp(false)} categories={COURIER_ISSUES} />}
    </div>
  );
}
