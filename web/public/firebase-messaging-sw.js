/* Service worker Firebase Cloud Messaging (notifications en arrière-plan).
   La configuration est transmise dans l'URL d'enregistrement par src/push.ts. */
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
const cfg = Object.fromEntries(new URL(location.href).searchParams);
if (cfg.apiKey) {
  firebase.initializeApp(cfg);
  firebase.messaging(); // affiche automatiquement les messages « notification »
}
