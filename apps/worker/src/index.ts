// Worker entry. Boots all BullMQ workers (import, sync, webhook delivery).
import * as Sentry from '@sentry/node';
import http from 'node:http';
import pino from 'pino';
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';

import { env } from './lib/env.js';
import { startBookingReminderTick } from './jobs/booking-reminder-tick.js';
import { startDraftCartTtlTick } from './jobs/draft-cart-ttl.js';
import { startProvenanceDigestTick } from './jobs/provenance-digest-tick.js';
import { startBroadcastFanoutWorker } from './jobs/broadcast-fanout.js';
import { startBroadcastSendWorker } from './jobs/broadcast-send.js';
import { startCrawlWorker } from './jobs/crawl.js';
import { startDataExportWorker } from './jobs/data-export.js';
import { startDunningTick } from './jobs/dunning-tick.js';
import { startImportWorker } from './jobs/import.js';
import { startSequenceTick } from './jobs/sequence-tick.js';
import { startInboxConsistencyTick } from './jobs/inbox-consistency.js';
import { startSyncWorker } from './jobs/sync.js';
import { startUptimeProbe } from './jobs/uptime-probe.js';
import { startWebhookDeliveryWorker } from './jobs/webhook-delivery.js';
import { prisma } from './jobs/db.js';

const log = pino({
  level: env.LOG_LEVEL,
  name: 'aligned-worker',
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
});

import { markShuttingDown } from './lib/lifecycle.js';

async function main() {
  log.info('starting workers…');

  // ----- Boot-time orphan reconciler -----------------------------------
  // CrawlJobs with status='running' but no live BullMQ job (because the
  // previous worker process was SIGKILLed mid-job and the BullMQ
  // attempts budget exhausted, OR the queue's prior attempts:1 config
  // never retried) get marked failed here so they don't sit "running"
  // forever in the UI. The 10-minute floor protects an actually-live
  // crawl in case a sibling worker is processing it RIGHT NOW; we'd
  // rather a slightly slow recovery than collide with a healthy run.
  try {
    const orphans = await prisma.crawlJob.updateMany({
      where: {
        status: 'running',
        finishedAt: null,
        startedAt: { lt: new Date(Date.now() - 10 * 60_000) },
      },
      data: {
        status: 'failed',
        errorMessage:
          'Worker restarted while this crawl was running. Click Start to retry — pages already fetched will not be re-crawled.',
        finishedAt: new Date(),
      },
    });
    if (orphans.count > 0) {
      log.info({ count: orphans.count }, 'reconciled orphaned crawl jobs');
    }
  } catch (err) {
    log.warn({ err }, 'orphan-reconciler skipped (DB unavailable)');
  }

  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT ?? 'development',
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
      release: process.env.SENTRY_RELEASE,
    });
  }

  // Prometheus metrics on a tiny HTTP server (separate port from API).
  const registry = new Registry();
  registry.setDefaultLabels({ app: 'aligned-worker' });
  collectDefaultMetrics({ register: registry });
  const jobsCompleted = new Counter({
    name: 'worker_jobs_completed_total',
    help: 'Jobs completed',
    labelNames: ['queue'],
    registers: [registry],
  });
  const jobsFailed = new Counter({
    name: 'worker_jobs_failed_total',
    help: 'Jobs failed',
    labelNames: ['queue'],
    registers: [registry],
  });
  const jobDuration = new Gauge({
    name: 'worker_last_job_duration_seconds',
    help: 'Last completed job duration per queue',
    labelNames: ['queue'],
    registers: [registry],
  });

  const metricsServer = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': registry.contentType });
      res.end(await registry.metrics());
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(404).end();
  });
  metricsServer.listen(Number(process.env.WORKER_METRICS_PORT ?? 9100), () =>
    log.info({ port: process.env.WORKER_METRICS_PORT ?? 9100 }, 'metrics server listening'),
  );

  // Start the uptime probe — separate from the BullMQ workers list because
  // it's not a queue worker, it's a recurring self-ping interval.
  startUptimeProbe();
  // Phase 5.4 — sequence tick: drives drip campaigns. Same shape as the
  // uptime probe (recurring interval), not a BullMQ worker.
  const sequenceTick = startSequenceTick();
  log.info({ name: sequenceTick.name }, 'tick started');
  // Phase 5.9 — dunning tick: hourly scan for past-due subscriptions over the
  // grace window; auto-suspends the org + notifies admins.
  const dunningTick = startDunningTick();
  log.info({ name: dunningTick.name }, 'tick started');
  // Booking reminder tick: every minute, send the operator-picked
  // template 2 hours before each confirmed booking's appointmentAt.
  const bookingReminderTick = startBookingReminderTick();
  log.info({ name: bookingReminderTick.name }, 'tick started');
  // Draft-cart sweeper: hourly tick that cancels draft carts older
  // than 14 days so abandoned in-progress orders don't accumulate.
  const draftCartTtlTick = startDraftCartTtlTick();
  log.info({ name: draftCartTtlTick.name }, 'tick started');
  // Phase 8 / 1.4 — daily provenance digest. Aggregates the prior 24h of
  // flagged bot replies across all tenants and emails the summary to every
  // ALIGNED admin. Silent when there are zero flagged replies in the window.
  const provenanceDigestTick = startProvenanceDigestTick();
  log.info({ name: provenanceDigestTick.name }, 'tick started');
  // Inbox consistency: every 15 min, re-link any orphaned (thread-less)
  // WhatsApp messages to their conversation so no chat is ever lost from the
  // inbox. Also repairs any pre-existing orphans on first run after boot.
  const inboxConsistencyTick = startInboxConsistencyTick();
  log.info({ name: inboxConsistencyTick.name }, 'tick started');

  const workers = [
    startImportWorker(),
    startSyncWorker(),
    startWebhookDeliveryWorker(),
    startCrawlWorker(),
    startDataExportWorker(),
    startBroadcastFanoutWorker(),
    startBroadcastSendWorker(),
  ];

  for (const w of workers) {
    w.on('ready', () => log.info({ name: w.name }, 'worker ready'));
    w.on('error', (err) => {
      log.error({ name: w.name, err }, 'worker error');
      Sentry.captureException(err, { extra: { worker: w.name } });
    });
    w.on('failed', (job, err) => {
      log.warn({ name: w.name, jobId: job?.id, err: err.message }, 'job failed');
      jobsFailed.inc({ queue: w.name });
      Sentry.captureException(err, { extra: { worker: w.name, jobId: job?.id } });
    });
    w.on('completed', (job) => {
      log.debug({ name: w.name, jobId: job.id }, 'job completed');
      jobsCompleted.inc({ queue: w.name });
      if (job.processedOn && job.finishedOn) {
        jobDuration.set({ queue: w.name }, (job.finishedOn - job.processedOn) / 1000);
      }
    });
  }

  log.info('all workers booted');

  const shutdown = async (sig: string) => {
    log.info(`${sig} received — closing workers…`);
    // Flip the flag BEFORE the worker.close()s so the in-flight crawl
    // handler can observe it on its next per-page poll and throw a
    // typed retryable error (BullMQ retries the job on the next boot).
    markShuttingDown();
    metricsServer.close();
    await Promise.all(workers.map((w) => w.close()));
    await prisma.$disconnect();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
