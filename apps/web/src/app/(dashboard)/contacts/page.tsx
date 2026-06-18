'use client';

import type { ContactDto } from '@aligned/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Info, Pencil, Plus, Save, Search, Trash2, Upload, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { CustomerInfoSheet } from '@/components/customer/customer-info-sheet';
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
  const [channelFilter, setChannelFilter] = useState<'all' | 'whatsapp' | 'instagram'>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Phone of the contact whose info slide-over is open (null = closed).
  const [infoPhone, setInfoPhone] = useState<string | null>(null);

  // Cursor-paginated so EVERY contact is reachable, not just the first 100.
  const contactsQuery = useInfiniteQuery({
    queryKey: ['contacts', { search, tag: tagFilter, channel: channelFilter }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<{ data: ContactDto[]; nextCursor: string | null }>(
        `/api/v1/contacts?` +
          new URLSearchParams({
            ...(search ? { search } : {}),
            ...(tagFilter ? { tag: tagFilter } : {}),
            ...(channelFilter !== 'all' ? { channel: channelFilter } : {}),
            ...(pageParam ? { cursor: pageParam } : {}),
            limit: '100',
          }).toString(),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const contacts = useMemo(
    () => contactsQuery.data?.pages.flatMap((p) => p.data) ?? [],
    [contactsQuery.data],
  );

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

  // Inline edit — patches displayName or phoneE164 in one call.
  const editMutation = useMutation({
    mutationFn: (vars: { id: string; displayName?: string | null; phoneE164?: string; blocked?: boolean }) => {
      const { id, ...body } = vars;
      return api.patch(`/api/v1/contacts/${id}`, body);
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['contacts'] });
      toast.success(vars.blocked === true ? 'Contact blocked' : vars.blocked === false ? 'Contact unblocked' : 'Saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  const total = contacts.length;
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
        {/* Channel filter — split WhatsApp vs Instagram contacts. */}
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5 text-xs">
          {(['all', 'whatsapp', 'instagram'] as const).map((c) => (
            <button
              key={c}
              onClick={() => setChannelFilter(c)}
              className={`rounded px-2.5 py-1 capitalize ${
                channelFilter === c
                  ? 'bg-primary text-primary-foreground'
                  : 'text-foreground-muted hover:bg-surface-muted'
              }`}
            >
              {c === 'all' ? 'All channels' : c}
            </button>
          ))}
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
                  <th className="px-6 py-3">Phone / Account</th>
                  <th
                    className="px-6 py-3"
                    title="The customer's WhatsApp profile name — what they set in WhatsApp → Settings → Profile → Name. Read-only; auto-fills when they message you."
                  >
                    WhatsApp nickname
                  </th>
                  <th className="px-6 py-3">Name (your label)</th>
                  <th className="px-6 py-3">Tags</th>
                  <th className="px-6 py-3">Source</th>
                  <th className="px-6 py-3">Last inbound</th>
                  <th className="w-20 px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {contactsQuery.isLoading ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-8 text-center text-foreground-muted">
                      Loading…
                    </td>
                  </tr>
                ) : null}
                {contacts.length === 0 && !contactsQuery.isLoading ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-foreground-muted">
                      No contacts yet. Add one or import a CSV to get started.
                    </td>
                  </tr>
                ) : null}
                {contacts.map((c) => (
                  <ContactRow
                    key={c.id}
                    contact={c}
                    onSave={(patch) => editMutation.mutate({ id: c.id, ...patch })}
                    saving={editMutation.isPending}
                    onShowInfo={() => setInfoPhone(c.phoneE164)}
                    onDelete={() => {
                      if (window.confirm(`Delete ${c.phoneE164}?`)) deleteMutation.mutate(c.id);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {contactsQuery.hasNextPage ? (
            <div className="flex justify-center border-t border-border p-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => contactsQuery.fetchNextPage()}
                loading={contactsQuery.isFetchingNextPage}
              >
                Load more contacts
              </Button>
            </div>
          ) : null}
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
      <CustomerInfoSheet
        phone={infoPhone}
        open={infoPhone !== null}
        onClose={() => setInfoPhone(null)}
      />
    </>
  );
}

// ---------- row with inline edit ------------------------------------------
function ContactRow({
  contact,
  onSave,
  saving,
  onShowInfo,
  onDelete,
}: {
  contact: ContactDto;
  onSave: (patch: { displayName?: string | null; phoneE164?: string; blocked?: boolean }) => void;
  saving: boolean;
  onShowInfo: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState(contact.phoneE164);
  const [name, setName] = useState(contact.displayName ?? '');

  // Instagram/Messenger contacts: phoneE164 holds a PSID, not a real number.
  // Show the @username (parsed from the display name) + a channel badge instead.
  const isSocial = (contact.channel ?? 'whatsapp') !== 'whatsapp';
  const handleMatch = (contact.displayName ?? '').match(/\(@([^)]+)\)/);
  const igHandle = handleMatch ? `@${handleMatch[1]}` : null;

  // Reset draft when the row identity changes (after save → refetch).
  if (!editing && (phone !== contact.phoneE164 || name !== (contact.displayName ?? ''))) {
    setPhone(contact.phoneE164);
    setName(contact.displayName ?? '');
  }

  const commit = () => {
    const patch: { displayName?: string | null; phoneE164?: string } = {};
    if (phone.trim() !== contact.phoneE164) patch.phoneE164 = phone.trim();
    const nextName = name.trim();
    if (nextName !== (contact.displayName ?? '')) patch.displayName = nextName || null;
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    onSave(patch);
    setEditing(false);
  };
  const cancel = () => {
    setPhone(contact.phoneE164);
    setName(contact.displayName ?? '');
    setEditing(false);
  };

  // The WhatsApp name column is intentionally read-only. Meta refreshes
  // it on every inbound; renaming it here would just get overwritten.
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-6 py-3 text-sm">
        {isSocial ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="rounded-full bg-fuchsia-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fuchsia-700">
              {contact.channel}
            </span>
            <span>{igHandle ?? 'account'}</span>
          </span>
        ) : editing ? (
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+14155551234"
            className="h-8 max-w-[14rem] font-mono text-sm"
            aria-label="Phone"
          />
        ) : (
          <span className="font-mono">{contact.phoneE164}</span>
        )}
      </td>
      <td className="px-6 py-3 text-sm text-foreground-muted">
        {contact.whatsappName ?? '—'}
      </td>
      <td className="px-6 py-3 text-sm">
        {editing ? (
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Operator-set name"
            className="h-8 max-w-[14rem] text-sm"
            aria-label="Name"
          />
        ) : (
          <span className="inline-flex items-center gap-2">
            {contact.displayName ?? '—'}
            {contact.blockedAt ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700">
                <Ban className="size-3" /> Blocked
              </span>
            ) : null}
          </span>
        )}
      </td>
      <td className="px-6 py-3">
        <div className="flex flex-wrap gap-1">
          {contact.tags.map((t) => (
            <span
              key={t}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-foreground-muted"
            >
              {t}
            </span>
          ))}
        </div>
      </td>
      <td className="px-6 py-3 text-sm text-foreground-muted">{contact.source}</td>
      <td className="px-6 py-3 text-sm text-foreground-muted">
        {contact.lastInboundAt ? new Date(contact.lastInboundAt).toLocaleDateString() : '—'}
      </td>
      <td className="px-6 py-3 text-right">
        {editing ? (
          <div className="flex items-center justify-end gap-1">
            <Button size="icon" variant="ghost" onClick={cancel} aria-label="Cancel">
              <X className="size-4" />
            </Button>
            <Button size="icon" variant="secondary" onClick={commit} loading={saving} aria-label="Save">
              <Save className="size-4" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-1">
            <Button size="icon" variant="ghost" onClick={onShowInfo} aria-label="View info & tags" title="Info & tags">
              <Info className="size-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => setEditing(true)} aria-label="Edit">
              <Pencil className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => {
                const blocking = !contact.blockedAt;
                if (
                  !blocking ||
                  window.confirm(
                    `Block ${contact.phoneE164}? The bot will stop auto-replying to them and they’ll be excluded from broadcasts. Their messages still appear in the inbox.`,
                  )
                ) {
                  onSave({ blocked: blocking });
                }
              }}
              aria-label={contact.blockedAt ? 'Unblock' : 'Block'}
              title={contact.blockedAt ? 'Unblock contact' : 'Block contact'}
              className={contact.blockedAt ? 'text-rose-600' : undefined}
            >
              <Ban className="size-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={onDelete} aria-label="Delete">
              <Trash2 className="size-4" />
            </Button>
          </div>
        )}
      </td>
    </tr>
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
