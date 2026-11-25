# Bot Vinted : surveiller et classer ses recherches

Le bot surveille vos recherches Vinted en continu. Il **classe** chaque annonce par catégorie et par recherche, signale les bonnes affaires et vous envoie une **alerte Discord ou Telegram** dès qu'une nouvelle annonce correspond. Il tourne **en permanence** et redémarre tout seul.

- Node.js ≥ 20, **aucune dépendance** à installer
- Recherches rangées par **catégories** (ex. « Sneakers », « Revente », « Perso »), avec une couleur et un salon Discord par catégorie
- Filtres en plus de ceux de Vinted : prix min/max, mots obligatoires, mots interdits, tailles exactes, âge maximum de l'annonce
- Niveau d'affaire calculé à partir d'un `prix_cible` : 🔥 excellente (≤ 70 % du prix cible), ✅ bonne (≤ 100 %)
- Tableau de bord web (`http://localhost:8080`) : annonces par catégorie et par recherche, tri par date, prix ou meilleure affaire
- `config.json` est relu à chaque cycle : vous pouvez ajouter, modifier ou mettre en pause une recherche **sans redémarrer**
- Pas de doublons, et pas de rafale d'alertes au démarrage : les annonces déjà en ligne sont mémorisées sans être envoyées
- Si Vinted bloque (erreur 429/403), le bot renouvelle sa session puis espace ses requêtes, jusqu'à 30 min de pause

## Installation

```bash
cd vinted-bot
cp config.example.json config.json   # puis éditez vos recherches
npm start                            # ou : node src/index.js
```

`npm run once` lance un seul passage, pratique pour tester. `npm test` lance les tests.

## Configurer ses recherches (`config.json`)

Le plus simple : faites votre recherche sur vinted.fr avec tous les filtres voulus (marque, taille, état, catégorie…), puis **copiez l'URL** dans le champ `url`.

```json
{
  "nom": "Nike Dunk Low 42-43",
  "categorie": "Sneakers",
  "url": "https://www.vinted.fr/catalog?search_text=nike%20dunk&brand_ids[]=53",
  "prix_max": 80,
  "prix_cible": 50,
  "mots_inclus": ["dunk"],
  "mots_exclus": ["enfant", "replica"],
  "tailles": ["42", "42.5", "43"]
}
```

| Champ | Rôle |
|---|---|
| `nom` | Nom unique de la recherche (obligatoire) |
| `categorie` | Catégorie de classement (dossier dans le tableau de bord) |
| `url` **ou** `recherche` | URL Vinted copiée, ou simple texte recherché |
| `prix_min`, `prix_max` | Fourchette de prix en € |
| `prix_cible` | Prix sous lequel l'annonce est une « bonne affaire » |
| `mots_inclus` / `mots_exclus` | Mots obligatoires / interdits dans le titre ou la marque (accents ignorés) |
| `tailles` | Tailles acceptées (« 42 » ne correspond pas à « 42.5 ») |
| `age_max_minutes` | Ignore les annonces publiées depuis plus longtemps |
| `actif` | `false` pour mettre la recherche en pause |
| `discord_webhook` | Salon Discord propre à cette recherche (sinon celui de la catégorie, sinon le global) |

Réglages généraux : `domaine` (`vinted.fr`, `vinted.be`, `vinted.es`…), `intervalle_secondes` (60 conseillé, ne descendez pas trop bas), `pause_entre_recherches_secondes`, `notifier_au_premier_passage`, `tableau_de_bord.port` et `tableau_de_bord.mot_de_passe`.

### Alertes Discord

Dans le salon Discord, ouvrez *Paramètres du salon → Intégrations → Webhooks → Nouveau webhook*, copiez l'URL et collez-la dans `notifications.discord_webhook`. Pour avoir **un salon par catégorie**, créez un webhook par salon et collez chaque URL dans `categories.<Nom>.discord_webhook`.

### Alertes Telegram

Créez un bot avec [@BotFather](https://t.me/BotFather) pour obtenir le `token`. Envoyez-lui un message, puis récupérez votre `chat_id` sur `https://api.telegram.org/bot<TOKEN>/getUpdates`. Renseignez les deux dans `notifications.telegram`.

## Le faire tourner en permanence

Choisissez une des trois méthodes, sur un serveur ou une machine toujours allumée (VPS, Raspberry Pi…).

**Docker** (le plus simple) :
```bash
docker compose up -d --build     # démarre et redémarre automatiquement
docker compose logs -f           # suivre les logs
```

**pm2** :
```bash
npm install -g pm2
pm2 start deploy/ecosystem.config.cjs
pm2 save && pm2 startup          # relance au redémarrage de la machine
pm2 logs vinted-bot
```

**systemd** (Linux) : copiez le dossier dans `/opt/vinted-bot` et `deploy/vinted-bot.service` dans `/etc/systemd/system/`, remplacez `User=` par votre nom d'utilisateur, puis lancez `sudo systemctl enable --now vinted-bot`.

Si le tableau de bord est accessible depuis Internet, définissez `tableau_de_bord.mot_de_passe` (ou la variable `DASHBOARD_PASSWORD`). L'identifiant demandé par le navigateur peut être n'importe lequel.

## Points d'accès

- `/` : tableau de bord (rafraîchi toutes les 60 s)
- `/api/articles` : annonces retenues, au format JSON
- `/sante` : état de chaque recherche (dernier passage, dernière erreur), utile pour une supervision

## Bon à savoir

Le bot interroge l'API publique utilisée par le site vinted.fr, à un rythme modéré. Cette API n'est pas officielle : Vinted peut la modifier ou limiter les accès automatisés, et ses conditions d'utilisation encadrent ce type d'usage. Gardez un intervalle raisonnable et réservez le bot à un usage personnel. L'état (annonces vues, historique) est stocké dans `data/etat.json`.
