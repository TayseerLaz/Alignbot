import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  DIRECT_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),

  // Wasabi (CSV uploads live here)
  WASABI_ENDPOINT: z.string().url().default('https://s3.eu-central-1.wasabisys.com'),
  WASABI_REGION: z.string().default('eu-central-1'),
  WASABI_BUCKET: z.string().default('aligned-dev'),
  WASABI_ACCESS_KEY_ID: z.string().optional(),
  WASABI_SECRET_ACCESS_KEY: z.string().optional(),

  // Outbound webhook delivery
  WEBHOOK_DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),

  // Worker concurrency knobs
  IMPORT_CONCURRENCY: z.coerce.number().int().positive().default(2),
  SYNC_CONCURRENCY: z.coerce.number().int().positive().default(4),
  WEBHOOK_CONCURRENCY: z.coerce.number().int().positive().default(8),
  EMAIL_CONCURRENCY: z.coerce.number().int().positive().default(4),
  CRAWL_CONCURRENCY: z.coerce.number().int().positive().default(2),

  // Phase 2 — Anthropic for crawl analysis. Worker no-ops AI step if missing.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('[env] invalid configuration:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

export const env: Env = loadEnv();
