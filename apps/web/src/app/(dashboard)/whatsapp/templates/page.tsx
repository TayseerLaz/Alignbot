'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Clock, MessageSquare, Plus, RefreshCw, Send, Trash2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
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
                        {t.rejectionReason ? (
                          <p className="mt-1 text-xs text-red-700">
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
  const [bodyText, setBodyText] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/v1/whatsapp/templates', { name, language, category, bodyText }),
    onSuccess: () => {
      toast.success('Draft created');
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates'] });
      onOpenChange(false);
      setName('');
      setBodyText('');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Create failed'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New template</DialogTitle>
          <DialogDescription>
            Templates are submitted to Meta for approval. Names must be lowercase letters, digits,
            and underscore.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-name">Name</Label>
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
                  <SelectItem value="UTILITY">Utility</SelectItem>
                  <SelectItem value="MARKETING">Marketing</SelectItem>
                  <SelectItem value="AUTHENTICATION">Authentication</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-body">Body</Label>
            <Textarea
              id="tpl-body"
              rows={5}
              placeholder="Hi {{1}}, your order {{2}} has shipped."
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
            />
            <p className="text-xs text-foreground-subtle">
              Use <span className="font-mono">{'{{1}}'}</span>, <span className="font-mono">{'{{2}}'}</span> etc.
              for variables. Meta substitutes them when you send.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            onClick={() => create.mutate()}
            disabled={!name || !bodyText}
          >
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
