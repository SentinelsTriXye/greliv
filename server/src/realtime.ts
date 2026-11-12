import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { userFromToken } from './http.js';
import { config } from './config.js';
import { q } from './db.js';

/**
 * Hub WebSocket : chaque utilisateur connecté reçoit les événements qui le concernent.
 * Pour plusieurs instances serveur, remplacer `send` par une publication Redis Pub/Sub
 * (chaque instance relaie alors vers ses propres sockets).
 */
const byUser = new Map<string, Set<WebSocket>>();
const admins = new Set<WebSocket>();

export function attachRealtime(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', async (ws, req) => {
    const token = new URL(req.url || '', 'http://x').searchParams.get('token') || '';
    const user = await userFromToken(token);
    if (!user) return ws.close(4401, 'unauthorized');
    if (!byUser.has(user.id)) byUser.set(user.id, new Set());
    byUser.get(user.id)!.add(ws);
    if (user.role === 'admin') admins.add(ws);
    (ws as any).alive = true;
    ws.on('pong', () => ((ws as any).alive = true));
    ws.on('close', () => {
      byUser.get(user.id)?.delete(ws);
      if (!byUser.get(user.id)?.size) byUser.delete(user.id);
      admins.delete(ws);
    });
    ws.send(JSON.stringify({ type: 'hello' }));
  });
  // Détection des connexions mortes
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!(ws as any).alive) { ws.terminate(); continue; }
      (ws as any).alive = false;
      ws.ping();
    }
  }, 30_000).unref();
}

export function send(userIds: (string | null | undefined)[], event: object, opts: { admins?: boolean } = {}) {
  const payload = JSON.stringify(event);
  const targets = new Set<WebSocket>();
  for (const id of userIds) if (id) byUser.get(id)?.forEach((ws) => targets.add(ws));
  if (opts.admins) admins.forEach((ws) => targets.add(ws));
  for (const ws of targets) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
}

// ── Notifications (in-app + push FCM optionnel) ────────────────────────
let fcm: { projectId: string; clientEmail: string; privateKey: string } | null = null;
let fcmToken: { value: string; exp: number } | null = null;
if (config.fcmServiceAccount) {
  try {
    const sa = JSON.parse(fs.readFileSync(config.fcmServiceAccount, 'utf8'));
    fcm = { projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key };
    console.log('[push] Firebase Cloud Messaging activé');
  } catch (e: any) { console.warn('[push] compte de service FCM illisible :', e.message); }
}
async function fcmAccessToken(): Promise<string> {
  if (fcmToken && fcmToken.exp > Date.now() + 60_000) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({ iss: fcm!.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }, fcm!.privateKey, { algorithm: 'RS256' });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const data: any = await res.json();
  fcmToken = { value: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return fcmToken.value;
}
async function pushFcm(userId: string, title: string, body: string, data: Record<string, string>) {
  if (!fcm) return;
  const devices = await q('SELECT token FROM devices WHERE user_id = $1', [userId]);
  if (!devices.length) return;
  const access = await fcmAccessToken();
  for (const d of devices) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${fcm.projectId}/messages:send`, {
      method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: d.token, notification: { title, body }, data } }),
    });
    if (res.status === 404 || res.status === 400) await q('DELETE FROM devices WHERE token = $1', [d.token]); // jeton périmé
  }
}

export async function notify(userId: string | null | undefined, title: string, body = '', data: Record<string, any> = {}) {
  if (!userId) return;
  await q('INSERT INTO notifications(user_id, title, body, data) VALUES ($1,$2,$3,$4)', [userId, title, body, data]);
  send([userId], { type: 'notification', title, body, data });
  pushFcm(userId, title, body, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]))).catch((e) => console.warn('[push]', e.message));
}
