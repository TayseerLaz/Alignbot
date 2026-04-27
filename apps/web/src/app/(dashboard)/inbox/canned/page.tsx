'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Clock, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
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
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';

interface CannedResponse {
  id: string;
  shortcut: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export default function CannedResponsesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: ['canned-responses'],
    queryFn: () => api.get<{ data: CannedResponse[] }>('/api/v1/canned-responses'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/canned-responses/${id}`),
    onSuccess: () => {
      toast.success('Removed');
      queryClient.invalidateQueries({ queryKey: ['canned-responses'] });
    },
  });

  const rows = list.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Canned responses"
        description="Quick-reply templates available in the inbox reply box. Use {phone} for the customer's number."
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link href="/inbox">
                <ArrowLeft className="size-4" /> Inbox
              </Link>
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> New canned response
            </Button>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Library</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <p className="px-6 py-8 text-center text-sm text-foreground-muted">Loading…</p>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No canned responses yet"
              description="Save your most-used replies as shortcuts. Insert them in the inbox with one click."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" /> Create one
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((cr) => (
                <li key={cr.id} className="flex items-start justify-between gap-3 px-6 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-sm text-brand-600">/{cr.shortcut}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{cr.body}</p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete /${cr.shortcut}`}
                    onClick={async () => {
                      if (
                        await confirmDialog({
                          title: `Delete /${cr.shortcut}?`,
                          confirmLabel: 'Delete',
                          destructive: true,
                        })
                      ) {
                        remove.mutate(cr.id);
                      }
                    }}
                  >
                    <Trash2 className="size-4 text-red-600" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CreateCannedDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

function CreateCannedDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [shortcut, setShortcut] = useState('');
  const [body, setBody] = useState('');

  const create = useMutation({
    mutationFn: () => api.post('/api/v1/canned-responses', { shortcut, body }),
    onSuccess: () => {
      toast.success('Created');
      queryClient.invalidateQueries({ queryKey: ['canned-responses'] });
      onOpenChange(false);
      setShortcut('');
      setBody('');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Create failed'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New canned response</DialogTitle>
          <DialogDescription>
            Shortcut is the trigger you remember. Body is what gets inserted (with{' '}
            <span className="font-mono">{'{phone}'}</span> substituted for the customer's number).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cr-shortcut">Shortcut</Label>
            <Input
              id="cr-shortcut"
              placeholder="hours"
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value.replace(/^\//, ''))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cr-body">Body</Label>
            <Textarea
              id="cr-body"
              rows={5}
              placeholder={
                'Thanks for messaging us!\nOur hours are Mon–Fri 9–17.\nFor urgent issues, call {phone}.'
              }
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={create.isPending} onClick={() => create.mutate()} disabled={!shortcut || !body}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
