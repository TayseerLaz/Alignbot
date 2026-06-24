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
import JSZip from 'jszip';

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

// --- CSV helpers -----------------------------------------------------------
// Export is a ZIP of CSV files (one per data type) so it opens directly in
// Excel / Google Sheets. Nested values (rare) are JSON-encoded within a cell.
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows || rows.length === 0) return '';
  const keys = Array.from(
    rows.reduce<Set<string>>((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set()),
  );
  const header = keys.map(csvCell).join(',');
  const lines = rows.map((r) => keys.map((k) => csvCell(r[k])).join(','));
  return [header, ...lines].join('\r\n');
}

// Flatten the gathered bundle into one CSV per entity, zipped. Nested includes
// (variants, images, pricing tiers, availability, tags) become their own CSVs
// linked by a parent-id column.
async function buildCsvZip(bundle: Record<string, unknown>): Promise<Buffer> {
  const zip = new JSZip();
  const add = (name: string, rows: Record<string, unknown>[]) => {
    const csv = toCsv(rows);
    if (csv) zip.file(name, csv);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = bundle as any;

  if (b.organization) add('organization.csv', [b.organization]);

  const cat = b.catalog ?? {};
  const products: any[] = cat.products ?? [];
  add(
    'products.csv',
    products.map(({ variants: _v, images: _i, ...rest }) => rest),
  );
  add(
    'product_variants.csv',
    products.flatMap((p) => (p.variants ?? []).map((v: any) => ({ productId: p.id, ...v }))),
  );
  add(
    'product_images.csv',
    products.flatMap((p) => (p.images ?? []).map((img: any) => ({ productId: p.id, ...img }))),
  );

  const services: any[] = cat.services ?? [];
  add(
    'services.csv',
    services.map(({ pricingTiers: _t, availability: _a, ...rest }) => rest),
  );
  add(
    'service_pricing_tiers.csv',
    services.flatMap((s) => (s.pricingTiers ?? []).map((t: any) => ({ serviceId: s.id, ...t }))),
  );
  add(
    'service_availability.csv',
    services.flatMap((s) => (s.availability ?? []).map((a: any) => ({ serviceId: s.id, ...a }))),
  );

  add('categories.csv', cat.categories ?? []);
  if (cat.businessInfo) add('business_info.csv', [cat.businessInfo]);
  add('locations.csv', cat.locations ?? []);
  add('contact_channels.csv', cat.contacts ?? []);
  add('faqs.csv', cat.faqs ?? []);
  add('policies.csv', cat.policies ?? []);

  const conv = b.conversations ?? {};
  const threads: any[] = conv.threads ?? [];
  add(
    'conversation_threads.csv',
    threads.map(({ tags: _tg, ...rest }) => rest),
  );
  add(
    'conversation_thread_tags.csv',
    threads.flatMap((t) => (t.tags ?? []).map((tag: any) => ({ threadId: t.id, ...tag }))),
  );
  add('conversation_messages.csv', conv.messages ?? []);
  add('conversation_notes.csv', conv.notes ?? []);

  const bot = b.bot ?? {};
  if (bot.config) add('bot_config.csv', [bot.config]);
  // Drop the embedding vector — it's a huge numeric array that bloats the CSV
  // and isn't human-useful in a portability export.
  add(
    'bot_knowledge_base.csv',
    (bot.knowledgeBase ?? []).map(({ embedding: _e, ...rest }: any) => rest),
  );

  add('audit_log.csv', b.audit ?? []);

  zip.file(
    'README.txt',
    [
      'ALIGNED / Hader data export',
      `Exported: ${new Date().toISOString()}`,
      '',
      'One CSV per data type. Rows that link to a parent (variants, images,',
      'pricing tiers, availability, thread tags) carry a parent-id column.',
      'Any nested value is JSON-encoded inside its cell.',
    ].join('\n'),
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
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
        format: 'csv+zip',
        version: 2,
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
        const zipped = await buildCsvZip(bundle);

        const storageKey = `exports/${organizationId}/${exportId}.zip`;
        const bytes = await putObject({
          storageKey,
          body: zipped,
          contentType: 'application/zip',
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
        const text = `Your data export is ready (${sizeMb} MB, CSV files in a .zip).\n\nDownload from the portal: ${downloadUrl}\n\nThis email is sent to admins of the organization that requested the export.`;
        const html = `
          <p>Your data export is ready.</p>
          <p><strong>Size:</strong> ${sizeMb} MB (CSV files in a .zip)</p>
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
