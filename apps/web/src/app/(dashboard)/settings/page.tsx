'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Building2, Download, Key, PlugZap, Trash2, User, Users, Webhook } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { api, ApiError, getAccessToken } from '@/lib/api';
import { useSession } from '@/lib/session';

function SettingsLink({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group block rounded-lg border border-border bg-surface p-4 transition-colors hover:border-brand-400 hover:bg-surface-muted/40"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-500">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-sm font-medium">
            {title}
            <ArrowRight className="size-3.5 translate-x-0 text-foreground-subtle opacity-0 transition-all group-hover:translate-x-1 group-hover:opacity-100" />
          </p>
          <p className="mt-0.5 text-xs text-foreground-muted">{description}</p>
        </div>
      </div>
    </Link>
  );
}

export default function SettingsPage() {
  const { session } = useSession();
  const router = useRouter();
  const organization = session?.organization;
  const user = session?.user;
  const isOrgAdmin = organization?.role === 'admin';
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function exportOrgData() {
    setExporting(true);
    try {
      const url = `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/organization/export`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `aligned-org-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      toast.success('Organization archive downloaded.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  async function deleteOrganization() {
    const confirmed = await confirmDialog({
      title: `Permanently delete ${organization?.name ?? 'this organization'}?`,
      body:
        'This is irreversible. Every product, service, FAQ, audit entry, member, API key, webhook endpoint, connector, and WhatsApp message will be deleted. ' +
        'Other organizations are unaffected. You will be signed out.',
      confirmLabel: 'Delete organization',
      destructive: true,
    });
    if (!confirmed) return;
    setDeleting(true);
    try {
      await api.delete('/api/v1/organization');
      toast.success('Organization deleted.');
      router.push('/login');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error('Delete failed.');
      setDeleting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Workspace and account preferences."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="size-4" /> Organization
            </CardTitle>
            <CardDescription>
              {organization ? (
                <>
                  Currently viewing{' '}
                  <span className="font-medium text-foreground">
                    {organization.name}
                  </span>{' '}
                  · <span className="font-mono">{organization.slug}</span>
                </>
              ) : (
                'Your workspace.'
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <SettingsLink
              href="/members"
              icon={Users}
              title="Members"
              description="Invite teammates, assign roles, deactivate users."
            />
            <div className="rounded-lg border border-dashed border-border p-4">
              <p className="text-sm font-medium text-foreground-muted">
                Organization name, logo & billing
              </p>
              <p className="mt-0.5 text-xs text-foreground-subtle">
                Coming in a future release. Contact ALIGNED to rename your
                organization for now.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="size-4" /> Your account
            </CardTitle>
            <CardDescription>
              {user
                ? `Signed in as ${user.email}.`
                : 'Your personal account.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <SettingsLink
              href="/settings/profile"
              icon={User}
              title="Profile & password"
              description="Update your name, change your password."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Key className="size-4" /> Integrations
            </CardTitle>
            <CardDescription>
              Keys, connectors, and webhooks for your chatbot and automations.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <SettingsLink
              href="/api-keys"
              icon={Key}
              title="API keys"
              description="Let the chatbot read your catalog (X-Aligned-Api-Key)."
            />
            <SettingsLink
              href="/connectors"
              icon={PlugZap}
              title="API connectors"
              description="Pull data from Shopify, Sheets, or accept push via inbound webhook."
            />
            <SettingsLink
              href="/webhooks"
              icon={Webhook}
              title="Outbound webhooks"
              description="Notify external systems when your catalog changes."
            />
          </CardContent>
        </Card>

        {isOrgAdmin ? (
          <Card>
            <CardHeader>
              <CardTitle>Organization data</CardTitle>
              <CardDescription>
                Export everything about <strong>{organization?.name}</strong> as JSON, or
                permanently delete the organisation. Org-admin only.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button variant="secondary" loading={exporting} onClick={exportOrgData}>
                <Download className="size-4" /> Download organization archive
              </Button>
              <p className="text-xs text-foreground-muted">
                Includes products, services, business info, FAQs, policies, members (without
                password hashes), audit log, webhook endpoints, connectors, and WhatsApp config.
                API keys + WhatsApp tokens are <em>not</em> included — those are issued, not
                portable.
              </p>
            </CardContent>
          </Card>
        ) : null}

        {isOrgAdmin ? (
          <Card className="border-red-200">
            <CardHeader>
              <CardTitle className="text-red-700">Delete organization</CardTitle>
              <CardDescription>
                Hard-delete this organisation and every entity inside it. Other organisations are
                unaffected. Refused if a member of this org is the last admin somewhere else.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="danger" loading={deleting} onClick={deleteOrganization}>
                <Trash2 className="size-4" /> Delete organization
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
