// Per-widget mock data services. Each function mirrors the shape of a
// future real endpoint (one fn per widget = one endpoint to wire up
// later). All return Promise<T> + an artificial 300 ms delay so the
// dashboard's loading / skeleton states are exercised in dev.
//
// To swap a widget over to the real API later, change the body of the
// matching fn here to an `api.get<>` call against your route — the
// widget components themselves never need to know.

const MOCK_DELAY_MS = 300;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), MOCK_DELAY_MS));
}

// ---------- 1. KPI strip ---------------------------------------------------

export type KpiTone = 'warning' | 'success' | 'neutral';

export interface KpiTile {
  id: string;
  label: string;
  value: number;
  subtext: string;
  subtextTone: KpiTone;
  href: string;
  /** When present, renders a small badge action on the tile header. */
  action?: { label: string; href: string };
}

export interface KpiStripData {
  tiles: KpiTile[];
}

export async function getKpiStrip(): Promise<KpiStripData> {
  return delay({
    tiles: [
      {
        id: 'products',
        label: 'Products',
        value: 21,
        subtext: '3 missing price/photo',
        subtextTone: 'warning',
        // Filtered product list — the products page accepts ?filter=incomplete.
        href: '/products?filter=incomplete',
      },
      {
        id: 'services',
        label: 'Services',
        value: 7,
        subtext: 'all complete',
        subtextTone: 'success',
        href: '/services',
      },
      {
        id: 'faqs',
        label: 'FAQs',
        value: 13,
        subtext: 'covers top topics',
        subtextTone: 'neutral',
        href: '/business-info',
      },
      {
        id: 'contacts',
        label: 'Contacts',
        value: 1204,
        subtext: '+38 this week',
        subtextTone: 'success',
        href: '/contacts',
        action: { label: 'ADD', href: '/contacts?new=1' },
      },
    ],
  });
}

// ---------- 2. Onboarding checklist ----------------------------------------

export interface OnboardingStep {
  id: string;
  label: string;
  href: string;
  completed: boolean;
}

export interface OnboardingData {
  steps: OnboardingStep[];
  /** True when all 4 are done — the banner hides itself in that case. */
  complete: boolean;
}

export async function getOnboardingChecklist(): Promise<OnboardingData> {
  const steps: OnboardingStep[] = [
    { id: 'connect-wa', label: 'Connect WhatsApp', href: '/whatsapp', completed: true },
    { id: 'add-catalog', label: 'Add catalog', href: '/products', completed: true },
    { id: 'train-bot', label: 'Train bot', href: '/bot', completed: false },
    { id: 'go-live', label: 'Go live', href: '/bot', completed: false },
  ];
  return delay({ steps, complete: steps.every((s) => s.completed) });
}

// ---------- 3. Inbox snapshot ----------------------------------------------

export interface InboxSnapshot {
  openThreads: number;
  unassigned: number;
  awaitingReply: number;
  /** Average first-response time, in seconds. */
  avgFirstResponseSeconds: number;
}

export async function getInboxSnapshot(): Promise<InboxSnapshot> {
  return delay({
    openThreads: 12,
    unassigned: 4,
    awaitingReply: 3,
    avgFirstResponseSeconds: 100, // 1m 40s
  });
}

// ---------- 4. Bot performance · today -------------------------------------

export interface BotPerformanceToday {
  autoResolvedPercent: number;
  botHandledMessages: number;
  handedToHuman: number;
  topFaq: string;
}

export async function getBotPerformanceToday(): Promise<BotPerformanceToday> {
  return delay({
    autoResolvedPercent: 86,
    botHandledMessages: 240,
    handedToHuman: 19,
    topFaq: 'opening hours',
  });
}

// ---------- 5. Outreach & campaigns ----------------------------------------

export type CampaignStatus = 'idle' | 'sending' | 'completed' | 'paused';

export interface ActiveCampaign {
  id: string;
  name: string;
  status: CampaignStatus;
  sent: number;
  delivered: number;
  read: number;
}

export interface OutreachData {
  active: ActiveCampaign | null;
}

export async function getOutreachCampaigns(): Promise<OutreachData> {
  return delay({
    active: {
      id: 'cmp_june_promo',
      name: 'June promo',
      status: 'sending',
      sent: 820,
      delivered: 790,
      read: 512,
    },
  });
}

// ---------- 6. AI chatbot budget · today -----------------------------------

export interface AiBudgetToday {
  plan: 'Unlimited' | 'Capped';
  used: number;
  /** Daily cap when plan === 'Capped'; otherwise ignored. */
  limit: number;
  estCostUsd: number;
}

export async function getAiBudgetToday(): Promise<AiBudgetToday> {
  return delay({
    plan: 'Unlimited',
    used: 41_951,
    limit: 200_000,
    estCostUsd: 0.012,
  });
}

// ---------- 7. Connections & sync ------------------------------------------

export type WebhookHealth = 'healthy' | 'degraded' | 'failing';

export interface ConnectionsData {
  /** ISO timestamp of the most recent successful sync, or null for "Never". */
  lastSyncIso: string | null;
  templates: { approved: number; pending: number };
  webhooks: WebhookHealth;
}

export async function getConnectionsSync(): Promise<ConnectionsData> {
  return delay({
    lastSyncIso: null, // "Never" per spec sample
    templates: { approved: 2, pending: 1 },
    webhooks: 'healthy',
  });
}

// ---------- 8. Recent activity ---------------------------------------------

export type ActivityKind =
  | 'product_updated'
  | 'service_updated'
  | 'login_succeeded'
  | 'business_info_updated'
  | 'broadcast_sent'
  | 'bot_deployed';

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  description: string;
  /** ISO timestamp. */
  at: string;
}

export async function getRecentActivity(): Promise<ActivityEvent[]> {
  const now = Date.now();
  const m = (n: number) => new Date(now - n * 60_000).toISOString();
  const h = (n: number) => new Date(now - n * 60 * 60_000).toISOString();
  return delay([
    { id: 'a1', kind: 'product_updated', description: 'Product updated', at: m(5) },
    { id: 'a2', kind: 'login_succeeded', description: 'Login succeeded', at: m(5) },
    { id: 'a3', kind: 'business_info_updated', description: 'Business info updated', at: h(3) },
  ]);
}
