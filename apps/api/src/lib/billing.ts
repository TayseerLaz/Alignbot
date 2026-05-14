// Phase 3 §5.1.3 — billing helpers.
//
// - getStripe()                lazy singleton; throws if STRIPE_SECRET_KEY unset
// - isStripeConfigured()       cheap check for routes that should 503 cleanly
// - resolveOrgPlan(tx, orgId)  current Plan (or Free fallback) for cap checks
// - capCheck(tx, orgId, kind)  throws RATE_LIMITED if a hard cap is breached
//
// Cap policy: writes that would push usage above the plan's monthly cap
// are blocked with 402-ish RATE_LIMITED + a message naming the cap. The
// cap is checked against `usage_monthly` (read in O(1)). The write path
// also increments `usage_events` so the daily roll-up stays correct.
import { ApiErrorCode } from '@aligned/shared';
import Stripe from 'stripe';

import { env } from './env.js';
import { badRequest } from './errors.js';

let _stripe: Stripe | null = null;
export function isStripeConfigured(): boolean {
  return !!env.STRIPE_SECRET_KEY;
}
export function getStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw badRequest(
      ApiErrorCode.SERVICE_UNAVAILABLE,
      'Stripe is not configured on this deployment.',
    );
  }
  if (_stripe) return _stripe;
  _stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' as never });
  return _stripe;
}

export function currentYearMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

// ALIGNED admins operate internal / demo orgs and shouldn't be throttled.
// Result is cached 5 minutes in Redis per-org so the hot write path
// (capCheck on every product create etc.) doesn't hit Postgres every call.
// Invalidate by deleting `plan:unlimited:<orgId>` if you flip a user's
// isAlignedAdmin flag and want it to take effect immediately.
export async function isOrgUnlimited(orgId: string): Promise<boolean> {
  const { getRedis } = await import('./redis.js');
  const redis = getRedis();
  const cacheKey = `plan:unlimited:${orgId}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached === '1') return true;
  if (cached === '0') return false;
  const { prisma } = await import('./db.js');
  const adminMember = await prisma.membership.findFirst({
    where: {
      organizationId: orgId,
      isActive: true,
      user: { isAlignedAdmin: true },
    },
    select: { id: true },
  });
  const unlimited = !!adminMember;
  await redis.set(cacheKey, unlimited ? '1' : '0', 'EX', 300).catch(() => {});
  return unlimited;
}

// All cap kinds the cap-check middleware understands. Note these are
// PER-MONTH or POINT-IN-TIME depending on the metric. Caps named
// `monthly_*` are reset at month boundary; the rest are absolute.
export type CapKind =
  | 'product'
  | 'service'
  | 'member'
  | 'monthly_message'
  | 'monthly_import'
  | 'api_key'
  | 'webhook';

interface MinimalTx {
  subscription: { findUnique: (args: { where: { organizationId: string } }) => Promise<{ planId: string; status: string; trialEndsAt: Date | null } | null> };
  plan: { findUnique: (args: { where: { id: string } }) => Promise<unknown | null>; findFirst: (args: { where: { code: string } }) => Promise<unknown | null> };
  product: { count: (args?: unknown) => Promise<number> };
  service: { count: (args?: unknown) => Promise<number> };
  membership: { count: (args?: unknown) => Promise<number> };
  apiKey: { count: (args?: unknown) => Promise<number> };
  webhookEndpoint: { count: (args?: unknown) => Promise<number> };
  usageMonthly: {
    findFirst: (args: { where: { organizationId: string; yearMonth: string; kind: string } }) => Promise<{ count: number } | null>;
  };
}

interface PlanRow {
  id: string;
  code: string;
  productCap: number | null;
  serviceCap: number | null;
  memberCap: number | null;
  monthlyMessageCap: number | null;
  monthlyImportCap: number | null;
  apiKeyCap: number | null;
  webhookCap: number | null;
}

export async function resolveOrgPlan(tx: MinimalTx, orgId: string): Promise<PlanRow> {
  const sub = await tx.subscription.findUnique({ where: { organizationId: orgId } });
  if (sub) {
    const plan = (await tx.plan.findUnique({ where: { id: sub.planId } })) as PlanRow | null;
    if (plan) return plan;
  }
  const free = (await tx.plan.findFirst({ where: { code: 'free' } })) as PlanRow | null;
  if (free) return free;
  // Last-ditch: synthesise an unlimited "no plan" so an unconfigured deploy
  // doesn't accidentally lock writes.
  return {
    id: 'no-plan',
    code: 'no-plan',
    productCap: null,
    serviceCap: null,
    memberCap: null,
    monthlyMessageCap: null,
    monthlyImportCap: null,
    apiKeyCap: null,
    webhookCap: null,
  };
}

export async function capCheck(tx: MinimalTx, orgId: string, kind: CapKind): Promise<void> {
  // ALIGNED-admin-operated orgs are unmetered across every cap kind.
  if (await isOrgUnlimited(orgId)) return;
  const plan = await resolveOrgPlan(tx, orgId);
  const cap =
    kind === 'product' ? plan.productCap
    : kind === 'service' ? plan.serviceCap
    : kind === 'member' ? plan.memberCap
    : kind === 'monthly_message' ? plan.monthlyMessageCap
    : kind === 'monthly_import' ? plan.monthlyImportCap
    : kind === 'api_key' ? plan.apiKeyCap
    : plan.webhookCap;

  if (cap == null) return; // unlimited

  let current = 0;
  if (kind === 'product') current = await tx.product.count({ where: { deletedAt: null } });
  else if (kind === 'service') current = await tx.service.count({ where: { deletedAt: null } });
  else if (kind === 'member') current = await tx.membership.count({ where: { isActive: true } });
  else if (kind === 'api_key') current = await tx.apiKey.count({ where: { revokedAt: null } });
  else if (kind === 'webhook') current = await tx.webhookEndpoint.count();
  else {
    // monthly_message / monthly_import — read the rolling counter.
    const ym = currentYearMonth();
    const eventKind = kind === 'monthly_message' ? 'message_outbound' : 'import_started';
    const row = await tx.usageMonthly.findFirst({
      where: { organizationId: orgId, yearMonth: ym, kind: eventKind },
    });
    current = row?.count ?? 0;
  }

  if (current >= cap) {
    throw badRequest(
      ApiErrorCode.RATE_LIMITED,
      `Plan cap reached for "${kind}" (${current}/${cap}). Upgrade your plan to continue.`,
    );
  }
}

// Fire-and-forget: increment the rolling usage counter. Called from write
// paths after the write succeeds.
export async function bumpUsage(
  prisma: {
    usageEvent: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    usageMonthly: { upsert: (args: { where: { organizationId_yearMonth_kind: { organizationId: string; yearMonth: string; kind: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<unknown> };
  },
  orgId: string,
  kind: string,
  count = 1,
): Promise<void> {
  try {
    await prisma.usageEvent.create({
      data: { organizationId: orgId, kind, count },
    });
    await prisma.usageMonthly.upsert({
      where: {
        organizationId_yearMonth_kind: {
          organizationId: orgId,
          yearMonth: currentYearMonth(),
          kind,
        },
      },
      create: { organizationId: orgId, yearMonth: currentYearMonth(), kind, count },
      update: { count: { increment: count } as never },
    });
  } catch (err) {
    console.error('[billing] bumpUsage failed', err);
  }
}
