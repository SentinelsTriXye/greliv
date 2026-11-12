# Passage en production

## 1. Avant d'ouvrir au public (bloquant)

| Sujet | À faire |
|---|---|
| Secrets | `JWT_SECRET` aléatoire (≥ 32 caractères) ; `NODE_ENV=production` (le serveur refuse de démarrer avec le secret par défaut) ; `CORS_ORIGIN` limité à votre domaine. |
| Données de démo | Ne lancez **pas** `db:seed` en production. Créez l'administrateur à la main (voir § 3). |
| HTTPS | Obligatoire : géolocalisation, Apple Pay/Google Pay et push ne fonctionnent qu'en HTTPS. |
| Stripe | Passez les clés en mode live, créez le webhook de production, finalisez l'activation Connect (vérification d'identité de la plateforme). |
| Tuiles de carte | Les serveurs publics d'OpenStreetMap et d'OSRM interdisent l'usage commercial intensif. Prenez un fournisseur (Mapbox, MapTiler, Stadia, Geoapify) ou hébergez OSRM. L'URL des tuiles est dans `web/src/ui.tsx`, celles d'OSRM dans `.env`. |
| Juridique | CGU/CGV, politique de confidentialité, mentions légales, bandeau cookies si traceurs ; registre des traitements RGPD ; contrat de sous-traitance avec l'hébergeur et Stripe. |
| Statut des livreurs | Vérification d'identité et du statut (auto-entrepreneur, assurance, titre de séjour) : la validation admin n'est qu'un interrupteur, la collecte des justificatifs reste à organiser. |
| Fiscalité | Facturation des commissions aux commerçants, TVA, obligations déclaratives des plateformes (DAC7). À cadrer avec un expert-comptable. |

## 2. Hébergement

Le serveur sert aussi l'application compilée : un seul service à déployer.

```bash
npm ci && npm run build
NODE_ENV=production node server/dist/index.js   # applique les migrations au démarrage
```

- **Base** : PostgreSQL managé avec PostGIS (Scaleway, OVHcloud, Clever Cloud, Supabase, RDS…), sauvegardes
  quotidiennes et restauration testée. Hébergement en UE recommandé (RGPD).
- **Application** : conteneur ou PaaS (Clever Cloud, Scalingo, Render, Fly.io) derrière un proxy TLS qui laisse passer
  les WebSockets (`/ws`).
- **Fichiers** : les photos sont écrites dans `UPLOAD_DIR`. Montez un volume persistant ou remplacez l'écriture disque
  de `POST /api/uploads` par un stockage objet (S3, Scaleway Object Storage).
- **Supervision** : sonde sur `/api/health`, collecte des logs, alertes d'erreurs (Sentry).

## 3. Créer le premier administrateur

```bash
node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" 'MotDePasseSolide'
```
```sql
INSERT INTO users(role, email, password_hash, name) VALUES ('admin', 'vous@domaine.fr', '<hash>', 'Votre nom');
```
Puis, dans *Paramètres*, cochez « Appliquer les horaires d'ouverture » et réglez frais, commission et rémunération.

## 4. Monter en charge

L'architecture tient sur une instance pour un lancement (quelques centaines de commandes par jour). Ensuite :

1. **Plusieurs instances API** : le hub WebSocket (`realtime.ts`) est en mémoire. Publiez les événements dans Redis
   Pub/Sub pour que chaque instance les relaie à ses sockets ; la fonction `send` est le seul point à modifier.
2. **Boucle d'attribution** (`dispatch.ts`) : elle tourne dans chaque processus. Avec plusieurs instances, protégez-la
   par un verrou (`pg_advisory_lock`) ou déplacez-la dans un worker (BullMQ). Les index uniques sur `offers`
   garantissent déjà qu'il n'y a jamais deux propositions actives pour une commande ou un livreur.
3. **Positions GPS** : une écriture toutes les 3 s par livreur actif. Au-delà de quelques centaines de livreurs,
   stockez la position courante dans Redis (GEO) et n'écrivez en base qu'aux changements d'étape.
4. **Lectures** : pagination des listes (limitées à 100–300 lignes aujourd'hui), réplica de lecture pour les statistiques.
5. **Sessions** : jetons JWT de 7 jours sans révocation. Ajoutez des jetons de rafraîchissement courts et une liste de
   révocation ; envisagez la double authentification pour l'administration.

## 5. Applications mobiles natives (React Native / Expo)

L'API est prête : authentification `Bearer`, REST sous `/api`, WebSocket sur `/ws?token=…`.

- Réutilisez `web/src/lib.ts` (formats, statuts, client HTTP) et la logique de `session.tsx`.
- Carte : `react-native-maps` ou `@rnmapbox/maps`. GPS livreur en arrière-plan : `expo-location` avec
  `startLocationUpdatesAsync` vers `POST /api/courier/location` — c'est le principal gain du natif : le suivi continue
  écran éteint, ce qu'un navigateur ne garantit pas.
- Paiement : `@stripe/stripe-react-native` (PaymentSheet) avec le `clientSecret` renvoyé par `POST /api/orders`.
- Push : `expo-notifications`, jeton FCM envoyé à `POST /api/me/devices` (déjà géré côté serveur).
- Publication : comptes Apple Developer et Google Play, fiches de confidentialité (localisation en arrière-plan à justifier).

## 6. Limites connues du MVP

- Les frais de livraison et l'heure d'arrivée affichée au client reposent sur une distance estimée (vol d'oiseau × 1,3),
  pas sur l'itinéraire réel ; l'itinéraire réel n'est utilisé que pour la navigation.
- Un livreur ne prend qu'une course à la fois (pas de regroupement de commandes).
- Un compte commerçant gère un seul établissement.
- Remboursement partiel après livraison : le montant est rendu au client, mais les virements déjà faits au commerçant
  et au livreur ne sont pas repris automatiquement (à régulariser dans Stripe).
- Pas de pourboire, de code promotionnel ni de commande programmée.
- Suivi GPS dans le navigateur : il s'interrompt si le téléphone du livreur verrouille l'écran (voir § 5).
- Aucune limite de zone au-delà d'un rayon de 12 km autour du centre de Grenoble (`server/src/geo.ts`).
