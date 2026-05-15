import { ApiErrorCode, type ApiErrorPayload } from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import fp from 'fastify-plugin';

import { HttpError } from '../lib/errors.js';
import { captureError } from '../lib/sentry.js';

export default fp(async function errorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;

    // Zod validation errors — 400 with field-level details.
    if (hasZodFastifySchemaValidationErrors(err)) {
      const payload: ApiErrorPayload = {
        error: {
          code: ApiErrorCode.VALIDATION_ERROR,
          message: 'Request validation failed.',
          details: err.validation,
          requestId,
        },
      };
      req.log.warn({ requestId, validation: err.validation }, 'validation failure');
      return reply.code(400).send(payload);
    }

    // Our typed HttpError.
    if (err instanceof HttpError) {
      const payload: ApiErrorPayload = {
        error: { code: err.code, message: err.message, details: err.details, requestId },
      };
      if (err.statusCode >= 500) {
        req.log.error({ err, requestId }, 'HttpError');
      } else {
        req.log.warn({ code: err.code, msg: err.message, requestId }, 'HttpError');
      }
      return reply.code(err.statusCode).send(payload);
    }

    // Fastify rate-limit error.
    if ((err as { statusCode?: number }).statusCode === 429) {
      const payload: ApiErrorPayload = {
        error: {
          code: ApiErrorCode.RATE_LIMITED,
          message: 'Too many requests. Slow down and try again.',
          requestId,
        },
      };
      return reply.code(429).send(payload);
    }

    // Unknown — 500. Log full stack always; surface the underlying
    // message to ALIGNED super-admins so they can diagnose without
    // needing SSH access to the systemd journal. Regular users still
    // see the generic "Internal server error." text.
    req.log.error({ err, requestId, route: req.routeOptions?.url }, 'unhandled error');
    captureError(err, { requestId, route: req.routeOptions?.url });
    const e = err as Error;
    const isSuperAdmin = (req as { auth?: { isAlignedAdmin?: boolean } }).auth?.isAlignedAdmin === true;
    const exposeDetails = isSuperAdmin || process.env.NODE_ENV !== 'production';
    const payload: ApiErrorPayload = {
      error: {
        code: ApiErrorCode.INTERNAL,
        message: 'Internal server error.',
        requestId,
        details: exposeDetails
          ? {
              name: e?.name,
              message: e?.message,
              // Trim stack so the response isn't huge; first 8 frames is plenty.
              stack: typeof e?.stack === 'string'
                ? e.stack.split('\n').slice(0, 8).join('\n')
                : undefined,
              route: req.routeOptions?.url,
            }
          : undefined,
      },
    };
    return reply.code(500).send(payload);
  });

  app.setNotFoundHandler((req, reply) => {
    const payload: ApiErrorPayload = {
      error: {
        code: ApiErrorCode.NOT_FOUND,
        message: `Route ${req.method} ${req.url} not found.`,
        requestId: req.id,
      },
    };
    reply.code(404).send(payload);
  });
});
