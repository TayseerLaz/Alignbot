'use client';

import Link from 'next/link';
import { ArrowRight, Building2, Key, PlugZap, User, Users, Webhook } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
  const organization = session?.organization;
  const user = session?.user;

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
      </div>
    </>
  );
}
