import { useEffect, useRef, useState, type ReactNode } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { request, STATUS, type LatLng } from './lib';
import { useLive, useSession } from './session';

export function Modal({ title, onClose, children, wide }: { title?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="row between">
          <h2>{title}</h2>
          <button className="icon-btn" style={{ boxShadow: 'none', background: 'var(--bg)' }} onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const StatusBadge = ({ status }: { status: string }) => <span className={`badge ${STATUS[status]?.tone || ''}`}>{STATUS[status]?.label || status}</span>;
export const Empty = ({ emoji, children }: { emoji: string; children: ReactNode }) => <div className="empty"><div className="big">{emoji}</div>{children}</div>;
export const Switch = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) =>
  <button type="button" className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
export const Tile = ({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) =>
  <div className="card tile"><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>;
export function Stars({ value, onChange }: { value: number; onChange?: (n: number) => void }) {
  return <div className="stars" role="radiogroup">{[1, 2, 3, 4, 5].map((n) => <button type="button" key={n} className={n <= value ? 'on' : ''} onClick={() => onChange?.(n)} aria-label={`${n} étoile${n > 1 ? 's' : ''}`}>⭐</button>)}</div>;
}
/** Bouton qui se désactive pendant l'action et affiche l'erreur éventuelle. */
export function ActionButton({ onAction, children, className = 'btn btn-primary', disabled }: { onAction: () => Promise<any>; children: ReactNode; className?: string; disabled?: boolean }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  return <button className={className} disabled={busy || disabled} onClick={async (e) => { e.stopPropagation(); setBusy(true); try { await onAction(); } catch (err: any) { toast(err.message, 'error'); } setBusy(false); }}>{children}</button>;
}

// ── Carte (Leaflet + OpenStreetMap) ────────────────────────────────────
export type MapMarker = LatLng & { id: string; kind: 'shop' | 'client' | 'courier' | 'pin'; emoji?: string; label?: string; onClick?: () => void };
const GRENOBLE: [number, number] = [45.1885, 5.7245];

export function MapView({ markers = [], route, className = '', fitKey, onPick, follow, zoom = 14 }: {
  markers?: MapMarker[]; route?: [number, number][] | null; className?: string; fitKey?: string; onPick?: (p: LatLng) => void; follow?: LatLng | null; zoom?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<{ markers: L.LayerGroup; route: L.LayerGroup } | null>(null);
  const pick = useRef(onPick); pick.current = onPick;

  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: false }).setView(GRENOBLE, zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(m);
    m.attributionControl.setPrefix(false);
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    layers.current = { route: L.layerGroup().addTo(m), markers: L.layerGroup().addTo(m) };
    m.on('click', (e) => pick.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    map.current = m;
    let alive = true;
    const resize = () => { if (alive) m.invalidateSize({ animate: false }); };
    const t = setTimeout(resize, 350);
    const ro = new ResizeObserver(resize);
    ro.observe(el.current!);
    // Arrêter toute animation en cours avant de détruire la carte (changement d'écran pendant un déplacement)
    return () => { alive = false; clearTimeout(t); ro.disconnect(); map.current = null; m.stop(); m.off(); m.remove(); };
  }, []); // eslint-disable-line

  const mk = JSON.stringify(markers.map((m) => [m.id, m.lat, m.lng, m.kind, m.emoji, m.label]));
  useEffect(() => {
    const g = layers.current?.markers; if (!g) return;
    g.clearLayers();
    for (const m of markers) {
      const round = m.kind === 'courier';
      const icon = L.divIcon({ className: '', html: `<div class="pin ${m.kind}"><span>${m.emoji || '📍'}</span></div>`, iconSize: [38, 38], iconAnchor: round ? [19, 19] : [19, 38] });
      const marker = L.marker([m.lat, m.lng], { icon, zIndexOffset: round ? 1000 : 0 }).addTo(g);
      if (m.label) marker.bindTooltip(m.label, { direction: 'top', offset: [0, round ? -20 : -38] });
      if (m.onClick) marker.on('click', m.onClick);
    }
  }, [mk]); // eslint-disable-line

  const rk = route ? `${route.length}:${route[0]}:${route[route.length - 1]}` : '';
  useEffect(() => {
    const g = layers.current?.route; if (!g) return;
    g.clearLayers();
    if (route && route.length > 1) {
      L.polyline(route, { color: '#fff', weight: 9, opacity: .9 }).addTo(g);
      L.polyline(route, { color: '#1565D8', weight: 5, lineCap: 'round' }).addTo(g);
    }
  }, [rk]); // eslint-disable-line

  useEffect(() => {
    const m = map.current; if (!m) return;
    const pts: [number, number][] = [...markers.map((x) => [x.lat, x.lng] as [number, number]), ...(route || [])];
    if (pts.length === 1) m.setView(pts[0], Math.max(m.getZoom(), 15), { animate: false });
    else if (pts.length > 1) m.fitBounds(L.latLngBounds(pts), { padding: [44, 44], maxZoom: 16, animate: false });
  }, [fitKey]); // eslint-disable-line

  useEffect(() => { if (follow && map.current) map.current.panTo([follow.lat, follow.lng], { animate: false }); }, [follow?.lat, follow?.lng]); // eslint-disable-line
  return <div ref={el} className={`map ${className}`} />;
}

// ── Sélecteur d'adresse : recherche, géolocalisation (avec consentement) ou point sur la carte ──
export type Address = { label: string; lat: number; lng: number; details?: string };
export function AddressPicker({ value, onChange, compact }: { value: Address | null; onChange: (a: Address) => void; compact?: boolean }) {
  const [text, setText] = useState(value?.label || '');
  const [results, setResults] = useState<Address[]>([]);
  const [msg, setMsg] = useState('');
  const typed = useRef(false);
  useEffect(() => {
    if (!typed.current || text.trim().length < 3) { setResults([]); return; }
    const t = setTimeout(async () => { try { setResults(await request(null, 'GET', `/geo/search?q=${encodeURIComponent(text)}`)); } catch { setResults([]); } }, 280);
    return () => clearTimeout(t);
  }, [text]);
  const choose = (a: Address) => { typed.current = false; setText(a.label); setResults([]); setMsg(''); onChange({ ...value, ...a }); };
  const fromPoint = async (p: LatLng) => {
    try { const r = await request(null, 'GET', `/geo/reverse?lat=${p.lat}&lng=${p.lng}`); choose({ label: r.label, ...p }); }
    catch { choose({ label: `Point sur la carte (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})`, ...p }); }
  };
  const locate = () => {
    if (!navigator.geolocation) return setMsg('La géolocalisation n\'est pas disponible sur cet appareil.');
    setMsg('Localisation en cours…');
    navigator.geolocation.getCurrentPosition(
      (pos) => fromPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setMsg('Position indisponible ou refusée. Saisissez une adresse ou touchez la carte.'),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <input className="input" placeholder="Ex. 14 boulevard Gambetta, Grenoble" value={text} onChange={(e) => { typed.current = true; setText(e.target.value); }} aria-label="Adresse" />
      {results.length > 0 && (
        <div className="card" style={{ padding: 6 }}>
          {results.map((r, i) => <button type="button" key={i} className="btn btn-ghost btn-block" style={{ justifyContent: 'flex-start', border: 0, fontWeight: 500, whiteSpace: 'normal', textAlign: 'left' }} onClick={() => choose(r)}>📍 {r.label}</button>)}
        </div>
      )}
      <button type="button" className="btn btn-sm" onClick={locate}>🧭 Utiliser ma position actuelle</button>
      {msg && <p className="small muted">{msg}</p>}
      <MapView className={compact ? '' : 'tall'} markers={value ? [{ id: 'a', kind: 'client', emoji: '🏠', ...value }] : []} fitKey={value ? `${value.lat},${value.lng}` : ''} onPick={fromPoint} />
      <p className="small muted">Astuce : touchez la carte pour placer précisément le point de livraison.</p>
    </div>
  );
}

// ── Messagerie de commande ─────────────────────────────────────────────
export function Chat({ orderId, thread, readOnly }: { orderId: string; thread: 'courier' | 'merchant'; readOnly?: boolean }) {
  const { api, toast } = useSession();
  const { data, reload } = useLive<any[]>(`/orders/${orderId}/messages/${thread}`, ['message']);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [data?.length]);
  const sendMsg = async (e: any) => {
    e.preventDefault();
    if (!text.trim()) return;
    try { await api('POST', `/orders/${orderId}/messages/${thread}`, { body: text.trim() }); setText(''); reload(); } catch (err: any) { toast(err.message, 'error'); }
  };
  const WHO: any = { client: 'Client', courier: 'Livreur', merchant: 'Établissement' };
  return (
    <div className="col">
      <div className="col" style={{ gap: 6, minHeight: 120, maxHeight: 300, overflowY: 'auto' }}>
        {data?.length === 0 && <p className="muted small center" style={{ marginTop: 40 }}>Aucun message pour le moment.</p>}
        {data?.map((m) => <div key={m.id} className={`bubble ${m.mine ? 'mine' : ''}`}>{!m.mine && <div className="small bold">{WHO[m.sender_role]}</div>}{m.body}</div>)}
        <div ref={end} />
      </div>
      {!readOnly && (
        <form className="row" onSubmit={sendMsg}>
          <input className="input" placeholder="Votre message…" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
          <button className="btn btn-primary">Envoyer</button>
        </form>
      )}
    </div>
  );
}

// ── Histogramme mono-série (survol = valeur exacte) ────────────────────
export function BarChart({ data, format = String, label }: { data: { label: string; value: number }[]; format?: (n: number) => string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 560, H = 190, padL = 8, padB = 22, padT = 10;
  const max = Math.max(1, ...data.map((d) => d.value));
  const step = (W - padL * 2) / data.length, bw = Math.min(26, step - 6);
  const y = (v: number) => padT + (H - padB - padT) * (1 - v / max);
  const every = Math.ceil(data.length / 7);
  return (
    <div style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }} role="img" aria-label={label}>
        {[0.5, 1].map((f) => <line key={f} x1={padL} x2={W - padL} y1={y(max * f)} y2={y(max * f)} stroke="#E3E8F0" strokeDasharray="3 4" />)}
        <text x={padL} y={y(max) - 2} fontSize="11" fill="#64708A">{format(max)}</text>
        {data.map((d, i) => {
          const x = padL + step * i + (step - bw) / 2, top = y(d.value), h = H - padB - top, r = Math.min(4, h);
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
              <rect x={padL + step * i} y={0} width={step} height={H} fill="transparent" />
              {h > 0 && <path d={`M${x},${H - padB} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - padB} Z`} fill="#1565D8" opacity={hover === null || hover === i ? 1 : 0.45} />}
              {i % every === 0 && <text x={x + bw / 2} y={H - 6} fontSize="11" fill="#64708A" textAnchor="middle">{d.label}</text>}
            </g>
          );
        })}
        <line x1={padL} x2={W - padL} y1={H - padB} y2={H - padB} stroke="#C9D1DE" />
      </svg>
      {hover !== null && <div className="chart-tip" style={{ left: `${((padL + step * (hover + 0.5)) / W) * 100}%`, top: `${(y(data[hover].value) / H) * 100}%` }}><b>{format(data[hover].value)}</b> · {data[hover].label}</div>}
    </div>
  );
}
export const dayLabel = (iso: string) => new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
