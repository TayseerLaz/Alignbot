'use client';

import type { ContactDto } from '@aligned/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  Download,
  Info,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
import { SkeletonRows } from '@/components/ui/skeleton';
import { api, ApiError, getAccessToken } from '@/lib/api';
import { useSession } from '@/lib/session';

interface TagBucket {
  tag: string;
  count: number;
}

interface DupContact {
  id: string;
  phoneE164: string;
  displayName: string | null;
  whatsappName: string | null;
  lastInboundAt: string | null;
}
interface DupGroup {
  key: string;
  sameName: boolean;
  contacts: DupContact[];
}
interface DuplicatesData {
  groupCount: number;
  groups: DupGroup[];
}

// Download a ready-to-fill CSV template whose headers match the importer
// (phone required; name/locale/tags optional). Any extra columns you add are
// imported as custom fields. Generated client-side — no server round-trip.
function downloadContactsTemplate() {
  const rows = [
    ['phone', 'name', 'locale', 'tags'],
    ['+9613123456', 'Jane Doe', 'en', 'vip,beirut'],
    ['+9613987654', 'John Smith', 'ar', 'newsletter'],
  ];
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'contacts-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ContactsPage() {
  const qc = useQueryClient();
  const { session } = useSession();
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  const instagramOn = !disabledFeatures.includes('instagram');
  // Channel-filter options — only offer Instagram when the tenant has it.
  const channelOptions = (['all', 'whatsapp', 'instagram'] as const).filter(
    (c) => c !== 'instagram' || instagramOn,
  );
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [channelFilter, setChannelFilter] = useState<'all' | 'whatsapp' | 'instagram'>('all');
  // If Instagram is turned off while it's the active filter, fall back to all.
  useEffect(() => {
    if (!instagramOn && channelFilter === 'instagram') setChannelFilter('all');
  }, [instagramOn, channelFilter]);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  // Phone of the contact whose info slide-over is open (null = closed).
  const [infoPhone, setInfoPhone] = useState<string | null>(null);
  // Numbered pagination: 1-based page + selectable page size.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Any filter / page-size change resets back to page 1.
  useEffect(() => {
    setPage(1);
  }, [search, tagFilter, channelFilter, pageSize]);

  const contactsQuery = useQuery({
    queryKey: ['contacts', { search, tag: tagFilter, channel: channelFilter, page, pageSize }],
    queryFn: () =>
      api.get<{ data: ContactDto[]; total?: number }>(
        `/api/v1/contacts?` +
          new URLSearchParams({
            ...(search ? { search } : {}),
            ...(tagFilter ? { tag: tagFilter } : {}),
            ...(channelFilter !== 'all' ? { channel: channelFilter } : {}),
            page: String(page),
            limit: String(pageSize),
          }).toString(),
      ),
    placeholderData: (prev) => prev, // keep the old page visible while the next loads
  });
  const contacts = useMemo(() => contactsQuery.data?.data ?? [], [contactsQuery.data]);
  const totalContacts = contactsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalContacts / pageSize));

  const tagsQuery = useQuery({
    queryKey: ['contacts', 'tags'],
    queryFn: () => api.get<{ data: TagBucket[] }>('/api/v1/contacts/tags'),
  });

  // Likely-duplicate numbers (same phone written differently). Drives the
  // banner + the review/merge dialog.
  const dupQuery = useQuery({
    queryKey: ['contacts', 'duplicates'],
    queryFn: () => api.get<{ data: DuplicatesData }>('/api/v1/contacts/duplicates'),
  });
  const dupCount = dupQuery.data?.data.groupCount ?? 0;

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

  const tags = useMemo(() => tagsQuery.data?.data ?? [], [tagsQuery.data]);

  // Reload after a contact is added/imported. Jump to page 1 (newest first) so
  // the new contact is visible immediately, and refetch the list + tags.
  const reloadContacts = () => {
    setPage(1);
    void qc.invalidateQueries({ queryKey: ['contacts'] });
    void qc.invalidateQueries({ queryKey: ['contacts', 'tags'] });
  };

  return (
    <>
      <PageHeader
        title="Contacts"
        description="Your customer phone book. Imported from CSV, the inbox, or added manually. Use these for broadcast audiences."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={downloadContactsTemplate}>
              <Download className="size-4" /> Download template
            </Button>
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              <Upload className="size-4" /> Import CSV
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> Add contact
            </Button>
          </div>
        }
      />

      {/* Duplicate-number flag — same phone written differently / different names. */}
      {dupCount > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm">
          <span className="flex items-center gap-2 text-red-800">
            <span className="text-base leading-none">⚠</span>
            <span>
              <strong>{dupCount}</strong> number{dupCount === 1 ? '' : 's'} look duplicated (same
              phone, different format or name). Merge each into one clean contact.
            </span>
          </span>
          <Button variant="secondary" size="sm" onClick={() => setDupOpen(true)}>
            Review &amp; fix
          </Button>
        </div>
      ) : null}

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
        {/* Channel filter — split WhatsApp vs Instagram contacts. Instagram is
            hidden when the tenant isn't subscribed to it. */}
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5 text-xs">
          {channelOptions.map((c) => (
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
          <CardTitle>
            {totalContacts.toLocaleString()} contact{totalContacts === 1 ? '' : 's'}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                <tr>
                  <th className="px-4 py-3 sm:px-6">Phone / Account</th>
                  <th
                    className="hidden px-6 py-3 lg:table-cell"
                    title="The customer's WhatsApp profile name — what they set in WhatsApp → Settings → Profile → Name. Read-only; auto-fills when they message you."
                  >
                    WhatsApp nickname
                  </th>
                  <th className="px-4 py-3 sm:px-6">Name (your label)</th>
                  <th className="hidden px-6 py-3 md:table-cell">Tags</th>
                  <th className="hidden px-6 py-3 lg:table-cell">Source</th>
                  <th className="hidden px-6 py-3 sm:table-cell">Last inbound</th>
                  <th className="w-16 px-4 py-3 sm:w-20 sm:px-6" />
                </tr>
              </thead>
              <tbody>
                {contactsQuery.isLoading ? (
                  <tr>
                    <td colSpan={7} className="p-0">
                      <SkeletonRows rows={5} cols={5} />
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
          {totalContacts > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-3 text-sm">
              {/* Range + per-page selector */}
              <div className="flex items-center gap-3 text-foreground-muted">
                <span>
                  {((page - 1) * pageSize + 1).toLocaleString()}–
                  {Math.min(page * pageSize, totalContacts).toLocaleString()} of{' '}
                  {totalContacts.toLocaleString()}
                </span>
                <label className="flex items-center gap-1.5">
                  <span className="text-xs uppercase tracking-wide text-foreground-subtle">
                    Per page
                  </span>
                  <select
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
                  >
                    {[25, 50, 100].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {/* Page navigation */}
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || contactsQuery.isFetching}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="size-4" /> Back
                </Button>
                <span className="text-foreground-muted">
                  Page {page} of {totalPages.toLocaleString()}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages || contactsQuery.isFetching}
                  aria-label="Next page"
                >
                  Next <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <CreateContactDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={reloadContacts} />
      <ImportCsvDialog open={importOpen} onOpenChange={setImportOpen} onDone={reloadContacts} />
      <DuplicatesDialog
        open={dupOpen}
        onOpenChange={setDupOpen}
        groups={dupQuery.data?.data.groups ?? []}
        onMerged={() => {
          void dupQuery.refetch();
          reloadContacts();
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
  onAddTag,
  onRemoveTag,
}: {
  contact: ContactDto;
  onSave: (patch: { displayName?: string | null; phoneE164?: string; blocked?: boolean }) => void;
  saving: boolean;
  onShowInfo: () => void;
  onDelete: () => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState(contact.phoneE164);
  const [name, setName] = useState(contact.displayName ?? '');
  const [tagDraft, setTagDraft] = useState('');

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
      <td className="px-4 py-3 text-sm sm:px-6">
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
      <td className="hidden px-6 py-3 text-sm text-foreground-muted lg:table-cell">
        {contact.whatsappName ?? '—'}
      </td>
      <td className="px-4 py-3 text-sm sm:px-6">
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
      <td className="hidden px-6 py-3 md:table-cell">
        <div className="flex flex-wrap items-center gap-1">
          {contact.tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs text-foreground-muted"
            >
              {t}
              {editing ? (
                <button
                  type="button"
                  onClick={() => onRemoveTag(t)}
                  className="text-foreground-subtle hover:text-rose-600"
                  aria-label={`Remove tag ${t}`}
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </span>
          ))}
          {editing ? (
            <input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const t = tagDraft.trim();
                  if (t && !contact.tags.includes(t)) onAddTag(t);
                  setTagDraft('');
                }
              }}
              placeholder="+ tag"
              aria-label="Add tag"
              className="h-6 w-20 rounded-full border border-dashed border-border bg-transparent px-2 text-xs outline-none focus:border-brand-400"
            />
          ) : contact.tags.length === 0 ? (
            <span className="text-xs text-foreground-subtle">—</span>
          ) : null}
        </div>
      </td>
      <td className="hidden px-6 py-3 text-sm text-foreground-muted lg:table-cell">
        {contact.source}
      </td>
      <td className="hidden px-6 py-3 text-sm text-foreground-muted sm:table-cell">
        {contact.lastInboundAt ? new Date(contact.lastInboundAt).toLocaleDateString() : '—'}
      </td>
      <td className="px-4 py-3 text-right sm:px-6">
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
                    `Block ${contact.phoneE164}? No messages can be sent to them — the AI bot stops replying and you can't message them from the inbox either — and they're excluded from broadcasts. Their incoming messages still appear in the inbox.`,
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

function DuplicatesDialog({
  open,
  onOpenChange,
  groups,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  groups: DupGroup[];
  onMerged: () => void;
}) {
  // keepId per group (default: the oldest/first contact in each group).
  const [keepByKey, setKeepByKey] = useState<Record<string, string>>({});
  const [autoMerging, setAutoMerging] = useState(false);
  const merge = useMutation({
    mutationFn: (vars: { keepId: string; dropIds: string[] }) =>
      api.post('/api/v1/contacts/merge', vars),
    onSuccess: () => {
      toast.success('Merged');
      onMerged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Merge failed'),
  });
  const nameOf = (c: DupContact) => c.displayName ?? c.whatsappName ?? '(no name)';
  // Safe one-click: groups whose entries share the same name (or are unnamed)
  // — just keep the first of each.
  const sameNameGroups = groups.filter((g) => g.sameName);
  const autoMergeSameName = async () => {
    setAutoMerging(true);
    try {
      for (const g of sameNameGroups) {
        const keepId = g.contacts[0]!.id;
        await api
          .post('/api/v1/contacts/merge', { keepId, dropIds: g.contacts.slice(1).map((c) => c.id) })
          .catch(() => undefined);
      }
      toast.success('Merged same-name duplicates');
      onMerged();
    } finally {
      setAutoMerging(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Duplicate numbers</DialogTitle>
          <DialogDescription>
            Each group is the same phone saved more than once. Pick the contact to keep — its tags
            absorb the others&apos;, and the duplicates are deleted.
          </DialogDescription>
          {sameNameGroups.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              loading={autoMerging}
              onClick={() => void autoMergeSameName()}
            >
              Auto-merge {sameNameGroups.length} same-name group{sameNameGroups.length === 1 ? '' : 's'}
            </Button>
          ) : null}
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {groups.length === 0 ? (
            <p className="py-6 text-center text-sm text-foreground-muted">No duplicates</p>
          ) : (
            groups.map((g) => {
              const keepId = keepByKey[g.key] ?? g.contacts[0]?.id ?? '';
              return (
                <div key={g.key} className="rounded-md border border-border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                      {g.contacts.length} entries {g.sameName ? '· same name' : '· different names'}
                    </span>
                    <Button
                      size="sm"
                      loading={merge.isPending}
                      onClick={() =>
                        merge.mutate({
                          keepId,
                          dropIds: g.contacts.map((c) => c.id).filter((id) => id !== keepId),
                        })
                      }
                    >
                      Merge — keep selected
                    </Button>
                  </div>
                  <div className="space-y-1">
                    {g.contacts.map((c) => (
                      <label
                        key={c.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface-muted"
                      >
                        <input
                          type="radio"
                          name={`keep-${g.key}`}
                          checked={keepId === c.id}
                          onChange={() => setKeepByKey((m) => ({ ...m, [g.key]: c.id }))}
                        />
                        <span className="font-medium text-foreground">{nameOf(c)}</span>
                        <span className="font-mono text-xs text-foreground-subtle">{c.phoneE164}</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
