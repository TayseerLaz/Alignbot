'use client';

import { ArrowUpRight, Briefcase, Building2, KeyRound, Package, RefreshCw } from 'lucide-react';
import Link from 'next/link';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useSession } from '@/lib/session';
import { fullName } from '@/lib/utils';

interface MetricCardProps {
  title: string;
  value: string | number;
  href: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
}

function MetricCard({ title, value, hint, href, icon: Icon }: MetricCardProps) {
  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm font-medium text-foreground-muted">{title}</CardTitle>
        <Icon className="size-4 text-foreground-subtle" />
      </CardHeader>
      <CardContent className="flex items-end justify-between">
        <div>
          <div className="text-3xl font-semibold tracking-tight">{value}</div>
          {hint ? <p className="mt-1 text-xs text-foreground-subtle">{hint}</p> : null}
        </div>
        <Link
          href={href}
          className="flex items-center gap-1 text-xs text-brand-500 hover:underline"
        >
          Open <ArrowUpRight className="size-3" />
        </Link>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { session } = useSession();
  const greeting = session ? fullName(session.user.firstName, session.user.lastName, '').split(' ')[0] : '';

  return (
    <>
      <PageHeader
        title={greeting ? `Welcome back, ${greeting}` : 'Welcome back'}
        description="Here's a snapshot of your organization's data health."
        actions={
          <Button variant="secondary" size="sm">
            <RefreshCw className="size-4" /> Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Products"
          value={0}
          hint="Add your first product"
          href="/products"
          icon={Package}
        />
        <MetricCard
          title="Services"
          value={0}
          hint="Add your first service"
          href="/services"
          icon={Briefcase}
        />
        <MetricCard
          title="Business info"
          value="Not set"
          hint="Hours, locations, FAQs"
          href="/business-info"
          icon={Building2}
        />
        <MetricCard
          title="API keys"
          value={0}
          hint="For your chatbot"
          href="/api-keys"
          icon={KeyRound}
        />
      </div>

      <section className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Get started</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="flex items-start justify-between gap-3 rounded-lg border border-dashed border-border p-4">
              <div>
                <p className="font-medium">Add your first products and services</p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Manually create entries or bulk import from a spreadsheet on Day 3.
                </p>
              </div>
              <Button asChild size="sm" variant="secondary">
                <Link href="/products">Open catalog</Link>
              </Button>
            </div>
            <div className="flex items-start justify-between gap-3 rounded-lg border border-dashed border-border p-4">
              <div>
                <p className="font-medium">Invite your team</p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Add admins, editors, or viewers to collaborate on your data.
                </p>
              </div>
              <Button asChild size="sm" variant="secondary">
                <Link href="/members">Manage members</Link>
              </Button>
            </div>
            <div className="flex items-start justify-between gap-3 rounded-lg border border-dashed border-border p-4">
              <div>
                <p className="font-medium">Connect your WhatsApp chatbot</p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Issue an API key so the chatbot can read your live catalog.
                </p>
              </div>
              <Button asChild size="sm" variant="secondary">
                <Link href="/api-keys">Create API key</Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>System status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-foreground-muted">Last sync</span>
              <span className="text-foreground-subtle">N/A</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-foreground-muted">API status</span>
              <span className="inline-flex items-center gap-1.5 text-success">
                <span className="size-2 rounded-full bg-success" /> Operational
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-foreground-muted">Active connections</span>
              <span>0</span>
            </div>
          </CardContent>
        </Card>
      </section>
    </>
  );
}
