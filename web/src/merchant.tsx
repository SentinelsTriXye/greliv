import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { Space, useSession, useLive, useEvent } from './session';
import { eur, hhmm, dateFr, pct, VEHICLES, DAYS, chime, unlockAudio, fileToDataUrl } from './lib';
import { Modal, Chat, StatusBadge, Empty, Switch, Tile, ActionButton, BarChart, dayLabel } from './ui';
import { ClaimModal } from './client';

export default function MerchantApp() {
  return <Space role="merchant"><Shell /></Space>;
}

function Shell() {
  const { logout, api, toast } = useSession();
  const { data: shop, reload } = useLive<any>('/merchant/me', ['profile', 'notification']);
  const [help, setHelp] = useState(false);
  if (!shop) return <div className="spinner" />;
  const setOnline = async (v: boolean) => { try { await api('PATCH', '/merchant/me', { is_online: v }); toast(v ? 'Votre établissement est en ligne.' : 'Établissement hors ligne : plus aucune commande ne sera reçue.', v ? 'success' : 'info'); reload(); } catch (e: any) { toast(e.message, 'error'); } };
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand" style={{ marginBottom: 18 }}><img src="/icon.svg" alt="" /> GreLiv Pro</div>
        <NavLink to="/commercant" end>🧾 Commandes</NavLink>
        <NavLink to="/commercant/catalogue">🍽️ Catalogue</NavLink>
        <NavLink to="/commercant/etablissement">🕒 Établissement</NavLink>
        <NavLink to="/commercant/activite">📈 Activité</NavLink>
        <div className="side-foot" style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => setHelp(true)}>🆘 Assistance</button>
          <button className="btn btn-sm btn-ghost" style={{ color: '#fff', borderColor: 'rgba(255,255,255,.25)' }} onClick={logout}>Se déconnecter</button>
        </div>
      </aside>
      <main className="main">
        <div className="row between wrap">
          <div><h1>{shop.emoji} {shop.name}</h1><p className="muted small">{shop.address}{shop.is_demo && ' · établissement fictif de démonstration'}</p></div>
          <div className="card row" style={{ padding: '10px 14px' }}>
            <span className={`badge ${shop.status !== 'approved' ? 'orange' : shop.is_online ? 'green' : 'red'}`}>{shop.status === 'pending' ? 'En attente de validation' : shop.status === 'suspended' ? 'Suspendu' : shop.is_online ? 'En ligne' : 'Hors ligne'}</span>
            <Switch on={shop.is_online} onChange={setOnline} label="Établissement en ligne" />
          </div>
        </div>
        {shop.status === 'pending' && <div className="card" style={{ background: 'var(--orange-soft)' }}>⏳ Votre établissement est en cours de validation par notre équipe. Vous pouvez déjà préparer votre catalogue et vos horaires : il sera visible des clients dès la validation.</div>}
        <Routes>
          <Route index element={<Orders shop={shop} />} />
          <Route path="catalogue" element={<Catalogue />} />
          <Route path="etablissement" element={<ShopSettings shop={shop} reload={reload} />} />
          <Route path="activite" element={<Activity shop={shop} />} />
        </Routes>
        <div className="row" style={{ display: 'none' }} />
      </main>
      {help && <ClaimModal onClose={() => setHelp(false)} categories={['Problème avec une commande', 'Problème avec un livreur', 'Paiements et reversements', 'Mon compte', 'Autre']} />}
    </div>
  );
}

// ── Commandes ──────────────────────────────────────────────────────────
function Orders({ shop }: { shop: any }) {
  const { api, toast } = useSession();
  const { data: orders, reload } = useLive<any[]>('/orders', ['order', 'order.new']);
  const [sound, setSound] = useState(() => localStorage.getItem('greliv:sound') !== 'off');
  const [chat, setChat] = useState<any>(null);
  const [refuse, setRefuse] = useState<any>(null);
  useEvent((e) => { if (e.type === 'order.new' && sound) chime(4); });
  // Rappel sonore tant qu'une commande attend une réponse
  const pending = orders?.filter((o) => o.status === 'placed').length || 0;
  useEffect(() => { if (!pending || !sound) return; const t = setInterval(() => chime(2), 12_000); return () => clearInterval(t); }, [pending, sound]);
  if (!orders) return <div className="spinner" />;
  const act = (path: string, body?: any, ok?: string) => async () => { await api('POST', path, body); if (ok) toast(ok, 'success'); reload(); };
  const today = new Date().toDateString();
  const cols: [string, string, any[]][] = [
    ['🔔 Nouvelles', 'Aucune nouvelle commande.', orders.filter((o) => o.status === 'placed')],
    ['👩‍🍳 En préparation', 'Rien en cuisine.', orders.filter((o) => ['accepted', 'preparing', 'courier_assigned', 'courier_en_route'].includes(o.status))],
    ['🛵 En livraison', 'Aucune livraison en cours.', orders.filter((o) => ['picked_up', 'delivering'].includes(o.status))],
    ['✅ Terminées aujourd\'hui', 'Aucune commande terminée aujourd\'hui.', orders.filter((o) => ['delivered', 'cancelled'].includes(o.status) && new Date(o.created_at).toDateString() === today)],
  ];
  return (
    <>
      <div className="row between wrap">
        <h2>Commandes en direct</h2>
        <button className={`chip ${sound ? 'on' : ''}`} onClick={() => { unlockAudio(); const v = !sound; setSound(v); localStorage.setItem('greliv:sound', v ? 'on' : 'off'); if (v) setTimeout(() => chime(1), 80); }}>{sound ? '🔔 Alerte sonore activée' : '🔕 Alerte sonore coupée'}</button>
      </div>
      <div className="kanban">
        {cols.map(([title, empty, list]) => (
          <div key={title} className="col">
            <div className="row between"><h3>{title}</h3><span className="badge">{list.length}</span></div>
            {list.length === 0 && <div className="card muted small center">{empty}</div>}
            {list.map((o) => <OrderCard key={o.id} o={o} shop={shop} act={act} onChat={() => setChat(o)} onRefuse={() => setRefuse(o)} />)}
          </div>
        ))}
      </div>
      {chat && <Modal title={`Client — commande #${chat.number}`} onClose={() => setChat(null)}><Chat orderId={chat.id} thread="merchant" /></Modal>}
      {refuse && <RefuseModal order={refuse} onClose={() => setRefuse(null)} onDone={reload} />}
    </>
  );
}

function OrderCard({ o, shop, act, onChat, onRefuse }: { o: any; shop: any; act: (p: string, b?: any, ok?: string) => () => Promise<void>; onChat: () => void; onRefuse: () => void }) {
  const [prep, setPrep] = useState(shop.prep_minutes);
  const isNew = o.status === 'placed';
  const cooking = ['accepted', 'preparing', 'courier_assigned', 'courier_en_route'].includes(o.status);
  return (
    <div className={`card col rise ${isNew ? 'order-new' : ''}`} style={{ gap: 10 }}>
      <div className="row between"><b>#{o.number} · {o.client.name}</b><span className="small muted num">{hhmm(o.created_at)}</span></div>
      {!isNew && <div className="row wrap"><StatusBadge status={o.status} />{o.ready_at && cooking && <span className="badge green">Prête ✓</span>}</div>}
      <div className="col" style={{ gap: 4 }}>
        {o.items.map((i: any) => (
          <div key={i.id}><b className="num">{i.quantity} ×</b> {i.name}
            {i.options.length > 0 && <div className="small muted">↳ {i.options.map((x: any) => x.choice).join(', ')}</div>}
            {i.note && <div className="small" style={{ color: '#B85700' }}>✏️ {i.note}</div>}
          </div>
        ))}
      </div>
      {o.instructions && <div className="badge orange" style={{ whiteSpace: 'normal', padding: '6px 10px', alignSelf: 'stretch' }}>📝 {o.instructions}</div>}
      <div className="row between small"><span className="muted">Total articles</span><b className="num">{eur(o.subtotal_cents)}</b></div>
      {o.status === 'cancelled' && <p className="small muted">{o.cancel_reason}</p>}
      {isNew && <>
        <div className="field">Temps de préparation estimé
          <div className="row wrap">{[10, 15, 20, 30, 45].map((n) => <button key={n} className={`chip ${prep === n ? 'on' : ''}`} style={{ padding: '6px 12px' }} onClick={() => setPrep(n)}>{n} min</button>)}</div>
        </div>
        <div className="row"><button className="btn btn-danger" onClick={onRefuse}>Refuser</button><ActionButton className="btn btn-orange grow" onAction={act(`/merchant/orders/${o.id}/accept`, { prepMinutes: prep }, 'Commande acceptée — recherche d\'un livreur.')}>Accepter</ActionButton></div>
      </>}
      {cooking && <>
        {o.courier ? <div className="row small" style={{ background: 'var(--blue-soft)', borderRadius: 12, padding: '8px 10px' }}>{VEHICLES[o.courier.vehicle].emoji} <span className="grow"><b>{o.courier.name}</b> vient récupérer la commande ({VEHICLES[o.courier.vehicle].label.toLowerCase()})</span></div>
          : <div className="small muted">🔎 Recherche d'un livreur à proximité…</div>}
        <div className="row"><button className="btn btn-sm" onClick={onChat}>💬 Client</button>
          {!o.ready_at ? <ActionButton className="btn btn-primary grow" onAction={act(`/merchant/orders/${o.id}/ready`, undefined, 'Commande signalée prête.')}>Commande prête</ActionButton> : <span className="grow small muted center">En attente du livreur</span>}</div>
      </>}
      {['picked_up', 'delivering'].includes(o.status) && o.courier && <div className="small muted">{VEHICLES[o.courier.vehicle].emoji} {o.courier.name} livre le client{o.eta_minutes ? ` · ~${o.eta_minutes} min` : ''}</div>}
    </div>
  );
}

function RefuseModal({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const { api, toast } = useSession();
  const reasons = ['Produit indisponible', 'Trop de commandes en cours', 'Fermeture imminente', 'Autre raison'];
  const [reason, setReason] = useState(reasons[0]);
  return (
    <Modal title={`Refuser la commande #${order.number}`} onClose={onClose}>
      <p className="muted">Le client sera prévenu et remboursé automatiquement.</p>
      <div className="col" style={{ gap: 8 }}>{reasons.map((r) => <button key={r} className={`chip ${reason === r ? 'on' : ''}`} onClick={() => setReason(r)}>{r}</button>)}</div>
      <ActionButton className="btn btn-danger btn-lg" onAction={async () => { await api('POST', `/merchant/orders/${order.id}/refuse`, { reason }); toast('Commande refusée, client remboursé.'); onDone(); onClose(); }}>Confirmer le refus</ActionButton>
    </Modal>
  );
}

// ── Catalogue ──────────────────────────────────────────────────────────
function Catalogue() {
  const { api, toast } = useSession();
  const { data: products, reload } = useLive<any[]>('/merchant/products', []);
  const [edit, setEdit] = useState<any>(null);
  if (!products) return <div className="spinner" />;
  const cats = [...new Set(products.map((p) => p.category))];
  const patch = async (p: any, body: any) => { try { await api('PATCH', `/merchant/products/${p.id}`, body); reload(); } catch (e: any) { toast(e.message, 'error'); } };
  return (
    <>
      <div className="row between"><h2>Catalogue · {products.length} produit(s)</h2><button className="btn btn-primary" onClick={() => setEdit({})}>+ Ajouter un produit</button></div>
      {products.length === 0 && <Empty emoji="🍽️">Votre catalogue est vide. Ajoutez votre premier produit.</Empty>}
      {cats.map((c) => (
        <div key={c} className="card">
          <h3 style={{ marginBottom: 6 }}>{c}</h3>
          <div className="table-wrap"><table className="table"><tbody>
            {products.filter((p) => p.category === c).map((p) => {
              const out = p.stock === 0;
              return (
                <tr key={p.id}>
                  <td style={{ width: 60 }}><div className="emoji-tile" style={{ width: 48, height: 48, fontSize: 22 }}>{p.image_url ? <img src={p.image_url} alt="" /> : p.emoji}</div></td>
                  <td><b>{p.name}</b><div className="small muted">{p.description}</div>{p.options.length > 0 && <span className="badge">{p.options.length} option(s)</span>}</td>
                  <td className="num bold">{eur(p.price_cents)}</td>
                  <td className="small">{p.stock === null ? <span className="muted">Stock illimité</span> : out ? <span className="badge red">Rupture</span> : <span>Stock : <b>{p.stock}</b></span>}</td>
                  <td><div className="row" style={{ gap: 6 }}><Switch on={p.available} onChange={(v) => patch(p, { available: v })} label="Disponible" /><span className="small muted">{p.available ? 'En vente' : 'Masqué'}</span></div></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm" onClick={() => setEdit(p)}>Modifier</button>{' '}
                    <ActionButton className="btn btn-sm btn-danger" onAction={async () => { if (confirm(`Supprimer « ${p.name} » ?`)) { await api('DELETE', `/merchant/products/${p.id}`); toast('Produit supprimé.'); reload(); } }}>Supprimer</ActionButton>
                  </td>
                </tr>
              );
            })}
          </tbody></table></div>
        </div>
      ))}
      {edit && <ProductEditor product={edit} categories={cats} onClose={() => setEdit(null)} onSaved={reload} />}
    </>
  );
}

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
function ProductEditor({ product, categories, onClose, onSaved }: { product: any; categories: string[]; onClose: () => void; onSaved: () => void }) {
  const { api, toast } = useSession();
  const [p, setP] = useState<any>({ name: '', description: '', category: categories[0] || 'Carte', emoji: '🍽️', image_url: null, available: true, options: [], ...product, price: product.price_cents != null ? (product.price_cents / 100).toFixed(2) : '', stockText: product.stock == null ? '' : String(product.stock) });
  const set = (k: string, v: any) => setP((x: any) => ({ ...x, [k]: v }));
  const setGroup = (gi: number, g: any) => set('options', p.options.map((x: any, i: number) => (i === gi ? g : x)));
  async function photo(e: any) {
    const file = e.target.files?.[0]; if (!file) return;
    try { set('image_url', (await api('POST', '/uploads', { dataUrl: await fileToDataUrl(file) })).url); } catch (err: any) { toast(err.message, 'error'); }
  }
  async function save() {
    const price_cents = Math.round(parseFloat(String(p.price).replace(',', '.')) * 100);
    if (!Number.isFinite(price_cents) || price_cents < 0) throw new Error('Prix invalide.');
    const options = p.options.map((g: any) => ({ id: g.id || slug(g.name), name: g.name, required: !!g.required, max: Number(g.max) || 1,
      choices: g.choices.filter((c: any) => c.name.trim()).map((c: any) => ({ id: c.id || slug(c.name), name: c.name, price_cents: Math.round(parseFloat(String(c.priceText ?? (c.price_cents || 0) / 100).replace(',', '.')) * 100) || 0 })) }));
    if (options.some((g: any) => !g.name.trim() || !g.choices.length)) throw new Error('Chaque groupe d\'options doit avoir un nom et au moins un choix.');
    const body = { name: p.name, description: p.description, category: p.category, emoji: p.emoji || '🍽️', image_url: p.image_url, available: p.available, price_cents, stock: p.stockText === '' ? null : Math.max(0, parseInt(p.stockText, 10) || 0), options };
    if (product.id) await api('PATCH', `/merchant/products/${product.id}`, body); else await api('POST', '/merchant/products', body);
    toast('Produit enregistré.', 'success'); onSaved(); onClose();
  }
  return (
    <Modal wide title={product.id ? 'Modifier le produit' : 'Nouveau produit'} onClose={onClose}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="col center" style={{ gap: 6 }}>
          <div className="emoji-tile" style={{ width: 96, height: 96, fontSize: 40 }}>{p.image_url ? <img src={p.image_url} alt="" /> : p.emoji}</div>
          <label className="btn btn-sm" style={{ cursor: 'pointer' }}>📷 Photo<input type="file" accept="image/*" hidden onChange={photo} /></label>
          {p.image_url && <button className="btn btn-sm btn-ghost" onClick={() => set('image_url', null)}>Retirer</button>}
        </div>
        <div className="col grow">
          <label className="field">Nom<input className="input" value={p.name} onChange={(e) => set('name', e.target.value)} maxLength={80} /></label>
          <label className="field">Description<textarea className="input" rows={2} value={p.description} onChange={(e) => set('description', e.target.value)} maxLength={300} /></label>
        </div>
      </div>
      <div className="row wrap">
        <label className="field grow">Prix (€)<input className="input num" inputMode="decimal" value={p.price} onChange={(e) => set('price', e.target.value)} placeholder="12,50" /></label>
        <label className="field grow">Catégorie<input className="input" list="cats" value={p.category} onChange={(e) => set('category', e.target.value)} /><datalist id="cats">{categories.map((c) => <option key={c} value={c} />)}</datalist></label>
        <label className="field" style={{ width: 90 }}>Icône<input className="input center" value={p.emoji} onChange={(e) => set('emoji', e.target.value)} maxLength={8} /></label>
      </div>
      <div className="row wrap">
        <label className="field grow">Stock (vide = illimité, 0 = rupture)<input className="input num" inputMode="numeric" value={p.stockText} onChange={(e) => set('stockText', e.target.value.replace(/\D/g, ''))} placeholder="Illimité" /></label>
        <div className="field">En vente<Switch on={p.available} onChange={(v) => set('available', v)} label="En vente" /></div>
      </div>
      <div className="divider" />
      <div className="row between"><h3>Options de personnalisation</h3><button className="btn btn-sm" onClick={() => set('options', [...p.options, { name: '', required: false, max: 1, choices: [{ name: '', priceText: '0' }] }])}>+ Groupe d'options</button></div>
      {p.options.length === 0 && <p className="small muted">Ex. « Taille » (obligatoire, 1 choix) ou « Suppléments » (facultatif, plusieurs choix).</p>}
      {p.options.map((g: any, gi: number) => (
        <div key={gi} className="card col" style={{ background: 'var(--bg)', boxShadow: 'none', gap: 8 }}>
          <div className="row wrap">
            <input className="input grow" style={{ minWidth: 140 }} placeholder="Nom du groupe (ex. Taille)" value={g.name} onChange={(e) => setGroup(gi, { ...g, name: e.target.value })} />
            <label className="row small"><input type="checkbox" checked={!!g.required} onChange={(e) => setGroup(gi, { ...g, required: e.target.checked })} /> Obligatoire</label>
            <label className="row small">Max <input className="input num" style={{ width: 60, padding: 8 }} inputMode="numeric" value={g.max} onChange={(e) => setGroup(gi, { ...g, max: e.target.value.replace(/\D/g, '') })} /></label>
            <button className="btn btn-sm btn-danger" onClick={() => set('options', p.options.filter((_: any, i: number) => i !== gi))}>Supprimer</button>
          </div>
          {g.choices.map((c: any, ci: number) => (
            <div key={ci} className="row">
              <input className="input grow" placeholder="Choix (ex. Grande)" value={c.name} onChange={(e) => setGroup(gi, { ...g, choices: g.choices.map((x: any, i: number) => (i === ci ? { ...x, name: e.target.value } : x)) })} />
              <input className="input num" style={{ width: 96 }} inputMode="decimal" aria-label="Supplément en euros" placeholder="+ €" value={c.priceText ?? ((c.price_cents || 0) / 100).toFixed(2)} onChange={(e) => setGroup(gi, { ...g, choices: g.choices.map((x: any, i: number) => (i === ci ? { ...x, priceText: e.target.value } : x)) })} />
              <button className="icon-btn" style={{ boxShadow: 'none' }} onClick={() => setGroup(gi, { ...g, choices: g.choices.filter((_: any, i: number) => i !== ci) })} aria-label="Retirer le choix">✕</button>
            </div>
          ))}
          <button className="btn btn-sm btn-ghost" onClick={() => setGroup(gi, { ...g, choices: [...g.choices, { name: '', priceText: '0' }] })}>+ Ajouter un choix</button>
        </div>
      ))}
      <ActionButton className="btn btn-primary btn-lg" disabled={!p.name.trim()} onAction={save}>Enregistrer</ActionButton>
    </Modal>
  );
}

// ── Établissement : informations, horaires, reversements ───────────────
function ShopSettings({ shop, reload }: { shop: any; reload: () => void }) {
  const { api, toast } = useSession();
  const [f, setF] = useState({ name: shop.name, description: shop.description, category: shop.category, phone: shop.phone || '', emoji: shop.emoji, prep_minutes: shop.prep_minutes });
  const [hours, setHours] = useState<Record<string, [string, string][]>>(shop.opening_hours || {});
  const set = (k: string) => (e: any) => setF((x) => ({ ...x, [k]: e.target.value }));
  const setSlot = (d: string, i: number, j: number, v: string) => setHours((h) => ({ ...h, [d]: (h[d] || []).map((s, k) => (k === i ? (j === 0 ? [v, s[1]] : [s[0], v]) as [string, string] : s)) }));
  return (
    <div className="grid2">
      <div className="card col">
        <h3>Informations</h3>
        <label className="field">Nom<input className="input" value={f.name} onChange={set('name')} /></label>
        <label className="field">Description<textarea className="input" rows={2} value={f.description} onChange={set('description')} /></label>
        <div className="row"><label className="field grow">Catégorie<input className="input" value={f.category} onChange={set('category')} /></label><label className="field" style={{ width: 90 }}>Icône<input className="input center" value={f.emoji} onChange={set('emoji')} /></label></div>
        <div className="row"><label className="field grow">Téléphone<input className="input" value={f.phone} onChange={set('phone')} /></label><label className="field grow">Préparation moyenne (min)<input className="input num" inputMode="numeric" value={f.prep_minutes} onChange={(e) => setF({ ...f, prep_minutes: e.target.value.replace(/\D/g, '') as any })} /></label></div>
        <ActionButton onAction={async () => { await api('PATCH', '/merchant/me', { ...f, prep_minutes: Number(f.prep_minutes) || 15 }); toast('Informations enregistrées.', 'success'); reload(); }}>Enregistrer</ActionButton>
        <div className="divider" />
        <h3>Reversements</h3>
        <p className="small muted">Commission de la plateforme : <b>{pct(shop.effective_commission_rate)}</b> du montant des articles. Le reste vous est reversé après chaque livraison.</p>
        <p className="small">{shop.payouts_ready ? '✅ Compte de reversement Stripe relié.' : 'Compte de reversement non relié.'}</p>
        <ActionButton className="btn" onAction={async () => { const r = await api('POST', '/connect/onboard'); if (r.url) location.href = r.url; else toast(r.message); }}>Configurer mes reversements (Stripe Connect)</ActionButton>
      </div>
      <div className="card col">
        <h3>Horaires d'ouverture</h3>
        {DAYS.map(([d, label]) => {
          const slots = hours[d] || [];
          return (
            <div key={d} className="row wrap" style={{ alignItems: 'flex-start' }}>
              <div style={{ width: 86, paddingTop: 8 }} className="bold small">{label}</div>
              <div className="col grow" style={{ gap: 6 }}>
                {slots.length === 0 && <span className="badge red" style={{ alignSelf: 'flex-start', marginTop: 6 }}>Fermé</span>}
                {slots.map((s, i) => (
                  <div key={i} className="row" style={{ gap: 6 }}>
                    <input type="time" className="input" style={{ padding: 8 }} value={s[0]} onChange={(e) => setSlot(d, i, 0, e.target.value)} aria-label={`${label} ouverture`} />
                    <span className="muted">→</span>
                    <input type="time" className="input" style={{ padding: 8 }} value={s[1]} onChange={(e) => setSlot(d, i, 1, e.target.value)} aria-label={`${label} fermeture`} />
                    <button className="icon-btn" style={{ boxShadow: 'none' }} onClick={() => setHours((h) => ({ ...h, [d]: slots.filter((_, k) => k !== i) }))} aria-label="Supprimer le créneau">✕</button>
                  </div>
                ))}
              </div>
              {slots.length < 3 && <button className="btn btn-sm" onClick={() => setHours((h) => ({ ...h, [d]: [...slots, ['12:00', '14:00']] }))}>+ Créneau</button>}
            </div>
          );
        })}
        <ActionButton onAction={async () => {
          for (const [d, slots] of Object.entries(hours)) for (const [a, b] of slots) if (!a || !b || a >= b) throw new Error(`Créneau invalide le ${DAYS.find((x) => x[0] === d)?.[1].toLowerCase()}.`);
          await api('PATCH', '/merchant/me', { opening_hours: hours }); toast('Horaires enregistrés.', 'success'); reload();
        }}>Enregistrer les horaires</ActionButton>
        <p className="small muted">Pour une fermeture exceptionnelle, utilisez l'interrupteur « En ligne » en haut de page.</p>
      </div>
    </div>
  );
}

// ── Activité ───────────────────────────────────────────────────────────
function Activity({ shop }: { shop: any }) {
  const { data: s } = useLive<any>('/merchant/stats', ['order']);
  const { data: orders } = useLive<any[]>('/orders?scope=history', ['order']);
  const [metric, setMetric] = useState<'revenue_cents' | 'orders'>('revenue_cents');
  if (!s) return <div className="spinner" />;
  return (
    <>
      <div className="tiles">
        <Tile label="Commandes reçues aujourd'hui" value={s.today.received} sub={`${s.today.orders} livrée(s)`} />
        <Tile label="Chiffre d'affaires du jour" value={eur(s.today.revenue_cents)} sub={`Net reversé : ${eur(s.today.net_cents)}`} />
        <Tile label="Chiffre d'affaires · 7 jours" value={eur(s.week.revenue_cents)} sub={`${s.week.orders} commandes`} />
        <Tile label="Chiffre d'affaires · 30 jours" value={eur(s.month.revenue_cents)} sub={`${s.month.orders} commandes`} />
        <Tile label="Commissions plateforme · 30 j" value={eur(s.month.commission_cents)} sub={`Taux : ${pct(shop.effective_commission_rate)}`} />
        <Tile label="Note moyenne" value={s.rating.avg ? `⭐ ${String(s.rating.avg).replace('.', ',')}` : '—'} sub={`${s.rating.n} avis`} />
      </div>
      <div className="grid2">
        <div className="card col">
          <div className="row between wrap"><h3>{metric === 'orders' ? 'Commandes livrées par jour' : 'Chiffre d\'affaires par jour'} · 14 jours</h3>
            <div className="row"><button className={`chip ${metric === 'revenue_cents' ? 'on' : ''}`} onClick={() => setMetric('revenue_cents')}>Chiffre d'affaires</button><button className={`chip ${metric === 'orders' ? 'on' : ''}`} onClick={() => setMetric('orders')}>Commandes</button></div></div>
          <BarChart label="Activité par jour" data={s.series.map((d: any) => ({ label: dayLabel(d.day), value: d[metric] }))} format={metric === 'orders' ? (n) => `${n} cmd` : eur} />
        </div>
        <div className="card col"><h3>Produits les plus vendus</h3>
          {s.top.length === 0 && <p className="muted small">Pas encore de ventes.</p>}
          {s.top.map((t: any) => <div key={t.name} className="row between"><span>{t.name}</span><b className="num">{t.qty}</b></div>)}
        </div>
      </div>
      <div className="card"><h3 style={{ marginBottom: 6 }}>Historique et commissions</h3>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Commande</th><th>Date</th><th>Statut</th><th>Articles</th><th>Commission</th><th>Net reversé</th></tr></thead>
          <tbody>{orders?.slice(0, 40).map((o) => <tr key={o.id}><td>#{o.number}</td><td className="small">{dateFr(o.created_at)}</td><td><StatusBadge status={o.status} /></td><td className="num">{eur(o.subtotal_cents)}</td>
            <td className="num">{o.status === 'delivered' ? `− ${eur(o.commission_cents)}` : '—'}</td><td className="num bold">{o.status === 'delivered' ? eur(o.merchant_net_cents) : '—'}</td></tr>)}</tbody>
        </table></div>
      </div>
    </>
  );
}
