// Single source of truth for dashboard widgets. The registry holds
// id → component + metadata (title, default-on, layout slot). The
// dashboard page reads this list in render-order and skips any widget
// the operator has hidden via the layout state.
//
// Adding a new widget is two edits:
//   1) build the component under ./widgets/your-widget.tsx
//   2) append an entry below
// Everything else (the ADD/KEEP toggles, the Add-widget dialog,
// localStorage persistence) picks it up for free.

import {
  Activity,
  Bot,
  Inbox,
  LayoutGrid,
  ListChecks,
  Plug,
  Send,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type { ComponentType } from 'react';

import { AiBudgetWidget } from './widgets/ai-budget';
import { BotPerformanceWidget } from './widgets/bot-performance';
import { ConnectionsSyncWidget } from './widgets/connections-sync';
import { InboxSnapshotWidget } from './widgets/inbox-snapshot';
import { KpiStripWidget } from './widgets/kpi-strip';
import { OnboardingChecklistWidget } from './widgets/onboarding-checklist';
import { OutreachCampaignsWidget } from './widgets/outreach-campaigns';
import { RecentActivityWidget } from './widgets/recent-activity';

export type WidgetId =
  | 'kpi-strip'
  | 'onboarding'
  | 'inbox-snapshot'
  | 'bot-performance'
  | 'outreach'
  | 'ai-budget'
  | 'connections'
  | 'recent-activity';

/**
 * Where the widget lives on the page. The dashboard places `full`
 * widgets at full width and `half` widgets inside a 2-col grid.
 * `kpi` is a special slot for the top stat strip (4-col responsive).
 */
export type WidgetSlot = 'kpi' | 'full' | 'half';

export interface WidgetDef {
  id: WidgetId;
  /** Human label shown in the Add-widget dialog. */
  title: string;
  /** Short blurb shown under the title in the Add-widget dialog. */
  description: string;
  icon: LucideIcon;
  slot: WidgetSlot;
  /** True = visible by default for a fresh user / cleared layout. */
  defaultOn: boolean;
  Component: ComponentType;
}

// Order matters: the dashboard renders widgets in this array's order
// (filtered by the current layout). KPI strip first, then onboarding
// banner, then the 2-col grid of half-width cards.
export const WIDGETS: WidgetDef[] = [
  {
    id: 'kpi-strip',
    title: 'Key counts',
    description: 'Products, services, FAQs, contacts — at a glance.',
    icon: LayoutGrid,
    slot: 'kpi',
    defaultOn: true,
    Component: KpiStripWidget,
  },
  {
    id: 'onboarding',
    title: 'Getting-started checklist',
    description: 'Connect WhatsApp → add catalog → train bot → go live.',
    icon: ListChecks,
    slot: 'full',
    defaultOn: true,
    Component: OnboardingChecklistWidget,
  },
  {
    id: 'inbox-snapshot',
    title: 'Inbox snapshot',
    description: 'Open / unassigned / awaiting reply + first-response time.',
    icon: Inbox,
    slot: 'half',
    defaultOn: true,
    Component: InboxSnapshotWidget,
  },
  {
    id: 'bot-performance',
    title: 'Bot performance · today',
    description: 'Auto-resolved %, messages handled, escalations, top FAQ.',
    icon: Bot,
    slot: 'half',
    defaultOn: true,
    Component: BotPerformanceWidget,
  },
  {
    id: 'outreach',
    title: 'Outreach & campaigns',
    description: 'Active campaign status + sent / delivered / read funnel.',
    icon: Send,
    slot: 'half',
    defaultOn: true,
    Component: OutreachCampaignsWidget,
  },
  {
    id: 'ai-budget',
    title: 'AI chatbot budget · today',
    description: 'Tokens used + estimated cost. Resets daily.',
    icon: Sparkles,
    slot: 'half',
    defaultOn: true,
    Component: AiBudgetWidget,
  },
  {
    id: 'connections',
    title: 'Connections & sync',
    description: 'Last sync, template approvals, webhook health.',
    icon: Plug,
    slot: 'half',
    defaultOn: true,
    Component: ConnectionsSyncWidget,
  },
  {
    id: 'recent-activity',
    title: 'Recent activity',
    description: 'The latest audit-log events with relative timestamps.',
    icon: Activity,
    slot: 'half',
    defaultOn: true,
    Component: RecentActivityWidget,
  },
];

export const WIDGETS_BY_ID: Record<WidgetId, WidgetDef> = WIDGETS.reduce(
  (acc, w) => ((acc[w.id] = w), acc),
  {} as Record<WidgetId, WidgetDef>,
);

export const DEFAULT_LAYOUT: WidgetId[] = WIDGETS.filter((w) => w.defaultOn).map((w) => w.id);
