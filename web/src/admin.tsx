import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { Space, useSession, useLive, useEvent } from './session';
import { eur, km, dateFr, pct, VEHICLES, STATUS, FLOW_LABEL, PAY_METHODS, hhmm } from './lib';
import { Modal, MapView, StatusBadge, Empty, Tile, ActionButton, BarChart, dayLabel, AddressPicker, Chat, type MapMarker } from './ui';

export default function AdminApp() {
  return <Space role="admin"><Shell /></Space>;
}

function Shell() {
  const { logout } = useSession();
  const { data: o } = useLive<any>('/admin/overview');
  const n = (v?: number) => (v ? <span className="badge orange" style={{ marginLeft: 'auto' }}>{v}</span> : null);
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand" style={{ marginBottom: 18 }}><img src="/icon.svg" alt="" /> GreLiv Admin</div>
        <NavLink to="/admin" end>📊 Tableau de bord</NavLink>
        <NavLink to="/admin/commandes">🧾 Commandes {n(o?.live.active_orders)}</NavLink>
        <NavLink to="/admin/carte">🗺️ Carte en direct</NavLink>
        <NavLink to="/admin/etablissements">🏪 Établissements {n(o?.live.pending_merchants)}</NavLink>
        <NavLink to="/admin/livreurs">🚲 Livreurs {n(o?.live.pending_couriers)}</NavLink>
        <NavLink to="/admin/utilisateurs">👥 Utilisateurs</NavLink>
        <NavLink to="/admin/reclamations">🆘 Réclamations {n(o?.live.open_tickets)}</NavLink>
        <NavLink to="/admin/transactions">💳 Transactions</NavLink>
        <NavLink to="/admin/parametres">⚙️ Paramètres</NavLink>
        <div className="side-foot" style={{ marginTop: 'auto' }}><button className="btn btn-sm btn-ghost btn-block" style={{ color: '#fff', borderColor: 'rgba(255,255,255,.25)' }} onClick={logout}>Se déconnecter</button></div>
      </aside>
      <main className="main">
        <Routes>
          <Route index element={<Dashboard o={o} />} />
          <Route path="commandes" element={<Orders />} />
          <Route path="carte" element={<LiveMap />} />
          <Route path="etablissements" element={<Merchants />} />
          <Route path="livreurs" element={<Couriers />} />
          <Route path="utilisateurs" element={<Users />} />
          <Route path="reclamations" element={<Tickets />} />
          <Route path="transactions" element={<Transactions />} />
          <Route path="parametres" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

function Dashboard({ o }: { o: any }) {
  const [metric, setMetric] = useState<'gmv_cents' | 'platform_cents' | 'orders'>('gmv_cents');
  if (!o) return <div className="spinner" />;
  const titles = { gmv_cents: 'Volume d\'affaires par jour', platform_cents: 'Revenu plateforme par jour', orders: 'Commandes livrées par jour' };
  return (
    <>
      <h1>Tableau de bord</h1>
      <div className="tiles">
        <Tile label="Commandes en cours" value={o.live.active_orders} sub={`${o.live.couriers_online} livreur(s) en service`} />
        <Tile label="Commandes aujourd'hui" value={o.today.orders} sub={`${o.today.delivered} livrée(s) · ${o.today.cancelled} annulée(s)`} />
        <Tile label="Volume d'affaires du jour" value={eur(o.today.gmv_cents)} sub={`Revenu plateforme : ${eur(o.today.platform_cents)}`} />
        <Tile label="Volume d'affaires · 30 jours" value={eur(o.month.gmv_cents)} sub={`${o.month.delivered} commandes livrées`} />
        <Tile label="Revenu plateforme · 30 jours" value={eur(o.month.platform_cents)} sub="Commissions + livraison − livreurs" />
        <Tile label="Remboursements · 30 jours" value={eur(o.month.refunded_cents)} sub={`${o.month.cancelled} annulation(s)`} />
      </div>
      <div className="grid2">
        <div className="card col">
          <div className="row between wrap"><h3>{titles[metric]} · 14 jours</h3>
            <div className="row wrap">{([['gmv_cents', 'Volume'], ['platform_cents', 'Revenu'], ['orders', 'Commandes']] as const).map(([k, l]) => <button key={k} className={`chip ${metric === k ? 'on' : ''}`} onClick={() => setMetric(k)}>{l}</button>)}</div></div>
          <BarChart label={titles[metric]} data={o.series.map((d: any) => ({ label: dayLabel(d.day), value: d[metric] }))} format={metric === 'orders' ? (n) => `${n} cmd` : eur} />
        </div>
        <div className="col">
          <div className="card col" style={{ gap: 8 }}><h3>Fonctionnement · 30 jours</h3>
            <div className="row between"><span>Durée moyenne commande → livraison</span><b>{o.perf.avg_delivery_min ?? '—'} min</b></div>
            <div className="row between"><span>Distance moyenne de livraison</span><b>{o.perf.avg_km != null ? `${String(o.perf.avg_km).replace('.', ',')} km` : '—'}</b></div>
            <div className="row between"><span>Note moyenne des établissements</span><b>⭐ {o.perf.avg_merchant_rating ?? '—'}</b></div>
            <div className="row between"><span>Note moyenne des livreurs</span><b>⭐ {o.perf.avg_courier_rating ?? '—'}</b></div>
            <div className="row between"><span>Clients actifs · établissements</span><b>{o.live.clients} · {o.live.merchants}</b></div>
          </div>
          <div className="card col" style={{ gap: 8 }}><h3>Meilleurs établissements · 30 jours</h3>
            {o.top.map((t: any) => <div key={t.name} className="row between"><span>{t.name}</span><span className="num"><b>{t.orders}</b> cmd · {eur(t.revenue_cents)}</span></div>)}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Commandes ──────────────────────────────────────────────────────────
function Orders() {
  const { data: orders, reload } = useLive<any[]>('/orders', ['order', 'order.new']);
  const [filter, setFilter] = useState<'active' | 'all' | 'delivered' | 'cancelled'>('active');
  const [open, setOpen] = useState<string | null>(null);
  if (!orders) return <div className="spinner" />;
  const list = orders.filter((o) => filter === 'all' || (filter === 'active' ? !['delivered', 'cancelled'].includes(o.status) : o.status === filter));
  return (
    <>
      <div className="row between wrap"><h1>Commandes</h1>
        <div className="row wrap">{([['active', 'En cours'], ['all', 'Toutes'], ['delivered', 'Livrées'], ['cancelled', 'Annulées']] as const).map(([k, l]) => <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}</div></div>
      <div className="card table-wrap">
        {list.length === 0 ? <Empty emoji="🧾">Aucune commande {filter === 'active' ? 'en cours' : ''}.</Empty> : (
          <table className="table">
            <thead><tr><th>N°</th><th>Heure</th><th>Client</th><th>Établissement</th><th>Livreur</th><th>Statut</th><th>Total</th><th /></tr></thead>
            <tbody>{list.map((o) => (
              <tr key={o.id}><td className="bold">#{o.number}</td><td className="small">{dateFr(o.created_at)}</td><td>{o.client.name}</td><td>{o.merchant.emoji} {o.merchant.name}</td>
                <td>{o.courier ? `${VEHICLES[o.courier.vehicle].emoji} ${o.courier.name}` : <span className="muted">—</span>}</td><td><StatusBadge status={o.status} /></td><td className="num bold">{eur(o.total_cents)}</td>
                <td><button className="btn btn-sm" onClick={() => setOpen(o.id)}>Détail</button></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {open && <OrderDetail id={open} onClose={() => setOpen(null)} onChange={reload} />}
    </>
  );
}

function OrderDetail({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { api, toast } = useSession();
  const { data: o, reload } = useLive<any>(`/orders/${id}`, ['order']);
  const [amount, setAmount] = useState('');
  if (!o) return <Modal title="Commande" onClose={onClose}><div className="spinner" /></Modal>;
  const refundable = o.total_cents - o.refunded_cents;
  const live = !['delivered', 'cancelled'].includes(o.status);
  return (
    <Modal wide title={`Commande #${o.number}`} onClose={onClose}>
      <div className="row wrap"><StatusBadge status={o.status} /><span className="badge">{PAY_METHODS[o.payment_method]} · {o.payment_provider === 'mock' ? 'simulé' : 'Stripe'}</span>
        <span className={`badge ${o.payment_status === 'paid' ? 'green' : o.payment_status.includes('refund') ? 'red' : ''}`}>{({ paid: 'Payée', refunded: 'Remboursée', partially_refunded: 'Remboursée partiellement', pending: 'Paiement en attente', failed: 'Paiement échoué' } as any)[o.payment_status]}</span></div>
      <div className="small">
        <p>👤 <b>{o.client.name}</b> {o.client.phone && `· ${o.client.phone}`} — {o.dropoff.address} {o.dropoff.details && `(${o.dropoff.details})`}</p>
        <p>🏪 <b>{o.merchant.name}</b> — {o.merchant.address}</p>
        <p>🚲 {o.courier ? <><b>{o.courier.name}</b> · {VEHICLES[o.courier.vehicle].label} · {Number(o.courier_km).toFixed(1)} km parcourus</> : 'Aucun livreur attribué'}</p>
        {o.cancel_reason && <p>❌ {o.cancel_reason}</p>}
        {o.proof_url && <p>📷 <a href={o.proof_url} target="_blank" rel="noreferrer">Preuve de remise</a></p>}
      </div>
      <div className="card col" style={{ boxShadow: 'none', background: 'var(--bg)', gap: 4 }}>
        {o.items.map((i: any) => <div key={i.id} className="row between small"><span>{i.quantity} × {i.name} {i.options.length > 0 && <span className="muted">({i.options.map((x: any) => x.choice).join(', ')})</span>}</span><span className="num">{eur(i.unit_price_cents * i.quantity)}</span></div>)}
        <div className="divider" />
        <div className="row between small"><span>Articles / Livraison ({km(o.distance_m)})</span><span className="num">{eur(o.subtotal_cents)} / {eur(o.delivery_fee_cents)}</span></div>
        <div className="row between small"><span>Commission · Rémunération livreur</span><span className="num">{eur(o.commission_cents)} · {eur(o.courier_pay_cents)}</span></div>
        <div className="row between bold"><span>Total client{o.refunded_cents > 0 && ` (remboursé : ${eur(o.refunded_cents)})`}</span><span className="num">{eur(o.total_cents)}</span></div>
      </div>
      <div className="small muted">{o.events.map((e: any) => `${hhmm(e.at)} ${e.status === 'ready' ? 'Prête' : FLOW_LABEL[e.status] || STATUS[e.status]?.label || e.status}`).join('  →  ')}</div>
      <details><summary className="bold small" style={{ cursor: 'pointer' }}>Messages échangés</summary><div className="grid2" style={{ marginTop: 8 }}><div><p className="small bold">Client ↔ établissement</p><Chat orderId={o.id} thread="merchant" readOnly /></div><div><p className="small bold">Client ↔ livreur</p><Chat orderId={o.id} thread="courier" readOnly /></div></div></details>
      {refundable > 0 && ['paid', 'partially_refunded'].includes(o.payment_status) && (
        <div className="row wrap">
          <input className="input num" style={{ width: 150 }} inputMode="decimal" placeholder={`Max ${(refundable / 100).toFixed(2)} €`} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Montant à rembourser" />
          <ActionButton className="btn" onAction={async () => { const c = Math.round(parseFloat(amount.replace(',', '.')) * 100); if (!(c > 0)) throw new Error('Montant invalide.'); await api('POST', `/admin/orders/${o.id}/refund`, { amountCents: c }); toast('Remboursement effectué.', 'success'); setAmount(''); reload(); onChange(); }}>Rembourser ce montant</ActionButton>
          {live && <ActionButton className="btn btn-danger" onAction={async () => { const reason = prompt('Motif de l\'annulation (communiqué au client) :'); if (!reason) return; await api('POST', `/admin/orders/${o.id}/cancel`, { reason }); toast('Commande annulée et remboursée.', 'success'); reload(); onChange(); }}>Annuler et rembourser</ActionButton>}
        </div>
      )}
    </Modal>
  );
}

// ── Carte en direct ────────────────────────────────────────────────────
function LiveMap() {
  const { data, reload } = useLive<any>('/admin/live', ['order', 'order.new', 'admin.refresh']);
  const [moved, setMoved] = useState<Record<string, { lat: number; lng: number }>>({});
  useEvent((e) => { if (e.type === 'position') setMoved((m) => ({ ...m, [e.courierId]: { lat: e.lat, lng: e.lng } })); });
  useEffect(() => { const t = setInterval(reload, 10_000); return () => clearInterval(t); }, [reload]);
  if (!data) return <div className="spinner" />;
  const markers: MapMarker[] = [
    ...data.merchants.map((m: any) => ({ id: m.id, kind: 'shop' as const, emoji: m.emoji, lat: m.lat, lng: m.lng, label: `${m.name}${m.is_online ? '' : ' (hors ligne)'}` })),
    ...data.orders.map((o: any) => ({ id: o.id, kind: 'client' as const, emoji: '🏠', lat: o.lat, lng: o.lng, label: `#${o.number} · ${STATUS[o.status].label}` })),
    ...data.couriers.map((c: any) => ({ id: c.id, kind: 'courier' as const, emoji: VEHICLES[c.vehicle].emoji, ...(moved[c.id] || { lat: c.lat, lng: c.lng }), label: `${c.name}${c.order_number ? ` · commande #${c.order_number}` : ' · disponible'}` })),
  ];
  return (
    <>
      <div className="row between wrap"><h1>Carte en direct · Grenoble</h1>
        <div className="row wrap"><span className="badge blue">🏪 {data.merchants.length} établissements</span><span className="badge orange">🚲 {data.couriers.length} livreurs en service</span><span className="badge night">🏠 {data.orders.length} commandes en cours</span></div></div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}><div style={{ height: '62vh', minHeight: 380 }}><MapView className="full" markers={markers} fitKey={`${data.merchants.length}`} zoom={13} /></div></div>
      <div className="card table-wrap">
        {data.orders.length === 0 ? <p className="muted center">Aucune livraison en cours.</p> : (
          <table className="table"><thead><tr><th>Commande</th><th>Établissement</th><th>Statut</th><th>Livreur</th></tr></thead>
            <tbody>{data.orders.map((o: any) => { const c = data.couriers.find((x: any) => x.id === o.courier_id); return <tr key={o.id}><td className="bold">#{o.number}</td><td>{o.merchant_name}</td><td><StatusBadge status={o.status} /></td><td>{c ? `${VEHICLES[c.vehicle].emoji} ${c.name}` : <span className="muted">Recherche en cours…</span>}</td></tr>; })}</tbody></table>
        )}
      </div>
    </>
  );
}

// ── Établissements ─────────────────────────────────────────────────────
const M_STATUS: any = { pending: ['En attente', 'orange'], approved: ['Validé', 'green'], suspended: ['Suspendu', 'red'], verified: ['Vérifié', 'green'], active: ['Actif', 'green'] };
const Pill = ({ s }: { s: string }) => <span className={`badge ${M_STATUS[s][1]}`}>{M_STATUS[s][0]}</span>;

function Merchants() {
  const { api, toast } = useSession();
  const { data, reload } = useLive<any[]>('/admin/merchants', ['admin.refresh']);
  const [create, setCreate] = useState(false);
  if (!data) return <div className="spinner" />;
  const patch = (id: string, body: any, ok: string) => async () => { await api('PATCH', `/admin/merchants/${id}`, body); toast(ok, 'success'); reload(); };
  return (
    <>
      <div className="row between wrap"><h1>Établissements partenaires</h1><button className="btn btn-primary" onClick={() => setCreate(true)}>+ Ajouter un établissement</button></div>
      <div className="card table-wrap"><table className="table">
        <thead><tr><th>Établissement</th><th>Gérant</th><th>Statut</th><th>Commandes</th><th>Note</th><th>Commission</th><th /></tr></thead>
        <tbody>{data.map((m) => (
          <tr key={m.id}><td><b>{m.name}</b> {m.is_demo && <span className="badge">Démo</span>}<div className="small muted">{m.category} · {m.address}</div></td>
            <td className="small">{m.owner_name}<div className="muted">{m.owner_email}</div></td><td><Pill s={m.status} /></td><td className="num">{m.orders}</td><td>{m.rating ? `⭐ ${m.rating}` : '—'}</td>
            <td><button className="btn btn-sm btn-ghost" onClick={async () => {
              const v = prompt(`Commission pour ${m.name} en % (vide = taux par défaut)`, m.commission_rate != null ? String(m.commission_rate * 100) : '');
              if (v === null) return;
              const rate = v.trim() === '' ? null : parseFloat(v.replace(',', '.')) / 100;
              if (rate !== null && !(rate >= 0 && rate <= 0.6)) return toast('Taux invalide (0 à 60 %).', 'error');
              try { await patch(m.id, { commission_rate: rate }, 'Commission mise à jour.')(); } catch (e: any) { toast(e.message, 'error'); }
            }}>{m.commission_rate != null ? pct(m.commission_rate) : 'Par défaut'} ✎</button></td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              {m.status !== 'approved' && <ActionButton className="btn btn-sm btn-primary" onAction={patch(m.id, { status: 'approved' }, `${m.name} validé.`)}>{m.status === 'pending' ? 'Valider' : 'Réactiver'}</ActionButton>}{' '}
              {m.status !== 'suspended' && <ActionButton className="btn btn-sm btn-danger" onAction={patch(m.id, { status: 'suspended' }, `${m.name} suspendu.`)}>{m.status === 'pending' ? 'Refuser' : 'Suspendre'}</ActionButton>}
            </td></tr>
        ))}</tbody>
      </table></div>
      {create && <CreateMerchant onClose={() => setCreate(false)} onDone={reload} />}
    </>
  );
}

function CreateMerchant({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { api, toast } = useSession();
  const [f, setF] = useState({ name: '', category: '', ownerName: '', ownerEmail: '', password: '' });
  const [addr, setAddr] = useState<any>(null);
  const set = (k: string) => (e: any) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Modal wide title="Nouvel établissement partenaire" onClose={onClose}>
      <div className="row wrap"><label className="field grow">Nom<input className="input" value={f.name} onChange={set('name')} /></label><label className="field grow">Catégorie<input className="input" value={f.category} onChange={set('category')} placeholder="Pizza, Épicerie…" /></label></div>
      <div className="field">Adresse<AddressPicker value={addr} onChange={setAddr} compact /></div>
      <div className="row wrap"><label className="field grow">Nom du gérant<input className="input" value={f.ownerName} onChange={set('ownerName')} /></label><label className="field grow">E-mail de connexion<input className="input" type="email" value={f.ownerEmail} onChange={set('ownerEmail')} /></label></div>
      <label className="field">Mot de passe provisoire (8 caractères min.)<input className="input" value={f.password} onChange={set('password')} /></label>
      <ActionButton className="btn btn-primary btn-lg" disabled={!addr || !f.name || !f.category || !f.ownerEmail || f.password.length < 8} onAction={async () => { await api('POST', '/admin/merchants', { ...f, address: addr.label, lat: addr.lat, lng: addr.lng }); toast('Établissement créé et validé.', 'success'); onDone(); onClose(); }}>Créer l'établissement</ActionButton>
    </Modal>
  );
}

function Couriers() {
  const { api, toast } = useSession();
  const { data, reload } = useLive<any[]>('/admin/couriers', ['admin.refresh']);
  if (!data) return <div className="spinner" />;
  const patch = (id: string, status: string, ok: string) => async () => { await api('PATCH', `/admin/couriers/${id}`, { status }); toast(ok, 'success'); reload(); };
  return (
    <>
      <h1>Livreurs</h1>
      <div className="card table-wrap"><table className="table">
        <thead><tr><th>Livreur</th><th>Véhicule</th><th>Compte</th><th>Service</th><th>Courses</th><th>Distance</th><th>Note</th><th /></tr></thead>
        <tbody>{data.map((c) => (
          <tr key={c.id}><td><b>{c.name}</b><div className="small muted">{c.email} {c.phone && `· ${c.phone}`}</div></td><td>{VEHICLES[c.vehicle].emoji} {VEHICLES[c.vehicle].label}</td><td><Pill s={c.status} /></td>
            <td>{c.available ? <span className="badge green">Disponible</span> : <span className="badge">Hors service</span>}</td><td className="num">{c.deliveries}</td><td className="num">{Number(c.total_km).toFixed(1)} km</td><td>{c.rating ? `⭐ ${c.rating}` : '—'}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              {c.status !== 'verified' && <ActionButton className="btn btn-sm btn-primary" onAction={patch(c.id, 'verified', `${c.name} vérifié.`)}>{c.status === 'pending' ? 'Vérifier le compte' : 'Réactiver'}</ActionButton>}{' '}
              {c.status !== 'suspended' && <ActionButton className="btn btn-sm btn-danger" onAction={patch(c.id, 'suspended', `${c.name} suspendu.`)}>{c.status === 'pending' ? 'Refuser' : 'Suspendre'}</ActionButton>}
            </td></tr>
        ))}</tbody>
      </table></div>
    </>
  );
}

function Users() {
  const { api, toast } = useSession();
  const [q, setQ] = useState('');
  const { data, reload } = useLive<any[]>(`/admin/users?q=${encodeURIComponent(q)}`, ['admin.refresh']);
  const ROLE: any = { client: '🛍️ Client', merchant: '🏪 Commerçant', courier: '🚲 Livreur', admin: '📊 Admin' };
  return (
    <>
      <div className="row between wrap"><h1>Utilisateurs</h1><input className="input" style={{ maxWidth: 280 }} placeholder="🔍 Nom ou e-mail" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="card table-wrap">{!data ? <div className="spinner" /> : (
        <table className="table">
          <thead><tr><th>Utilisateur</th><th>Rôle</th><th>Inscription</th><th>Commandes</th><th>Statut</th><th /></tr></thead>
          <tbody>{data.map((u) => (
            <tr key={u.id}><td><b>{u.name}</b><div className="small muted">{u.email} {u.phone && `· ${u.phone}`}</div></td><td>{ROLE[u.role]}</td><td className="small">{dateFr(u.created_at)}</td><td className="num">{u.role === 'client' ? u.orders : '—'}</td>
              <td><span className={`badge ${u.status === 'active' ? 'green' : 'red'}`}>{u.status === 'active' ? 'Actif' : 'Suspendu'}</span></td>
              <td style={{ textAlign: 'right' }}>{u.role !== 'admin' && <ActionButton className={`btn btn-sm ${u.status === 'active' ? 'btn-danger' : 'btn-primary'}`} onAction={async () => { await api('PATCH', `/admin/users/${u.id}`, { status: u.status === 'active' ? 'suspended' : 'active' }); toast('Statut mis à jour.', 'success'); reload(); }}>{u.status === 'active' ? 'Suspendre' : 'Réactiver'}</ActionButton>}</td></tr>
          ))}</tbody>
        </table>)}
      </div>
    </>
  );
}

function Tickets() {
  const { data, reload } = useLive<any[]>('/admin/tickets', ['admin.refresh']);
  const [open, setOpen] = useState<any>(null);
  const [order, setOrder] = useState<string | null>(null);
  const ROLE: any = { client: 'Client', merchant: 'Commerçant', courier: 'Livreur' };
  if (!data) return <div className="spinner" />;
  return (
    <>
      <h1>Réclamations et assistance</h1>
      {data.length === 0 && <Empty emoji="🎉">Aucune demande.</Empty>}
      {data.map((t) => (
        <div key={t.id} className="card col" style={{ gap: 8 }}>
          <div className="row between wrap"><div><b>{t.category}</b> <span className="badge">{ROLE[t.author_role]}</span> <span className="small muted">{t.author_name} · {dateFr(t.created_at)}</span></div>
            <span className={`badge ${t.status === 'open' ? 'orange' : 'green'}`}>{t.status === 'open' ? 'À traiter' : 'Traitée'}</span></div>
          <p>{t.message}</p>
          {t.resolution && <p className="small muted">↳ {t.resolution}{t.refund_cents > 0 && ` — remboursé ${eur(t.refund_cents)}`}</p>}
          <div className="row wrap">
            {t.order_id && <button className="btn btn-sm" onClick={() => setOrder(t.order_id)}>Voir la commande #{t.order_number}</button>}
            {t.status === 'open' && <button className="btn btn-sm btn-primary" onClick={() => setOpen(t)}>Traiter la demande</button>}
          </div>
        </div>
      ))}
      {open && <ResolveTicket t={open} onClose={() => setOpen(null)} onDone={reload} />}
      {order && <OrderDetail id={order} onClose={() => setOrder(null)} onChange={reload} />}
    </>
  );
}
function ResolveTicket({ t, onClose, onDone }: { t: any; onClose: () => void; onDone: () => void }) {
  const { api, toast } = useSession();
  const [resolution, setResolution] = useState(''); const [refund, setRefund] = useState('');
  const max = t.order_id && ['paid', 'partially_refunded'].includes(t.payment_status) ? t.total_cents - t.refunded_cents : 0;
  return (
    <Modal title="Traiter la demande" onClose={onClose}>
      <p className="muted">« {t.message} »</p>
      <label className="field">Réponse envoyée à l'utilisateur<textarea className="input" rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} /></label>
      {max > 0 && <label className="field">Remboursement (€) — facultatif, maximum {eur(max)}<input className="input num" inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="0,00" /></label>}
      <ActionButton className="btn btn-primary btn-lg" disabled={resolution.trim().length < 2} onAction={async () => {
        const cents = refund.trim() ? Math.round(parseFloat(refund.replace(',', '.')) * 100) : 0;
        if (!(cents >= 0) || cents > max) throw new Error('Montant de remboursement invalide.');
        await api('PATCH', `/admin/tickets/${t.id}`, { resolution, refundCents: cents }); toast('Demande traitée.', 'success'); onDone(); onClose();
      }}>Clôturer la demande</ActionButton>
    </Modal>
  );
}

function Transactions() {
  const { data } = useLive<any[]>('/admin/transactions', ['order']);
  const TYPE: any = { payment: ['Paiement client', 'green'], refund: ['Remboursement', 'red'], merchant_payout: ['Reversement commerçant', 'blue'], courier_payout: ['Rémunération livreur', 'orange'] };
  const ST: any = { succeeded: 'Réussi', simulated: 'Simulé', pending_onboarding: 'En attente (compte Stripe non relié)', failed: 'Échec' };
  if (!data) return <div className="spinner" />;
  return (
    <>
      <h1>Transactions</h1>
      <div className="card table-wrap"><table className="table">
        <thead><tr><th>Date</th><th>Type</th><th>Commande</th><th>Bénéficiaire</th><th>Prestataire</th><th>État</th><th style={{ textAlign: 'right' }}>Montant</th></tr></thead>
        <tbody>{data.map((t) => <tr key={t.id}><td className="small">{dateFr(t.created_at)}</td><td><span className={`badge ${TYPE[t.type][1]}`}>{TYPE[t.type][0]}</span></td><td>{t.order_number ? `#${t.order_number}` : '—'}</td><td>{t.beneficiary || '—'}</td>
          <td className="small">{t.provider === 'mock' ? 'Simulateur' : 'Stripe'}</td><td className="small">{ST[t.status] || t.status}</td><td className="num bold" style={{ textAlign: 'right' }}>{eur(t.amount_cents)}</td></tr>)}</tbody>
      </table></div>
    </>
  );
}

// ── Paramètres ─────────────────────────────────────────────────────────
function Settings() {
  const { api, toast } = useSession();
  const [s, setS] = useState<any>(null);
  useEffect(() => { api('GET', '/admin/settings').then(setS).catch((e) => toast(e.message, 'error')); }, []); // eslint-disable-line
  if (!s) return <div className="spinner" />;
  const euro = (group: string, key: string, label: string) => (
    <label className="field">{label}<input className="input num" inputMode="decimal" defaultValue={(s[group][key] / 100).toFixed(2)} onBlur={(e) => { const v = Math.round(parseFloat(e.target.value.replace(',', '.')) * 100); if (Number.isFinite(v)) setS((x: any) => ({ ...x, [group]: { ...x[group], [key]: v } })); }} /></label>);
  const num = (group: string, key: string, label: string, scale = 1) => (
    <label className="field">{label}<input className="input num" inputMode="decimal" defaultValue={Math.round(s[group][key] * scale * 100) / 100} onBlur={(e) => { const v = parseFloat(e.target.value.replace(',', '.')) / scale; if (Number.isFinite(v)) setS((x: any) => ({ ...x, [group]: { ...x[group], [key]: v } })); }} /></label>);
  const example = Math.min(s.delivery_fee.max_cents, Math.max(s.delivery_fee.min_cents, s.delivery_fee.base_cents + 2 * s.delivery_fee.per_km_cents));
  const examplePay = Math.max(s.courier_pay.min_cents, s.courier_pay.base_cents + 2 * s.courier_pay.per_km_cents + s.courier_pay.approach_per_km_cents);
  return (
    <>
      <div className="row between wrap"><h1>Paramètres de la plateforme</h1>
        <ActionButton className="btn btn-primary" onAction={async () => { setS(await api('PUT', '/admin/settings', s)); toast('Paramètres enregistrés. Ils s\'appliquent aux prochaines commandes.', 'success'); }}>Enregistrer</ActionButton></div>
      <div className="grid2">
        <div className="card col"><h3>Frais de livraison (payés par le client)</h3>
          <div className="row">{euro('delivery_fee', 'base_cents', 'Forfait de base (€)')}{euro('delivery_fee', 'per_km_cents', 'Par kilomètre (€)')}</div>
          <div className="row">{euro('delivery_fee', 'min_cents', 'Minimum (€)')}{euro('delivery_fee', 'max_cents', 'Maximum (€)')}</div>
          <p className="small muted">Exemple : une livraison à 2 km coûte <b>{eur(example)}</b> au client.</p></div>
        <div className="card col"><h3>Commission sur les établissements</h3>
          {num('commission', 'rate', 'Taux par défaut (%)', 100)}
          <p className="small muted">Prélevée sur le montant des articles. Un taux spécifique peut être défini par établissement dans « Établissements ».</p></div>
        <div className="card col"><h3>Rémunération des livreurs</h3>
          <div className="row">{euro('courier_pay', 'base_cents', 'Forfait par course (€)')}{euro('courier_pay', 'min_cents', 'Minimum garanti (€)')}</div>
          <div className="row">{euro('courier_pay', 'per_km_cents', 'Par km de livraison (€)')}{euro('courier_pay', 'approach_per_km_cents', 'Par km d\'approche (€)')}</div>
          <p className="small muted">Exemple : 1 km d'approche + 2 km de livraison = <b>{eur(examplePay)}</b>.</p></div>
        <div className="card col"><h3>Attribution des commandes</h3>
          <div className="row">{num('dispatch', 'radius_km', 'Rayon de recherche initial (km)')}{num('dispatch', 'offer_timeout_s', 'Délai de réponse du livreur (s)')}</div>
          <p className="small muted">Le rayon s'élargit d'1 km par minute d'attente (jusqu'à 3× le rayon initial). Sans réponse dans le délai, la course est proposée au livreur suivant.</p></div>
        <div className="card col"><h3>Service</h3>
          <div className="row">{num('service', 'max_delivery_km', 'Distance max. de livraison (km)')}{euro('service', 'min_order_cents', 'Minimum de commande (€)')}</div>
          {num('service', 'accept_timeout_min', 'Annulation auto. si l\'établissement ne répond pas (min)')}
          <label className="row"><input type="checkbox" checked={s.service.enforce_hours} onChange={(e) => setS({ ...s, service: { ...s.service, enforce_hours: e.target.checked } })} /> Appliquer les horaires d'ouverture des établissements</label>
          <p className="small muted">Décoché (mode démonstration) : les établissements « en ligne » acceptent les commandes à toute heure.</p></div>
      </div>
    </>
  );
}
