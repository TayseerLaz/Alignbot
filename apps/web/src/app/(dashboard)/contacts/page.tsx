'use client';

import type { ContactDto } from '@aligned/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Trash2, Upload, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError, getAccessToken } from '@/lib/api';

interface TagBucket {
  tag: string;
  count: number;
}

export default function ContactsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const contactsQuery = useQuery({
    queryKey: ['contacts', { search, tag: tagFilter }],
    queryFn: () =>
      api.get<{ data: ContactDto[]; nextCursor: string | null }>(
        `/api/v1/contacts?` +
          new URLSearchParams({
            ...(search ? { search } : {}),
            ...(tagFilter ? { tag: tagFilter } : {}),
            limit: '100',
          }).toString(),
      ),
  });

  const tagsQuery = useQuery({
    queryKey: ['contacts', 'tags'],
    queryFn: () => api.get<{ data: TagBucket[] }>('/api/v1/contacts/tags'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/contacts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['contacts', 'tags'] });
      toast.success('Contact deleted');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
  });

  const total = contactsQuery.data?.data.length ?? 0;
  const tags = useMemo(() => tagsQuery.data?.data ?? [], [tagsQuery.data]);

  return (
    <>
      <PageHeader
        title="Contacts"
        description="Your customer phone book. Imported from CSV, the inbox, or added manually. Use these for broadcast audiences."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              <Upload className="size-4" /> Import CSV
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> Add contact
            </Button>
          </div>
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 size-4 text-foreground-subtle" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by phone or name…"
            className="w-72 pl-9"
          />
        </div>
        {tags.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-foreground-subtle">Tags</span>
            {tags.slice(0, 12).map((t) => (
              <button
                key={t.tag}
                onClick={() => setTagFilter(tagFilter === t.tag ? null : t.tag)}
                className={`rounded-full px-3 py-1 text-xs ${
                  tagFilter === t.tag
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-surface-muted text-foreground-muted hover:bg-surface'
                }`}
              >
                {t.tag} <span className="opacity-60">({t.count})</span>
              </button>
            ))}
            {tagFilter ? (
              <button
                onClick={() => setTagFilter(null)}
                className="text-xs text-foreground-subtle hover:text-foreground"
              >
                <X className="inline size-3" /> clear
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{total} contact{total === 1 ? '' : 's'}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                <tr>
                  <th className="px-6 py-3">Phone</th>
                  <th className="px-6 py-3">Name</th>
                  <th className="px-6 py-3">Tags</th>
                  <th className="px-6 py-3">Source</th>
                  <th className="px-6 py-3">Last inbound</th>
                  <th className="w-12 px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {contactsQuery.isLoading ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-8 text-center text-foreground-muted">
                      Loading…
                    </td>
                  </tr>
                ) : null}
                {contactsQuery.data?.data.length === 0 && !contactsQuery.isLoading ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-foreground-muted">
                      No contacts yet. Add one or import a CSV to get started.
                    </td>
                  </tr>
                ) : null}
                {contactsQuery.data?.data.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0">
                    <td className="px-6 py-4 font-mono text-sm">{c.phoneE164}</td>
                    <td className="px-6 py-4">{c.displayName ?? '—'}</td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1">
                        {c.tags.map((t) => (
                          <span
                            key={t}
                            className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-foreground-muted"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-foreground-muted">{c.source}</td>
                    <td className="px-6 py-4 text-foreground-muted">
                      {c.lastInboundAt ? new Date(c.lastInboundAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => {
                          if (window.confirm(`Delete ${c.phoneE164}?`)) deleteMutation.mutate(c.id);
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <CreateContactDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          qc.invalidateQueries({ queryKey: ['contacts'] });
          qc.invalidateQueries({ queryKey: ['contacts', 'tags'] });
        }}
      />
      <ImportCsvDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ['contacts'] });
          qc.invalidateQueries({ queryKey: ['contacts', 'tags'] });
        }}
      />
    </>
  );
}

// ---------- create-contact dialog -----------------------------------------
function CreateContactDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.post('/api/v1/contacts', {
        phoneE164: phone,
        displayName: name || undefined,
        tags: tagsRaw
          ? tagsRaw
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined,
      });
      toast.success('Contact added');
      setPhone('');
      setName('');
      setTagsRaw('');
      onOpenChange(false);
      onCreated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add contact</DialogTitle>
          <DialogDescription>One phone number per contact. Use E.164 format.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="phone">Phone (E.164)</Label>
            <Input
              id="phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+14155551234"
            />
          </div>
          <div>
            <Label htmlFor="name">Display name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="tags">Tags (comma-separated)</Label>
            <Input
              id="tags"
              value={tagsRaw}
              onChange={(e) => setTagsRaw(e.target.value)}
              placeholder="vip, austin"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !phone}>
            {submitting ? 'Adding…' : 'Add contact'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- import CSV dialog ----------------------------------------------
function ImportCsvDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{
    total: number;
    created: number;
    updated: number;
    skipped: number;
    errors: { row: number; error: string }[];
  } | null>(null);

  const submit = async () => {
    if (!file) return;
    setRunning(true);
    setResult(null);
    try {
      // Step 1: upload to /assets/upload-csv (existing).
      const fd = new FormData();
      fd.append('file', file);
      const uploadRes = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/assets/upload-csv`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
          body: fd,
          credentials: 'include',
        },
      );
      if (!uploadRes.ok) {
        const text = await uploadRes.text();
        throw new Error(`Upload failed: ${text || uploadRes.statusText}`);
      }
      const upload = (await uploadRes.json()) as { data: { assetId: string } };
      // Step 2: import.
      const importRes = await api.post<{
        data: {
          total: number;
          created: number;
          updated: number;
          skipped: number;
          errors: { row: number; error: string }[];
        };
      }>('/api/v1/contacts/import', {
        assetId: upload.data.assetId,
      });
      setResult(importRes.data);
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : err instanceof Error ? err.message : 'Import failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import contacts</DialogTitle>
          <DialogDescription>
            CSV with at least a phone column. Recognized columns: <code>phone</code>,{' '}
            <code>name</code>, <code>locale</code>, <code>tags</code>. Extras land in attributes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {result ? (
            <div className="rounded border border-border bg-surface-muted p-3 text-sm">
              <p>
                <strong>Imported:</strong> {result.created} created · {result.updated} updated ·{' '}
                {result.skipped} skipped · {result.total} total
              </p>
              {result.errors.length > 0 ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-foreground-subtle">
                    {result.errors.length} error{result.errors.length === 1 ? '' : 's'}
                  </summary>
                  <ul className="mt-1 max-h-40 overflow-y-auto text-xs">
                    {result.errors.slice(0, 100).map((e) => (
                      <li key={`${e.row}-${e.error}`}>
                        Row {e.row}: {e.error}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={submit} disabled={!file || running}>
            {running ? 'Importing…' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
