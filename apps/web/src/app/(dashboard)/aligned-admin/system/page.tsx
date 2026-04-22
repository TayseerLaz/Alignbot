'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  Building2,
  CheckCircle2,
  Database,
  Inbox,
  Rocket,
  Trash2,
  Users,
  Webhook,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

interface SystemHealth {
  orgs: { active: number; suspended: number; deleted: number };
  users: { total: number; pending: number; disabled: number };
  queues: {
    import: { waiting: number; active: number; failed: number };
    sync: { waiting: number; active: number; failed: number };
    webhook: { waiting: number; active: number; failed: number };
  };
  redis: { connected: boolean; opsPerSec: number | null };
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'default',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'default' | 'good' | 'warn';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : 'text-foreground';
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
              {label}
            </p>
            <p className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</p>
            {sub ? (
              <p className="mt-0.5 text-xs text-foreground-muted">{sub}</p>
            ) : null}
          </div>
          <Icon className="size-5 text-foreground-subtle" />
        </div>
      </CardContent>
    </Card>
  );
}

function QueueRow({
  name,
  icon: Icon,
  w,
  a,
  f,
}: {
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  w: number;
  a: number;
  f: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-foreground-subtle" />
        <span className="text-sm font-medium">{name}</span>
      </div>
      <div className="flex items-center gap-3 text-xs">
        <span>
          <span className="text-foreground-subtle">Waiting</span>{' '}
          <span className="font-mono">{w}</span>
        </span>
        <span>
          <span className="text-foreground-subtle">Active</span>{' '}
          <span className="font-mono">{a}</span>
        </span>
        <span>
          <span className="text-foreground-subtle">Failed</span>{' '}
          <span className={`font-mono ${f > 0 ? 'text-red-600' : ''}`}>{f}</span>
        </span>
      </div>
    </div>
  );
}

export default function AlignedAdminSystemPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();

  const system = useQuery({
    queryKey: ['admin-system'],
    queryFn: () => api.get<{ data: SystemHealth }>('/api/v1/aligned-admin/system'),
    refetchInterval: 10_000,
  });

  const drainFailed = useMutation({
    mutationFn: (queue: 'import' | 'sync' | 'webhook') =>
      api.post(`/api/v1/aligned-admin/queues/${queue}/drain-failed`),
    onSuccess: (_d, queue) => {
      queryClient.invalidateQueries({ queryKey: ['admin-system'] });
      toast.success(`Cleared failed jobs on ${queue} queue`);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Drain failed'),
  });

  if (!session?.user.isAlignedAdmin) {
    return (
      <>
        <PageHeader title="System health" />
        <Card>
          <CardContent className="p-6 text-sm text-foreground-muted">
            ALIGNED admin role required.
          </CardContent>
        </Card>
      </>
    );
  }

  const h = system.data?.data;
  const totalFailed =
    (h?.queues.import.failed ?? 0) +
    (h?.queues.sync.failed ?? 0) +
    (h?.queues.webhook.failed ?? 0);

  return (
    <>
      <PageHeader
        title="System health"
        description="Queue depth, Redis, and tenant counts across the platform."
        actions={
          <Button asChild variant="secondary">
            <Link href="/aligned-admin">Tenants</Link>
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Building2}
          label="Organisations"
          value={h ? h.orgs.active : '—'}
          sub={h ? `${h.orgs.suspended} suspended · ${h.orgs.deleted} deleted` : undefined}
        />
        <StatCard
          icon={Users}
          label="Users"
          value={h ? h.users.total : '—'}
          sub={h ? `${h.users.pending} pending · ${h.users.disabled} disabled` : undefined}
        />
        <StatCard
          icon={Database}
          label="Redis"
          value={h ? (h.redis.connected ? (h.redis.opsPerSec ?? 0) : 'down') : '—'}
          sub={h?.redis.connected ? 'ops/s · connected' : 'disconnected'}
          tone={h?.redis.connected ? 'good' : 'warn'}
        />
        <StatCard
          icon={totalFailed > 0 ? AlertCircle : CheckCircle2}
          label="Queue failures"
          value={totalFailed}
          sub={totalFailed === 0 ? 'all clear' : 'see breakdown below'}
          tone={totalFailed > 0 ? 'warn' : 'good'}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4" /> Queues
          </CardTitle>
          <CardDescription>
            Auto-refreshes every 10 s. High failure counts usually mean orphan
            repeatable jobs — clear them with the button on the right.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {!h ? (
            <p className="text-sm text-foreground-muted">Loading…</p>
          ) : (
            <>
              <QueueRow name="Imports" icon={Inbox} w={h.queues.import.waiting} a={h.queues.import.active} f={h.queues.import.failed} />
              <QueueRow name="API sync" icon={Rocket} w={h.queues.sync.waiting} a={h.queues.sync.active} f={h.queues.sync.failed} />
              <QueueRow name="Outbound webhooks" icon={Webhook} w={h.queues.webhook.waiting} a={h.queues.webhook.active} f={h.queues.webhook.failed} />

              {totalFailed > 0 ? (
                <div className="flex flex-wrap gap-2 pt-2">
                  {(['import', 'sync', 'webhook'] as const).map((q) =>
                    h.queues[q].failed > 0 ? (
                      <Button
                        key={q}
                        size="sm"
                        variant="secondary"
                        loading={drainFailed.isPending && drainFailed.variables === q}
                        onClick={() => drainFailed.mutate(q)}
                      >
                        <Trash2 className="size-3.5" /> Drain {q} failed ({h.queues[q].failed})
                      </Button>
                    ) : null,
                  )}
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
