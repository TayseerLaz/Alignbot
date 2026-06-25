'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Building2, CreditCard, Download, Key, MessageCircle, Phone, ShoppingBag, Trash2, User, Users } from 'lucide-react';
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
import { api, ApiError } from '@/lib/api';
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
  const disabledFeatures = organization?.disabledFeatures ?? [];
  const phoneOn = !disabledFeatures.includes('phone');
  // Messenger + Instagram share the /settings/messenger page. Show it while
  // EITHER channel is enabled; hide the whole section only when BOTH are off.
  const messagingOn =
    !disabledFeatures.includes('messenger') || !disabledFeatures.includes('instagram');
  const [deleting, setDeleting] = useState(false);

  async function deleteOrganization() {
    const confirmed = await confirmDialog({
      title: `Are you sure you want to delete ${organization?.name ?? 'this organization'}?`,
      body:
        'This is irreversible. Every product, service, FAQ, audit entry, member, API key, webhook endpoint, connector, and WhatsApp message will be deleted. ' +
        'Other organizations are unaffected. You will be signed out.',
      confirmLabel: 'Delete organization',
      destructive: true,
      // Force the admin to type "delete" before the button enables.
      requireText: 'delete',
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
            <SettingsLink
              href="/settings/billing"
              icon={CreditCard}
              title="Plan"
              description="Your current plan and usage caps."
            />
            {messagingOn && (
              <SettingsLink
                href="/settings/messenger"
                icon={MessageCircle}
                title="Messenger & Instagram"
                description="Let the AI bot answer your Facebook Page and Instagram DMs, not just WhatsApp."
              />
            )}
            {/* Branding is Phase 2 — hidden until logo/accent/footer
                are wired into the actual portal layout. The /settings/branding
                route still loads via direct URL, but no UI links to it. */}
            <SettingsLink
              href="/settings/data-export"
              icon={Download}
              title="Data export"
              description="Download all your products, conversations, and bot config (GDPR)."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Key className="size-4" /> Integrations
            </CardTitle>
            <CardDescription>
              Connect WhatsApp and phone channels to your chatbot.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <SettingsLink
              href="/whatsapp"
              icon={MessageCircle}
              title="WhatsApp"
              description="Connect your Meta WhatsApp Business number + manage templates."
            />
            <SettingsLink
              href="/connectors"
              icon={ShoppingBag}
              title="Shopify"
              description="Sync your Shopify products & orders into the platform via an API connector."
            />
            {phoneOn ? (
              <SettingsLink
                href="/phone-integrations"
                icon={Phone}
                title="Phone integration"
                description="Connect phone numbers to your AI voicebot (Aseer-time phone bridge)."
              />
            ) : null}
          </CardContent>
        </Card>

        {/* Account + the danger zone (delete org) live together in one box. */}
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
          <CardContent className="space-y-3">
            <SettingsLink
              href="/settings/profile"
              icon={User}
              title="Profile & password"
              description="Update your name, change your password."
            />

            {isOrgAdmin ? (
              <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/40 p-3 dark:border-red-400/30 dark:bg-red-400/10">
                <div>
                  <p className="text-sm font-semibold text-red-700">Delete organization</p>
                  <p className="mt-0.5 text-xs text-foreground-muted">
                    Hard-delete this organisation and every entity inside it. Other organisations are
                    unaffected. Refused if a member of this org is the last admin somewhere else.
                  </p>
                </div>
                <Button variant="danger" loading={deleting} onClick={deleteOrganization}>
                  <Trash2 className="size-4" /> Delete organization
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
