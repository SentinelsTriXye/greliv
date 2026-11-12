export const eur = (cents: number) => (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
export const km = (m: number) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
export const hhmm = (d: string | Date) => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
export const dateFr = (d: string | Date) => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' · ' + hhmm(d);
export const pct = (r: number) => `${Math.round(r * 1000) / 10} %`.replace('.', ',');

export type Role = 'client' | 'merchant' | 'courier' | 'admin';
export const SPACES: Record<Role, { path: string; label: string; emoji: string; tagline: string }> = {
  client: { path: '/client', label: 'Client', emoji: '🛍️', tagline: 'Commander et suivre sa livraison' },
  merchant: { path: '/commercant', label: 'Commerçant', emoji: '🏪', tagline: 'Recevoir et préparer les commandes' },
  courier: { path: '/livreur', label: 'Livreur', emoji: '🚲', tagline: 'Accepter des courses, GPS et gains' },
  admin: { path: '/admin', label: 'Administrateur', emoji: '📊', tagline: 'Piloter toute la plateforme' },
};

export const STATUS: Record<string, { label: string; tone: string }> = {
  awaiting_payment: { label: 'Paiement en attente', tone: '' },
  placed: { label: 'Commande passée', tone: 'orange' },
  accepted: { label: 'Acceptée', tone: 'blue' },
  preparing: { label: 'En préparation', tone: 'blue' },
  courier_assigned: { label: 'Livreur attribué', tone: 'blue' },
  courier_en_route: { label: 'Livreur en route vers l\'établissement', tone: 'blue' },
  picked_up: { label: 'Commande récupérée', tone: 'blue' },
  delivering: { label: 'Livraison en cours', tone: 'orange' },
  delivered: { label: 'Livrée', tone: 'green' },
  cancelled: { label: 'Annulée', tone: 'red' },
};
/** Les 8 étapes du parcours, dans l'ordre. */
export const FLOW = ['placed', 'accepted', 'preparing', 'courier_assigned', 'courier_en_route', 'picked_up', 'delivering', 'delivered'];
export const FLOW_LABEL: Record<string, string> = {
  placed: 'Commande passée', accepted: 'Acceptée par l\'établissement', preparing: 'En préparation', courier_assigned: 'Livreur attribué',
  courier_en_route: 'Livreur en route vers l\'établissement', picked_up: 'Commande récupérée', delivering: 'Livraison en cours', delivered: 'Commande livrée',
};
export const VEHICLES: Record<string, { label: string; emoji: string; kmh: number }> = {
  bike: { label: 'Vélo', emoji: '🚲', kmh: 15 }, ebike: { label: 'Vélo électrique', emoji: '⚡', kmh: 20 },
  scooter: { label: 'Scooter', emoji: '🛵', kmh: 28 }, car: { label: 'Voiture', emoji: '🚗', kmh: 25 },
};
export const PAY_METHODS: Record<string, string> = { card: 'Carte bancaire', apple_pay: 'Apple Pay', google_pay: 'Google Pay' };
export const DAYS: [string, string][] = [['mon', 'Lundi'], ['tue', 'Mardi'], ['wed', 'Mercredi'], ['thu', 'Jeudi'], ['fri', 'Vendredi'], ['sat', 'Samedi'], ['sun', 'Dimanche']];

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}
export async function request(token: string | null, method: string, path: string, body?: any) {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Connexion impossible. Vérifiez votre réseau puis réessayez.', 0, 'network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Erreur ${res.status}`, res.status, data.code);
  return data;
}

export type LatLng = { lat: number; lng: number };
export function haversine(a: LatLng, b: LatLng) {
  const R = 6371000, rad = Math.PI / 180;
  const s = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ── Sons (Web Audio : aucun fichier à charger) ─────────────────────────
let ctx: AudioContext | null = null;
export function unlockAudio() {
  try { ctx = ctx || new (window.AudioContext || (window as any).webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch { /* indisponible */ }
}
export function chime(times = 2) {
  if (!ctx || ctx.state !== 'running') return;
  for (let i = 0; i < times; i++) {
    [880, 1175].forEach((f, j) => {
      const o = ctx!.createOscillator(), g = ctx!.createGain();
      const t = ctx!.currentTime + i * 0.6 + j * 0.16;
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(ctx!.destination); o.start(t); o.stop(t + 0.32);
    });
  }
}

export function fileToDataUrl(file: File, maxSide = 1280): Promise<string> {
  // Redimensionne côté client pour limiter le poids des photos
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.82));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('Image illisible.'));
    img.src = URL.createObjectURL(file);
  });
}
