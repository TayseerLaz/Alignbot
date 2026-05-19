// Phase 3 §5.1.4 — GDPR data portability worker.
//
// Reads everything tenant-scoped for the org (catalog, conversations, bot
// config, audit), JSON.stringifies the bundle, gzips it, uploads to Wasabi
// at `exports/<orgId>/<exportId>.json.gz`, then emails the requester a
// short-lived signed download URL.
//
// The "everything" list is deliberately explicit — adding a new tenant
// table later means consciously choosing whether it's part of an export.
// That's safer than reflective walks that quietly include everything.
import { Worker } from 'bullmq';
import { gzipSync } from 'node:zlib';

import { sendEmail } from '../lib/email.js';
import { env } from '../lib/env.js';
import { getConnection } from '../lib/redis.js';
import { putObject } from '../lib/storage.js';

import { prisma, withRlsBypass } from './db.js';

interface DataExportPayload {
  organizationId: string;
  requestedByUserId: string;
  requestedByEmail: string;
  exportId: string;
}

async function gatherBundle(orgId: string): Promise<Record<string, unknown>> {
  return withRlsBypass(async (tx) => {
    // Catalog
    const [organization, products, services, categories, businessInfo, locations, contacts, faqs, policies] =
      await Promise.all([
        tx.organization.findUnique({ where: { id: orgId } }),
        tx.product.findMany({
          where: { organizationId: orgId },
          include: { variants: true, images: true },
        }),
        tx.service.findMany({
          where: { organizationId: orgId },
          include: { pricingTiers: true, availability: true },
        }),
        tx.category.findMany({ where: { organizationId: orgId } }),
        tx.businessInfo.findUnique({ where: { organizationId: orgId } }),
        tx.location.findMany({ where: { organizationId: orgId } }),
        tx.contactChannel.findMany({ where: { organizationId: orgId } }),
        tx.fAQ.findMany({ where: { organizationId: orgId } }),
        tx.policy.findMany({ where: { organizationId: orgId } }),
      ]);

    // Conversations
    const [threads, messages, notes] = await Promise.all([
      tx.whatsAppThread.findMany({ where: { organizationId: orgId }, include: { tags: true } }),
      tx.whatsAppMessage.findMany({ where: { organizationId: orgId }, orderBy: { receivedAt: 'asc' } }),
      tx.whatsAppNote.findMany({ where: { organizationId: orgId } }),
    ]);

    // Bot config + KB
    const [botConfig, kb] = await Promise.all([
      tx.botConfig.findUnique({ where: { organizationId: orgId } }),
      tx.knowledgeBaseEntry.findMany({ where: { organizationId: orgId } }),
    ]);

    // Audit log (last 5,000 entries — full history is in cold storage if
    // ever needed; spec calls for "exportable for compliance" not "every
    // entry since the dawn of time").
    const audit = await tx.auditLog.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
      take: 5_000,
    });

    return {
      meta: {
        exportedAt: new Date().toISOString(),
        format: 'json+gzip',
        version: 1,
      },
      organization,
      catalog: {
        products,
        services,
        categories,
        businessInfo,
        locations,
        contacts,
        faqs,
        policies,
      },
      conversations: {
        threads,
        messages,
        notes,
      },
      bot: {
        config: botConfig,
        knowledgeBase: kb,
      },
      audit,
    };
  });
}

export function startDataExportWorker() {
  return new Worker<DataExportPayload>(
    'data-export',
    async (job) => {
      const { organizationId, exportId, requestedByEmail } = job.data;

      // Mark running.
      await withRlsBypass((tx) =>
        tx.dataExport.update({
          where: { id: exportId },
          data: { status: 'running', startedAt: new Date() },
        }),
      );

      try {
        const bundle = await gatherBundle(organizationId);
        const json = Buffer.from(JSON.stringify(bundle, null, 2));
        const gzipped = gzipSync(json);

        const storageKey = `exports/${organizationId}/${exportId}.json.gz`;
        const bytes = await putObject({
          storageKey,
          body: gzipped,
          contentType: 'application/gzip',
        });

        await withRlsBypass((tx) =>
          tx.dataExport.update({
            where: { id: exportId },
            data: {
              status: 'succeeded',
              storageKey,
              fileSizeBytes: bytes,
              finishedAt: new Date(),
            },
          }),
        );

        // Email notification — link drops the user back into the portal,
        // which mints a signed URL when they click "Download". We don't
        // embed the signed URL in email because email may be retained
        // longer than the URL's lifetime.
        const downloadUrl = `${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/settings/data-export`;
        const sizeMb = (bytes / (1024 * 1024)).toFixed(2);
        const subject = 'Your data export is ready';
        const text = `Your data export is ready (${sizeMb} MB, gzipped JSON).\n\nDownload from the portal: ${downloadUrl}\n\nThis email is sent to admins of the organization that requested the export.`;
        const html = `
          <p>Your data export is ready.</p>
          <p><strong>Size:</strong> ${sizeMb} MB (gzipped JSON)</p>
          <p><a href="${downloadUrl}">Download from the portal</a></p>
          <p style="color:#64748b;font-size:12px;margin-top:24px">Download links are short-lived and minted on demand. If the link expires, request a new one from the same page.</p>
        `;

        try {
          await sendEmail({ to: requestedByEmail, subject, text, html });
        } catch (err) {
          // Email delivery failures shouldn't fail the export — the row
          // is already 'succeeded' and the user can find it in the
          // portal regardless. Log loudly for ops.
          // eslint-disable-next-line no-console
          console.error('[data-export] email send failed', err);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'export failed';
        await withRlsBypass((tx) =>
          tx.dataExport.update({
            where: { id: exportId },
            data: { status: 'failed', finishedAt: new Date(), errorMessage: message },
          }),
        ).catch(() => undefined);
        throw err;
      }
    },
    {
      connection: getConnection(),
      concurrency: env.DATA_EXPORT_CONCURRENCY,
    },
  );
}

// Re-export for convenience so the worker entry doesn't need to know about prisma.
export { prisma };
