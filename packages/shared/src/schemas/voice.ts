import { z } from 'zod';

import { uuidSchema } from './common.js';

// ----------------------------------------------------------------------------
// Voice media gateway (Aseer-time voicebot) — /api/v1/voice/*
//
// The voicebot authenticates with X-Aligned-Api-Key. It fetches the compiled
// per-tenant persona/grounding once per call (voice:config) and posts call
// lifecycle + transcript turns as they happen (voice:calls). The bridge's
// audio path is a 20 ms pacing loop, so its client is fire-and-forget — these
// endpoints must stay cheap and idempotent (retries happen).
// ----------------------------------------------------------------------------

export const voiceCallOutcomes = ['in_progress', 'completed', 'handoff', 'dropped'] as const;
export type VoiceCallOutcome = (typeof voiceCallOutcomes)[number];

export const voiceTurnRoles = ['caller', 'assistant'] as const;
export type VoiceTurnRole = (typeof voiceTurnRoles)[number];

/** GET /voice/config response payload. */
export const voiceConfigSchema = z.object({
  // Full system-prompt for the realtime speech model, compiled from
  // BotConfig + BusinessInfo + catalog + FAQs. The voicebot passes this
  // verbatim as `session.instructions`.
  instructions: z.string(),
  // Exact first sentence the bot should speak when the call connects.
  // Null = the voicebot keeps its own default greeting.
  greeting: z.string().nullable(),
  // Comma-separated language codes from BotConfig.languages (e.g. "en,ar").
  languages: z.string(),
  businessName: z.string().nullable(),
});

// The AudioSocket call UUID is dashed-lowercase hex (derived from SHA1 of the
// Asterisk UNIQUEID — not RFC 4122, so z.string().uuid() would reject it).
export const voiceCallUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const startVoiceCallBodySchema = z.object({
  callUuid: voiceCallUuidSchema,
  // Caller ID as delivered by the PBX/gateway. Format varies per trunk, so
  // this is a free-form string, not E.164-validated.
  callerId: z.string().trim().max(64).nullish(),
  dialedExten: z.string().trim().max(32).nullish(),
  startedAt: z.string().datetime().optional(),
});
export type StartVoiceCallBody = z.infer<typeof startVoiceCallBodySchema>;

export const appendVoiceTurnsBodySchema = z.object({
  turns: z
    .array(
      z.object({
        // Client-assigned per-call monotonic sequence number. Makes the
        // append idempotent (unique on (voiceCallId, seq) + skipDuplicates —
        // a retried batch whose first attempt actually committed inserts
        // nothing) and gives the transcript a stable order tiebreak when
        // several turns share the same `at` millisecond.
        seq: z.number().int().min(0).max(1_000_000),
        role: z.enum(voiceTurnRoles),
        text: z.string().trim().min(1).max(8000),
        at: z.string().datetime().optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type AppendVoiceTurnsBody = z.infer<typeof appendVoiceTurnsBodySchema>;

export const endVoiceCallBodySchema = z.object({
  outcome: z.enum(['completed', 'handoff', 'dropped']),
  reason: z.string().trim().max(500).nullish(),
  endedAt: z.string().datetime().optional(),
});
export type EndVoiceCallBody = z.infer<typeof endVoiceCallBodySchema>;

/** Portal-facing call summary (list + detail). */
export const voiceCallSchema = z.object({
  id: uuidSchema,
  callUuid: z.string(),
  callerId: z.string().nullable(),
  dialedExten: z.string().nullable(),
  outcome: z.enum(voiceCallOutcomes),
  handoffReason: z.string().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  turnCount: z.number().int(),
});

export const voiceCallTurnSchema = z.object({
  id: uuidSchema,
  role: z.enum(voiceTurnRoles),
  text: z.string(),
  at: z.string().datetime(),
});

export const voiceCallDetailSchema = voiceCallSchema.omit({ turnCount: true }).extend({
  turns: z.array(voiceCallTurnSchema),
});
