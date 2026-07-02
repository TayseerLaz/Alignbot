'use client';

import { Check, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';

import { AddWidgetDialog } from '@/components/dashboard/add-widget-dialog';
import { AdminPlatformDashboard } from '@/components/dashboard/admin-platform-dashboard';
import { AiBudgetBanner } from '@/components/dashboard/ai-budget-banner';
import { WalletBalanceBanner } from '@/components/dashboard/wallet-balance-banner';
import { EditModeProvider, useEditMode } from '@/components/dashboard/edit-mode-context';
import { useDashboardLayout } from '@/components/dashboard/use-dashboard-layout';
import { WIDGETS_BY_ID, type WidgetDef, type WidgetId } from '@/components/dashboard/widget-registry';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/session';
import { fullName } from '@/lib/utils';

// Dashboard page is now a thin layout shell:
//   1) reads the operator's saved widget layout (localStorage)
//   2) drops the visible widgets into three render slots — KPI strip,
//      full-width banners, and a 2-col grid of half-width cards
//   3) exposes an "Edit dashboard" toggle that flips every widget into
//      KEEP/ADD mode + opens the Add-widget dialog (the widget bank)
//
// Widgets themselves own their data fetching, loading / empty / error
// states, and accessibility — see components/dashboard/widgets/*.

export default function DashboardPage() {
  const { session } = useSession();
  const layout = useDashboardLayout();
  const greeting = session
    ? fullName(session.user.firstName, session.user.lastName, '').split(' ')[0] ?? ''
    : '';

  // ALIGNED HQ gets a platform overview instead of the per-org widget board.
  // Gate: the user is an ALIGNED admin AND the active org is one of their real
  // memberships. While "controlling" a tenant (impersonation mints a
  // no-membership session for that org), the active org is NOT in
  // availableOrganizations — so the admin sees that tenant's normal dashboard,
  // which is what they want when managing the tenant's data.
  const inOwnHqAsAdmin =
    !!session?.user.isAlignedAdmin &&
    session.availableOrganizations.some((o) => o.id === session.organization.id);

  if (inOwnHqAsAdmin) {
    return <AdminPlatformDashboard greeting={greeting} />;
  }

  return (
    <EditModeProvider layout={layout}>
      <DashboardShell greeting={greeting} />
    </EditModeProvider>
  );
}

function DashboardShell({ greeting }: { greeting: string }) {
  const { editing, setEditing, layout } = useEditMode();
  const { session } = useSession();
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  const [addOpen, setAddOpen] = useState(false);

  // Pre-bucket the visible widgets by render slot so the layout below
  // doesn't have to scan the registry inline. Widgets whose org-feature the
  // tenant doesn't have (catalog/orders/broadcasts/contacts/phone/AI/inbox…)
  // are hidden entirely.
  const visible = layout.visible
    .map((id) => WIDGETS_BY_ID[id])
    .filter(Boolean)
    .filter((w) => !w.feature || !disabledFeatures.includes(w.feature));
  const kpi = visible.find((w) => w.slot === 'kpi');
  const fullWidth = visible.filter((w) => w.slot === 'full');
  const halfWidth = visible.filter((w) => w.slot === 'half');

  return (
    <>
      <PageHeader
        title={greeting ? `Welcome back, ${greeting}` : 'Welcome back'}
        description="Here's a snapshot of your organization's data health."
        actions={
          editing ? (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setAddOpen(true)}
                aria-label="Add widgets to dashboard"
              >
                <Plus className="size-4" /> Add widget
              </Button>
              <Button size="sm" onClick={() => setEditing(false)}>
                <Check className="size-4" /> Done editing
              </Button>
            </div>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setEditing(true)}
              aria-label="Edit dashboard layout"
            >
              <Pencil className="size-4" /> Edit dashboard
            </Button>
          )
        }
      />

      {/* Daily AI-budget alert — shown above everything when the bot is near or
          at its daily limit (the cap that pauses automatic replies). Paired with
          the prepaid WhatsApp balance alert (empty/low balance pauses sending). */}
      <div className="mb-6 space-y-3">
        <AiBudgetBanner />
        <WalletBalanceBanner />
      </div>

      {visible.length === 0 ? (
        <EmptyDashboard onAddClick={() => setAddOpen(true)} />
      ) : (
        <div className="space-y-6">
          {/* Slot 1: KPI strip — handles its own responsive 4/2/1 grid. */}
          {kpi ? <SlotRenderer def={kpi} /> : null}

          {/* Slot 2: Full-width widgets (onboarding banner). */}
          {fullWidth.map((w) => (
            <SlotRenderer key={w.id} def={w} />
          ))}

          {/* Slot 3: 2-col grid of half-width cards. Collapses to 1
              column on mobile via grid-cols-1 → lg:grid-cols-2. */}
          {halfWidth.length > 0 ? (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {halfWidth.map((w) => (
                <SlotRenderer key={w.id} def={w} />
              ))}
            </div>
          ) : null}
        </div>
      )}

      <AddWidgetDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}

function SlotRenderer({ def }: { def: WidgetDef }) {
  const Comp = def.Component;
  return <Comp />;
}

function EmptyDashboard({ onAddClick }: { onAddClick: () => void }) {
  return (
    <div className="rounded-lg border-2 border-dashed border-border bg-surface-muted/30 p-10 text-center">
      <p className="text-base font-medium">Your dashboard is empty.</p>
      <p className="mt-1 text-sm text-foreground-muted">
        Add a widget to start tracking what matters to you.
      </p>
      <Button onClick={onAddClick} className="mt-4">
        <Plus className="size-4" /> Add your first widget
      </Button>
    </div>
  );
}

// Type-only export to satisfy `import type` callers that wired against
// the old shape. The runtime layout API now lives in the hook.
export type { WidgetId };
