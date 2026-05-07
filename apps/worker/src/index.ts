// Worker entry. Boots all BullMQ workers (import, sync, webhook delivery).
import * as Sentry from '@sentry/node';
import http from 'node:http';
import pino from 'pino';
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';

import { env } from './lib/env.js';
import { startBroadcastFanoutWorker } from './jobs/broadcast-fanout.js';
import { startBroadcastSendWorker } from './jobs/broadcast-send.js';
import { startCrawlWorker } from './jobs/crawl.js';
import { startDataExportWorker } from './jobs/data-export.js';
import { startDunningTick } from './jobs/dunning-tick.js';
import { startImportWorker } from './jobs/import.js';
import { startSequenceTick } from './jobs/sequence-tick.js';
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

async function main() {
  log.info('starting workers…');

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
    metricsServer.close();
    await Promise.all(workers.map((w) => w.close()));
    await prisma.$disconnect();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
