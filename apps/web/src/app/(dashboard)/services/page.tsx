'use client';

import type { Category, ServiceListItem } from '@aligned/shared';
import { PRICE_UNIT_LABELS } from '@aligned/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Briefcase, Clock, MoreHorizontal, Plus, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatRelative } from '@/lib/format';

const ALL_CATEGORIES = '__all__';
const ALL_AVAILABILITY = '__all__';

export default function ServicesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [categoryId, setCategoryId] = useState<string>(ALL_CATEGORIES);
  const [availability, setAvailability] = useState<string>(ALL_AVAILABILITY);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedSearch) p.set('q', debouncedSearch);
    if (categoryId !== ALL_CATEGORIES) p.set('categoryId', categoryId);
    if (availability !== ALL_AVAILABILITY) p.set('isAvailable', availability);
    p.set('limit', '50');
    return p.toString();
  }, [debouncedSearch, categoryId, availability]);

  const servicesQuery = useQuery({
    queryKey: ['services', params],
    queryFn: () => api.get<{ data: ServiceListItem[] }>(`/api/v1/services?${params}`),
  });
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ data: Category[] }>('/api/v1/categories'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/services/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['services'] });
      toast.success('Service deleted');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (vars: { ids?: string[]; all?: boolean }) =>
      api.post<{ data: { deleted: number } }>('/api/v1/services/bulk-delete', vars),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['services'] });
      setSelected(new Set());
      toast.success(`Deleted ${res.data.deleted} service${res.data.deleted === 1 ? '' : 's'}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
  });

  const createDraft = async () => {
    setCreating(true);
    try {
      const stamp = Date.now().toString(36).toLowerCase();
      const res = await api.post<{ data: { id: string } }>(`/api/v1/services`, {
        name: 'Untitled service',
        // Slug must be unique per draft (@@unique([organizationId, slug])).
        slug: `draft-${stamp}`,
        isAvailable: false,
      });
      router.push(`/services/${res.data.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not create draft');
    } finally {
      setCreating(false);
    }
  };

  const services = servicesQuery.data?.data ?? [];
  const allSelected = services.length > 0 && services.every((s) => selected.has(s.id));
  const someSelected = selected.size > 0;
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(services.map((s) => s.id)));
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <PageHeader
        title="Services"
        description="Bookable services with pricing tiers and availability windows."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              loading={bulkDeleteMutation.isPending}
              onClick={async () => {
                const ok = await confirmDialog({
                  title: 'Delete every service?',
                  body: 'This soft-deletes every service in your catalog. The chatbot stops answering about all of them immediately. Type DELETE in the next step to confirm — you can restore from the activity log if needed.',
                  confirmLabel: 'Continue',
                  destructive: true,
                });
                if (!ok) return;
                const typed = window.prompt('Type DELETE to confirm wiping every service:');
                if (typed?.trim().toUpperCase() === 'DELETE') {
                  bulkDeleteMutation.mutate({ all: true });
                }
              }}
            >
              <Trash2 className="size-4" /> Delete all
            </Button>
            <Button onClick={createDraft} loading={creating}>
              <Plus className="size-4" /> New service
            </Button>
          </div>
        }
      />

      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
            <Input
              placeholder="Search services…"
              className="pl-9"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger className="w-full lg:w-48">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
              {categoriesQuery.data?.data.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={availability} onValueChange={setAvailability}>
            <SelectTrigger className="w-full lg:w-44">
              <SelectValue placeholder="Availability" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_AVAILABILITY}>All availability</SelectItem>
              <SelectItem value="true">Available</SelectItem>
              <SelectItem value="false">Unavailable</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {someSelected ? (
          <div className="flex items-center justify-between gap-3 border-b border-border bg-brand-50/40 px-4 py-2 text-sm">
            <span>
              <strong>{selected.size}</strong> selected
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="danger"
                loading={bulkDeleteMutation.isPending}
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: `Delete ${selected.size} service${selected.size === 1 ? '' : 's'}?`,
                    body: 'This soft-deletes the selected services. The chatbot stops answering about them immediately. You can restore from the activity log if needed.',
                    confirmLabel: 'Delete',
                    destructive: true,
                  });
                  if (ok) bulkDeleteMutation.mutate({ ids: Array.from(selected) });
                }}
              >
                <Trash2 className="size-4" /> Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          </div>
        ) : null}

        <CardContent className="p-0">
          {servicesQuery.isLoading ? (
            <div className="px-6 py-12 text-center text-sm text-foreground-muted">Loading…</div>
          ) : services.length === 0 ? (
            <EmptyState
              icon={Briefcase}
              title={debouncedSearch ? 'No matches' : 'No services yet'}
              description={
                debouncedSearch
                  ? 'Try a different search term or filter.'
                  : 'Add your first service to let the chatbot answer bookings.'
              }
              action={
                !debouncedSearch ? (
                  <Button onClick={createDraft} loading={creating}>
                    <Plus className="size-4" /> Create your first service
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                  <tr>
                    <th className="w-10 px-4 py-3">
                      <input
                        type="checkbox"
                        className="size-4 cursor-pointer rounded border-border accent-brand-500"
                        checked={allSelected}
                        aria-label={allSelected ? 'Deselect all services' : 'Select all services on this page'}
                        onChange={toggleAll}
                      />
                    </th>
                    <th className="px-4 py-3">Service</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Duration</th>
                    <th className="px-4 py-3 text-right">Starts at</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Updated</th>
                    <th className="w-12 px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {services.map((s) => (
                    <tr key={s.id} className="border-b border-border last:border-0 hover:bg-surface-muted/50">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          className="size-4 cursor-pointer rounded border-border accent-brand-500"
                          checked={selected.has(s.id)}
                          aria-label={`Select ${s.name}`}
                          onChange={() => toggleOne(s.id)}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <Link href={`/services/${s.id}`} className="block">
                          <p className="font-medium">{s.name}</p>
                          {s.shortDescription ? (
                            <p className="truncate text-xs text-foreground-subtle">{s.shortDescription}</p>
                          ) : null}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-foreground-muted">
                        {s.categoryName ?? <span className="text-foreground-subtle">—</span>}
                      </td>
                      <td className="px-4 py-3 text-foreground-muted">
                        {s.durationMinutes ? (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="size-3.5" /> {s.durationMinutes} min
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="font-medium">{formatMoney(s.basePriceMinor, s.currency)}</span>
                        <span className="ml-1 text-xs text-foreground-subtle">
                          {PRICE_UNIT_LABELS[s.priceUnit]}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {s.isAvailable ? (
                          <Badge variant="success">Available</Badge>
                        ) : (
                          <Badge variant="muted">Unavailable</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-foreground-muted">{formatRelative(s.updatedAt)}</td>
                      <td className="px-4 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href={`/services/${s.id}`}>Edit</Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-red-600 focus:text-red-700"
                              onSelect={async () => {
                                if (
                                  await confirmDialog({
                                    title: `Delete "${s.name}"?`,
                                    body: 'The service will be hidden from the chatbot immediately.',
                                    confirmLabel: 'Delete service',
                                    destructive: true,
                                  })
                                ) {
                                  deleteMutation.mutate(s.id);
                                }
                              }}
                            >
                              <Trash2 className="size-4" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
