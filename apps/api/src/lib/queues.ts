import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

import { env } from './env.js';

// Single shared connection for queue producers (api). Workers use their own.
let connection: IORedis | null = null;

function getConnection(): IORedis {
  if (connection) return connection;
  connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

// ----- Queue names ---------------------------------------------------------
export const QUEUE_IMPORT = 'import';
export const QUEUE_SYNC = 'sync';
export const QUEUE_WEBHOOK_DELIVERY = 'webhook-delivery';
export const QUEUE_EMAIL = 'email';
export const QUEUE_CRAWL = 'crawl';
export const QUEUE_DATA_EXPORT = 'data-export';

// ----- Job payload types (single source of truth shared with worker) ------
export interface ImportJobPayload {
  organizationId: string;
  importJobId: string;
}

export interface SyncJobPayload {
  organizationId: string;
  connectorId: string;
  syncRunId: string;
  trigger: 'scheduled' | 'manual' | 'webhook';
}

export interface WebhookDeliveryPayload {
  organizationId: string;
  deliveryId: string;
}

export interface EmailJobPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface CrawlJobPayload {
  organizationId: string;
  crawlJobId: string;
}

export interface DataExportPayload {
  organizationId: string;
  requestedByUserId: string;
  requestedByEmail: string;
  exportId: string;
}

// ----- Queue singletons (lazy) --------------------------------------------
let importQueue: Queue<ImportJobPayload> | null = null;
let syncQueue: Queue<SyncJobPayload> | null = null;
let webhookQueue: Queue<WebhookDeliveryPayload> | null = null;
let emailQueue: Queue<EmailJobPayload> | null = null;

export function getImportQueue(): Queue<ImportJobPayload> {
  if (!importQueue) importQueue = new Queue(QUEUE_IMPORT, { connection: getConnection() });
  return importQueue;
}

export function getSyncQueue(): Queue<SyncJobPayload> {
  if (!syncQueue) {
    syncQueue = new Queue(QUEUE_SYNC, { connection: getConnection() });
  }
  return syncQueue;
}

export function getWebhookQueue(): Queue<WebhookDeliveryPayload> {
  if (!webhookQueue) {
    webhookQueue = new Queue(QUEUE_WEBHOOK_DELIVERY, { connection: getConnection() });
  }
  return webhookQueue;
}

export function getEmailQueue(): Queue<EmailJobPayload> {
  if (!emailQueue) emailQueue = new Queue(QUEUE_EMAIL, { connection: getConnection() });
  return emailQueue;
}

let crawlQueue: Queue<CrawlJobPayload> | null = null;
export function getCrawlQueue(): Queue<CrawlJobPayload> {
  if (!crawlQueue) crawlQueue = new Queue(QUEUE_CRAWL, { connection: getConnection() });
  return crawlQueue;
}

let dataExportQueue: Queue<DataExportPayload> | null = null;
export function getDataExportQueue(): Queue<DataExportPayload> {
  if (!dataExportQueue) {
    dataExportQueue = new Queue(QUEUE_DATA_EXPORT, { connection: getConnection() });
  }
  return dataExportQueue;
}

// QueueEvents — used by API to subscribe to progress (e.g. for SSE on imports).
let importEvents: QueueEvents | null = null;
export function getImportQueueEvents(): QueueEvents {
  if (!importEvents) importEvents = new QueueEvents(QUEUE_IMPORT, { connection: getConnection() });
  return importEvents;
}
