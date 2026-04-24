import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().url(),
  DIRECT_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),

  EMAIL_FROM: z.string().default('ALIGNED <noreply@aligned.local>'),
  EMAIL_DEV_SMTP_HOST: z.string().default('localhost'),
  EMAIL_DEV_SMTP_PORT: z.coerce.number().int().positive().default(1025),
  // Production SMTP (AWS SES). Falls back to dev transport when EMAIL_SMTP_HOST is empty.
  EMAIL_SMTP_HOST: z.string().optional(),
  EMAIL_SMTP_PORT: z.coerce.number().int().positive().optional(),
  EMAIL_SMTP_USER: z.string().optional(),
  EMAIL_SMTP_PASS: z.string().optional(),
  EMAIL_SMTP_SECURE: z
    .string()
    .optional()
    .transform((s) => s === 'true'),

  // Wasabi (S3-compatible) — leave keys empty to disable in dev (uploads will 503).
  WASABI_ENDPOINT: z.string().url().default('https://s3.eu-central-1.wasabisys.com'),
  WASABI_REGION: z.string().default('eu-central-1'),
  WASABI_BUCKET: z.string().default('aligned-dev'),
  WASABI_ACCESS_KEY_ID: z.string().optional(),
  WASABI_SECRET_ACCESS_KEY: z.string().optional(),
  WASABI_PUBLIC_URL_BASE: z.string().url().optional(),
  WASABI_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_API_PER_SECOND: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_READ_API_PER_SECOND: z.coerce.number().int().positive().default(200),

  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default('development'),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

  // UptimeRobot — read-only API key ("monitor-specific" or "main" account
  // key). Leave empty to hide the uptime tile in the admin panel.
  UPTIMEROBOT_API_KEY: z.string().optional(),
  UPTIMEROBOT_MONITOR_IDS: z.string().optional(), // csv of monitor ids
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
