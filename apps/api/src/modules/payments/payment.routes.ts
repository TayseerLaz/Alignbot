// Per-tenant payment configuration API.
//
// Credentials are write-only: clients send raw keys (encrypted at rest with
// the same AES-256-GCM helper as WhatsApp secrets), and GET only ever returns
// `has*` booleans — never the secrets themselves. Send an empty string to
// clear a stored credential; omit it to leave it unchanged.
import { decryptSecret, encryptSecret } from '@aligned/db';
import {
  type PaymentProvider,
  itemEnvelopeSchema,
  paymentConfigSchema,
  upsertPaymentConfigBodySchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { recordAudit } from '../../lib/audit.js';

type Creds = {
  myfatoorahApiKey?: string;
  stripeSecretKey?: string;
  paypalClientId?: string;
  paypalSecret?: string;
};

function parseCreds(encrypted: string | null): Creds {
  if (!encrypted) return {};
  try {
    const json = decryptSecret(encrypted);
    return json ? (JSON.parse(json) as Creds) : {};
  } catch {
    return {};
  }
}

function isReady(provider: PaymentProvider, creds: Creds, staticLinkUrl: string | null, bankDetails: string | null): boolean {
  switch (provider) {
    case 'none':
    case 'cash':
      return true;
    case 'static_link':
      return !!staticLinkUrl;
    case 'bank_transfer':
      return !!bankDetails;
    case 'myfatoorah':
      return !!creds.myfatoorahApiKey;
    case 'stripe':
      return !!creds.stripeSecretKey;
    case 'paypal':
      return !!(creds.paypalClientId && creds.paypalSecret);
    default:
      return false;
  }
}

function serialize(row: {
  provider: string;
  staticLinkUrl: string | null;
  bankDetails: string | null;
  testMode: boolean;
  credentials: string | null;
  updatedAt: Date;
}) {
  const creds = parseCreds(row.credentials);
  const provider = row.provider as PaymentProvider;
  return {
    provider,
    staticLinkUrl: row.staticLinkUrl,
    bankDetails: row.bankDetails,
    testMode: row.testMode,
    hasMyfatoorahKey: !!creds.myfatoorahApiKey,
    hasStripeKey: !!creds.stripeSecretKey,
    hasPaypalCreds: !!(creds.paypalClientId && creds.paypalSecret),
    ready: isReady(provider, creds, row.staticLinkUrl, row.bankDetails),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const EMPTY_ROW = {
  provider: 'none',
  staticLinkUrl: null,
  bankDetails: null,
  testMode: true,
  credentials: null,
  updatedAt: new Date(0),
};

export default async function paymentRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /payment-config -----------------------------------------
  r.get(
    '/payment-config',
    {
      schema: {
        tags: ['payments'],
        summary: 'Get the org payment provider config (secrets masked).',
        response: { 200: itemEnvelopeSchema(paymentConfigSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const row = await tx.paymentConfig.findUnique({ where: { organizationId: orgId } });
        return { data: serialize(row ?? EMPTY_ROW) };
      });
    },
  );

  // ---------- PUT /payment-config -----------------------------------------
  r.put(
    '/payment-config',
    {
      schema: {
        tags: ['payments'],
        summary: 'Upsert the org payment provider config. Credentials are write-only.',
        body: upsertPaymentConfigBodySchema,
        response: { 200: itemEnvelopeSchema(paymentConfigSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const b = req.body;
      return app.tenant(req, async (tx) => {
        const existing = await tx.paymentConfig.findUnique({ where: { organizationId: orgId } });
        const creds = parseCreds(existing?.credentials ?? null);

        // Merge credentials: provided non-empty = set, empty string = clear,
        // undefined = leave unchanged.
        const applyCred = (key: keyof Creds, val: string | undefined) => {
          if (val === undefined) return;
          if (val === '') delete creds[key];
          else creds[key] = val;
        };
        applyCred('myfatoorahApiKey', b.myfatoorahApiKey);
        applyCred('stripeSecretKey', b.stripeSecretKey);
        applyCred('paypalClientId', b.paypalClientId);
        applyCred('paypalSecret', b.paypalSecret);

        const encryptedCreds =
          Object.keys(creds).length > 0 ? encryptSecret(JSON.stringify(creds)) : null;

        const data = {
          provider: b.provider,
          staticLinkUrl: b.staticLinkUrl === undefined ? existing?.staticLinkUrl ?? null : b.staticLinkUrl || null,
          bankDetails: b.bankDetails === undefined ? existing?.bankDetails ?? null : b.bankDetails || null,
          testMode: b.testMode ?? existing?.testMode ?? true,
          credentials: encryptedCreds,
        };

        const row = await tx.paymentConfig.upsert({
          where: { organizationId: orgId },
          create: { organizationId: orgId, ...data },
          update: data,
        });

        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'payment_config',
          entityId: row.id,
          metadata: { event: 'payment_config_updated', provider: row.provider },
        });

        return { data: serialize(row) };
      });
    },
  );
}
