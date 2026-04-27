'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ImageIcon, Palette, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';
import { uploadFile } from '@/lib/upload';

interface Branding {
  id: string;
  logoAssetId: string | null;
  logoUrl?: string | null;
  accentColor: string | null;
  customCname: string | null;
  footerText: string | null;
  updatedAt: string;
}

export default function BrandingPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<{ data: Branding }>('/api/v1/branding'),
  });

  const [accent, setAccent] = useState('');
  const [cname, setCname] = useState('');
  const [footer, setFooter] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!q.data) return;
    setAccent(q.data.data.accentColor ?? '');
    setCname(q.data.data.customCname ?? '');
    setFooter(q.data.data.footerText ?? '');
  }, [q.data]);

  async function onLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error('Logo must be under 2 MB.');
      return;
    }
    setUploading(true);
    try {
      const { assetId } = await uploadFile(file, 'image');
      await api.put('/api/v1/branding', { logoAssetId: assetId });
      toast.success('Logo uploaded');
      qc.invalidateQueries({ queryKey: ['branding'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function clearLogo() {
    await api.put('/api/v1/branding', { logoAssetId: null });
    toast.success('Logo removed');
    qc.invalidateQueries({ queryKey: ['branding'] });
  }

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/branding', {
        accentColor: accent || null,
        customCname: cname || null,
        footerText: footer || null,
      }),
    onSuccess: () => {
      toast.success('Branding saved');
      qc.invalidateQueries({ queryKey: ['branding'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  return (
    <>
      <PageHeader
        title="Branding"
        description="White-label your portal: accent colour, footer text, custom CNAME for the inbox."
        actions={
          <Button variant="secondary" asChild>
            <Link href="/settings">
              <ArrowLeft className="size-4" /> Back to settings
            </Link>
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Palette className="size-4" /> Brand basics
          </CardTitle>
          <CardDescription>
            Logo, accent colour, footer, and an optional CNAME. CNAME is stored only — DNS is your job.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Logo</Label>
            <div className="flex items-center gap-3">
              {q.data?.data.logoUrl ? (
                <img
                  src={q.data.data.logoUrl}
                  alt="Org logo"
                  className="h-16 w-16 rounded-md border border-border bg-white object-contain"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-border bg-surface-muted text-foreground-subtle">
                  <ImageIcon className="size-6" />
                </div>
              )}
              <div className="flex flex-col gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="hidden"
                  onChange={onLogoFile}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  loading={uploading}
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload className="size-3.5" /> {q.data?.data.logoUrl ? 'Replace' : 'Upload logo'}
                </Button>
                {q.data?.data.logoUrl ? (
                  <Button variant="ghost" size="sm" onClick={clearLogo}>
                    <Trash2 className="size-3.5" /> Remove
                  </Button>
                ) : null}
              </div>
            </div>
            <p className="text-xs text-foreground-subtle">PNG / JPG / WebP / SVG, ≤2 MB.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="accent">Accent colour (hex)</Label>
            <div className="flex gap-2">
              <Input
                id="accent"
                placeholder="#0070C9"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                maxLength={7}
              />
              <span
                aria-hidden
                className="inline-block size-10 shrink-0 rounded-md border border-border"
                style={{ background: /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#ffffff' }}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cname">Custom CNAME (optional)</Label>
            <Input
              id="cname"
              placeholder="inbox.yourcompany.com"
              value={cname}
              onChange={(e) => setCname(e.target.value)}
            />
            <p className="text-xs text-foreground-muted">
              Point a CNAME at <span className="font-mono">alignbot.aligned-tech.com</span> on your
              DNS provider, then enter it here. We don't manage your DNS — just store the value.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="footer">Footer text</Label>
            <Textarea
              id="footer"
              rows={2}
              placeholder="Powered by Yourbrand · support@yourbrand.com"
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
            />
          </div>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save branding
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
