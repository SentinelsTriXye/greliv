import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config, paymentProvider } from './config.js';
import { migrate, one } from './db.js';
import { errorHandler, h } from './http.js';
import { attachRealtime } from './realtime.js';
import { startDispatchLoop } from './dispatch.js';
import { stripe } from './payments.js';
import { markPaid } from './orders.js';
import { core } from './routes/core.js';
import { merchant } from './routes/merchant.js';
import { courier } from './routes/courier.js';
import { admin } from './routes/admin.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://js.stripe.com', 'https://www.gstatic.com'],
      frameSrc: ['https://js.stripe.com', 'https://hooks.stripe.com'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'https://api.stripe.com', 'https://*.googleapis.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org', 'https://*.stripe.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      upgradeInsecureRequests: null,
    },
  },
}));
app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim()) }));

// Webhook Stripe : corps brut requis pour vérifier la signature (avant express.json)
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), h(async (req, res) => {
  if (!stripe || !config.stripeWebhookSecret) return res.status(503).json({ error: 'Stripe non configuré.' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, String(req.headers['stripe-signature']), config.stripeWebhookSecret);
  } catch { return res.status(400).json({ error: 'Signature invalide.' }); }
  if (event.type === 'payment_intent.succeeded') {
    const orderId = (event.data.object as any).metadata?.orderId;
    if (orderId) await markPaid(orderId);
  }
  res.json({ received: true });
}));

app.use(express.json({ limit: '6mb' }));
app.use('/api/auth', rateLimit({ windowMs: 10 * 60_000, limit: config.isProd ? 40 : 1000, standardHeaders: true, legacyHeaders: false, message: { error: 'Trop de tentatives. Réessayez dans quelques minutes.' } }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false, message: { error: 'Trop de requêtes.' } }));

app.get('/api/health', h(async (_req, res) => {
  await one('SELECT 1');
  res.json({ ok: true, paymentProvider, routing: config.routingProvider });
}));
app.use('/api/merchant', merchant);
app.use('/api/courier', courier);
app.use('/api/admin', admin);
app.use('/api', core);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Route inconnue.' }));

fs.mkdirSync(config.uploadDir, { recursive: true });
app.use('/uploads', express.static(config.uploadDir, { maxAge: '30d', index: false }));

// En production, le serveur sert aussi l'application web compilée (web/dist)
if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
  app.use(express.static(config.webDist, { maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
}
app.use(errorHandler);

const server = http.createServer(app);
attachRealtime(server);

await migrate();
startDispatchLoop();
server.listen(config.port, () => {
  console.log(`[api] GreLiv prêt sur http://localhost:${config.port} — paiement : ${paymentProvider}, itinéraires : ${config.routingProvider}`);
});
