'use client';

import type {
  WhatsAppChannelDto,
  WhatsAppMessageDto,
  WhatsAppTestSendResult,
  WhatsAppVerifyResult,
} from '@aligned/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  ExternalLink,
  MessageCircle,
  Phone,
  Plus,
  PowerOff,
  Send,
  ShieldCheck,
  Star,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

interface TemplateOption {
  id: string;
  name: string;
  language: string;
  status: string;
  bodyText?: string;
  // Full Meta-shaped components — the test-send form parses these to
  // figure out which header / URL-button placeholders need input
  // fields. Optional because older synced templates may not have it.
  components?: Record<string, unknown>[] | null;
}

type FormState = {
  label: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  appId: string;
  accessToken: string; // empty = leave alone, '__clear__' sentinel handled below
  appSecret: string;
  greetingMessage: string;
  businessName: string;
  businessAbout: string;
  businessAddress: string;
  businessEmail: string;
  isActive: boolean;
};

function formFromChannel(c: WhatsAppChannelDto): FormState {
  return {
    label: c.label ?? '',
    wabaId: c.wabaId ?? '',
    phoneNumberId: c.phoneNumberId ?? '',
    displayPhoneNumber: c.displayPhoneNumber ?? '',
    appId: c.appId ?? '',
    accessToken: '',
    appSecret: '',
    greetingMessage: c.greetingMessage ?? '',
    businessName: c.businessName ?? '',
    businessAbout: c.businessAbout ?? '',
    businessAddress: c.businessAddress ?? '',
    businessEmail: c.businessEmail ?? '',
    isActive: c.isActive,
  };
}

async function copyToClipboard(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Couldn't copy — click the field and copy manually.");
  }
}

export default function WhatsAppPage() {
  const queryClient = useQueryClient();

  // Multi-number: the full list of the org's WhatsApp numbers. The first call
  // to GET /whatsapp lazily creates the primary stub, so we hit it once to
  // guarantee at least one row exists, then drive everything off the list.
  const numbersQ = useQuery({
    queryKey: ['whatsapp-numbers'],
    queryFn: async () => {
      await api.get<{ data: WhatsAppChannelDto }>('/api/v1/whatsapp'); // ensure primary stub
      return api.get<{ data: WhatsAppChannelDto[] }>('/api/v1/whatsapp/numbers');
    },
  });
  const numbers = numbersQ.data?.data ?? [];
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  // Keep a valid selection: default to the primary, fall back to the first.
  useEffect(() => {
    if (numbers.length === 0) return;
    if (!selectedChannelId || !numbers.some((n) => n.id === selectedChannelId)) {
      setSelectedChannelId((numbers.find((n) => n.isPrimary) ?? numbers[0]!).id);
    }
  }, [numbers, selectedChannelId]);

  const messagesQ = useQuery({
    queryKey: ['whatsapp-messages'],
    queryFn: () => api.get<{ data: WhatsAppMessageDto[] }>('/api/v1/whatsapp/messages?limit=5'),
    refetchInterval: 10_000,
  });
  // Approved templates — used to populate the test-send dropdown so the
  // operator can pick instead of typing a name/language by hand.
  const templatesQ = useQuery({
    queryKey: ['whatsapp-templates'],
    queryFn: () => api.get<{ data: TemplateOption[] }>('/api/v1/whatsapp/templates'),
  });

  const channel = numbers.find((n) => n.id === selectedChannelId) ?? null;

  const [form, setForm] = useState<FormState | null>(null);
  useEffect(() => {
    if (channel) setForm(formFromChannel(channel));
    // Re-seed the form when the selected number changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannelId, channel?.updatedAt]);

  const invalidateNumbers = () =>
    queryClient.invalidateQueries({ queryKey: ['whatsapp-numbers'] });

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.put<{ data: WhatsAppChannelDto }>(`/api/v1/whatsapp/numbers/${selectedChannelId}`, payload),
    onSuccess: () => {
      invalidateNumbers();
      toast.success('Saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  // Add a new number, then select it so the operator can fill in its creds.
  const addNumber = useMutation({
    mutationFn: () =>
      api.post<{ data: WhatsAppChannelDto }>('/api/v1/whatsapp/numbers', {}),
    onSuccess: async (res) => {
      await invalidateNumbers();
      setSelectedChannelId(res.data.id);
      toast.success('Number added — fill in its credentials');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Add failed'),
  });

  // Make the selected number the org default (primary).
  const promote = useMutation({
    mutationFn: () => api.post(`/api/v1/whatsapp/numbers/${selectedChannelId}/promote`),
    onSuccess: () => {
      invalidateNumbers();
      toast.success('Set as primary number');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Failed'),
  });

  // Remove a non-primary number entirely.
  const removeNumber = useMutation({
    mutationFn: () => api.delete(`/api/v1/whatsapp/numbers/${selectedChannelId}`),
    onSuccess: async () => {
      await invalidateNumbers();
      setSelectedChannelId(null);
      toast.success('Number removed');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Remove failed'),
  });

  const verify = useMutation({
    mutationFn: () =>
      api.post<{ data: WhatsAppVerifyResult }>('/api/v1/whatsapp/verify', {
        channelId: selectedChannelId,
      }),
    onSuccess: (res) => {
      const r = res.data;
      if (r.ok) {
        toast.success(
          `Connected to Meta · ${r.verifiedDisplayPhoneNumber ?? 'phone'}${r.verifiedQualityRating ? ' · ' + r.verifiedQualityRating + ' quality' : ''}`,
        );
      } else {
        toast.error(`Verification failed (${r.status})${r.errorMessage ? ': ' + r.errorMessage : ''}`);
      }
      invalidateNumbers();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Verify failed'),
  });

  const testSend = useMutation({
    mutationFn: (args: {
      to: string;
      templateName: string;
      templateLanguage: string;
      parameters: string[];
      headerTextParam?: string;
      buttonUrlParams?: string[];
    }) =>
      api.post<{ data: WhatsAppTestSendResult }>('/api/v1/whatsapp/test-send', {
        ...args,
        channelId: selectedChannelId,
      }),
    onSuccess: (res, vars) => {
      const r = res.data;
      if (r.ok) toast.success(`${vars.templateName} template sent`);
      else toast.error(r.errorMessage ?? 'Send failed');
      queryClient.invalidateQueries({ queryKey: ['whatsapp-messages'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Send failed'),
  });

  // "Disconnect" clears this number's credentials (keeps the row + webhook
  // verify token so it can be reconnected). Removing the row entirely is the
  // separate "Remove number" action (non-primary only).
  const disconnect = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/whatsapp/numbers/${selectedChannelId}`, {
        accessToken: '',
        appSecret: '',
        wabaId: '',
        phoneNumberId: '',
        appId: '',
        isActive: false,
        botEnabled: false,
      }),
    onSuccess: () => {
      invalidateNumbers();
      toast.success('Disconnected');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Disconnect failed'),
  });

  if (!channel || !form) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const credsComplete = channel.hasAccessToken && !!channel.phoneNumberId;
  const verifiedOk = channel.lastVerifyStatus === 'success';
  const verifiedRecently =
    !!channel.lastVerifiedAt &&
    Date.now() - new Date(channel.lastVerifiedAt).getTime() < 7 * 24 * 60 * 60 * 1000;

  // Build the PUT body. Empty string for secrets = clear; non-empty = update;
  // unchanged form value = leave alone (field omitted).
  const buildPayload = (): Record<string, unknown> => {
    const initial = formFromChannel(channel);
    const out: Record<string, unknown> = {};
    const keys = Object.keys(form) as (keyof FormState)[];
    for (const k of keys) {
      if (k === 'accessToken' || k === 'appSecret') {
        // Secrets: omit unless the user typed something.
        if (form[k] !== '') out[k] = form[k];
        continue;
      }
      if (form[k] !== initial[k]) out[k] = form[k];
    }
    return out;
  };

  return (
    <>
      <PageHeader
        title="WhatsApp"
        description="Connect your Meta WhatsApp Business number so the platform can verify credentials and receive inbound messages."
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={verifiedOk && channel.isActive ? 'success' : 'muted'} className="gap-1">
              {verifiedOk && channel.isActive ? (
                <>
                  <CheckCircle2 className="size-3" /> Live
                </>
              ) : verifiedOk ? (
                <>
                  <CheckCircle2 className="size-3" /> Connected · paused
                </>
              ) : credsComplete ? (
                <>
                  <AlertTriangle className="size-3" /> Not yet verified
                </>
              ) : (
                'Not configured'
              )}
            </Badge>
          </div>
        }
      />

      {/* Multi-number switcher — pick which number to configure. The AI bot can
          be deployed on any subset of numbers (per-number toggle below). */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Your WhatsApp numbers</CardTitle>
              <CardDescription>
                Run several numbers and choose which ones the AI bot replies on.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => addNumber.mutate()}
              loading={addNumber.isPending}
            >
              <Plus className="size-4" /> Add number
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {numbers.map((n) => {
              const isSel = n.id === selectedChannelId;
              const name = n.label || n.displayPhoneNumber || 'Untitled number';
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setSelectedChannelId(n.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
                    isSel
                      ? 'border-brand-400 bg-brand-50 text-brand-800 dark:bg-brand-400/10'
                      : 'border-border hover:bg-surface-muted',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      n.isActive ? 'bg-success' : 'bg-foreground-subtle/40',
                    )}
                  />
                  <span className="font-medium">{name}</span>
                  {n.isPrimary ? <Star className="size-3.5 text-amber-500" /> : null}
                  {n.botEnabled ? (
                    <Badge variant="success" className="gap-1 px-1.5 py-0 text-[10px]">
                      <Bot className="size-3" /> AI
                    </Badge>
                  ) : null}
                </button>
              );
            })}
          </div>

          {channel && form ? (
            <div className="space-y-3 border-t border-border pt-3">
              {/* Inline rename — change this number's display name right here. */}
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[14rem] flex-1 space-y-1">
                  <Label htmlFor="number-name">Number name</Label>
                  <Input
                    id="number-name"
                    placeholder="e.g. Sales line, Support, Dubai branch"
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') save.mutate({ label: form.label.trim() || null });
                    }}
                  />
                </div>
                <Button
                  size="sm"
                  onClick={() => save.mutate({ label: form.label.trim() || null })}
                  loading={save.isPending}
                  disabled={(form.label.trim() || null) === (channel.label ?? null)}
                >
                  Save name
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
              {/* Per-number AI bot switch — the core multi-number control. */}
              <Button
                size="sm"
                variant={channel.botEnabled ? 'primary' : 'secondary'}
                onClick={() => save.mutate({ botEnabled: !channel.botEnabled })}
                loading={save.isPending}
                title="When ON, the AI bot auto-replies to customers messaging this number (the bot must also be deployed on the Bot page)."
              >
                <Bot className="size-4" />
                {channel.botEnabled ? 'AI bot: ON for this number' : 'AI bot: OFF for this number'}
              </Button>
              {!channel.isPrimary ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => promote.mutate()}
                  loading={promote.isPending}
                >
                  <Star className="size-4" /> Make primary
                </Button>
              ) : null}
              {!channel.isPrimary ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-coral-700"
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: 'Remove this number?',
                      body: 'The number and its conversations link will be removed. This cannot be undone.',
                      confirmLabel: 'Remove',
                      destructive: true,
                    });
                    if (ok) removeNumber.mutate();
                  }}
                  loading={removeNumber.isPending}
                >
                  <Trash2 className="size-4" /> Remove number
                </Button>
              ) : null}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Honesty banner — Phase 1.5 only stores credentials + verifies + receives;
          autonomous bot replies still belong to your bot runtime. */}
      <Card className="mb-6 border border-amber-200 bg-amber-50/40 dark:border-amber-400/30 dark:bg-amber-400/10">
        {/* text-foreground resolves to near-black in light mode and the
            pale token in dark mode, so the banner reads on both. Inline
            `color` style on the body wrapper is a belt-and-suspenders
            fallback in case any cascade rule sneaks in — child elements
            inherit it. */}
        <CardContent
          className="flex items-start gap-3 py-3 text-xs text-foreground"
          style={{ color: 'var(--color-foreground)' }}
        >
          <MessageCircle className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-semibold">This page connects credentials, not conversations.</p>
            <p className="leading-relaxed">
              The platform will verify your token, expose a webhook URL Meta can call, and persist
              inbound messages for the audit log. <strong>Auto-responding to customers</strong> is
              still done by your bot runtime — Landbot, an in-house bridge, or Phase 2 when it
              ships. See the{' '}
              <a
                className="font-medium text-foreground underline underline-offset-2"
                href="/docs/NO_CODE_CHATBOT_PLAYBOOK.md"
              >
                no-code playbook
              </a>{' '}
              for the wiring.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* ----- Webhook info Meta needs ----- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="size-4" /> Meta webhook configuration
              </CardTitle>
              <CardDescription>
                Paste these into{' '}
                <span className="font-mono">developers.facebook.com → your app → WhatsApp →
                Configuration → Webhooks</span>
                . Then subscribe the app to the WhatsApp Business Account and tick the{' '}
                <span className="font-mono">messages</span> field.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="callback-url">Callback URL</Label>
                <div className="flex gap-2">
                  <Input id="callback-url" readOnly value={channel.webhookCallbackUrl} className="font-mono text-xs" />
                  <Button
                    variant="secondary"
                    size="icon"
                    aria-label="Copy callback URL"
                    onClick={() => copyToClipboard(channel.webhookCallbackUrl, 'Callback URL')}
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="verify-token">Verify token</Label>
                <div className="flex gap-2">
                  <Input id="verify-token" readOnly value={channel.webhookVerifyToken} className="font-mono text-xs" />
                  <Button
                    variant="secondary"
                    size="icon"
                    aria-label="Copy verify token"
                    onClick={() => copyToClipboard(channel.webhookVerifyToken, 'Verify token')}
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-foreground-subtle">
                Meta sends a one-time GET to the callback URL with this verify token. The platform
                echoes the challenge back when the token matches.
              </p>
            </CardContent>
          </Card>

          {/* ----- Credentials ----- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Phone className="size-4" /> Meta credentials
              </CardTitle>
              <CardDescription>
                Find these in{' '}
                <a
                  href="https://business.facebook.com/"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-brand-500 underline"
                >
                  Meta Business Settings
                </a>{' '}
                <ExternalLink className="inline size-3" /> → WhatsApp → API Setup. The access token
                must be a <strong>System User</strong> token (non-expiring). The app secret is on
                the app dashboard → Settings → Basic.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="wabaId">WhatsApp Business Account ID (WABA ID)</Label>
                <Input
                  id="wabaId"
                  value={form.wabaId}
                  onChange={(e) => setForm({ ...form, wabaId: e.target.value.trim() })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="phoneNumberId">Phone number ID</Label>
                <Input
                  id="phoneNumberId"
                  value={form.phoneNumberId}
                  onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value.trim() })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="displayPhoneNumber">Display phone number (optional)</Label>
                <Input
                  id="displayPhoneNumber"
                  placeholder="+14155551234"
                  value={form.displayPhoneNumber}
                  onChange={(e) => setForm({ ...form, displayPhoneNumber: e.target.value.trim() })}
                />
                <p className="text-xs text-foreground-subtle">
                  Auto-populated by a successful verify.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="appId">Meta App ID</Label>
                <Input
                  id="appId"
                  value={form.appId}
                  onChange={(e) => setForm({ ...form, appId: e.target.value.trim() })}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="accessToken">
                  System User access token{' '}
                  {channel.hasAccessToken ? (
                    <span className="ml-1 text-foreground-subtle">
                      (current: <span className="font-mono">{channel.accessTokenMasked}</span>)
                    </span>
                  ) : null}
                </Label>
                <Input
                  id="accessToken"
                  type="password"
                  autoComplete="off"
                  placeholder={channel.hasAccessToken ? 'Leave blank to keep current' : 'EAAxxxxxxxxx…'}
                  value={form.accessToken}
                  onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="appSecret">
                  App secret{' '}
                  {channel.hasAppSecret ? (
                    <span className="ml-1 text-foreground-subtle">
                      (current: <span className="font-mono">{channel.appSecretMasked}</span>)
                    </span>
                  ) : null}
                </Label>
                <Input
                  id="appSecret"
                  type="password"
                  autoComplete="off"
                  placeholder={channel.hasAppSecret ? 'Leave blank to keep current' : '32-char hex from Meta'}
                  value={form.appSecret}
                  onChange={(e) => setForm({ ...form, appSecret: e.target.value })}
                />
                <p className="text-xs text-foreground-subtle">
                  Used to verify the <span className="font-mono">X-Hub-Signature-256</span> header
                  on inbound webhooks.
                </p>
              </div>
              <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
                <Button onClick={() => save.mutate(buildPayload())} loading={save.isPending}>
                  Save credentials
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => verify.mutate()}
                  loading={verify.isPending}
                  disabled={!credsComplete}
                >
                  <ShieldCheck className="size-4" /> Verify with Meta
                </Button>
                {channel.lastVerifiedAt ? (
                  <span className="text-xs text-foreground-subtle">
                    last checked {formatRelative(channel.lastVerifiedAt)} ·{' '}
                    <span className={verifiedOk ? 'text-emerald-700' : 'text-red-600'}>
                      {channel.lastVerifyStatus}
                    </span>
                  </span>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {/* ----- Pointers to the real sources of truth -----
              The fields that used to live here (businessName / Address /
              About / greetingMessage) were write-only — the AI bot reads
              from BusinessInfo + BotConfig instead, so editing them here
              had no effect on what the customer saw. Replaced the form
              with a clear pointer to where each value actually lives. */}
          <Card>
            <CardHeader>
              <CardTitle>Business profile & greeting</CardTitle>
              <CardDescription>
                The AI bot pulls its identity + opening line from two other pages — edit them
                there.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-muted/30 px-3 py-2">
                <div>
                  <p className="font-medium">Business name, email, address, about, opening hours</p>
                  <p className="text-xs text-foreground-muted">
                    Source of truth: <span className="font-mono">/business-info</span>
                  </p>
                </div>
                <Button asChild size="sm" variant="secondary">
                  <Link href="/business-info">Edit business info</Link>
                </Button>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-muted/30 px-3 py-2">
                <div>
                  <p className="font-medium">Greeting, personality, handoff message, languages</p>
                  <p className="text-xs text-foreground-muted">
                    Source of truth: <span className="font-mono">/bot</span>
                  </p>
                </div>
                <Button asChild size="sm" variant="secondary">
                  <Link href="/bot">Edit bot config</Link>
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* ----- Inbound + test message log ----- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageCircle className="size-4" /> Recent messages
              </CardTitle>
              <CardDescription>
                The 5 most recent inbound + outbound messages for this number. For full history,
                use <span className="font-mono">/inbox</span>.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {(messagesQ.data?.data ?? []).length === 0 ? (
                <p className="px-6 py-6 text-center text-sm text-foreground-muted">
                  Nothing yet. Try the test send or message your number from a tester phone.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {(messagesQ.data?.data ?? []).slice(0, 5).map((m) => (
                    <li key={m.id} className="grid grid-cols-[auto_1fr_auto] items-start gap-3 px-6 py-3 text-sm">
                      <Badge variant={m.direction === 'inbound' ? 'success' : 'muted'} className="mt-0.5">
                        {m.direction}
                      </Badge>
                      <div className="min-w-0">
                        <p className="truncate">
                          <span className="font-mono text-xs text-foreground-subtle">
                            {m.fromNumber ?? m.toNumber ?? '—'}
                          </span>{' '}
                          · {m.messageType ?? 'unknown'}
                        </p>
                        {m.body ? (
                          <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground">
                            {m.body}
                          </p>
                        ) : null}
                      </div>
                      <span className="whitespace-nowrap text-xs text-foreground-subtle">
                        {formatRelative(m.receivedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ----- Sidebar column ----- */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Credentials" value={credsComplete ? 'configured' : 'incomplete'} ok={credsComplete} />
              <Row
                label="Last verify"
                value={channel.lastVerifyStatus ?? 'never'}
                ok={verifiedOk}
                warn={!verifiedRecently && !!channel.lastVerifyStatus}
              />
              <Row
                label="Inbound webhook"
                value={channel.hasAppSecret ? 'ready' : 'app secret missing'}
                ok={channel.hasAppSecret}
              />
              <Row label="Live" value={channel.isActive ? 'ON' : 'OFF'} ok={channel.isActive} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Live toggle</CardTitle>
              <CardDescription>
                Marks the channel as active in this platform. Your bot runtime is responsible for
                actually replying — the toggle does not start a bot.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant={channel.isActive ? 'secondary' : 'primary'}
                onClick={() => save.mutate({ isActive: !channel.isActive })}
                loading={save.isPending}
                disabled={!verifiedOk}
              >
                <PowerOff className="size-4" /> {channel.isActive ? 'Set OFF' : 'Set Live'}
              </Button>
              {!verifiedOk ? (
                <p className="mt-2 text-xs text-foreground-subtle">
                  Verify with Meta first.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Send a test</CardTitle>
              <CardDescription>
                Sends an approved WhatsApp template. The recipient must be added as a tester in
                Meta until business verification is complete. Pick a template from the dropdown —
                it's populated from <span className="font-mono">/whatsapp/templates</span>.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TestSendForm
                templates={templatesQ.data?.data ?? []}
                onSend={(args) => testSend.mutate(args)}
                loading={testSend.isPending}
                disabled={!verifiedOk}
              />
            </CardContent>
          </Card>

          <Card className="border-red-200">
            <CardHeader>
              <CardTitle className="text-red-700">Disconnect</CardTitle>
              <CardDescription>
                Clears credentials and marks the channel inactive. Re-paste your token to reconnect.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="danger"
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: 'Disconnect WhatsApp?',
                      body: 'Stored credentials will be cleared. The webhook URL + verify token stay the same so you can reconnect later.',
                      confirmLabel: 'Disconnect',
                      destructive: true,
                    })
                  ) {
                    disconnect.mutate();
                  }
                }}
                loading={disconnect.isPending}
                disabled={!channel.hasAccessToken && !channel.hasAppSecret}
              >
                <Trash2 className="size-4" /> Disconnect
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value, ok, warn }: { label: string; value: string; ok?: boolean; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-foreground-muted">{label}</span>
      <span
        className={
          ok ? 'text-emerald-700 font-medium' : warn ? 'text-amber-700 font-medium' : 'text-foreground-subtle'
        }
      >
        {value}
      </span>
    </div>
  );
}

// Count the highest {{N}} placeholder in a template's body so we know
// how many parameter inputs to render. Returns 0 for static templates.
function countPlaceholders(body: string | undefined | null): number {
  if (!body) return 0;
  const matches = body.match(/{{\s*(\d+)\s*}}/g) ?? [];
  let max = 0;
  for (const m of matches) {
    const n = Number(m.replace(/[^\d]/g, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

interface TestSendArgs {
  to: string;
  templateName: string;
  templateLanguage: string;
  parameters: string[];
  headerTextParam?: string;
  buttonUrlParams?: string[];
}

// Inspect a template's stored components and pull out:
//   - whether the HEADER is TEXT with {{1}}
//   - URL buttons (in order) and whether each contains {{1}}
// Used to decide which extra input fields the test-send form needs to
// render alongside the body-parameter inputs.
function inspectComponents(components: Record<string, unknown>[] | null | undefined): {
  headerTextHasVar: boolean;
  urlButtonsWithVar: { url: string; text: string }[];
} {
  if (!Array.isArray(components)) {
    return { headerTextHasVar: false, urlButtonsWithVar: [] };
  }
  let headerTextHasVar = false;
  const urlButtonsWithVar: { url: string; text: string }[] = [];
  for (const raw of components) {
    const c = raw as {
      type?: string;
      format?: string;
      text?: string;
      buttons?: { type?: string; url?: string; text?: string }[];
    };
    const t = (c.type ?? '').toUpperCase();
    if (t === 'HEADER' && (c.format ?? '').toUpperCase() === 'TEXT') {
      if (/{{\s*1\s*}}/.test(c.text ?? '')) headerTextHasVar = true;
    }
    if (t === 'BUTTONS') {
      for (const b of c.buttons ?? []) {
        if ((b.type ?? '').toUpperCase() !== 'URL') continue;
        if (/{{\s*1\s*}}/.test(b.url ?? '')) {
          urlButtonsWithVar.push({ url: b.url ?? '', text: b.text ?? '' });
        }
      }
    }
  }
  return { headerTextHasVar, urlButtonsWithVar };
}

function TestSendForm({
  templates,
  onSend,
  loading,
  disabled,
}: {
  templates: TemplateOption[];
  onSend: (args: TestSendArgs) => void;
  loading: boolean;
  disabled: boolean;
}) {
  const [to, setTo] = useState('');
  // Approved templates first; fall back to hello_world / en_US so the
  // dropdown is never empty even before the user runs Sync from Meta.
  const approved = templates.filter((t) => t.status === 'approved');
  const options: TemplateOption[] =
    approved.length > 0
      ? approved
      : [{ id: 'hello_world', name: 'hello_world', language: 'en_US', status: 'fallback' }];
  // Each option's value is "name|language" so we can recover both halves
  // on change without an extra lookup.
  const [selected, setSelected] = useState<string>(`${options[0]!.name}|${options[0]!.language}`);
  // Keep the selection in sync if the templates list updates after first render
  // (Sync from Meta, async load).
  useEffect(() => {
    const exists = options.some((o) => `${o.name}|${o.language}` === selected);
    if (!exists && options[0]) {
      setSelected(`${options[0].name}|${options[0].language}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.length]);
  const [name, language] = selected.split('|');
  const selectedTpl = options.find((o) => `${o.name}|${o.language}` === selected);
  const placeholderCount = countPlaceholders(selectedTpl?.bodyText);
  const { headerTextHasVar, urlButtonsWithVar } = inspectComponents(selectedTpl?.components);

  const [params, setParams] = useState<string[]>([]);
  const [headerParam, setHeaderParam] = useState<string>('');
  const [urlParams, setUrlParams] = useState<string[]>([]);

  // Reset all variable-input arrays whenever the picked template changes
  // (different templates have different placeholder shapes).
  useEffect(() => {
    setParams(Array.from({ length: placeholderCount }, () => ''));
    setHeaderParam('');
    setUrlParams(Array.from({ length: urlButtonsWithVar.length }, () => ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, placeholderCount, urlButtonsWithVar.length]);

  const allBodyFilled = params.every((v) => v.trim().length > 0);
  const headerOk = !headerTextHasVar || headerParam.trim().length > 0;
  const urlsOk = urlButtonsWithVar.length === 0 || urlParams.every((v) => v.trim().length > 0);

  return (
    <div className="space-y-2">
      <Input
        placeholder="+14155551234"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        disabled={disabled}
        aria-label="Recipient phone"
      />
      <Select value={selected} onValueChange={setSelected} disabled={disabled}>
        <SelectTrigger>
          <SelectValue placeholder="Pick a template…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((t) => (
            <SelectItem key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>
              <span className="font-mono">{t.name}</span>{' '}
              <span className="text-foreground-subtle">· {t.language}</span>
              {t.status !== 'approved' && t.status !== 'fallback' ? (
                <span className="ml-2 text-foreground-subtle">({t.status})</span>
              ) : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {approved.length === 0 ? (
        <p className="text-xs text-foreground-subtle">
          No approved templates yet — falling back to <span className="font-mono">hello_world / en_US</span>.
          Use <span className="font-mono">/whatsapp/templates → Sync from Meta</span> to populate.
        </p>
      ) : null}
      {selectedTpl?.bodyText ? (
        <pre className="whitespace-pre-wrap rounded border border-border bg-surface-muted/40 px-3 py-2 text-xs font-mono text-foreground">
          {selectedTpl.bodyText}
        </pre>
      ) : null}

      {/* Header text {{1}} when present */}
      {headerTextHasVar ? (
        <div className="space-y-1.5">
          <p className="text-xs text-foreground-muted">
            This template has a header variable. Fill the value that will replace{' '}
            <span className="font-mono">{'{{1}}'}</span> in the header line.
          </p>
          <Input
            placeholder="value for header {{1}}"
            value={headerParam}
            onChange={(e) => setHeaderParam(e.target.value)}
            disabled={disabled}
            aria-label="Header parameter"
          />
        </div>
      ) : null}

      {/* Body placeholders */}
      {placeholderCount > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs text-foreground-muted">
            This template has {placeholderCount} body variable{placeholderCount === 1 ? '' : 's'}. Fill
            them in order — they bind to <span className="font-mono">{'{{1}}'}</span>,{' '}
            <span className="font-mono">{'{{2}}'}</span>, … in the body above.
          </p>
          {params.map((value, i) => (
            <Input
              key={i}
              placeholder={`value for body {{${i + 1}}}`}
              value={value}
              onChange={(e) => {
                const next = params.slice();
                next[i] = e.target.value;
                setParams(next);
              }}
              disabled={disabled}
              aria-label={`Body parameter ${i + 1}`}
            />
          ))}
        </div>
      ) : null}

      {/* URL button placeholders */}
      {urlButtonsWithVar.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs text-foreground-muted">
            {urlButtonsWithVar.length === 1 ? 'One URL button' : `${urlButtonsWithVar.length} URL buttons`}{' '}
            need a runtime value — Meta interpolates each into the URL where{' '}
            <span className="font-mono">{'{{1}}'}</span> appears.
          </p>
          {urlButtonsWithVar.map((btn, i) => (
            <div key={i} className="space-y-0.5">
              <p className="text-[11px] font-mono text-foreground-subtle">
                {btn.text ? `"${btn.text}" → ` : ''}
                {btn.url}
              </p>
              <Input
                placeholder={`value for URL {{1}} (button ${i + 1})`}
                value={urlParams[i] ?? ''}
                onChange={(e) => {
                  const next = urlParams.slice();
                  next[i] = e.target.value;
                  setUrlParams(next);
                }}
                disabled={disabled}
                aria-label={`URL button parameter ${i + 1}`}
              />
            </div>
          ))}
        </div>
      ) : null}

      <Button
        onClick={() =>
          onSend({
            to,
            templateName: (name ?? '').trim(),
            templateLanguage: (language ?? '').trim(),
            parameters: params.map((p) => p.trim()),
            headerTextParam: headerTextHasVar ? headerParam.trim() : undefined,
            buttonUrlParams: urlButtonsWithVar.length > 0 ? urlParams.map((v) => v.trim()) : undefined,
          })
        }
        loading={loading}
        disabled={
          disabled ||
          to.trim().length < 6 ||
          !name ||
          !language ||
          (placeholderCount > 0 && !allBodyFilled) ||
          !headerOk ||
          !urlsOk
        }
      >
        <Send className="size-4" /> Send {name || 'template'}
      </Button>
    </div>
  );
}
