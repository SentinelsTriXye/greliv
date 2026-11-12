import type { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { ZodError } from 'zod';
import { config } from './config.js';
import { one } from './db.js';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
export const bad = (msg: string, code?: string) => new HttpError(400, msg, code);
export const notFound = (msg = 'Introuvable') => new HttpError(404, msg);
export const forbidden = (msg = 'Accès refusé') => new HttpError(403, msg);

export type Role = 'client' | 'merchant' | 'courier' | 'admin';
export type AuthUser = { id: string; role: Role; name: string; email: string };
declare global { namespace Express { interface Request { user: AuthUser } } }

/** Enveloppe les handlers async pour propager les erreurs. */
export const h = (fn: (req: Request, res: Response) => Promise<any>): RequestHandler =>
  (req, res, next) => fn(req, res).catch(next);

export function signToken(u: { id: string; role: string }) {
  return jwt.sign({ sub: u.id, role: u.role }, config.jwtSecret, { expiresIn: '7d' });
}
export async function userFromToken(token: string): Promise<AuthUser | null> {
  try {
    const p = jwt.verify(token, config.jwtSecret) as { sub: string };
    const u = await one('SELECT id, role, name, email, status FROM users WHERE id = $1', [p.sub]);
    if (!u || u.status !== 'active') return null;
    return { id: u.id, role: u.role, name: u.name, email: u.email };
  } catch { return null; }
}

export const auth = (...roles: Role[]): RequestHandler => async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const user = token ? await userFromToken(token) : null;
  if (!user) return next(new HttpError(401, 'Session expirée, veuillez vous reconnecter.'));
  if (roles.length && !roles.includes(user.role)) return next(forbidden());
  req.user = user;
  next();
};

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const first = err.errors[0];
    return res.status(400).json({ error: `Données invalides : ${first.path.join('.')} — ${first.message}` });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Fichier trop volumineux.' });
  console.error('[erreur]', err);
  res.status(500).json({ error: 'Erreur interne du serveur.' });
}
