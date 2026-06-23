'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, Search, Trash2, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { SkeletonRows } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';

type LeadStatus = 'new' | 'contacted' | 'converted' | 'archived';

interface LeadRow {
  id: string;
  name: string;
  phone: string;
  source: string;
  status: LeadStatus;
  note: string | null;
  createdAt: string;
}

const STATUSES: LeadStatus[] = ['new', 'contacted', 'converted', 'archived'];
const STATUS_TONE: Record<LeadStatus, string> = {
  new: 'bg-blue-100 text-blue-800',
  contacted: 'bg-amber-100 text-amber-800',
  converted: 'bg-emerald-100 text-emerald-800',
  archived: 'bg-zinc-100 text-zinc-600',
};

export default function LeadsPage() {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const [debounced, setDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState<LeadStatus | ''>('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const leads = useQuery({
    queryKey: ['admin-leads', debounced, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debounced) params.set('q', debounced);
      if (statusFilter) params.set('status', statusFilter);
      const qs = params.toString();
      return api.get<{ data: LeadRow[] }>(`/api/v1/aligned-admin/leads${qs ? `?${qs}` : ''}`);
    },
    refetchInterval: 30_000,
  });

  const setStatus = useMutation({
    mutationFn: (vars: { id: string; status: LeadStatus }) =>
      api.patch(`/api/v1/aligned-admin/leads/${vars.id}`, { status: vars.status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-leads'] });
      // Also refresh the sidebar "new leads" badge immediately — moving a
      // lead off 'new' (or onto it) changes the count, so the number badge
      // should update right away instead of lingering until its 30s poll.
      queryClient.invalidateQueries({ queryKey: ['sidebar-leads-count'] });
    },
    onError: () => toast.error('Could not update lead'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/aligned-admin/leads/${id}`),
    onSuccess: () => {
      toast.success('Lead deleted');
      queryClient.invalidateQueries({ queryKey: ['admin-leads'] });
      queryClient.invalidateQueries({ queryKey: ['sidebar-leads-count'] });
    },
    onError: () => toast.error('Could not delete lead'),
  });

  const rows = leads.data?.data ?? [];

  return (
    <>
      <PageHeader
        backHref="/aligned-admin"
        backLabel="Tenants"
        title="Leads"
        description="WhatsApp numbers captured from the hader.ai landing page."
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name or number…"
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant={statusFilter === '' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setStatusFilter('')}
          >
            All
          </Button>
          {STATUSES.map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? 'primary' : 'secondary'}
              size="sm"
              className="capitalize"
              onClick={() => setStatusFilter(s)}
            >
              {s}
            </Button>
          ))}
        </div>
        <Badge variant="muted" className="ml-auto gap-1">
          <Users className="size-3.5" /> {rows.length}
        </Badge>
      </div>

      <Card>
        <CardContent className="p-0">
          {leads.isLoading ? (
            <SkeletonRows rows={6} cols={5} className="px-3 py-2" />
          ) : rows.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              No leads yet. Numbers submitted on the landing page appear here.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">WhatsApp number</th>
                    <th className="px-4 py-3 font-medium">Source</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Captured</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((lead) => (
                    <tr key={lead.id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="px-4 py-3 font-medium">{lead.name}</td>
                      <td className="px-4 py-3">
                        <a
                          href={`https://wa.me/${lead.phone.replace(/[^0-9]/g, '')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 font-mono text-foreground hover:text-primary"
                        >
                          <Phone className="size-3.5 text-emerald-600" />
                          {lead.phone}
                        </a>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{lead.source}</td>
                      <td className="px-4 py-3">
                        <select
                          value={lead.status}
                          onChange={(e) =>
                            setStatus.mutate({ id: lead.id, status: e.target.value as LeadStatus })
                          }
                          className={`rounded-md px-2 py-1 text-xs font-medium capitalize ${STATUS_TONE[lead.status]}`}
                        >
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatRelative(lead.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={async () => {
                            const ok = await confirmDialog({
                              title: 'Delete lead?',
                              body: `Remove ${lead.name} (${lead.phone}). This cannot be undone.`,
                              confirmLabel: 'Delete',
                              destructive: true,
                            });
                            if (ok) remove.mutate(lead.id);
                          }}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
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
