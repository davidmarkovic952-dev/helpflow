import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import path from 'node:path';
import fs from 'node:fs';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import { createLlm, type Llm } from './ai/provider.js';
import { csrfProtection, sessionMiddleware } from './security/session.js';
import { RateLimiter } from './security/rateLimit.js';
import { limit } from './routes/util.js';
import { authRoutes } from './routes/auth.js';
import { ticketRoutes } from './routes/tickets.js';
import { kbRoutes } from './routes/kb.js';
import { adminRoutes } from './routes/admin.js';
import { publicRoutes } from './routes/public.js';

export function createApp(db: Db, cfg: Config, opts: { llm?: Llm | null; clientDir?: string } = {}) {
  const app = express();
  const llm = opts.llm === undefined ? createLlm(cfg) : opts.llm;
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.TRUST_PROXY); // tačan IP iza reverse proxy-ja (bitno za rate limit i audit)

  // Bezbednosna zaglavlja: strogi CSP bez inline skripti i stilova, HSTS, zabrana uokvirivanja.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'none'"],
        formAction: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: cfg.COOKIE_SECURE ? [] : null
      }
    },
    strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false
  }));
  app.use((_req, res, next) => { res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()'); next(); });

  const globalLimiter = new RateLimiter(600, 60_000);
  app.use('/api', limit(globalLimiter, req => `g:${req.ip}`));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '64kb', strict: true }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/public', publicRoutes(db, llm)); // bez sesije i bez CSRF-a (nema kolačića)
  app.use('/api', sessionMiddleware(db, cfg), csrfProtection(cfg));
  app.use('/api/auth', authRoutes(db, cfg));
  app.use('/api/tickets', ticketRoutes(db, cfg, llm));
  app.use('/api/kb', kbRoutes(db));
  app.use('/api/admin', adminRoutes(db));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Nije pronađeno' }));

  // Produkcija: isti origin za API i frontend → jednostavan i bezbedan model kolačića.
  const dir = opts.clientDir;
  if (dir && fs.existsSync(dir)) {
    app.use(express.static(dir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dir, 'index.html')));
  }

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Zahtev je prevelik' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Neispravan JSON' });
    console.error(JSON.stringify({ level: 'error', msg: err?.message, path: req.path, method: req.method })); // bez tela zahteva i tokena
    res.status(500).json({ error: 'Greška na serveru' });
  };
  app.use(onError);
  return app;
}
