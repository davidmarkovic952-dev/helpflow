import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ZodType } from 'zod';
import type { RateLimiter } from '../security/rateLimit.js';

/** Validacija ulaza: nepoznata polja se odbacuju (strict šeme), greška bez detalja o internim strukturama. */
export function parse<T>(schema: ZodType<T>, data: unknown, res: Response): T | undefined {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  res.status(400).json({ error: 'Neispravni podaci', fields: r.error.issues.slice(0, 5).map(i => ({ path: i.path.join('.'), message: i.message })) });
}

export const ah = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next: NextFunction) => { fn(req, res).catch(next); };

export function limit(rl: RateLimiter, keyFn: (req: Request) => string): RequestHandler {
  return (req, res, next) => {
    const wait = rl.take(keyFn(req));
    if (wait > 0) { res.setHeader('Retry-After', String(wait)); return res.status(429).json({ error: 'Previše zahteva, pokušajte kasnije' }); }
    next();
  };
}

export const idParam = (req: Request) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };
