# GreLiv — plateforme de livraison à Grenoble (MVP)

Plateforme de livraison de repas et de produits pour Grenoble et son agglomération :
quatre interfaces (client, commerçant, livreur, administrateur), une API et une base communes,
synchronisées en temps réel. Identité bleu électrique `#1565D8` / orange vif `#FF7900`, interface en français.

> « GreLiv » est un nom de travail : il se change dans `web/index.html`, `web/public/manifest.webmanifest`
> et les libellés `brand`. **Tous les établissements, comptes et commandes fournis sont fictifs** (badge « Démo »).

## Démarrage rapide

Prérequis : Node.js ≥ 20, Docker (ou un PostgreSQL 14+ avec l'extension PostGIS).

```bash
cp .env.example .env          # la configuration par défaut suffit pour la démo
docker compose up -d          # PostgreSQL + PostGIS
npm install
npm run db:reset              # schéma + données de démonstration
npm run dev                   # API sur :4000, application web sur :5173
```

Ouvrez <http://localhost:5173> et choisissez un espace. Chaque espace garde sa propre session :
ouvrez-les dans quatre onglets pour suivre une commande de bout en bout.

| Espace | Adresse | Compte de démonstration (mot de passe `demo1234`) |
|---|---|---|
| Client | `/client` | `client@greliv.test` |
| Commerçant | `/commercant` | `resto1@greliv.test` (Pizzeria Belledonne) … `resto8@greliv.test` |
| Livreur | `/livreur` | `livreur.velo@greliv.test`, `livreur.scooter@greliv.test`, `livreur.voiture@greliv.test` |
| Administrateur | `/admin` | `admin@greliv.test` |

Comptes « en attente » pour tester la validation : `resto.attente@greliv.test`, `livreur.attente@greliv.test`.

`npm run db:reset` efface tout : **arrêtez le serveur avant** de le lancer, puis redémarrez-le.

### Scénario complet à jouer (≈ 3 minutes)

1. **Client** — connectez-vous, ouvrez *Pizzeria Belledonne*, personnalisez une pizza, ouvrez le panier,
   *Commander et payer* → carte de test `4242 4242 4242 4242` (ou `4000 0000 0000 0002` pour tester un refus).
2. **Commerçant** (`resto1`) — la commande arrive avec une alerte sonore ; choisissez le temps de préparation, *Accepter*.
3. **Livreur** (`livreur.velo`) — *Me rendre disponible* ; la proposition arrive (rémunération, distances,
   secteur de destination, compte à rebours) → *Accepter la course*. L'itinéraire vers l'établissement s'affiche.
4. **Commerçant** — *Commande prête* (il voit quel livreur arrive).
5. **Livreur** — *J'ai récupéré la commande* → trajet vers l'adresse exacte du client → saisissez le **code à 4 chiffres**
   affiché chez le client (ou photo de preuve de remise) → *Valider la livraison*.
6. **Client** — suit le livreur sur la carte pendant tout le trajet, puis note l'établissement et le livreur.
7. **Administrateur** — tableau de bord, carte en direct, commandes, remboursements, réclamations, paramètres.

**GPS du livreur** : par défaut l'écran livreur est en mode *Simulation* (position dans Grenoble qui avance le long
de l'itinéraire, ×3) pour pouvoir tester depuis un bureau. Le bouton *GPS réel* utilise la géolocalisation de l'appareil
(HTTPS requis hors `localhost`) ; il faut alors se trouver réellement dans la zone pour recevoir des courses.

### Tests automatisés

```bash
npm run test:e2e                       # 39 vérifications API : commande, paiement, attribution, livraison, remboursements
node e2e/ui-scenario.mjs ./captures    # même parcours joué dans 4 navigateurs (nécessite `npm i -D playwright`)
```

Les deux s'exécutent contre un serveur démarré sur des données fraîches (`npm run db:reset`).
Le second attend l'application compilée servie par l'API : `npm run build` puis `BASE_URL=http://localhost:4000`.

## Ce que contient le MVP

**Client** — inscription/connexion, adresse (recherche, géolocalisation ou point sur la carte), établissements proches
(liste et carte, filtres, recherche), menus avec options, panier, frais de livraison affichés avant paiement,
paiement carte / Apple Pay / Google Pay, suivi en direct sur carte avec position du livreur et heure d'arrivée,
notifications à chaque étape, messagerie et appel du livreur / de l'établissement, annulation avant acceptation,
notation, historique, réclamations, export et suppression des données.

**Commerçant** — commandes en direct avec alerte sonore, accepter (temps de préparation) / refuser (remboursement
automatique), commande prête, livreur attendu, catalogue (produits, prix, photos, options, stocks et ruptures),
horaires, mise hors ligne, chiffre d'affaires, commandes du jour, commissions, reversements.

**Livreur** — statut disponible/indisponible, consentement de géolocalisation, proposition de course à durée limitée,
itinéraire adapté au véhicule vers l'établissement puis vers le client, recalcul automatique, distance et temps
restants, kilomètres parcourus, validation par code ou photo, gains jour/semaine/mois, historique, assistance.

**Administrateur** — commandes en temps réel, carte des livraisons, validation des établissements et des livreurs,
utilisateurs, frais de livraison, commissions (globale et par établissement), rémunération des livreurs,
paramètres d'attribution, chiffre d'affaires, remboursements, réclamations, transactions, statistiques.

### Parcours d'une commande

`Commande passée → Acceptée → En préparation → Livreur attribué → Livreur en route → Commande récupérée → Livraison en cours → Livrée`

Chaque transition est une mise à jour SQL conditionnelle (`UPDATE … WHERE status = ANY(attendus)`) : un double clic ou
deux requêtes concurrentes ne peuvent pas produire un statut incohérent. Chaque changement est journalisé
(`order_events`), diffusé par WebSocket aux parties concernées et accompagné d'une notification.
Les commandes en double sont empêchées par une clé d'idempotence unique par client.

### Attribution automatique (`server/src/dispatch.ts`)

Dès l'acceptation, PostGIS cherche les livreurs vérifiés, disponibles, localisés depuis moins de 3 minutes, sans course
ni proposition en cours, dans un rayon qui s'élargit avec l'attente. Score = temps d'approche + 35 % du temps de
livraison avec leur véhicule ; les courses hors de portée du véhicule sont écartées. Le meilleur reçoit une proposition
(30 s par défaut). Refus ou silence → proposition au suivant. Tout l'état est en base : un redémarrage ne perd rien.

## Architecture

```
greliv/
├── server/               API Node.js + TypeScript (Express, ws, pg, zod, Stripe)
│   ├── migrations/       schéma PostgreSQL/PostGIS
│   ├── src/
│   │   ├── index.ts      démarrage HTTP + WebSocket, sécurité, webhook Stripe
│   │   ├── orders.ts     devis, création, machine à états, annulation
│   │   ├── dispatch.ts   attribution et réattribution des courses
│   │   ├── payments.ts   Stripe / simulateur, remboursements, reversements Connect
│   │   ├── geo.ts        distances, itinéraires (OSRM / Mapbox / estimation), géocodage (BAN)
│   │   ├── realtime.ts   hub WebSocket, notifications in-app et push FCM
│   │   ├── routes/       core (auth, client), merchant, courier, admin
│   │   └── seed.ts       données fictives de démonstration
│   └── test/scenario.ts  test de bout en bout de l'API
├── web/                  application web mobile-first (React, Vite, Leaflet)
│   └── src/              client.tsx, merchant.tsx, courier.tsx, admin.tsx, session.tsx, ui.tsx, pay.tsx
├── e2e/ui-scenario.mjs   scénario navigateur (Playwright)
└── docs/PRODUCTION.md    passage en production
```

### Écarts assumés par rapport à la pile recommandée

- **Interfaces en application web installable (PWA) plutôt qu'en React Native/Expo.** Les quatre espaces sont une
  application React mobile-first, utilisable dès maintenant sur Android et iOS depuis le navigateur (« Ajouter à l'écran
  d'accueil »). Ce choix a permis de livrer et de tester réellement le parcours complet. L'API REST + WebSocket est
  indépendante de l'interface : des applications Expo peuvent s'y brancher sans la modifier (voir `docs/PRODUCTION.md`).
- **L'administration est une route de la même application** (`/admin`) plutôt qu'un projet Next.js séparé.
- **Cartographie OpenStreetMap** (Leaflet + tuiles OSM + itinéraires OSRM + adresses BAN) : aucune clé nécessaire.
  Mapbox s'active par configuration pour les itinéraires avec trafic réel.

## Connecter les services externes

Tout se règle dans `.env` (serveur) ; redémarrez le serveur après modification.

### Stripe (paiement en mode test)

1. Créez un compte sur <https://dashboard.stripe.com>, restez en **mode test**, copiez les clés dans *Développeurs → Clés API*.
2. `.env` : `STRIPE_SECRET_KEY=sk_test_…` et `STRIPE_PUBLISHABLE_KEY=pk_test_…`.
3. Webhook (recommandé) : `stripe listen --forward-to localhost:4000/api/webhooks/stripe`, puis copiez le secret affiché
   dans `STRIPE_WEBHOOK_SECRET=whsec_…`. En production, créez l'endpoint `https://votre-domaine/api/webhooks/stripe`
   avec l'événement `payment_intent.succeeded`.
4. Apple Pay / Google Pay : activez-les dans *Paramètres → Moyens de paiement* ; pour Apple Pay, enregistrez votre domaine.
   Ils apparaissent automatiquement dans la feuille de paiement sur les appareils compatibles (HTTPS obligatoire).
5. Stripe Connect : activez Connect (comptes *Express*). Commerçants et livreurs relient leur compte depuis
   *Établissement → Configurer mes reversements* / *Compte → Configurer mes versements*. À chaque livraison, la plateforme
   vire le net au commerçant et la rémunération au livreur ; sans compte relié, la ligne reste « en attente ».

Sans clé, un **simulateur** prend le relais (aucun débit, bandeau « mode démonstration »). Dans les deux cas,
aucune donnée de carte n'est stockée : avec Stripe, elle ne transite même pas par le serveur.

### Cartes et itinéraires

- Par défaut : `ROUTING_PROVIDER=osrm` (serveurs publics `routing.openstreetmap.de`, profils vélo et voiture) et
  `GEOCODER=ban`. Si un service est injoignable, l'application bascule sur une estimation locale (distance à vol
  d'oiseau × 1,3 et vitesse moyenne du véhicule) et l'indique à l'écran.
- Mapbox : `ROUTING_PROVIDER=mapbox` et `MAPBOX_TOKEN=pk.…` (jeton créé sur <https://account.mapbox.com>) —
  profils `cycling` et `driving-traffic` (trafic en temps réel).
- Sans trafic fourni par le service, un coefficient horaire (heures de pointe) est appliqué aux scooters et voitures.

### Notifications push (Firebase Cloud Messaging)

Les notifications in-app (WebSocket) fonctionnent sans configuration. Pour le push en arrière-plan :

1. Créez un projet sur <https://console.firebase.google.com>, ajoutez une application Web.
2. *Paramètres du projet → Comptes de service → Générer une clé privée* : enregistrez le JSON hors du dépôt et
   renseignez `FCM_SERVICE_ACCOUNT=/chemin/vers/cle.json`.
3. *Cloud Messaging → Certificats Web Push* : générez la paire de clés (VAPID).
4. Créez `web/.env` :
   ```
   VITE_FIREBASE_API_KEY=…
   VITE_FIREBASE_PROJECT_ID=…
   VITE_FIREBASE_SENDER_ID=…
   VITE_FIREBASE_APP_ID=…
   VITE_FIREBASE_VAPID_KEY=…
   ```

## État des vérifications

Vérifié dans cet environnement : schéma et données, les 39 contrôles du test API, et le parcours complet joué dans
quatre navigateurs sans erreur console (simulateur de paiement, GPS simulé, itinéraires en mode estimation).

**Non vérifié ici faute d'accès réseau ou de clés** — le code est écrit, à valider de votre côté :
paiement Stripe réel (PaymentIntents, webhook, Connect), itinéraires OSRM/Mapbox, géocodage BAN, affichage des tuiles
OpenStreetMap, push FCM, et GPS réel sur un téléphone.

Passage en production : voir [`docs/PRODUCTION.md`](docs/PRODUCTION.md).
