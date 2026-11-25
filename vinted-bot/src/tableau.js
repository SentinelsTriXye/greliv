// Petit tableau de bord web : annonces classées par catégorie et par recherche.

import http from 'node:http';

const echapper = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function pageHtml(etat, config, requete) {
  const categorie = requete.searchParams.get('categorie') ?? '';
  const recherche = requete.searchParams.get('recherche') ?? '';
  const tri = requete.searchParams.get('tri') ?? 'recent';

  let articles = etat.articles.filter(
    (a) => (!categorie || a.categorie === categorie) && (!recherche || a.recherche === recherche),
  );
  if (tri === 'prix') articles = [...articles].sort((a, b) => (a.prix ?? 1e9) - (b.prix ?? 1e9));
  if (tri === 'affaire') articles = [...articles].sort((a, b) => b.score - a.score);
  articles = articles.slice(0, 300);

  const recherches = config.recherches ?? [];
  const parCategorie = new Map();
  for (const r of recherches) {
    const c = r.categorie || 'Sans catégorie';
    if (!parCategorie.has(c)) parCategorie.set(c, []);
    parCategorie.get(c).push(r);
  }

  const lien = (p) => {
    const q = new URLSearchParams({ categorie, recherche, tri, ...p });
    for (const [k, v] of [...q]) if (!v) q.delete(k);
    return '?' + q;
  };

  const menu = [...parCategorie]
    .map(([c, rs]) => {
      const couleur = config.categories?.[c]?.couleur ?? '#09B1BA';
      const items = rs
        .map((r) => {
          const s = etat.stats[r.nom] ?? {};
          const statut = r.actif === false ? 'pause' : s.derniere_erreur ? 'erreur' : 'ok';
          return `<li><a class="${recherche === r.nom ? 'actif' : ''}" href="${lien({ categorie: '', recherche: r.nom })}">
            <span class="pastille ${statut}" title="${echapper(s.derniere_erreur ?? statut)}"></span>${echapper(r.nom)}
            <small>${s.total ?? 0}</small></a></li>`;
        })
        .join('');
      return `<section><a class="cat ${categorie === c ? 'actif' : ''}" style="--c:${echapper(couleur)}"
        href="${lien({ categorie: c, recherche: '' })}">${echapper(c)}</a><ul>${items}</ul></section>`;
    })
    .join('');

  const cartes = articles
    .map(
      (a) => `<a class="carte ${a.affaire}" href="${echapper(a.url)}" target="_blank" rel="noopener">
      ${a.photo ? `<img loading="lazy" src="${echapper(a.photo)}" alt="">` : '<div class="img"></div>'}
      <div class="info">
        <strong>${a.prix != null ? a.prix.toFixed(2).replace('.', ',') + ' €' : '?'}</strong>
        ${a.affaire !== 'normal' ? `<span class="badge">${a.affaire === 'excellente' ? '🔥' : '✅'} ${a.affaire}</span>` : ''}
        <p>${echapper(a.titre)}</p>
        <small>${echapper([a.marque, a.taille, a.etat].filter(Boolean).join(' · '))}</small>
        <small class="meta">${echapper(a.categorie)} › ${echapper(a.recherche)} · ${new Date(a.trouve_le).toLocaleString('fr-FR')}</small>
      </div></a>`,
    )
    .join('');

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<title>Bot Vinted</title><style>
:root{--fond:#f6f7f8;--carte:#fff;--texte:#1d1d1f;--doux:#6b7280;--bord:#e5e7eb;--acc:#09B1BA}
@media (prefers-color-scheme:dark){:root{--fond:#111315;--carte:#1b1e21;--texte:#ececec;--doux:#9aa1a9;--bord:#2b2f33}}
*{box-sizing:border-box}body{margin:0;font:14px system-ui,sans-serif;background:var(--fond);color:var(--texte)}
a{color:inherit;text-decoration:none}.app{display:grid;grid-template-columns:260px 1fr;min-height:100vh}
nav{border-right:1px solid var(--bord);padding:16px;background:var(--carte)}nav h1{font-size:18px;margin:0 0 12px}
.cat{display:block;font-weight:600;margin-top:14px;padding:4px 8px;border-left:4px solid var(--c);border-radius:4px}
nav ul{list-style:none;margin:4px 0;padding:0}nav li a{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:6px}
nav li small{margin-left:auto;color:var(--doux)}.actif{background:color-mix(in srgb,var(--acc) 15%,transparent)}
.pastille{width:8px;height:8px;border-radius:50%;background:#22c55e;flex:none}.pastille.erreur{background:#ef4444}.pastille.pause{background:#9ca3af}
main{padding:16px}.barre{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:center}
.barre a{padding:6px 12px;border:1px solid var(--bord);border-radius:999px;background:var(--carte)}
.grille{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.carte{background:var(--carte);border:1px solid var(--bord);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.carte.excellente{border-color:#f97316}.carte.bonne{border-color:#22c55e}
.carte img,.carte .img{width:100%;aspect-ratio:3/4;object-fit:cover;background:var(--bord)}
.info{padding:8px;display:flex;flex-direction:column;gap:2px}.info p{margin:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.info small{color:var(--doux)}.badge{font-size:12px}.meta{font-size:11px}
@media (max-width:700px){.app{grid-template-columns:1fr}nav{border-right:0;border-bottom:1px solid var(--bord)}main{padding:16px}}
</style></head><body><div class="app"><nav><h1>🧺 Bot Vinted</h1>
<a class="cat ${!categorie && !recherche ? 'actif' : ''}" style="--c:var(--doux)" href="${lien({ categorie: '', recherche: '' })}">Tout</a>
${menu}</nav><main><div class="barre"><span>Trier :</span>
<a class="${tri === 'recent' ? 'actif' : ''}" href="${lien({ tri: 'recent' })}">Plus récents</a>
<a class="${tri === 'prix' ? 'actif' : ''}" href="${lien({ tri: 'prix' })}">Prix croissant</a>
<a class="${tri === 'affaire' ? 'actif' : ''}" href="${lien({ tri: 'affaire' })}">Meilleures affaires</a>
<span style="margin-left:auto;color:var(--doux)">${articles.length} annonce(s)</span></div>
<div class="grille">${cartes || '<p>Aucune annonce pour le moment.</p>'}</div></main></div></body></html>`;
}

export function demarrerTableau({ stockage, lireConfig, port, motDePasse, journal = console }) {
  const serveur = http.createServer((req, res) => {
    if (motDePasse) {
      const [, b64] = (req.headers.authorization ?? '').split(' ');
      const mdp = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
      if (mdp !== motDePasse) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Bot Vinted"' });
        return res.end('Authentification requise');
      }
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/sante') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, stats: stockage.etat.stats }));
    }
    if (url.pathname === '/api/articles') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(stockage.etat.articles));
    }
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pageHtml(stockage.etat, lireConfig(), url));
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }
  });
  serveur.listen(port, () => journal.info(`Tableau de bord : http://localhost:${port}`));
  return serveur;
}
