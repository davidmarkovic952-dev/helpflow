import { z } from 'zod';

/** Konfiguracija se proverava pri startu — aplikacija odbija da radi sa nebezbednim podešavanjima. */
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().url(),                       // uloga helpflow_app (bez BYPASSRLS)
  DATABASE_ADMIN_URL: z.string().url().optional(),      // samo za migracije
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  ENCRYPTION_KEY: z.string().refine(k => Buffer.from(k, 'base64').length === 32, 'ENCRYPTION_KEY mora biti 32 bajta u base64'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  AI_PROVIDER: z.enum(['rules', 'gemini', 'anthropic']).default('rules'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5'),
  HIBP_CHECK: z.enum(['true', 'false']).default('false').transform(v => v === 'true')
}).superRefine((e, ctx) => {
  if (e.NODE_ENV === 'production' && !e.COOKIE_SECURE) ctx.addIssue({ code: 'custom', message: 'COOKIE_SECURE mora biti true u produkciji' });
  if (e.AI_PROVIDER === 'gemini' && !e.GEMINI_API_KEY) ctx.addIssue({ code: 'custom', message: 'GEMINI_API_KEY nedostaje' });
  if (e.AI_PROVIDER === 'anthropic' && !e.ANTHROPIC_API_KEY) ctx.addIssue({ code: 'custom', message: 'ANTHROPIC_API_KEY nedostaje' });
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map(i => `${i.path.join('.') || 'config'}: ${i.message}`).join('\n');
    throw new Error(`Neispravna konfiguracija:\n${msg}`);
  }
  return r.data;
}
