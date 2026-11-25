// Client minimal pour l'API catalogue publique de Vinted.
// Vinted exige un cookie de session obtenu en visitant la page d'accueil :
// on le récupère au démarrage et on le renouvelle en cas de 401/403.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class VintedError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Convertit une URL de recherche Vinted (copiée depuis le navigateur)
 * en paramètres pour l'API : catalog[]=1&brand_ids[]=53 → catalog_ids=1, brand_ids=53.
 */
export function urlVersParametres(url) {
  const u = new URL(url);
  const multi = new Map();
  const simple = {};
  for (const [cle, valeur] of u.searchParams) {
    if (cle.endsWith('[]')) {
      let nom = cle.slice(0, -2);
      if (nom === 'catalog') nom = 'catalog_ids';
      if (!multi.has(nom)) multi.set(nom, []);
      multi.get(nom).push(valeur);
    } else {
      simple[cle] = valeur;
    }
  }
  for (const [nom, valeurs] of multi) simple[nom] = valeurs.join(',');
  // Paramètres propres à l'interface web, inutiles pour l'API
  delete simple.time;
  delete simple.search_id;
  delete simple.page;
  return simple;
}

/** Construit les paramètres API d'une recherche de la configuration. */
export function parametresRecherche(recherche) {
  const p = recherche.url ? urlVersParametres(recherche.url) : {};
  if (recherche.recherche) p.search_text = recherche.recherche;
  if (recherche.prix_min != null && p.price_from == null) p.price_from = String(recherche.prix_min);
  if (recherche.prix_max != null && p.price_to == null) p.price_to = String(recherche.prix_max);
  if (!p.order) p.order = 'newest_first';
  p.per_page = '96';
  p.page = '1';
  return p;
}

/** Normalise un article de l'API en un objet stable, quel que soit le format renvoyé. */
export function normaliserArticle(brut, domaine) {
  const montant = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return Number.parseFloat(v.amount);
    return Number.parseFloat(v);
  };
  const prix = montant(brut.price);
  const prixTotal = montant(brut.total_item_price) ?? prix;
  const devise =
    (typeof brut.price === 'object' && brut.price?.currency_code) || brut.currency || 'EUR';
  const horodatage = brut.photo?.high_resolution?.timestamp;
  return {
    id: String(brut.id),
    titre: brut.title ?? '',
    prix,
    prix_total: prixTotal,
    devise,
    marque: brut.brand_title ?? '',
    taille: brut.size_title ?? '',
    etat: brut.status ?? '',
    url: brut.url || `https://www.${domaine}/items/${brut.id}`,
    photo: brut.photo?.url ?? brut.photo?.thumbnails?.[0]?.url ?? null,
    vendeur: brut.user?.login ?? '',
    favoris: brut.favourite_count ?? 0,
    publie_le: horodatage ? new Date(horodatage * 1000).toISOString() : null,
  };
}

export class ClientVinted {
  constructor({ domaine = 'vinted.fr', fetchImpl = globalThis.fetch, journal = console } = {}) {
    this.base = `https://www.${domaine}`;
    this.domaine = domaine;
    this.fetch = fetchImpl;
    this.journal = journal;
    this.cookies = '';
  }

  async ouvrirSession() {
    const rep = await this.fetch(this.base + '/', {
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'fr-FR,fr;q=0.9' },
      redirect: 'follow',
    });
    const brut =
      typeof rep.headers.getSetCookie === 'function'
        ? rep.headers.getSetCookie()
        : [rep.headers.get('set-cookie')].filter(Boolean);
    this.cookies = brut
      .map((c) => c.split(';')[0])
      .filter(Boolean)
      .join('; ');
    if (!this.cookies) throw new VintedError("Impossible d'obtenir un cookie de session Vinted", rep.status);
    this.journal.info?.('Session Vinted ouverte');
  }

  async chercher(params, { nouvelEssai = true } = {}) {
    if (!this.cookies) await this.ouvrirSession();
    const url = `${this.base}/api/v2/catalog/items?${new URLSearchParams(params)}`;
    const rep = await this.fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        Referer: this.base + '/catalog',
        Cookie: this.cookies,
      },
    });
    if ((rep.status === 401 || rep.status === 403) && nouvelEssai) {
      this.cookies = '';
      return this.chercher(params, { nouvelEssai: false });
    }
    if (!rep.ok) throw new VintedError(`Vinted a répondu ${rep.status}`, rep.status);
    const json = await rep.json();
    return (json.items ?? []).map((a) => normaliserArticle(a, this.domaine));
  }
}
