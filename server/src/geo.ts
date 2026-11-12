import { config } from './config.js';

export type LatLng = { lat: number; lng: number };
export type Vehicle = 'bike' | 'ebike' | 'scooter' | 'car';
export type Route = {
  distance_m: number; duration_s: number; geometry: [number, number][];
  steps: { instruction: string; distance_m: number }[]; source: string;
};

export const GRENOBLE: LatLng = { lat: 45.1885, lng: 5.7245 };
export const SERVICE_RADIUS_KM = 12;

export function haversine(a: LatLng, b: LatLng): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
/** Distance « par la route » estimée sans appel externe (détour urbain moyen ≈ 30 %). */
export const roadDistance = (a: LatLng, b: LatLng) => Math.round(haversine(a, b) * 1.3);
export const inServiceArea = (p: LatLng) => haversine(p, GRENOBLE) <= SERVICE_RADIUS_KM * 1000;

/** Vitesses moyennes en ville (km/h). */
export const SPEED_KMH: Record<Vehicle, number> = { bike: 15, ebike: 20, scooter: 28, car: 25 };
/** Portée maximale d'une course (approche + livraison) selon le véhicule, en mètres. */
export const MAX_RANGE_M: Record<Vehicle, number> = { bike: 7000, ebike: 11000, scooter: 20000, car: 40000 };

/** Coefficient de circulation (heure de Paris). Les vélos ne sont pas affectés. */
export function trafficFactor(vehicle: Vehicle, date = new Date()): number {
  if (vehicle === 'bike' || vehicle === 'ebike') return 1;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const t = Number(get('hour')) + Number(get('minute')) / 60;
  const weekend = ['Sat', 'Sun'].includes(get('weekday'));
  let f = 1;
  if (!weekend && ((t >= 7.5 && t <= 9.5) || (t >= 16.5 && t <= 19))) f = 1.35;
  else if (t >= 12 && t <= 13.5) f = 1.12;
  return vehicle === 'scooter' ? 1 + (f - 1) / 2 : f;
}
export function travelSeconds(distance_m: number, vehicle: Vehicle): number {
  return Math.round((distance_m / 1000 / SPEED_KMH[vehicle]) * 3600 * trafficFactor(vehicle));
}

// ── Itinéraires ────────────────────────────────────────────────────────
let providerDownUntil = 0; // coupe-circuit : évite d'attendre un fournisseur injoignable

function fallbackRoute(a: LatLng, b: LatLng, vehicle: Vehicle): Route {
  const d = roadDistance(a, b);
  const n = 24;
  const geometry = Array.from({ length: n + 1 }, (_, i) => [a.lat + ((b.lat - a.lat) * i) / n, a.lng + ((b.lng - a.lng) * i) / n] as [number, number]);
  return { distance_m: d, duration_s: travelSeconds(d, vehicle), geometry, steps: [{ instruction: 'Rejoindre la destination (trajet estimé)', distance_m: d }], source: 'estimation' };
}

const MODIFIER: Record<string, string> = {
  left: 'à gauche', right: 'à droite', 'slight left': 'légèrement à gauche', 'slight right': 'légèrement à droite',
  'sharp left': 'franchement à gauche', 'sharp right': 'franchement à droite', straight: 'tout droit', uturn: 'demi-tour',
};
function frInstruction(step: any): string {
  const m = step.maneuver || {}; const name = step.name ? ` sur ${step.name}` : '';
  const mod = MODIFIER[m.modifier] || '';
  switch (m.type) {
    case 'depart': return `Départ${name}`;
    case 'arrive': return 'Vous êtes arrivé';
    case 'roundabout': case 'rotary': return `Au rond-point, prendre la sortie ${m.exit ?? ''}${name}`.trim();
    case 'turn': case 'end of road': case 'fork': return `Tourner ${mod}${name}`;
    case 'new name': case 'continue': return `Continuer ${mod}${name}`.replace('  ', ' ');
    default: return `Continuer${name}`;
  }
}

async function fetchJson(url: string, ms = 2500): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'delivery-mvp' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Itinéraire adapté au véhicule. Fournisseur externe si disponible, sinon estimation locale. */
export async function getRoute(a: LatLng, b: LatLng, vehicle: Vehicle): Promise<Route> {
  if (config.routingProvider === 'none' || Date.now() < providerDownUntil) return fallbackRoute(a, b, vehicle);
  const coords = `${a.lng},${a.lat};${b.lng},${b.lat}`;
  const cyclist = vehicle === 'bike' || vehicle === 'ebike';
  try {
    let url: string; let hasTraffic = false;
    if (config.routingProvider === 'mapbox' && config.mapboxToken) {
      const profile = cyclist ? 'cycling' : 'driving-traffic';
      hasTraffic = !cyclist;
      url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords}?geometries=geojson&overview=full&steps=true&language=fr&access_token=${config.mapboxToken}`;
    } else {
      url = `${cyclist ? config.osrmBike : config.osrmCar}/route/v1/driving/${coords}?geometries=geojson&overview=full&steps=true`;
    }
    const data = await fetchJson(url);
    const r = data.routes?.[0];
    if (!r) throw new Error('aucun itinéraire');
    let duration = r.duration as number;
    // Ajustements : VAE plus rapide qu'un vélo, scooter ≈ voiture ; trafic heuristique si le fournisseur n'en a pas
    if (vehicle === 'ebike') duration *= SPEED_KMH.bike / SPEED_KMH.ebike;
    if (!hasTraffic) duration *= trafficFactor(vehicle);
    return {
      distance_m: Math.round(r.distance), duration_s: Math.round(duration),
      geometry: r.geometry.coordinates.map((c: number[]) => [c[1], c[0]]),
      steps: (r.legs?.[0]?.steps || []).map((s: any) => ({ instruction: s.maneuver?.instruction || frInstruction(s), distance_m: Math.round(s.distance) })),
      source: config.routingProvider,
    };
  } catch (e: any) {
    providerDownUntil = Date.now() + 60_000;
    console.warn(`[geo] itinéraire externe indisponible (${e.message}) — estimation locale pendant 60 s`);
    return fallbackRoute(a, b, vehicle);
  }
}

// ── Géocodage ──────────────────────────────────────────────────────────
// Liste locale de secours (lieux publics de Grenoble) utilisée si la BAN est injoignable.
const LOCAL_ADDRESSES: { label: string; lat: number; lng: number }[] = [
  ['Place Victor Hugo, 38000 Grenoble', 45.1889, 5.7228], ['Place Grenette, 38000 Grenoble', 45.1903, 5.7272],
  ['Place Notre-Dame, 38000 Grenoble', 45.1929, 5.7318], ['Place Saint-Bruno, 38000 Grenoble', 45.1883, 5.7133],
  ['Gare de Grenoble, Place de la Gare, 38000 Grenoble', 45.1915, 5.7146], ['Cours Jean Jaurès, 38000 Grenoble', 45.1840, 5.7190],
  ['Avenue Alsace-Lorraine, 38000 Grenoble', 45.1895, 5.7185], ['Boulevard Gambetta, 38000 Grenoble', 45.1862, 5.7226],
  ['Rue Félix Poulat, 38000 Grenoble', 45.1896, 5.7259], ['Quai Stéphane Jay, 38000 Grenoble', 45.1930, 5.7275],
  ['Caserne de Bonne, 38000 Grenoble', 45.1832, 5.7252], ['Place Championnet, 38000 Grenoble', 45.1846, 5.7235],
  ['Avenue Maréchal Randon, Île Verte, 38000 Grenoble', 45.1975, 5.7370], ['Parc Paul Mistral, 38000 Grenoble', 45.1853, 5.7372],
  ['Place Schuman, Europole, 38000 Grenoble', 45.1929, 5.7093], ['Avenue Jean Perrot, 38100 Grenoble', 45.1740, 5.7380],
  ['Grand\'Place, 38100 Grenoble', 45.1585, 5.7320], ['Cours de la Libération, 38100 Grenoble', 45.1700, 5.7130],
  ['Avenue Gabriel Péri, 38400 Saint-Martin-d\'Hères', 45.1830, 5.7560], ['Domaine Universitaire, 38400 Saint-Martin-d\'Hères', 45.1930, 5.7680],
  ['Avenue de Verdun, 38240 Meylan', 45.2090, 5.7790], ['Grande Rue, 38700 La Tronche', 45.2045, 5.7400],
  ['Avenue Aristide Briand, 38600 Fontaine', 45.1930, 5.6880], ['Cours Jean Jaurès, 38130 Échirolles', 45.1460, 5.7180],
  ['Avenue Ambroise Croizat, 38400 Saint-Martin-d\'Hères', 45.1760, 5.7650], ['Place Vaucanson, 38000 Grenoble', 45.1880, 5.7262],
].map(([label, lat, lng]) => ({ label: label as string, lat: lat as number, lng: lng as number }));

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export async function geocode(query: string) {
  const qy = query.trim();
  if (qy.length < 3) return [];
  if (config.geocoder === 'ban') {
    try {
      const data = await fetchJson(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(qy)}&lat=${GRENOBLE.lat}&lon=${GRENOBLE.lng}&limit=8`, 2000);
      const res = (data.features || [])
        .map((f: any) => ({ label: f.properties.label as string, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }))
        .filter((r: any) => inServiceArea(r));
      if (res.length) return res.slice(0, 6);
    } catch { /* secours local */ }
  }
  const words = norm(qy).split(/\s+/).filter((w) => !/^\d+$/.test(w));
  const num = qy.match(/^\s*(\d+\s*(bis|ter)?)/i)?.[1];
  return LOCAL_ADDRESSES.filter((a) => words.every((w) => norm(a.label).includes(w))).slice(0, 6)
    .map((a) => ({ ...a, label: num ? `${num} ${a.label}` : a.label }));
}

export async function reverseGeocode(p: LatLng): Promise<string> {
  if (config.geocoder === 'ban') {
    try {
      const data = await fetchJson(`https://api-adresse.data.gouv.fr/reverse/?lat=${p.lat}&lon=${p.lng}`, 2000);
      const label = data.features?.[0]?.properties?.label;
      if (label) return label;
    } catch { /* secours local */ }
  }
  const nearest = [...LOCAL_ADDRESSES].sort((a, b) => haversine(a, p) - haversine(b, p))[0];
  return haversine(nearest, p) < 400 ? `Près de ${nearest.label}` : `Point sur la carte (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})`;
}

/** Adresse approximative montrée au livreur avant la prise en charge (sans numéro de rue). */
export const approxAddress = (address: string) => address.replace(/^\s*\d+\s*(bis|ter)?[ ,]*/i, '').trim();
