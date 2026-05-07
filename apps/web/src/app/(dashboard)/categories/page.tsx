'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
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
import { api, ApiError } from '@/lib/api';

interface Category {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  productCount?: number;
}

export default function CategoriesPage() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const cats = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ data: Category[] }>('/api/v1/categories'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/categories/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      toast.success('Category deleted');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Delete failed'),
  });

  return (
    <>
      <PageHeader
        title="Categories"
        description="Organize products into categories for chatbot retrieval and the storefront."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> New category
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>{cats.data?.data.length ?? 0} categories</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-foreground-subtle">
              <tr>
                <th className="px-6 py-3">Name</th>
                <th className="px-6 py-3">Slug</th>
                <th className="px-6 py-3">Products</th>
                <th className="w-12 px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {cats.isLoading ? (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-foreground-muted">Loading…</td>
                </tr>
              ) : null}
              {cats.data?.data.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-12 text-center text-foreground-muted">No categories yet.</td>
                </tr>
              ) : null}
              {cats.data?.data.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="px-6 py-4 font-medium">{c.name}</td>
                  <td className="px-6 py-4 font-mono text-xs text-foreground-muted">{c.slug}</td>
                  <td className="px-6 py-4 font-mono text-sm">{c.productCount ?? 0}</td>
                  <td className="px-6 py-4 text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        if (window.confirm(`Delete "${c.name}"? Products keep their data but lose this category link.`))
                          deleteMutation.mutate(c.id);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <CreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        existing={cats.data?.data ?? []}
        onCreated={() => qc.invalidateQueries({ queryKey: ['categories'] })}
      />
    </>
  );
}

function CreateDialog({
  open,
  onOpenChange,
  existing,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  existing: Category[];
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [parentId, setParentId] = useState<string | ''>('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/api/v1/categories', {
        name,
        slug: slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        parentId: parentId || undefined,
      });
      toast.success('Category created');
      onOpenChange(false);
      onCreated();
      setName('');
      setSlug('');
      setParentId('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New category</DialogTitle>
          <DialogDescription>Categories can be nested under a parent.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>Slug (auto-generated if blank)</Label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="men-shoes" />
          </div>
          <div>
            <Label>Parent (optional)</Label>
            <select
              className="w-full rounded border border-border px-3 py-2 text-sm"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              <option value="">No parent (top-level)</option>
              {existing.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!name || busy} loading={busy}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
