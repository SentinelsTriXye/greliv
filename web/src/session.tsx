import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { request, ApiError, SPACES, VEHICLES, chime, unlockAudio, type Role } from './lib';
import { registerPush } from './push';
import { AddressPicker } from './ui';

type Listener = (e: any) => void;
type Ctx = {
  role: Role; user: any; api: (method: string, path: string, body?: any) => Promise<any>;
  logout: () => void; reloadUser: () => Promise<void>; online: boolean;
  subscribe: (fn: Listener) => () => void; toast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
};
const SessionCtx = createContext<Ctx>(null as any);
export const useSession = () => useContext(SessionCtx);

/** Charge une ressource et la recharge à chaque événement temps réel pertinent (et toutes les 30 s par sécurité). */
export function useLive<T = any>(path: string | null, types?: string[]) {
  const { api, subscribe } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    try { const d = await api('GET', path); if (n === seq.current) { setData(d); setError(null); } }
    catch (e: any) { if (n === seq.current) setError(e.message); }
  }, [path, api]);
  useEffect(() => {
    setData(null); reload();
    const off = subscribe((e) => { if (e.type !== 'position' && (!types || types.includes(e.type) || e.type === 'reconnect')) reload(); });
    const t = setInterval(reload, 30_000);
    return () => { off(); clearInterval(t); };
  }, [reload, subscribe]); // eslint-disable-line
  return { data, error, reload, setData };
}
export function useEvent(fn: Listener) {
  const { subscribe } = useSession();
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}

export function Space({ role, children }: { role: Role; children: ReactNode }) {
  const key = `greliv:token:${role}`;
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(key));
  const [user, setUser] = useState<any>(null);
  const [online, setOnline] = useState(true);
  const [toasts, setToasts] = useState<{ id: number; msg: string; tone: string }[]>([]);
  const listeners = useRef(new Set<Listener>());

  const toast = useCallback((msg: string, tone: string = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  const logout = useCallback(() => { localStorage.removeItem(key); setToken(null); setUser(null); }, [key]);
  const api = useCallback(async (method: string, path: string, body?: any) => {
    try { return await request(token, method, path, body); }
    catch (e) { if (e instanceof ApiError && e.status === 401 && token) logout(); throw e; }
  }, [token, logout]);
  const reloadUser = useCallback(async () => { setUser(await api('GET', '/me')); }, [api]);
  const subscribe = useCallback((fn: Listener) => { listeners.current.add(fn); return () => { listeners.current.delete(fn); }; }, []);

  useEffect(() => { document.body.classList.toggle('mobile-space', role === 'client' || role === 'courier'); }, [role]);
  useEffect(() => { if (token) reloadUser().catch((e) => { if (e.status !== 401) toast(e.message, 'error'); }); }, [token]); // eslint-disable-line
  useEffect(() => { if (user) registerPush(api); }, [user?.id]); // eslint-disable-line

  // WebSocket avec reconnexion automatique (délai progressif)
  useEffect(() => {
    if (!token) return;
    let ws: WebSocket | null = null, stop = false, tries = 0, timer: any, wasDown = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${token}`);
      ws.onopen = () => { tries = 0; setOnline(true); if (wasDown) listeners.current.forEach((fn) => fn({ type: 'reconnect' })); wasDown = false; };
      ws.onmessage = (m) => {
        const e = JSON.parse(m.data);
        if (e.type === 'notification') {
          toast(e.body ? `${e.title} — ${e.body}` : e.title);
          if (e.data?.kind === 'new_order' || e.data?.kind === 'offer') chime(3);
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(e.title, { body: e.body, icon: '/icon.svg' });
        }
        if (e.type === 'profile') reloadUser().catch(() => {});
        listeners.current.forEach((fn) => fn(e));
      };
      ws.onclose = (ev) => {
        if (stop) return;
        if (ev.code === 4401) return logout();
        wasDown = true; setOnline(false);
        timer = setTimeout(connect, Math.min(8000, 800 * 2 ** tries++));
      };
    };
    connect();
    return () => { stop = true; clearTimeout(timer); ws?.close(); };
  }, [token]); // eslint-disable-line

  const toastLayer = <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.msg}</div>)}</div>;
  if (!token) return <>{toastLayer}<AuthScreen role={role} onToken={(t) => { localStorage.setItem(key, t); setToken(t); }} toast={toast} /></>;
  if (!user) return <div className="spinner" />;
  return (
    <SessionCtx.Provider value={{ role, user, api, logout, reloadUser, online, subscribe, toast: toast as any }}>
      {toastLayer}
      {!online && <div className="offline">Connexion perdue — reconnexion en cours…</div>}
      <div onPointerDown={unlockAudio} style={{ minHeight: '100%' }}>{children}</div>
    </SessionCtx.Provider>
  );
}

const DEMO: Record<Role, [string, string][]> = {
  client: [['Camille (cliente)', 'client@greliv.test'], ['Jules (client)', 'client2@greliv.test']],
  merchant: [['Pizzeria Belledonne', 'resto1@greliv.test'], ['Burger des Alpes', 'resto2@greliv.test'], ['Sushi Chartreuse', 'resto3@greliv.test']],
  courier: [['Léa · vélo', 'livreur.velo@greliv.test'], ['Hugo · scooter', 'livreur.scooter@greliv.test'], ['Inès · voiture', 'livreur.voiture@greliv.test']],
  admin: [['Administrateur', 'admin@greliv.test']],
};

function AuthScreen({ role, onToken, toast }: { role: Role; onToken: (t: string) => void; toast: (m: string, t?: any) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState<any>({ email: '', password: '', name: '', phone: '', vehicle: 'bike', shopName: '', category: 'Restaurant' });
  const [addr, setAddr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setF((x: any) => ({ ...x, [k]: e.target.value }));
  const sp = SPACES[role];

  async function submit(e?: any, creds?: { email: string; password: string }) {
    e?.preventDefault();
    setBusy(true);
    try {
      if (mode === 'login' || creds) {
        onToken((await request(null, 'POST', '/auth/login', { email: creds?.email ?? f.email, password: creds?.password ?? f.password, role })).token);
      } else {
        if (role === 'merchant' && !addr) throw new Error('Indiquez l\'adresse de l\'établissement.');
        const body: any = { role, email: f.email, password: f.password, name: f.name, phone: f.phone || undefined };
        if (role === 'courier') body.vehicle = f.vehicle;
        if (role === 'merchant') body.shop = { name: f.shopName, category: f.category, address: addr.label, lat: addr.lat, lng: addr.lng };
        onToken((await request(null, 'POST', '/auth/register', body)).token);
        if (role !== 'client') toast('Compte créé. Il sera activé après validation par notre équipe.', 'success');
      }
    } catch (err: any) { toast(err.message, 'error'); }
    setBusy(false);
  }

  return (
    <div className="phone" style={{ background: '#fff' }}>
      <div className="hero" style={{ paddingBottom: 34 }}>
        <Link to="/" style={{ color: '#fff', opacity: .85 }} className="small">← Changer d'espace</Link>
        <div className="brand" style={{ marginTop: 18, fontSize: 28 }}><img src="/icon.svg" alt="" /> GreLiv</div>
        <p style={{ opacity: .9, marginTop: 6 }}>Espace {sp.label.toLowerCase()} {sp.emoji} — {sp.tagline.toLowerCase()}</p>
      </div>
      <form className="page rise" onSubmit={submit} style={{ marginTop: -18, background: '#fff', borderRadius: '24px 24px 0 0', paddingBottom: 32 }}>
        {role !== 'admin' && (
          <div className="row">
            <button type="button" className={`chip grow ${mode === 'login' ? 'on' : ''}`} onClick={() => setMode('login')}>Connexion</button>
            <button type="button" className={`chip grow ${mode === 'register' ? 'on' : ''}`} onClick={() => setMode('register')}>Créer un compte</button>
          </div>
        )}
        {mode === 'register' && <>
          <label className="field">Nom complet<input className="input" required minLength={2} value={f.name} onChange={set('name')} autoComplete="name" /></label>
          <label className="field">Téléphone<input className="input" type="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" /></label>
          {role === 'courier' && (
            <label className="field">Moyen de transport
              <select className="input" value={f.vehicle} onChange={set('vehicle')}>{Object.entries(VEHICLES).map(([k, v]) => <option key={k} value={k}>{v.emoji} {v.label}</option>)}</select>
            </label>
          )}
          {role === 'merchant' && <>
            <label className="field">Nom de l'établissement<input className="input" required minLength={2} value={f.shopName} onChange={set('shopName')} /></label>
            <label className="field">Catégorie<input className="input" required value={f.category} onChange={set('category')} placeholder="Pizza, Épicerie, Fleuriste…" /></label>
            <div className="field">Adresse de l'établissement<AddressPicker value={addr} onChange={setAddr} compact /></div>
          </>}
        </>}
        <label className="field">Adresse e-mail<input className="input" type="email" required value={f.email} onChange={set('email')} autoComplete="email" /></label>
        <label className="field">Mot de passe<input className="input" type="password" required minLength={mode === 'register' ? 8 : 1} value={f.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{mode === 'login' ? 'Se connecter' : 'Créer mon compte'}</button>
        {mode === 'register' && <p className="small muted center">En créant un compte, vous acceptez le traitement de vos données pour la gestion de vos commandes (RGPD). Vous pouvez les exporter ou les supprimer à tout moment depuis votre compte.</p>}
        {mode === 'login' && (
          <div className="card" style={{ background: 'var(--orange-soft)', boxShadow: 'none' }}>
            <p className="small bold">Comptes de démonstration (fictifs)</p>
            <p className="small muted" style={{ marginBottom: 8 }}>Mot de passe : <b>demo1234</b> — un clic pour se connecter.</p>
            <div className="row wrap">{DEMO[role].map(([label, email]) => (
              <button type="button" key={email} className="btn btn-sm" style={{ background: '#fff' }} disabled={busy} onClick={() => submit(undefined, { email, password: 'demo1234' })}>{label}</button>
            ))}</div>
          </div>
        )}
      </form>
    </div>
  );
}
