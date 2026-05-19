'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ClipboardCheck, Copy } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

interface CreatedTenant {
  organization: { id: string; slug: string; name: string };
  admin: { email: string };
  generatedPassword: string | null;
  welcomeEmailSent: boolean;
}

const PLANS = [
  {
    code: 'free' as const,
    name: 'Free',
    blurb: '25 products · 500 messages/mo · 1 broadcast/mo · 2 members',
  },
  {
    code: 'starter' as const,
    name: 'Starter',
    blurb: '250 products · 5k messages/mo · 5 broadcasts/mo · 5 members',
  },
  {
    code: 'growth' as const,
    name: 'Growth',
    blurb: '1k products · 50k messages/mo · 10 broadcasts/mo · 10 members',
  },
  {
    code: 'enterprise' as const,
    name: 'Enterprise',
    blurb: 'Unlimited · SLA + dedicated support · SSO + audit',
  },
];

export default function NewTenantPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { session } = useSession();

  const [organizationName, setOrgName] = useState('');
  const [organizationSlug, setOrgSlug] = useState('');
  const [planCode, setPlanCode] = useState<'free' | 'starter' | 'growth' | 'enterprise'>('free');
  const [adminFirstName, setFirst] = useState('');
  const [adminLastName, setLast] = useState('');
  const [adminEmail, setEmail] = useState('');
  const [adminPassword, setPwd] = useState('');
  const [sendWelcomeEmail, setSendEmail] = useState(true);

  const [created, setCreated] = useState<CreatedTenant | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ data: CreatedTenant }>('/api/v1/aligned-admin/orgs', {
        organizationName: organizationName.trim(),
        organizationSlug: organizationSlug.trim() || undefined,
        planCode,
        adminFirstName: adminFirstName.trim(),
        adminLastName: adminLastName.trim(),
        adminEmail: adminEmail.trim().toLowerCase(),
        adminPassword: adminPassword.trim() || undefined,
        sendWelcomeEmail,
      }),
    onSuccess: (res) => {
      setCreated(res.data);
      qc.invalidateQueries({ queryKey: ['admin-orgs'] });
      toast.success(`Created ${res.data.organization.name}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Create failed'),
  });

  // Block render if the operator somehow lands here without admin role.
  // Backend still gates the API; this is just to avoid showing a form
  // that's guaranteed to 403.
  if (!session?.user.isAlignedAdmin) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-sm text-foreground-muted">ALIGNED admin role required.</p>
        </CardContent>
      </Card>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!organizationName.trim()) return toast.error('Organization name is required.');
    if (!adminFirstName.trim()) return toast.error('First name is required.');
    if (!adminEmail.trim()) return toast.error('Email is required.');
    if (adminPassword.trim() && adminPassword.trim().length < 12) {
      return toast.error('If set, password must be at least 12 characters.');
    }
    create.mutate();
  };

  return (
    <>
      <PageHeader
        title="New tenant"
        description="Provision an organization on behalf of a customer. Pre-verified — they can log in immediately."
        actions={
          <Button variant="secondary" asChild>
            <Link href="/aligned-admin">
              <ArrowLeft className="size-4" /> Back to tenants
            </Link>
          </Button>
        }
      />

      <form onSubmit={submit} className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* ----- Org details ----- */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Organization</CardTitle>
            <CardDescription>The workspace your customer will operate.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="org-name">Company name</Label>
              <Input
                id="org-name"
                value={organizationName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Acme Trading LLC"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="org-slug">URL slug (optional)</Label>
              <Input
                id="org-slug"
                value={organizationSlug}
                onChange={(e) => setOrgSlug(e.target.value)}
                placeholder="Auto-derived from name if blank (e.g. acme-trading-llc)"
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-foreground-subtle">
                Lowercase letters, digits, hyphens. Used as the tenant identifier internally.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ----- Plan ----- */}
        <Card>
          <CardHeader>
            <CardTitle>Plan</CardTitle>
            <CardDescription>Bootstraps a trialing subscription on this plan.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {PLANS.map((p) => (
              <button
                key={p.code}
                type="button"
                onClick={() => setPlanCode(p.code)}
                className={`w-full rounded-lg border p-3 text-left transition ${
                  planCode === p.code
                    ? 'border-brand-500 bg-brand-50/60 dark:bg-brand-500/10'
                    : 'border-border bg-surface hover:bg-surface-muted'
                }`}
              >
                <div className="text-sm font-semibold">{p.name}</div>
                <div className="mt-1 text-[11px] text-foreground-muted">{p.blurb}</div>
              </button>
            ))}
          </CardContent>
        </Card>

        {/* ----- Admin user ----- */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Primary admin</CardTitle>
            <CardDescription>
              The login account we&apos;ll create. Email skips verification — they can sign in
              immediately.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="first-name">First name</Label>
              <Input
                id="first-name"
                value={adminFirstName}
                onChange={(e) => setFirst(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="last-name">Last name (optional)</Label>
              <Input
                id="last-name"
                value={adminLastName}
                onChange={(e) => setLast(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={adminEmail}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@acme-trading.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password (optional)</Label>
              <Input
                id="password"
                type="text"
                value={adminPassword}
                onChange={(e) => setPwd(e.target.value)}
                placeholder="Leave blank to auto-generate"
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-foreground-subtle">
                If blank, we generate a strong 16-character temporary password. The customer is
                emailed it and prompted to change on first login.
              </p>
            </div>
            <div className="lg:col-span-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={sendWelcomeEmail}
                  onChange={(e) => setSendEmail(e.target.checked)}
                  className="mt-1 size-4 accent-brand-600"
                />
                <span>
                  <span className="font-medium">Send welcome email</span>
                  <span className="block text-[11px] text-foreground-muted">
                    Delivers the login URL + email + password (if generated) to the customer&apos;s
                    inbox. Uncheck only for silent QA imports.
                  </span>
                </span>
              </label>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2 lg:col-span-3">
          <Button variant="secondary" asChild>
            <Link href="/aligned-admin">Cancel</Link>
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create tenant
          </Button>
        </div>
      </form>

      {/* Once the tenant exists we show this modal with the generated
          password so the operator can copy it (the welcome email already
          has it, but a copy in the UI is friendlier for verbal handoff). */}
      <Dialog
        open={Boolean(created)}
        onOpenChange={(open) => {
          if (!open) {
            const slug = created?.organization.slug;
            setCreated(null);
            // Reset form state. Navigating back to the admin list is the
            // usual next step.
            setOrgName('');
            setOrgSlug('');
            setFirst('');
            setLast('');
            setEmail('');
            setPwd('');
            setPlanCode('free');
            setSendEmail(true);
            if (slug) router.push('/aligned-admin');
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Tenant ready</DialogTitle>
          </DialogHeader>
          {created ? (
            <div className="space-y-3 text-sm">
              <p>
                <strong>{created.organization.name}</strong> is live. Slug:{' '}
                <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">
                  {created.organization.slug}
                </code>
              </p>
              <div className="rounded-lg border border-border bg-surface-muted px-3 py-2.5 font-mono text-xs">
                <div>
                  <span className="text-foreground-muted">Email:</span> {created.admin.email}
                </div>
                {created.generatedPassword ? (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-foreground-muted">Pass:</span>
                    <code className="break-all">{created.generatedPassword}</code>
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      aria-label="Copy password"
                      onClick={() => {
                        navigator.clipboard.writeText(created.generatedPassword ?? '');
                        toast.success('Password copied');
                      }}
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="mt-1 text-foreground-muted">
                    Password: <em>set by you above</em>
                  </div>
                )}
              </div>
              {created.welcomeEmailSent ? (
                <p className="flex items-center gap-1.5 text-[12px] text-emerald-600">
                  <ClipboardCheck className="size-3.5" /> Welcome email sent to{' '}
                  {created.admin.email}.
                </p>
              ) : (
                <p className="text-[12px] text-amber-600">
                  Welcome email skipped — share the credentials manually.
                </p>
              )}
              <p className="text-[11px] text-foreground-subtle">
                This password is shown <strong>once</strong>. After closing this dialog you can
                still reset it from the tenant&apos;s detail page if needed.
              </p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
