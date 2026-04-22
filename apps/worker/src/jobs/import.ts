// Streaming CSV/XLSX import worker.
//
// Why streaming: a 50 MB CSV with 200K rows would otherwise blow the heap.
// Strategy:
//   1. Stream-parse the file from Wasabi (csv-parse for CSV, ExcelJS streaming for XLSX).
//   2. For each row, apply column mapping → coerce to typed payload → Zod validate.
//   3. Upsert into the right table inside a per-tenant txn (RLS enforced).
//   4. Persist a per-row result so the user can download an error CSV later.
//   5. After every N rows, update the parent ImportJob's progress counters.
//
// Cancellation: the worker re-reads ImportJob.status between rows; if the user
// cancelled, we stop and mark as `cancelled` (rows already written stay).
import type { Prisma, PrismaClient } from '@aligned/db';
import type { Readable } from 'node:stream';

import { parse as csvParse } from 'csv-parse';
import { Worker } from 'bullmq';
import ExcelJS from 'exceljs';
import { z } from 'zod';

import { env } from '../lib/env.js';
import { getConnection } from '../lib/redis.js';
import { getObjectStream } from '../lib/storage.js';

import { prisma, withRlsBypass, withTenant } from './db.js';
import { upsertOne } from './shared-upsert.js';

async function notifyImportResult(
  organizationId: string,
  importJobId: string,
  status: 'succeeded' | 'partial' | 'failed' | 'cancelled',
  counts: { succeeded: number; failed: number; total: number },
) {
  const titles: Record<typeof status, string> = {
    succeeded: 'Import completed',
    partial: 'Import partially completed',
    failed: 'Import failed',
    cancelled: 'Import cancelled',
  };
  const severity =
    status === 'succeeded' ? 'success' : status === 'failed' ? 'error' : status === 'partial' ? 'warning' : 'info';
  await withRlsBypass((tx) =>
    tx.notification.create({
      data: {
        organizationId,
        kind:
          status === 'succeeded'
            ? 'import_succeeded'
            : status === 'partial'
              ? 'import_partial'
              : status === 'failed'
                ? 'import_failed'
                : 'generic',
        severity,
        title: titles[status],
        body:
          status === 'cancelled'
            ? 'Cancelled by user.'
            : `${counts.succeeded} of ${counts.total} rows succeeded${counts.failed ? `, ${counts.failed} failed` : ''}.`,
        link: `/imports/${importJobId}`,
        entityType: 'import_job',
        entityId: importJobId,
      },
    }),
  ).catch((err) => console.error('[import] notify failed', err));
}

const PROGRESS_FLUSH_EVERY = 25;

interface RowError {
  path: string;
  message: string;
}

// ---------- streaming row sources ------------------------------------------
async function* streamCsvRows(
  source: Readable,
): AsyncGenerator<{ headers: string[]; row: string[]; rowNumber: number }> {
  const parser = source.pipe(
    csvParse({
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }),
  );
  let headers: string[] | null = null;
  let rowNumber = 1;
  for await (const record of parser) {
    if (!headers) {
      headers = record as string[];
      rowNumber++;
      continue;
    }
    yield { headers, row: record as string[], rowNumber };
    rowNumber++;
  }
}

async function* streamXlsxRows(
  source: Readable,
): AsyncGenerator<{ headers: string[]; row: string[]; rowNumber: number }> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(source, {
    sharedStrings: 'cache',
    styles: 'cache',
    hyperlinks: 'ignore',
    worksheets: 'emit',
  });
  let headers: string[] | null = null;
  for await (const worksheetReader of reader) {
    for await (const row of worksheetReader) {
      const values = (row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v)));
      if (!headers) {
        headers = values;
        continue;
      }
      yield { headers, row: values, rowNumber: row.number };
    }
    break; // first worksheet only
  }
}

function applyMapping(
  headers: string[],
  values: string[],
  mapping: Record<string, string> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i] ?? '';
    const target = mapping?.[header] ?? mapping?.[header.trim()] ?? header;
    if (!target) continue;
    out[target] = values[i] ?? '';
  }
  return out;
}

// ---------- the worker -----------------------------------------------------
export function startImportWorker() {
  const worker = new Worker(
    'import',
    async (job) => {
      const { organizationId, importJobId } = job.data as {
        organizationId: string;
        importJobId: string;
      };

      const importJob = await prisma.importJob.update({
        where: { id: importJobId },
        data: { status: 'validating', startedAt: new Date() },
      });

      const asset = importJob.sourceAssetId
        ? await prisma.asset.findUnique({ where: { id: importJob.sourceAssetId } })
        : null;
      if (!asset) throw new Error('Source asset missing for import job ' + importJobId);

      const stream = await getObjectStream(asset.storageKey);
      const isXlsx =
        asset.contentType.includes('spreadsheet') || asset.contentType.includes('officedocument');
      const rows = isXlsx ? streamXlsxRows(stream) : streamCsvRows(stream);

      let processed = 0;
      let succeeded = 0;
      let failed = 0;
      const skipped = 0;

      await prisma.importJob.update({
        where: { id: importJobId },
        data: { status: 'processing' },
      });

      for await (const { headers, row, rowNumber } of rows) {
        if (processed > 0 && processed % PROGRESS_FLUSH_EVERY === 0) {
          const fresh = await prisma.importJob.findUnique({
            where: { id: importJobId },
            select: { status: true },
          });
          if (fresh?.status === 'cancelled') {
            await prisma.importJob.update({
              where: { id: importJobId },
              data: {
                processedRows: processed,
                succeededRows: succeeded,
                failedRows: failed,
                skippedRows: skipped,
                finishedAt: new Date(),
              },
            });
            return;
          }
          await prisma.importJob.update({
            where: { id: importJobId },
            data: { processedRows: processed, succeededRows: succeeded, failedRows: failed },
          });
        }

        const raw = applyMapping(
          headers,
          row,
          (importJob.columnMapping as Record<string, string> | null) ?? null,
        );
        try {
          const resultId = await withTenant(organizationId, (tx) =>
            upsertOne(tx as PrismaClient, organizationId, importJob.entityKind, raw),
          );
          succeeded++;
          await prisma.importJobRow.create({
            data: {
              organizationId,
              importJobId,
              rowNumber,
              status: 'succeeded',
              resultEntityId: resultId,
              rawData: raw as Prisma.InputJsonValue,
            },
          });
        } catch (err) {
          failed++;
          const errors: RowError[] =
            err instanceof z.ZodError
              ? err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
              : [{ path: '', message: err instanceof Error ? err.message : String(err) }];
          await prisma.importJobRow.create({
            data: {
              organizationId,
              importJobId,
              rowNumber,
              status: 'failed',
              rawData: raw as Prisma.InputJsonValue,
              errors: errors as unknown as Prisma.InputJsonValue,
            },
          });
        }
        processed++;
      }

      const finalStatus = failed === 0 ? 'succeeded' : succeeded === 0 ? 'failed' : 'partial';
      await prisma.importJob.update({
        where: { id: importJobId },
        data: {
          status: finalStatus,
          totalRows: processed,
          processedRows: processed,
          succeededRows: succeeded,
          failedRows: failed,
          finishedAt: new Date(),
        },
      });
      await notifyImportResult(organizationId, importJobId, finalStatus, {
        succeeded,
        failed,
        total: processed,
      });
    },
    {
      connection: getConnection(),
      concurrency: env.IMPORT_CONCURRENCY,
    },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    try {
      await prisma.importJob.update({
        where: { id: job.data.importJobId },
        data: { status: 'failed', errorMessage: err.message, finishedAt: new Date() },
      });
    } catch {
      // ignore
    }
  });

  return worker;
}
