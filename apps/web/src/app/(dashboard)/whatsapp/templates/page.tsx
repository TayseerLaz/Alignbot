'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Clock, MessageSquare, Plus, RefreshCw, Send, Trash2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';

interface Template {
  id: string;
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION' | string;
  bodyText: string;
  components: Record<string, unknown>[] | null;
  status: 'draft' | 'pending' | 'approved' | 'rejected' | string;
  rejectionReason: string | null;
  metaTemplateId: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'muted'> = {
  draft: 'muted',
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
};

const STATUS_ICON: Record<string, typeof Clock> = {
  draft: Clock,
  pending: Clock,
  approved: CheckCircle2,
  rejected: XCircle,
};

export default function TemplatesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: ['whatsapp-templates'],
    queryFn: () => api.get<{ data: Template[] }>('/api/v1/whatsapp/templates'),
    refetchInterval: 30_000, // poll for status changes
  });

  const submit = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/whatsapp/templates/${id}/submit`),
    onSuccess: () => {
      toast.success('Submitted to Meta — awaiting approval');
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Submit failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/whatsapp/templates/${id}`),
    onSuccess: () => {
      toast.success('Template removed');
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates'] });
    },
  });

  const sync = useMutation({
    mutationFn: () =>
      api.post<{ data: { imported: number; updated: number; total: number } }>(
        '/api/v1/whatsapp/templates/sync',
      ),
    onSuccess: (res) => {
      const { imported, updated, total } = res.data;
      toast.success(`Synced ${total} from Meta — ${imported} new, ${updated} updated`);
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Sync failed'),
  });

  const rows = list.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Message templates"
        description="Templates required to send messages outside the 24-hour customer session window."
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link href="/whatsapp">
                <ArrowLeft className="size-4" /> WhatsApp
              </Link>
            </Button>
            <Button
              variant="secondary"
              onClick={() => sync.mutate()}
              loading={sync.isPending}
              title="Pull every template from Meta and refresh statuses"
            >
              <RefreshCw className="size-4" /> Sync from Meta
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> New template
            </Button>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Templates</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <p className="px-6 py-8 text-center text-sm text-foreground-muted">Loading…</p>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="No templates yet"
              description="Create your first template, then submit it to Meta. Approval typically takes a few minutes."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" /> New template
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((t) => {
                const StatusIcon = STATUS_ICON[t.status] ?? Clock;
                return (
                  <li key={t.id} className="px-6 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-mono font-semibold">{t.name}</p>
                          <Badge variant={STATUS_VARIANT[t.status] ?? 'muted'} className="gap-1">
                            <StatusIcon className="size-3" /> {t.status}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {t.category}
                          </Badge>
                          <span className="text-xs text-foreground-subtle">{t.language}</span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{t.bodyText}</p>
                        {/* Only surface a rejection reason when Meta has
                            actually rejected the template. Meta returns the
                            literal string "NONE" for approved templates,
                            which is truthy — guarding on status fixes the
                            "approved · Rejected: NONE" rendering. */}
                        {t.status === 'rejected' &&
                        t.rejectionReason &&
                        t.rejectionReason.toUpperCase() !== 'NONE' ? (
                          <p className="mt-1 text-xs text-red-700 dark:text-red-300">
                            <strong>Rejected:</strong> {t.rejectionReason}
                          </p>
                        ) : null}
                        <p className="mt-1 text-xs text-foreground-subtle">
                          updated {formatRelative(t.updatedAt)}
                          {t.metaTemplateId ? <> · meta id {t.metaTemplateId}</> : null}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        {t.status === 'draft' || t.status === 'rejected' ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={submit.isPending && submit.variables === t.id}
                            onClick={() => submit.mutate(t.id)}
                          >
                            <Send className="size-3.5" /> Submit to Meta
                          </Button>
                        ) : null}
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Delete template"
                          onClick={async () => {
                            if (
                              await confirmDialog({
                                title: `Delete template "${t.name}"?`,
                                body: 'This deletes the local row. Approved templates remain in Meta — remove them there if you no longer want to send them.',
                                confirmLabel: 'Delete',
                                destructive: true,
                              })
                            ) {
                              remove.mutate(t.id);
                            }
                          }}
                        >
                          <Trash2 className="size-4 text-red-600" />
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <CreateTemplateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Full template builder. Maps onto Meta's WhatsApp Cloud API template
// schema 1-to-1: optional header (TEXT / IMAGE / VIDEO / DOCUMENT),
// required body with up to N {{1}}…{{N}} placeholders and per-placeholder
// example values, optional footer (60 char cap), and up to 10 buttons of
// types QUICK_REPLY / URL / PHONE_NUMBER / COPY_CODE.
// ---------------------------------------------------------------------------
type HeaderFormat = 'NONE' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
type ButtonRow =
  | { type: 'QUICK_REPLY'; text: string }
  | { type: 'URL'; text: string; url: string; example: string }
  | { type: 'PHONE_NUMBER'; text: string; phoneNumber: string }
  | { type: 'COPY_CODE'; example: string };

function countPlaceholders(s: string): number {
  const m = s.match(/{{\s*(\d+)\s*}}/g) ?? [];
  return m.reduce((acc, raw) => {
    const n = Number(raw.replace(/[^\d]/g, ''));
    return Number.isFinite(n) && n > acc ? n : acc;
  }, 0);
}

function CreateTemplateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('en_US');
  const [category, setCategory] = useState<'MARKETING' | 'UTILITY' | 'AUTHENTICATION'>('UTILITY');

  // Header
  const [headerFormat, setHeaderFormat] = useState<HeaderFormat>('NONE');
  const [headerText, setHeaderText] = useState('');
  const [headerTextExample, setHeaderTextExample] = useState('');
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');

  // Body
  const [bodyText, setBodyText] = useState('');
  const bodyVarCount = countPlaceholders(bodyText);
  const [bodyExamples, setBodyExamples] = useState<string[]>([]);
  useEffect(() => {
    setBodyExamples((prev) => {
      const next = prev.slice(0, bodyVarCount);
      while (next.length < bodyVarCount) next.push('');
      return next;
    });
  }, [bodyVarCount]);

  // Footer
  const [footer, setFooter] = useState('');

  // Buttons
  const [buttons, setButtons] = useState<ButtonRow[]>([]);
  const headerHasVar = /{{\s*1\s*}}/.test(headerText);

  const buildComponents = (): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    if (headerFormat !== 'NONE') {
      const header: Record<string, unknown> = { type: 'HEADER', format: headerFormat };
      if (headerFormat === 'TEXT') {
        if (!headerText.trim()) throw new Error('Header text required.');
        header.text = headerText.trim();
        if (headerHasVar) {
          if (!headerTextExample.trim()) throw new Error('Header example required for {{1}}.');
          header.example = { header_text: [headerTextExample.trim()] };
        }
      } else {
        if (!headerMediaUrl.trim()) throw new Error(`${headerFormat.toLowerCase()} URL required.`);
        header.example = { header_handle: [headerMediaUrl.trim()] };
      }
      out.push(header);
    }
    const body: Record<string, unknown> = { type: 'BODY', text: bodyText.trim() };
    if (bodyVarCount > 0) {
      if (bodyExamples.some((v) => !v.trim())) {
        throw new Error(`Fill an example value for each of {{1}}…{{${bodyVarCount}}}.`);
      }
      body.example = { body_text: [bodyExamples.map((v) => v.trim())] };
    }
    out.push(body);
    if (footer.trim()) {
      out.push({ type: 'FOOTER', text: footer.trim() });
    }
    if (buttons.length > 0) {
      const metaButtons = buttons.map((b) => {
        if (b.type === 'QUICK_REPLY') return { type: 'QUICK_REPLY', text: b.text.trim() };
        if (b.type === 'URL') {
          const out: Record<string, unknown> = {
            type: 'URL',
            text: b.text.trim(),
            url: b.url.trim(),
          };
          if (b.url.includes('{{1}}') && b.example.trim()) out.example = [b.example.trim()];
          return out;
        }
        if (b.type === 'PHONE_NUMBER') {
          return { type: 'PHONE_NUMBER', text: b.text.trim(), phone_number: b.phoneNumber.trim() };
        }
        return { type: 'COPY_CODE', example: b.example.trim() };
      });
      out.push({ type: 'BUTTONS', buttons: metaButtons });
    }
    return out;
  };

  const create = useMutation({
    mutationFn: () => {
      const components = buildComponents();
      return api.post('/api/v1/whatsapp/templates', {
        name,
        language,
        category,
        bodyText,
        components,
      });
    },
    onSuccess: () => {
      toast.success('Draft created');
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates'] });
      onOpenChange(false);
      // Reset everything for the next open.
      setName('');
      setBodyText('');
      setBodyExamples([]);
      setHeaderFormat('NONE');
      setHeaderText('');
      setHeaderTextExample('');
      setHeaderMediaUrl('');
      setFooter('');
      setButtons([]);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Create failed'),
  });

  const submitDisabled =
    !name ||
    !bodyText.trim() ||
    (headerFormat === 'TEXT' && !headerText.trim()) ||
    (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat) && !headerMediaUrl.trim()) ||
    (headerFormat === 'TEXT' && headerHasVar && !headerTextExample.trim()) ||
    (bodyVarCount > 0 && bodyExamples.some((v) => !v.trim())) ||
    buttons.some((b) => {
      if (b.type === 'QUICK_REPLY') return !b.text.trim();
      if (b.type === 'URL') return !b.text.trim() || !b.url.trim();
      if (b.type === 'PHONE_NUMBER') return !b.text.trim() || !b.phoneNumber.trim();
      return !b.example.trim();
    });

  const addButton = (type: ButtonRow['type']) => {
    if (buttons.length >= 10) {
      toast.error('Meta caps templates at 10 buttons.');
      return;
    }
    const next: ButtonRow =
      type === 'QUICK_REPLY'
        ? { type: 'QUICK_REPLY', text: '' }
        : type === 'URL'
          ? { type: 'URL', text: '', url: 'https://', example: '' }
          : type === 'PHONE_NUMBER'
            ? { type: 'PHONE_NUMBER', text: '', phoneNumber: '+' }
            : { type: 'COPY_CODE', example: '' };
    setButtons([...buttons, next]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>New template</DialogTitle>
          <DialogDescription>
            Header + body + footer + buttons — full Meta template builder. Submitted as a draft;
            click <span className="font-mono">Submit to Meta</span> on the list to request approval.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          {/* Identity */}
          <div className="space-y-1.5">
            <Label htmlFor="tpl-name">Name (lowercase, digits, underscore)</Label>
            <Input
              id="tpl-name"
              placeholder="order_shipped"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-lang">Language</Label>
              <Input id="tpl-lang" value={language} onChange={(e) => setLanguage(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-cat">Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as typeof category)}>
                <SelectTrigger id="tpl-cat">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="UTILITY">Utility (transactional)</SelectItem>
                  <SelectItem value="MARKETING">Marketing (promotional)</SelectItem>
                  <SelectItem value="AUTHENTICATION">Authentication (OTP)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Header */}
          <div className="rounded-md border border-border bg-surface-muted/30 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">Header (optional)</Label>
              <Select value={headerFormat} onValueChange={(v) => setHeaderFormat(v as HeaderFormat)}>
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">No header</SelectItem>
                  <SelectItem value="TEXT">Text</SelectItem>
                  <SelectItem value="IMAGE">Image</SelectItem>
                  <SelectItem value="VIDEO">Video</SelectItem>
                  <SelectItem value="DOCUMENT">Document</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {headerFormat === 'TEXT' ? (
              <>
                <Input
                  placeholder="Header text (max 60 chars). May include {{1}}."
                  value={headerText}
                  onChange={(e) => setHeaderText(e.target.value.slice(0, 60))}
                />
                {headerHasVar ? (
                  <Input
                    placeholder="Example value for {{1}}"
                    value={headerTextExample}
                    onChange={(e) => setHeaderTextExample(e.target.value)}
                  />
                ) : null}
              </>
            ) : null}
            {['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat) ? (
              <>
                <Input
                  placeholder={`Public ${headerFormat.toLowerCase()} URL (e.g. https://cdn.example.com/file.jpg)`}
                  value={headerMediaUrl}
                  onChange={(e) => setHeaderMediaUrl(e.target.value)}
                />
                <p className="text-xs text-foreground-subtle">
                  Meta downloads this URL to register the template. Use a CDN / S3-style link that's
                  publicly accessible for at least the approval window. After approval, the asset
                  can move — Meta stores its own copy.
                </p>
              </>
            ) : null}
          </div>

          {/* Body */}
          <div className="rounded-md border border-border bg-surface-muted/30 p-3 space-y-2">
            <Label className="text-sm font-semibold">Body (required)</Label>
            <Textarea
              rows={4}
              placeholder="Hi {{1}}, your order {{2}} has shipped."
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
            />
            <p className="text-xs text-foreground-subtle">
              Use <span className="font-mono">{'{{1}}'}</span>, <span className="font-mono">{'{{2}}'}</span> for variables; supply an example for each below so Meta can review.
            </p>
            {bodyVarCount > 0 ? (
              <div className="space-y-1.5">
                {Array.from({ length: bodyVarCount }, (_, i) => (
                  <Input
                    key={i}
                    placeholder={`Example for {{${i + 1}}}`}
                    value={bodyExamples[i] ?? ''}
                    onChange={(e) => {
                      const next = bodyExamples.slice();
                      next[i] = e.target.value;
                      setBodyExamples(next);
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>

          {/* Footer */}
          <div className="rounded-md border border-border bg-surface-muted/30 p-3 space-y-2">
            <Label className="text-sm font-semibold">Footer (optional, max 60 chars)</Label>
            <Input
              placeholder="Powered by Aligned"
              value={footer}
              onChange={(e) => setFooter(e.target.value.slice(0, 60))}
            />
          </div>

          {/* Buttons */}
          <div className="rounded-md border border-border bg-surface-muted/30 p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label className="text-sm font-semibold">Buttons (optional, up to 10)</Label>
              <div className="ml-auto flex flex-wrap gap-1">
                <Button size="sm" variant="ghost" onClick={() => addButton('QUICK_REPLY')}>
                  + Quick reply
                </Button>
                <Button size="sm" variant="ghost" onClick={() => addButton('URL')}>
                  + URL
                </Button>
                <Button size="sm" variant="ghost" onClick={() => addButton('PHONE_NUMBER')}>
                  + Call
                </Button>
                <Button size="sm" variant="ghost" onClick={() => addButton('COPY_CODE')}>
                  + Copy code
                </Button>
              </div>
            </div>
            {buttons.map((b, i) => (
              <div key={i} className="flex items-start gap-2 rounded border border-border bg-surface p-2">
                <span className="mt-2 w-20 shrink-0 text-xs font-medium text-foreground-muted">
                  {b.type === 'QUICK_REPLY'
                    ? 'Quick'
                    : b.type === 'URL'
                      ? 'URL'
                      : b.type === 'PHONE_NUMBER'
                        ? 'Call'
                        : 'Copy'}
                </span>
                <div className="flex flex-1 flex-col gap-1.5">
                  {b.type !== 'COPY_CODE' ? (
                    <Input
                      placeholder="Button text (max 25)"
                      value={(b as { text: string }).text}
                      onChange={(e) => {
                        const next = [...buttons];
                        (next[i] as { text: string }).text = e.target.value.slice(0, 25);
                        setButtons(next);
                      }}
                    />
                  ) : null}
                  {b.type === 'URL' ? (
                    <>
                      <Input
                        placeholder="https://example.com/{{1}}"
                        value={b.url}
                        onChange={(e) => {
                          const next = [...buttons];
                          (next[i] as { url: string }).url = e.target.value;
                          setButtons(next);
                        }}
                      />
                      {b.url.includes('{{1}}') ? (
                        <Input
                          placeholder="Example URL parameter (e.g. order/12345)"
                          value={b.example}
                          onChange={(e) => {
                            const next = [...buttons];
                            (next[i] as { example: string }).example = e.target.value;
                            setButtons(next);
                          }}
                        />
                      ) : null}
                    </>
                  ) : null}
                  {b.type === 'PHONE_NUMBER' ? (
                    <Input
                      placeholder="+14155551234"
                      value={b.phoneNumber}
                      onChange={(e) => {
                        const next = [...buttons];
                        (next[i] as { phoneNumber: string }).phoneNumber = e.target.value;
                        setButtons(next);
                      }}
                    />
                  ) : null}
                  {b.type === 'COPY_CODE' ? (
                    <Input
                      placeholder="Example code value (e.g. SAVE10)"
                      value={b.example}
                      onChange={(e) => {
                        const next = [...buttons];
                        (next[i] as { example: string }).example = e.target.value;
                        setButtons(next);
                      }}
                    />
                  ) : null}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setButtons(buttons.filter((_, j) => j !== i))}
                  aria-label="Remove button"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
            {buttons.length === 0 ? (
              <p className="text-xs italic text-foreground-subtle">
                No buttons yet. Quick replies are useful for surveys/yes-no; URL/call buttons drive
                conversion; copy-code is great for promo codes.
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            onClick={() => {
              try {
                create.mutate();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Invalid template');
              }
            }}
            disabled={submitDisabled}
          >
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
