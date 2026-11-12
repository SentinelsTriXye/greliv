/**
 * Notifications push web via Firebase Cloud Messaging (optionnel).
 * Activé uniquement si les variables VITE_FIREBASE_* sont définies (voir README).
 * Sans configuration, les notifications in-app (WebSocket) restent pleinement fonctionnelles.
 */
const env = import.meta.env;
const cfg = {
  apiKey: env.VITE_FIREBASE_API_KEY, projectId: env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: env.VITE_FIREBASE_SENDER_ID, appId: env.VITE_FIREBASE_APP_ID,
};
const V = '10.14.1';

export async function registerPush(api: (m: string, p: string, b?: any) => Promise<any>) {
  if (!cfg.apiKey || !env.VITE_FIREBASE_VAPID_KEY || !('serviceWorker' in navigator) || !('Notification' in window)) return;
  try {
    if ((await Notification.requestPermission()) !== 'granted') return;
    const { initializeApp } = await import(/* @vite-ignore */ `https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
    const { getMessaging, getToken } = await import(/* @vite-ignore */ `https://www.gstatic.com/firebasejs/${V}/firebase-messaging.js`);
    const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js?' + new URLSearchParams(cfg as any));
    const token = await getToken(getMessaging(initializeApp(cfg)), { vapidKey: env.VITE_FIREBASE_VAPID_KEY, serviceWorkerRegistration: reg });
    if (token) await api('POST', '/me/devices', { token, platform: 'web' });
  } catch (e) {
    console.warn('[push] enregistrement impossible', e);
  }
}
