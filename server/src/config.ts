import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// .env à la racine du monorepo (en plus d'un éventuel server/.env)
dotenv.config({ path: path.resolve(here, '../../.env') });

const env = process.env;
export const config = {
  port: Number(env.PORT || 4000),
  databaseUrl: env.DATABASE_URL || 'postgres://greliv:greliv@localhost:5432/greliv',
  jwtSecret: env.JWT_SECRET || 'dev-secret-a-changer-absolument',
  corsOrigin: env.CORS_ORIGIN || '*',
  publicUrl: env.PUBLIC_URL || 'http://localhost:5173',
  stripeSecretKey: env.STRIPE_SECRET_KEY || '',
  stripePublishableKey: env.STRIPE_PUBLISHABLE_KEY || '',
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  routingProvider: (env.ROUTING_PROVIDER || 'osrm') as 'osrm' | 'mapbox' | 'none',
  osrmCar: env.OSRM_URL_CAR || 'https://routing.openstreetmap.de/routed-car',
  osrmBike: env.OSRM_URL_BIKE || 'https://routing.openstreetmap.de/routed-bike',
  mapboxToken: env.MAPBOX_TOKEN || '',
  geocoder: (env.GEOCODER || 'ban') as 'ban' | 'none',
  fcmServiceAccount: env.FCM_SERVICE_ACCOUNT || '',
  uploadDir: path.resolve(here, '..', env.UPLOAD_DIR || './uploads'),
  migrationsDir: path.resolve(here, '../migrations'),
  webDist: path.resolve(here, '../../web/dist'),
  isProd: env.NODE_ENV === 'production',
};
export const paymentProvider: 'stripe' | 'mock' = config.stripeSecretKey ? 'stripe' : 'mock';

if (config.isProd && config.jwtSecret.startsWith('dev-secret')) {
  throw new Error('JWT_SECRET doit être défini en production.');
}
