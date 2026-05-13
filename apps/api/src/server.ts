import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import underPressure from '@fastify/under-pressure';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

import { env } from './lib/env.js';
import { getRedis } from './lib/redis.js';
import { initSentry } from './lib/sentry.js';
import accountRoutes from './modules/account/account.routes.js';
import twoFactorRoutes from './modules/account/2fa.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import auditRoutes from './modules/audit/audit.routes.js';
import billingRoutes from './modules/billing/billing.routes.js';
import botRoutes from './modules/bot/bot.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';
import dataExportRoutes from './modules/data-export/data-export.routes.js';
import orgRoutes from './modules/org/org.routes.js';
import saasRoutes from './modules/saas/saas.routes.js';
import statusRoutes from './modules/status/status.routes.js';
import inboxRoutes from './modules/whatsapp-inbox/inbox.routes.js';
import whatsappRoutes from './modules/whatsapp/whatsapp.routes.js';
import whatsappTemplatesRoutes from './modules/whatsapp-templates/templates.routes.js';
import apiKeyRoutes from './modules/api-keys/api-keys.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import businessInfoRoutes from './modules/catalog/business-info.routes.js';
import categoryRoutes from './modules/catalog/category.routes.js';
import productRoutes from './modules/catalog/product.routes.js';
import serviceRoutes from './modules/catalog/service.routes.js';
import connectorRoutes from './modules/connectors/connector.routes.js';
import inboundWebhookRoutes from './modules/connectors/inbound-webhook.routes.js';
import contactsRoutes from './modules/contacts/contacts.routes.js';
import broadcastsRoutes from './modules/broadcasts/broadcasts.routes.js';
import segmentsRoutes from './modules/segments/segments.routes.js';
import sequencesRoutes from './modules/sequences/sequences.routes.js';
import importRoutes from './modules/imports/import.routes.js';
import memberRoutes from './modules/members/members.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import readApiRoutes from './modules/read/read.routes.js';
import revisionRoutes from './modules/revisions/revisions.routes.js';
import multipartUploadRoutes from './modules/storage/multipart-upload.routes.js';
import storageRoutes from './modules/storage/storage.routes.js';
import webhookEndpointRoutes from './modules/webhooks/webhooks.routes.js';
import apiKeyPlugin from './plugins/api-key.js';
import authPlugin from './plugins/auth.js';
import errorHandler from './plugins/error-handler.js';
import healthcheck from './plugins/healthcheck.js';
import metrics from './plugins/metrics.js';
import tenantContext from './plugins/tenant-context.js';

export async function buildServer() {
  initSentry();
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
          : undefined,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-aligned-api-key"]',
          'req.body.password',
          'req.body.newPassword',
          'req.body.currentPassword',
          'req.body.token',
          '*.passwordHash',
          '*.refreshTokenHash',
          '*.tokenHash',
          '*.keyHash',
          '*.signingSecret',
          '*.webhookSecret',
        ],
        remove: true,
      },
    },
    trustProxy: true,
    disableRequestLogging: false,
    bodyLimit: 5 * 1024 * 1024, // 5 MB. CSV/Excel imports use the multipart route (10 MB capped there).
    genReqId: () => crypto.randomUUID(),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Capture the raw JSON body on every request before parsing so HMAC
  // verifiers (WhatsApp Cloud API, Stripe webhooks, etc.) can compute
  // signatures against Meta's/Stripe's original bytes — not a Node
  // re-stringification that may reorder keys or change escaping and
  // break the HMAC comparison. The body is attached at `req.rawBody`.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      try {
        const buf = body as Buffer;
        (req as unknown as { rawBody?: string }).rawBody = buf.toString('utf8');
        const parsed = buf.length === 0 ? {} : JSON.parse(buf.toString('utf8'));
        done(null, parsed);
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        e.statusCode = 400;
        done(e, undefined);
      }
    },
  );

  // Security & basics
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(sensible);
  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

  await app.register(rateLimit, {
    global: true,
    timeWindow: '1 second',
    redis: getRedis(),
    nameSpace: 'aligned-rl:',
    skipOnError: true,
    // Chatbot Read API gets its own (higher) ceiling per API key.
    max: (req) =>
      req.url.startsWith('/api/v1/read/')
        ? env.RATE_LIMIT_READ_API_PER_SECOND
        : env.RATE_LIMIT_API_PER_SECOND,
    // Bypass for Playwright runs. Only outside production; the header is set
    // by apps/e2e/playwright.config.ts.
    allowList: (req) =>
      env.NODE_ENV !== 'production' && req.headers['x-e2e-run'] === '1',
    keyGenerator: (req) => {
      if (req.url.startsWith('/api/v1/read/')) {
        const apiKey = req.headers['x-aligned-api-key'];
        return Array.isArray(apiKey) ? apiKey[0] ?? req.ip : (apiKey ?? req.ip);
      }
      return req.ip;
    },
  });

  await app.register(underPressure, {
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: 1024 * 1024 * 1024, // 1 GB
    maxRssBytes: 1024 * 1024 * 1024 * 2, // 2 GB
    maxEventLoopUtilization: 0.98,
    healthCheckInterval: 5000,
    exposeStatusRoute: false,
  });

  // OpenAPI / Swagger UI
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'ALIGNED Business Platform API',
        version: '0.1.0',
        description: 'Multi-tenant catalog + chatbot read API.',
      },
      servers: [{ url: env.API_PUBLIC_URL }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKey: { type: 'apiKey', in: 'header', name: 'X-Aligned-Api-Key' },
        },
      },
      tags: [
        { name: 'auth', description: 'Authentication, sessions, invitations' },
        { name: 'members', description: 'Members + roles' },
        { name: 'catalog', description: 'Products, services, categories' },
        { name: 'business-info', description: 'Hours, locations, contacts, FAQs, policies' },
        { name: 'storage', description: 'Asset uploads' },
        { name: 'imports', description: 'CSV/Excel imports' },
        { name: 'connectors', description: 'API connectors + scheduled syncs' },
        { name: 'webhooks', description: 'Outbound webhooks' },
        { name: 'api-keys', description: 'API keys for the chatbot read API' },
        { name: 'chatbot-read', description: 'Read-only API consumed by the WhatsApp chatbot' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // Filtered chatbot-only Swagger UI on /docs/chatbot using its own swagger plugin.
  await app.register(async (chatbotScope) => {
    await chatbotScope.register(swagger, {
      openapi: {
        info: {
          title: 'ALIGNED Chatbot Read API',
          version: '0.1.0',
          description: 'Read-only endpoints for chatbot integrations. API-key authenticated.',
        },
        servers: [{ url: env.API_PUBLIC_URL }],
        components: {
          securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'X-Aligned-Api-Key' } },
        },
      },
      transform: jsonSchemaTransform,
      // Only expose chatbot-read tagged routes.
      // Note: routes are registered globally above; this swagger instance
      // observes them via the parent encapsulation context.
    });
    await chatbotScope.register(swaggerUi, { routePrefix: '/docs/chatbot' });
  });

  // App-specific
  await app.register(errorHandler);
  await app.register(metrics);
  await app.register(healthcheck);
  await app.register(authPlugin);
  await app.register(apiKeyPlugin);
  await app.register(tenantContext);

  // Routes — portal (JWT cookie/bearer)
  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(memberRoutes, { prefix: '/api/v1' });
  await app.register(storageRoutes, { prefix: '/api/v1' });
  await app.register(multipartUploadRoutes, { prefix: '/api/v1' });
  await app.register(categoryRoutes, { prefix: '/api/v1' });
  await app.register(productRoutes, { prefix: '/api/v1' });
  await app.register(serviceRoutes, { prefix: '/api/v1' });
  await app.register(businessInfoRoutes, { prefix: '/api/v1' });
  await app.register(importRoutes, { prefix: '/api/v1' });
  await app.register(connectorRoutes, { prefix: '/api/v1' });
  await app.register(webhookEndpointRoutes, { prefix: '/api/v1' });
  await app.register(apiKeyRoutes, { prefix: '/api/v1' });
  await app.register(revisionRoutes, { prefix: '/api/v1' });
  await app.register(notificationRoutes, { prefix: '/api/v1' });
  await app.register(dashboardRoutes, { prefix: '/api/v1' });
  await app.register(auditRoutes, { prefix: '/api/v1' });
  await app.register(accountRoutes, { prefix: '/api/v1' });
  await app.register(twoFactorRoutes, { prefix: '/api/v1' });
  await app.register(dataExportRoutes, { prefix: '/api/v1' });
  await app.register(orgRoutes, { prefix: '/api/v1' });
  await app.register(whatsappRoutes, { prefix: '/api/v1' });
  await app.register(inboxRoutes, { prefix: '/api/v1' });
  await app.register(whatsappTemplatesRoutes, { prefix: '/api/v1' });
  await app.register(botRoutes, { prefix: '/api/v1' });
  await app.register(billingRoutes, { prefix: '/api/v1' });
  await app.register(saasRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1' });
  await app.register(contactsRoutes, { prefix: '/api/v1' });
  await app.register(segmentsRoutes, { prefix: '/api/v1' });
  await app.register(broadcastsRoutes, { prefix: '/api/v1' });
  await app.register(sequencesRoutes, { prefix: '/api/v1' });

  // Routes — public (HMAC-verified, no JWT)
  await app.register(inboundWebhookRoutes, { prefix: '/api/v1' });

  // Routes — public status page data (no auth). Mounted at /api/v1/status.
  await app.register(statusRoutes, { prefix: '/api/v1' });

  // Routes — chatbot read API (X-Aligned-Api-Key)
  await app.register(readApiRoutes, { prefix: '/api/v1' });

  return app;
}

async function start() {
  const app = await buildServer();
  try {
    await app.listen({ host: env.API_HOST, port: env.API_PORT });
    app.log.info(
      { url: `${env.API_PUBLIC_URL}/docs`, chatbotDocs: `${env.API_PUBLIC_URL}/docs/chatbot` },
      `ALIGNED API listening on :${env.API_PORT}`,
    );
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, async () => {
      app.log.info(`${sig} received, draining…`);
      await app.close();
      process.exit(0);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await start();
}
