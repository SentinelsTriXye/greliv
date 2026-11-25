// Boucle principale : parcourt chaque recherche active, filtre, classe, notifie.

import fs from 'node:fs';
import { ClientVinted, parametresRecherche } from './vinted.js';
import { filtrer, classer } from './classement.js';
import { Notificateur } from './notifications.js';

const dormir = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** Lit et valide le fichier de configuration (relu à chaque cycle : modifications à chaud). */
export function lireConfig(fichier) {
  const config = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  const noms = new Set();
  for (const r of config.recherches ?? []) {
    if (!r.nom) throw new Error('Chaque recherche doit avoir un « nom »');
    if (noms.has(r.nom)) throw new Error(`Nom de recherche en double : « ${r.nom} »`);
    if (!r.url && !r.recherche) throw new Error(`« ${r.nom} » : il faut une « url » ou une « recherche »`);
    noms.add(r.nom);
  }
  return config;
}

export class Bot {
  constructor({ fichierConfig, stockage, fetchImpl = globalThis.fetch, journal = console }) {
    this.fichierConfig = fichierConfig;
    this.stockage = stockage;
    this.journal = journal;
    this.fetch = fetchImpl;
    this.config = lireConfig(fichierConfig);
    this.client = new ClientVinted({ domaine: this.config.domaine, fetchImpl, journal });
    this.notificateur = new Notificateur({ fetchImpl, journal });
    this.erreursConsecutives = 0;
  }

  rechargerConfig() {
    try {
      const nouvelle = lireConfig(this.fichierConfig);
      if (nouvelle.domaine !== this.config.domaine)
        this.client = new ClientVinted({ domaine: nouvelle.domaine, fetchImpl: this.fetch, journal: this.journal });
      this.config = nouvelle;
    } catch (e) {
      this.journal.error(`Configuration invalide, on garde l'ancienne : ${e.message}`);
    }
  }

  /** Traite une recherche ; retourne la liste des nouveaux articles retenus. */
  async traiterRecherche(recherche) {
    const articles = await this.client.chercher(parametresRecherche(recherche));
    const premierPassage = !this.stockage.dejaInitialisee(recherche.nom);
    const nouveaux = articles.filter((a) => !this.stockage.estVu(recherche.nom, a.id));
    this.stockage.marquerVus(
      recherche.nom,
      nouveaux.map((a) => a.id),
    );

    const retenus = nouveaux
      .filter((a) => filtrer(a, recherche, { ageMaxMinutes: this.config.age_max_minutes }).ok)
      .map((a) => classer(a, recherche));

    if (premierPassage && !this.config.notifier_au_premier_passage) {
      this.journal.info(`[${recherche.nom}] premier passage : ${articles.length} annonces existantes mémorisées`);
      this.stockage.ajouterArticles(retenus);
      return [];
    }

    // Les plus anciennes d'abord pour que les alertes arrivent dans l'ordre chronologique
    for (const article of [...retenus].reverse()) {
      await this.notificateur.envoyer(article, recherche, this.config);
    }
    this.stockage.ajouterArticles(retenus);
    return retenus;
  }

  async cycle() {
    this.rechargerConfig();
    const actives = (this.config.recherches ?? []).filter((r) => r.actif !== false);
    this.stockage.nettoyer((this.config.recherches ?? []).map((r) => r.nom));
    let erreurs = 0;

    for (const [i, recherche] of actives.entries()) {
      try {
        const nouveaux = await this.traiterRecherche(recherche);
        this.stockage.noterPassage(recherche.nom, { trouves: nouveaux.length });
        if (nouveaux.length)
          this.journal.info(`[${recherche.categorie ?? '-'} › ${recherche.nom}] ${nouveaux.length} nouvelle(s) annonce(s)`);
      } catch (e) {
        erreurs++;
        this.stockage.noterPassage(recherche.nom, { erreur: e.message });
        this.journal.warn(`[${recherche.nom}] ${e.message}`);
        if (e.status === 429) break; // trop de requêtes : on arrête ce cycle
      }
      if (i < actives.length - 1) await dormir((this.config.pause_entre_recherches_secondes ?? 3) * 1000);
    }
    this.stockage.sauvegarder();
    this.erreursConsecutives = erreurs && erreurs === actives.length ? this.erreursConsecutives + 1 : 0;
  }

  /** Tourne en permanence jusqu'à l'arrêt (signal). */
  async tourner(signal) {
    this.journal.info(`Bot démarré : ${(this.config.recherches ?? []).length} recherche(s) configurée(s)`);
    while (!signal?.aborted) {
      const debut = Date.now();
      try {
        await this.cycle();
      } catch (e) {
        this.journal.error(`Cycle en échec : ${e.stack ?? e.message}`);
        this.erreursConsecutives++;
      }
      const base = (this.config.intervalle_secondes ?? 60) * 1000;
      // Recul progressif si Vinted bloque (jusqu'à 30 min), plus un peu d'aléa
      const recul = Math.min(2 ** this.erreursConsecutives, 30) * (this.erreursConsecutives ? 60_000 : 0);
      const attente = Math.max(base + recul - (Date.now() - debut), 5000) * (0.85 + Math.random() * 0.3);
      if (this.erreursConsecutives) this.journal.warn(`Pause prolongée : ${Math.round(attente / 1000)} s`);
      await dormir(attente, signal);
    }
    this.stockage.sauvegarder();
    this.journal.info('Bot arrêté proprement');
  }
}
