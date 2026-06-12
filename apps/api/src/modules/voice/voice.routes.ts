// Voice media gateway API — consumed by the Aseer-time voicebot bridge.
//
// Two halves:
//   1. X-Aligned-Api-Key routes (the voicebot):
//      GET  /voice/config              — compiled realtime persona/grounding
//      POST /voice/calls               — call started (idempotent upsert)
//      POST /voice/calls/:uuid/turns   — append finalized transcript turns
//      POST /voice/calls/:uuid/end     — call ended (outcome + reason)
//   2. JWT portal routes (the dashboard):
//      GET  /voice/calls               — recent calls
//      GET  /voice/calls/:id           — one call with its transcript
//
// The voicebot's client is fire-and-forget with retries, so every write here
// is idempotent and tolerates out-of-order arrival (turns/end before start
// auto-create the call row). The config response is cached in the same Redis
// keyspace as the chatbot read API, so catalog writes invalidate it too.
import {
  ApiErrorCode,
  appendVoiceTurnsBodySchema,
  endVoiceCallBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  startVoiceCallBodySchema,
  uuidSchema,
  voiceCallDetailSchema,
  voiceCallSchema,
  voiceCallUuidSchema,
  voiceConfigSchema,
} from '@aligned/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { gatherBotData } from '../../lib/bot-engine.js';
import { withTenant } from '../../lib/db.js';
import type { Tx } from '../../lib/db.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { readCacheGet, readCacheSet } from '../../lib/read-cache.js';
import { compileVoiceConfig } from '../../lib/voice-prompt.js';
import { decodeCursor, encodeCursor } from '../catalog/shared.js';

// Cumulative ceiling per call. A real phone call produces a few hundred turns
// at most; the cap exists so a leaked voice:calls key cannot grow one call's
// transcript without bound (the per-request zod cap alone doesn't stop a loop).
const MAX_TURNS_PER_CALL = 2000;

function requireScope(req: FastifyRequest, scope: string) {
  if (!req.apiKey?.scopes.includes(scope)) {
    throw forbidden(ApiErrorCode.ROLE_INSUFFICIENT, `API key missing required scope: ${scope}`);
  }
}

// Find-or-create the call row. Turns/end can arrive before the start event
// (the voicebot's queue is best-effort), so ingestion never 404s on a
// missing call — it materializes one with startedAt=now instead.
async function ensureCall(tx: Tx, orgId: string, callUuid: string) {
  return tx.voiceCall.upsert({
    where: { organizationId_callUuid: { organizationId: orgId, callUuid } },
    update: {},
    create: { organizationId: orgId, callUuid, startedAt: new Date() },
    select: { id: true },
  });
}

export default async function voiceRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ===========================================================================
  // API-key half — the voicebot bridge
  // ===========================================================================

  // ---------- GET /voice/config ---------------------------------------------
  r.get(
    '/voice/config',
    {
      schema: {
        tags: ['voice'],
        summary:
          'Compiled per-tenant realtime persona + grounding for the voicebot. Cached 60s; invalidated on catalog writes.',
        response: { 200: itemEnvelopeSchema(voiceConfigSchema) },
        security: [{ apiKey: [] }],
      },
      preHandler: [app.requireApiKey],
    },
    async (req, reply) => {
      requireScope(req, 'voice:config');
      const orgId = req.apiKey!.organizationId;

      type Envelope = { data: z.infer<typeof voiceConfigSchema> };
      const hit = await readCacheGet<Envelope>(orgId, 'voice-config', null);
      if (hit && !hit.stale) {
        reply.header('x-cache', 'HIT');
        return hit.value;
      }
      const value = await withTenant(orgId, async (tx) => {
        const org = await tx.organization.findUnique({
          where: { id: orgId },
          select: { name: true },
        });
        const data = await gatherBotData(tx, orgId);
        return { data: compileVoiceConfig(data, org?.name ?? 'this business') };
      });
      await readCacheSet(orgId, 'voice-config', null, value);
      reply.header('x-cache', hit?.stale ? 'STALE' : 'MISS');
      return value;
    },
  );

  // ---------- POST /voice/calls ---------------------------------------------
  r.post(
    '/voice/calls',
    {
      schema: {
        tags: ['voice'],
        summary: 'Register a call start. Idempotent on (org, callUuid).',
        body: startVoiceCallBodySchema,
        response: { 201: itemEnvelopeSchema(z.object({ id: uuidSchema })) },
        security: [{ apiKey: [] }],
      },
      preHandler: [app.requireApiKey],
    },
    async (req, reply) => {
      requireScope(req, 'voice:calls');
      const orgId = req.apiKey!.organizationId;
      const b = req.body;
      const row = await withTenant(orgId, async (tx) => {
        // Never overwrite stored metadata (call records are historical), but
        // DO fill nulls: when turns/end arrived first, ensureCall created the
        // row with no callerId/dialedExten and the late start event carries
        // them.
        const call = await tx.voiceCall.upsert({
          where: { organizationId_callUuid: { organizationId: orgId, callUuid: b.callUuid } },
          update: {},
          create: {
            organizationId: orgId,
            callUuid: b.callUuid,
            callerId: b.callerId ?? null,
            dialedExten: b.dialedExten ?? null,
            startedAt: b.startedAt ? new Date(b.startedAt) : new Date(),
          },
          select: { id: true },
        });
        if (b.callerId != null) {
          await tx.voiceCall.updateMany({
            where: { id: call.id, callerId: null },
            data: { callerId: b.callerId },
          });
        }
        if (b.dialedExten != null) {
          await tx.voiceCall.updateMany({
            where: { id: call.id, dialedExten: null },
            data: { dialedExten: b.dialedExten },
          });
        }
        return call;
      });
      reply.code(201);
      return { data: { id: row.id } };
    },
  );

  // ---------- POST /voice/calls/:callUuid/turns -----------------------------
  r.post(
    '/voice/calls/:callUuid/turns',
    {
      schema: {
        tags: ['voice'],
        summary: 'Append finalized transcript turns to a call.',
        params: z.object({ callUuid: voiceCallUuidSchema }),
        body: appendVoiceTurnsBodySchema,
        response: { 200: itemEnvelopeSchema(z.object({ appended: z.number().int() })) },
        security: [{ apiKey: [] }],
      },
      preHandler: [app.requireApiKey],
    },
    async (req) => {
      requireScope(req, 'voice:calls');
      const orgId = req.apiKey!.organizationId;
      const { callUuid } = req.params;
      const appended = await withTenant(orgId, async (tx) => {
        const call = await ensureCall(tx, orgId, callUuid);
        const existing = await tx.voiceCallTurn.count({ where: { voiceCallId: call.id } });
        if (existing + req.body.turns.length > MAX_TURNS_PER_CALL) {
          throw conflict(`Call transcript is full (max ${MAX_TURNS_PER_CALL} turns).`);
        }
        // skipDuplicates + the (voiceCallId, seq) unique constraint make a
        // retried batch (committed first attempt, lost response) a no-op.
        const result = await tx.voiceCallTurn.createMany({
          data: req.body.turns.map((t) => ({
            organizationId: orgId,
            voiceCallId: call.id,
            seq: t.seq,
            role: t.role,
            text: t.text,
            at: t.at ? new Date(t.at) : new Date(),
          })),
          skipDuplicates: true,
        });
        return result.count;
      });
      return { data: { appended } };
    },
  );

  // ---------- POST /voice/calls/:callUuid/end -------------------------------
  r.post(
    '/voice/calls/:callUuid/end',
    {
      schema: {
        tags: ['voice'],
        summary: 'Mark a call ended with its outcome.',
        params: z.object({ callUuid: voiceCallUuidSchema }),
        body: endVoiceCallBodySchema,
        response: { 200: itemEnvelopeSchema(z.object({ id: uuidSchema })) },
        security: [{ apiKey: [] }],
      },
      preHandler: [app.requireApiKey],
    },
    async (req) => {
      requireScope(req, 'voice:calls');
      const orgId = req.apiKey!.organizationId;
      const { callUuid } = req.params;
      const b = req.body;
      const row = await withTenant(orgId, async (tx) => {
        const call = await ensureCall(tx, orgId, callUuid);
        // Ended calls are immutable history: only the FIRST end event lands;
        // replays (or a hostile key re-posting months later) are no-ops.
        await tx.voiceCall.updateMany({
          where: { id: call.id, endedAt: null },
          data: {
            outcome: b.outcome,
            handoffReason: b.reason ?? null,
            endedAt: b.endedAt ? new Date(b.endedAt) : new Date(),
          },
        });
        return call;
      });
      return { data: { id: row.id } };
    },
  );

  // ===========================================================================
  // Portal half — dashboard (JWT)
  // ===========================================================================

  // ---------- GET /voice/calls ----------------------------------------------
  r.get(
    '/voice/calls',
    {
      schema: {
        tags: ['voice'],
        summary: 'List voice calls (newest first, cursor-paginated).',
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().optional(),
        }),
        response: { 200: listEnvelopeSchema(voiceCallSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const cursor = decodeCursor<{ id: string }>(req.query.cursor);
        const rows = await tx.voiceCall.findMany({
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          take: req.query.limit + 1,
          ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
          include: { _count: { select: { turns: true } } },
        });
        const hasMore = rows.length > req.query.limit;
        const page = hasMore ? rows.slice(0, req.query.limit) : rows;
        return {
          data: page.map((c) => ({
            id: c.id,
            callUuid: c.callUuid,
            callerId: c.callerId,
            dialedExten: c.dialedExten,
            outcome: c.outcome,
            handoffReason: c.handoffReason,
            startedAt: c.startedAt.toISOString(),
            endedAt: c.endedAt ? c.endedAt.toISOString() : null,
            turnCount: c._count.turns,
          })),
          nextCursor: hasMore ? encodeCursor({ id: page[page.length - 1]!.id }) : null,
        };
      });
    },
  );

  // ---------- GET /voice/calls/:id ------------------------------------------
  r.get(
    '/voice/calls/:id',
    {
      schema: {
        tags: ['voice'],
        summary: 'Get one voice call with its full transcript.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(voiceCallDetailSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const c = await tx.voiceCall.findFirst({
          where: { id: req.params.id },
          // seq breaks ties when a batch shares one `at` millisecond; the
          // take matches MAX_TURNS_PER_CALL so the response stays bounded.
          include: {
            turns: { orderBy: [{ at: 'asc' }, { seq: 'asc' }], take: MAX_TURNS_PER_CALL },
          },
        });
        if (!c) throw notFound('Voice call not found.');
        return {
          data: {
            id: c.id,
            callUuid: c.callUuid,
            callerId: c.callerId,
            dialedExten: c.dialedExten,
            outcome: c.outcome,
            handoffReason: c.handoffReason,
            startedAt: c.startedAt.toISOString(),
            endedAt: c.endedAt ? c.endedAt.toISOString() : null,
            turns: c.turns.map((t) => ({
              id: t.id,
              role: t.role as 'caller' | 'assistant',
              text: t.text,
              at: t.at.toISOString(),
            })),
          },
        };
      });
    },
  );
}
