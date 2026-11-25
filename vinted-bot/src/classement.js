// Filtrage et classement des articles trouvés.

const normaliser = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/**
 * Indique si un article passe les filtres d'une recherche.
 * Retourne { ok: true } ou { ok: false, raison }.
 */
export function filtrer(article, recherche, { maintenant = Date.now(), ageMaxMinutes } = {}) {
  const texte = normaliser(`${article.titre} ${article.marque}`);
  const prix = article.prix;

  if (recherche.prix_min != null && prix != null && prix < recherche.prix_min)
    return { ok: false, raison: 'prix trop bas' };
  if (recherche.prix_max != null && prix != null && prix > recherche.prix_max)
    return { ok: false, raison: 'prix trop haut' };

  for (const mot of recherche.mots_exclus ?? [])
    if (texte.includes(normaliser(mot))) return { ok: false, raison: `mot exclu « ${mot} »` };

  const inclus = recherche.mots_inclus ?? [];
  if (inclus.length && !inclus.every((m) => texte.includes(normaliser(m))))
    return { ok: false, raison: 'mot requis absent' };

  const tailles = recherche.tailles ?? [];
  if (tailles.length) {
    const t = normaliser(article.taille);
    const correspond = tailles.some((voulue) => {
      const v = normaliser(voulue);
      // « 42 » doit correspondre à « 42 », « EU 42 », « 42 / L » mais pas à « 42.5 »
      return new RegExp(`(^|[^0-9.,])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^0-9.,])`).test(t);
    });
    if (!correspond) return { ok: false, raison: 'taille non voulue' };
  }

  const ageMax = recherche.age_max_minutes ?? ageMaxMinutes;
  if (ageMax && article.publie_le) {
    const age = (maintenant - Date.parse(article.publie_le)) / 60000;
    if (age > ageMax) return { ok: false, raison: 'annonce trop ancienne' };
  }

  return { ok: true };
}

/**
 * Attribue une catégorie, un niveau d'affaire et un score à un article retenu.
 * Le score sert au tri « meilleures affaires » du tableau de bord.
 */
export function classer(article, recherche) {
  let affaire = 'normal';
  let score = 0;
  if (recherche.prix_cible != null && article.prix != null) {
    const ratio = article.prix / recherche.prix_cible;
    if (ratio <= 0.7) affaire = 'excellente';
    else if (ratio <= 1) affaire = 'bonne';
    score = Math.round((1 - ratio) * 100);
  }
  if (article.etat && /neuf/i.test(article.etat)) score += 10;
  return {
    ...article,
    recherche: recherche.nom,
    categorie: recherche.categorie || 'Sans catégorie',
    affaire,
    score,
  };
}
