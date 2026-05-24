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
  // Phase 5 hotfix — Wasabi accounts default to "no public objects allowed",
  // so even when WASABI_PUBLIC_URL_BASE is set, the public URL 403s. Only
  // emit public URLs when the bucket is explicitly opt-in public.
  WASABI_PUBLIC_BUCKET: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),
  WASABI_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  // Phase 6 — Google Cloud TTS for voice replies. Optional; bot routes
  // fall back to text replies when the key is missing.
  GOOGLE_TTS_API_KEY: z.string().optional(),
  GOOGLE_TTS_DEFAULT_VOICE_EN: z.string().default('en-US-Neural2-J'),
  GOOGLE_TTS_DEFAULT_VOICE_AR: z.string().default('ar-XA-Wavenet-B'),
  // ElevenLabs — alternate TTS provider. Same fallback behaviour as Google:
  // missing key + voice id ⇒ provider is unavailable, the bot routes
  // silently fall back to text.
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  // Phase 11.2 — default switched from `eleven_multilingual_v2` (1.5-3.5s
  // per voice note) to `eleven_flash_v2_5` (0.4-0.8s, ~3x faster).
  // Quality on short customer-service replies is comparable; the
  // difference matters more for long-form narration. Operators can pin
  // back to the older model via the env var without a code push if
  // quality regresses on a specific use case.
  ELEVENLABS_MODEL: z.string().default('eleven_flash_v2_5'),

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

  // Phase 2 — OpenAI API key for the AI bot builder + bot runtime.
  // Leave empty to disable AI features (analyze + simulate + scenarios all
  // 503; the rest of the platform keeps working).
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  // Phase 11 — Whisper-1 (the original 2022 model) was OK at English but
  // mediocre on Arabic dialects; it routinely normalised Lebanese /
  // Egyptian / Gulf into MSA and butchered code-switched audio. We've
  // upgraded the default to gpt-4o-transcribe — best-in-class on dialects
  // + code-switching, same cost-per-minute as whisper-1. The env var
  // exists so ops can roll back to "whisper-1" without a code push if
  // gpt-4o-transcribe has an outage.
  OPENAI_TRANSCRIBE_MODEL: z.string().default('gpt-4o-transcribe'),
  // Phase 12 — optional Groq backend for chat completions. Groq's LPU
  // inference runs Llama 3.3 70B at ~500 tokens/sec (vs OpenAI's ~50-100
  // tok/sec) — every bot reply lands ~1.5-3s faster. The /openai/v1
  // base URL is OpenAI-API-compatible so we use the same SDK. When
  // GROQ_API_KEY is unset (default), every chat call goes to OpenAI
  // exactly as before — no behaviour change for existing deployments.
  //
  // Transcription stays on OpenAI (gpt-4o-transcribe is meaningfully
  // better on Arabic dialects than Groq's Whisper Large v3).
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),

  // Phase 3 §5.1.3 — Stripe billing. Empty values disable billing surfaces:
  // /billing/checkout 503s, /webhooks/stripe rejects, cap middleware
  // skips. Existing orgs stay on whatever subscription state they had.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PORTAL_RETURN_URL: z.string().url().optional(),
  TRIAL_LENGTH_DAYS: z.coerce.number().int().positive().default(14),

  // Phase 3 §5.1.4 — custom CNAMEs. Customers point a CNAME at this host;
  // we verify with `dns.promises.resolveCname` before the row goes
  // 'verified' (which is the gate for Caddy on-demand TLS).
  CUSTOM_CNAME_TARGET: z.string().default('hader.ai'),
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
