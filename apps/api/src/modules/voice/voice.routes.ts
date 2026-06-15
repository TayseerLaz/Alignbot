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
  normalizePhoneNumber,
  startVoiceCallBodySchema,
  uuidSchema,
  voiceCallDetailSchema,
  voiceCallSchema,
  voiceCallUuidSchema,
  voiceConfigSchema,
  voiceResolveResponseSchema,
} from '@aligned/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { gatherBotData } from '../../lib/bot-engine.js';
import { withRlsBypass, withTenant } from '../../lib/db.js';
import type { Tx } from '../../lib/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { readCacheGet, readCacheSet } from '../../lib/read-cache.js';
import { compileVoiceConfig } from '../../lib/voice-prompt.js';
import { decodeCursor, encodeCursor } from '../catalog/shared.js';

type VoiceConfigEnvelope = { data: z.infer<typeof voiceConfigSchema> };

// Compile (or fetch from the 60s-fresh / 5min-stale Redis cache) the org's
// realtime voice config. Shared by GET /voice/config (api-key) and
// GET /voice/resolve (gateway) so both serve byte-identical, co-invalidated
// config. The cache key is the same one catalog writes flush.
async function loadVoiceConfig(
  orgId: string,
): Promise<{ value: VoiceConfigEnvelope; cache: 'HIT' | 'STALE' | 'MISS' }> {
  const hit = await readCacheGet<VoiceConfigEnvelope>(orgId, 'voice-config', null);
  if (hit && !hit.stale) return { value: hit.value, cache: 'HIT' };
  const value = await withTenant(orgId, async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    const data = await gatherBotData(tx, orgId);
    return { data: compileVoiceConfig(data, org?.name ?? 'this business') };
  });
  await readCacheSet(orgId, 'voice-config', null, value);
  return { value, cache: hit?.stale ? 'STALE' : 'MISS' };
}

// Resolved identity for a call-lifecycle write. Two credentials map onto it:
//   • X-Aligned-Api-Key  → org from the key; line by apiKeyId (attribution).
//   • X-Voice-Gateway-Secret + X-Phone-Integration-Id → org + line from the
//     referenced phone integration (shared gateway mode, cross-tenant).
type VoiceWriteCtx = { orgId: string; phoneIntegrationId: string | null };

async function authenticateVoiceWrite(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<VoiceWriteCtx> {
  const gwRaw = req.headers['x-voice-gateway-secret'];
  const gw = Array.isArray(gwRaw) ? gwRaw[0] : gwRaw;
  if (gw) {
    await app.requireVoiceGateway(req);
    const pidRaw = req.headers['x-phone-integration-id'];
    const pid = Array.isArray(pidRaw) ? pidRaw[0] : pidRaw;
    const parsed = uuidSchema.safeParse(pid);
    if (!parsed.success) {
      throw badRequest(
        ApiErrorCode.VALIDATION_ERROR,
        'Gateway mode requires a valid X-Phone-Integration-Id header.',
      );
    }
    const line = await withRlsBypass((tx) =>
      tx.phoneIntegration.findFirst({
        where: { id: parsed.data, isActive: true },
        select: { id: true, organizationId: true },
      }),
    );
    if (!line) throw notFound('Phone integration not found or inactive.');
    return { orgId: line.organizationId, phoneIntegrationId: line.id };
  }
  // Dedicated single-line mode — the existing X-Aligned-Api-Key path.
  await app.requireApiKey(req);
  requireScope(req, 'voice:calls');
  const orgId = req.apiKey!.organizationId;
  const line = await withRlsBypass((tx) =>
    tx.phoneIntegration.findFirst({
      where: { apiKeyId: req.apiKey!.id },
      select: { id: true },
    }),
  );
  return { orgId, phoneIntegrationId: line?.id ?? null };
}

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
      const { value, cache } = await loadVoiceConfig(orgId);
      reply.header('x-cache', cache);
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
    },
    async (req, reply) => {
      const { orgId, phoneIntegrationId } = await authenticateVoiceWrite(app, req);
      const b = req.body;
      const row = await withTenant(orgId, async (tx) => {
        // Never overwrite stored metadata (call records are historical), but
        // DO fill nulls: when turns/end arrived first, ensureCall created the
        // row with no callerId/dialedExten/line and the late start event
        // carries them.
        const call = await tx.voiceCall.upsert({
          where: { organizationId_callUuid: { organizationId: orgId, callUuid: b.callUuid } },
          update: {},
          create: {
            organizationId: orgId,
            callUuid: b.callUuid,
            callerId: b.callerId ?? null,
            dialedExten: b.dialedExten ?? null,
            phoneIntegrationId,
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
        if (phoneIntegrationId != null) {
          await tx.voiceCall.updateMany({
            where: { id: call.id, phoneIntegrationId: null },
            data: { phoneIntegrationId },
          });
          // Best-effort recency stamp for the line (updateMany = no-op if gone).
          await tx.phoneIntegration.updateMany({
            where: { id: phoneIntegrationId },
            data: { lastCallAt: new Date() },
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
    },
    async (req) => {
      const { orgId } = await authenticateVoiceWrite(app, req);
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
    },
    async (req) => {
      const { orgId } = await authenticateVoiceWrite(app, req);
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

  // ---------- GET /voice/resolve --------------------------------------------
  // Shared gateway mode: map an inbound dialed number (DID) to the tenant phone
  // line that owns it + the compiled (org-wide) voice config. Auth is the
  // platform gateway secret, not an org key — this is the one cross-tenant read.
  r.get(
    '/voice/resolve',
    {
      schema: {
        tags: ['voice'],
        summary:
          'Resolve a dialed number to its tenant phone line + compiled voice config (gateway-secret auth).',
        querystring: z.object({ did: z.string().trim().min(1).max(40) }),
        response: { 200: itemEnvelopeSchema(voiceResolveResponseSchema) },
      },
      preHandler: [app.requireVoiceGateway],
    },
    async (req, reply) => {
      const did = normalizePhoneNumber(req.query.did);
      if (did.length < 2) throw notFound('No phone line matches that number.');
      const line = await withRlsBypass((tx) =>
        tx.phoneIntegration.findFirst({
          where: { phoneNumber: did, isActive: true },
          select: { id: true, organizationId: true },
        }),
      );
      if (!line) throw notFound('No active phone line matches that number.');

      const { value, cache } = await loadVoiceConfig(line.organizationId);
      reply.header('x-cache', cache);
      return {
        data: {
          ...value.data,
          phoneIntegrationId: line.id,
          organizationId: line.organizationId,
        },
      };
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
          // Restrict to one phone line (used by the per-line "Calls" view).
          phoneIntegrationId: uuidSchema.optional(),
        }),
        response: { 200: listEnvelopeSchema(voiceCallSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const cursor = decodeCursor<{ id: string }>(req.query.cursor);
        const rows = await tx.voiceCall.findMany({
          where: req.query.phoneIntegrationId
            ? { phoneIntegrationId: req.query.phoneIntegrationId }
            : undefined,
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
