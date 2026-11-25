// Persistance simple dans un fichier JSON (aucune dépendance).
// Garde les identifiants déjà vus par recherche et les derniers articles retenus.

import fs from 'node:fs';
import path from 'node:path';

const MAX_VUS_PAR_RECHERCHE = 2000;

export class Stockage {
  constructor(fichier, { maxArticles = 3000 } = {}) {
    this.fichier = fichier;
    this.maxArticles = maxArticles;
    this.etat = { vus: {}, articles: [], stats: {} };
    this.charger();
  }

  charger() {
    try {
      const contenu = JSON.parse(fs.readFileSync(this.fichier, 'utf8'));
      this.etat = { vus: {}, articles: [], stats: {}, ...contenu };
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`État illisible (${e.message}), on repart de zéro`);
    }
  }

  sauvegarder() {
    fs.mkdirSync(path.dirname(this.fichier), { recursive: true });
    const tmp = this.fichier + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.etat));
    fs.renameSync(tmp, this.fichier);
  }

  dejaInitialisee(nomRecherche) {
    return Object.hasOwn(this.etat.vus, nomRecherche);
  }

  estVu(nomRecherche, id) {
    return (this.etat.vus[nomRecherche] ?? []).includes(id);
  }

  marquerVus(nomRecherche, ids) {
    const liste = this.etat.vus[nomRecherche] ?? [];
    const ensemble = new Set(liste);
    for (const id of ids) if (!ensemble.has(id)) liste.push(id);
    this.etat.vus[nomRecherche] = liste.slice(-MAX_VUS_PAR_RECHERCHE);
  }

  ajouterArticles(articles) {
    const date = new Date().toISOString();
    this.etat.articles.unshift(...articles.map((a) => ({ ...a, trouve_le: date })));
    this.etat.articles.length = Math.min(this.etat.articles.length, this.maxArticles);
  }

  noterPassage(nomRecherche, { trouves = 0, erreur = null } = {}) {
    const s = this.etat.stats[nomRecherche] ?? { total: 0 };
    s.dernier_passage = new Date().toISOString();
    s.total += trouves;
    s.derniere_erreur = erreur;
    this.etat.stats[nomRecherche] = s;
  }

  /** Supprime l'historique des recherches qui n'existent plus dans la configuration. */
  nettoyer(nomsActuels) {
    const garder = new Set(nomsActuels);
    for (const nom of Object.keys(this.etat.vus)) if (!garder.has(nom)) delete this.etat.vus[nom];
    for (const nom of Object.keys(this.etat.stats)) if (!garder.has(nom)) delete this.etat.stats[nom];
  }
}
