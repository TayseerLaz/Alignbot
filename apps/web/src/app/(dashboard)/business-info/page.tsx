'use client';

import {
  type BusinessInfoDto,
  CONTACT_KINDS,
  type ContactKind,
  type FaqDto,
  type LocationDto,
  type PolicyDto,
  POLICY_KINDS,
  type PolicyKind,
  DAY_OF_WEEK_LABELS,
  DAYS_OF_WEEK,
  FaqVisibility,
} from '@aligned/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CalendarCheck, MapPin, MessageSquare, Phone, Plus, Save, ScrollText, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MarkdownEditor } from '@/components/ui/rich-text-editor';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';

export default function BusinessInfoPage() {
  return (
    <>
      <PageHeader
        title="Business info"
        description="Hours, locations, FAQs, and policies that the chatbot uses to answer questions."
      />
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">
            <Building2 className="mr-2 size-4" /> Profile &amp; hours
          </TabsTrigger>
          <TabsTrigger value="locations">
            <MapPin className="mr-2 size-4" /> Locations
          </TabsTrigger>
          <TabsTrigger value="contacts">
            <Phone className="mr-2 size-4" /> Contacts
          </TabsTrigger>
          <TabsTrigger value="faqs">
            <MessageSquare className="mr-2 size-4" /> FAQs
          </TabsTrigger>
          <TabsTrigger value="policies">
            <ScrollText className="mr-2 size-4" /> Policies
          </TabsTrigger>
          <TabsTrigger value="booking">
            <CalendarCheck className="mr-2 size-4" /> Booking form
          </TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <ProfilePanel />
        </TabsContent>
        <TabsContent value="locations">
          <LocationsPanel />
        </TabsContent>
        <TabsContent value="contacts">
          <ContactsPanel />
        </TabsContent>
        <TabsContent value="faqs">
          <FaqsPanel />
        </TabsContent>
        <TabsContent value="policies">
          <PoliciesPanel />
        </TabsContent>
        <TabsContent value="booking">
          <BookingFormPanel />
        </TabsContent>
      </Tabs>
    </>
  );
}

// ---------- profile + hours ------------------------------------------------
type HoursMap = Record<(typeof DAYS_OF_WEEK)[number], { open: string; close: string }[]>;

function emptyHours(): HoursMap {
  return DAYS_OF_WEEK.reduce(
    (acc, d) => ({ ...acc, [d]: [] }),
    {} as HoursMap,
  );
}

function ProfilePanel() {
  const queryClient = useQueryClient();
  const infoQuery = useQuery({
    queryKey: ['business-info'],
    queryFn: () => api.get<{ data: BusinessInfoDto | null }>('/api/v1/business-info'),
  });

  const [draft, setDraft] = useState<{
    legalName: string;
    tagline: string;
    about: string;
    websiteUrl: string;
    timezone: string;
    currency: string;
    hours: HoursMap;
  }>({
    legalName: '',
    tagline: '',
    about: '',
    websiteUrl: '',
    timezone: 'UTC',
    currency: 'USD',
    hours: emptyHours(),
  });

  useEffect(() => {
    const info = infoQuery.data?.data;
    if (!info) return;
    setDraft({
      legalName: info.legalName ?? '',
      tagline: info.tagline ?? '',
      about: info.about ?? '',
      websiteUrl: info.websiteUrl ?? '',
      timezone: info.timezone,
      currency: info.currency,
      hours: { ...emptyHours(), ...((info.operatingHours as HoursMap | null) ?? {}) },
    });
  }, [infoQuery.data]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/business-info', {
        legalName: draft.legalName || null,
        tagline: draft.tagline || null,
        about: draft.about || null,
        websiteUrl: draft.websiteUrl || null,
        timezone: draft.timezone,
        currency: draft.currency,
        operatingHours: draft.hours,
      }),
    onSuccess: () => {
      toast.success('Business profile saved');
      queryClient.invalidateQueries({ queryKey: ['business-info'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>The chatbot uses this to introduce your business.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="legalName">Legal name</Label>
            <Input
              id="legalName"
              value={draft.legalName}
              onChange={(e) => setDraft({ ...draft, legalName: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="websiteUrl">Website</Label>
            <Input
              id="websiteUrl"
              type="url"
              placeholder="https://"
              value={draft.websiteUrl}
              onChange={(e) => setDraft({ ...draft, websiteUrl: e.target.value })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="tagline">Tagline</Label>
            <Input
              id="tagline"
              value={draft.tagline}
              onChange={(e) => setDraft({ ...draft, tagline: e.target.value })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="about">About</Label>
            <Textarea
              id="about"
              rows={5}
              value={draft.about}
              onChange={(e) => setDraft({ ...draft, about: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="timezone">Timezone</Label>
            <Input
              id="timezone"
              value={draft.timezone}
              onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="currency">Currency (3-letter)</Label>
            <Input
              id="currency"
              value={draft.currency}
              maxLength={3}
              onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Operating hours</CardTitle>
          <CardDescription>Add open/close times per day. Leave a day blank to be closed.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {DAYS_OF_WEEK.map((day) => {
            const slot = draft.hours[day]?.[0];
            const open = slot?.open ?? '';
            const close = slot?.close ?? '';
            const isOpen = !!slot;
            return (
              <div key={day} className="grid grid-cols-[80px_auto_1fr_1fr] items-center gap-2">
                <span className="text-xs font-medium">{DAY_OF_WEEK_LABELS[day]}</span>
                <input
                  type="checkbox"
                  className="size-4 cursor-pointer rounded border-border accent-brand-500"
                  checked={isOpen}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      hours: { ...prev.hours, [day]: e.target.checked ? [{ open: '09:00', close: '17:00' }] : [] },
                    }))
                  }
                />
                <Input
                  type="time"
                  disabled={!isOpen}
                  value={open}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      hours: { ...prev.hours, [day]: [{ open: e.target.value, close }] },
                    }))
                  }
                />
                <Input
                  type="time"
                  disabled={!isOpen}
                  value={close}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      hours: { ...prev.hours, [day]: [{ open, close: e.target.value }] },
                    }))
                  }
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="lg:col-span-3">
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          <Save className="size-4" /> Save profile &amp; hours
        </Button>
      </div>
    </div>
  );
}

// ---------- locations ------------------------------------------------------
function LocationsPanel() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const list = useQuery({
    queryKey: ['locations'],
    queryFn: () => api.get<{ data: LocationDto[] }>('/api/v1/business-info/locations'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/business-info/locations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['locations'] });
      toast.success('Location removed');
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Locations</CardTitle>
          <CardDescription>Where the business operates from.</CardDescription>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="size-4" /> Add location
        </Button>
      </CardHeader>
      <CardContent>
        {list.data?.data.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-foreground-muted">
            No locations yet. Add one so the chatbot can answer "where are you?".
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {list.data?.data.map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-3 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{l.name}</p>
                    {l.isPrimary ? <Badge variant="default">Primary</Badge> : null}
                  </div>
                  <p className="text-xs text-foreground-muted">
                    {[l.addressLine1, l.city, l.region, l.postalCode, l.country]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                  {(l.phone || l.email) && (
                    <p className="text-xs text-foreground-subtle">
                      {[l.phone, l.email].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove location"
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: `Remove "${l.name}"?`,
                        body: 'This location will stop appearing in chatbot replies.',
                        confirmLabel: 'Remove location',
                        destructive: true,
                      })
                    ) {
                      remove.mutate(l.id);
                    }
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <LocationDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}

function LocationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({
    name: '',
    addressLine1: '',
    city: '',
    region: '',
    postalCode: '',
    country: '',
    phone: '',
    email: '',
    isPrimary: false,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/v1/business-info/locations', {
        name: draft.name,
        addressLine1: draft.addressLine1 || null,
        city: draft.city || null,
        region: draft.region || null,
        postalCode: draft.postalCode || null,
        country: draft.country.toUpperCase() || null,
        phone: draft.phone || null,
        email: draft.email || null,
        isPrimary: draft.isPrimary,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['locations'] });
      toast.success('Location added');
      onOpenChange(false);
      setDraft({
        name: '',
        addressLine1: '',
        city: '',
        region: '',
        postalCode: '',
        country: '',
        phone: '',
        email: '',
        isPrimary: false,
      });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Could not add'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a location</DialogTitle>
          <DialogDescription>
            All fields except name are optional. You can set this location as primary.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="loc-name">Name</Label>
            <Input
              id="loc-name"
              required
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="loc-addr">Address</Label>
            <Input
              id="loc-addr"
              value={draft.addressLine1}
              onChange={(e) => setDraft({ ...draft, addressLine1: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>City</Label>
              <Input value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Region / state</Label>
              <Input value={draft.region} onChange={(e) => setDraft({ ...draft, region: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Postal code</Label>
              <Input
                value={draft.postalCode}
                onChange={(e) => setDraft({ ...draft, postalCode: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Country (2-letter)</Label>
              <Input
                maxLength={2}
                value={draft.country}
                onChange={(e) => setDraft({ ...draft, country: e.target.value.toUpperCase() })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input
                type="email"
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.isPrimary}
              onChange={(e) => setDraft({ ...draft, isPrimary: e.target.checked })}
              className="size-4 rounded border-border accent-brand-500"
            />
            Mark as primary
          </label>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Add location
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- contacts -------------------------------------------------------
interface ContactItem {
  id: string;
  kind: ContactKind;
  label: string | null;
  value: string;
  isPrimary: boolean;
  sortOrder: number;
}

function ContactsPanel() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['contacts'],
    queryFn: () => api.get<{ data: ContactItem[] }>('/api/v1/business-info/contacts'),
  });
  const [draft, setDraft] = useState<{ kind: ContactKind; label: string; value: string }>({
    kind: 'whatsapp',
    label: '',
    value: '',
  });
  const create = useMutation({
    mutationFn: () =>
      api.post('/api/v1/business-info/contacts', {
        kind: draft.kind,
        label: draft.label || null,
        value: draft.value,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      toast.success('Contact added');
      setDraft({ kind: 'whatsapp', label: '', value: '' });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/business-info/contacts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contacts'] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contact channels</CardTitle>
        <CardDescription>Phones, emails, and social handles your customers can reach you at.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Select value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v as ContactKind })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTACT_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Label (optional)"
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
          <Input
            required
            placeholder="Value (e.g. +1 555 0100)"
            value={draft.value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          />
          <Button type="submit" loading={create.isPending}>
            <Plus className="size-4" /> Add
          </Button>
        </form>

        <ul className="divide-y divide-border">
          {list.data?.data.map((c) => (
            <li key={c.id} className="flex items-center justify-between py-2">
              <div className="flex items-center gap-3">
                <Badge variant="muted">{c.kind}</Badge>
                <span className="font-medium">{c.value}</span>
                {c.label ? <span className="text-xs text-foreground-subtle">{c.label}</span> : null}
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove"
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: 'Remove this contact?',
                      confirmLabel: 'Remove',
                      destructive: true,
                    })
                  ) {
                    remove.mutate(c.id);
                  }
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------- FAQs -----------------------------------------------------------
function FaqsPanel() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['faqs'],
    queryFn: () => api.get<{ data: FaqDto[] }>('/api/v1/business-info/faqs'),
  });
  const [draft, setDraft] = useState({ question: '', answer: '' });
  const create = useMutation({
    mutationFn: () => api.post('/api/v1/business-info/faqs', draft),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['faqs'] });
      setDraft({ question: '', answer: '' });
      toast.success('FAQ added');
    },
  });
  const update = useMutation({
    mutationFn: (vars: { id: string; patch: Partial<FaqDto> }) =>
      api.patch(`/api/v1/business-info/faqs/${vars.id}`, vars.patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['faqs'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/business-info/faqs/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['faqs'] }),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Add FAQ</CardTitle>
          <CardDescription>Public FAQs are exposed to the chatbot read API.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="faq-q">Question</Label>
              <Input
                id="faq-q"
                required
                value={draft.question}
                onChange={(e) => setDraft({ ...draft, question: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="faq-a">Answer</Label>
              <Textarea
                id="faq-a"
                rows={4}
                required
                value={draft.answer}
                onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
              />
            </div>
            <Button type="submit" loading={create.isPending}>
              <Plus className="size-4" /> Add FAQ
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Existing FAQs</CardTitle>
        </CardHeader>
        <CardContent>
          {list.data?.data.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-foreground-muted">No FAQs yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {list.data?.data.map((f) => (
                <li key={f.id} className="space-y-2 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <p className="font-medium">{f.question}</p>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-foreground-muted">{f.answer}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={f.visibility}
                        onValueChange={(v) =>
                          update.mutate({ id: f.id, patch: { visibility: v as FaqVisibility } })
                        }
                      >
                        <SelectTrigger className="h-8 w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="public">Public</SelectItem>
                          <SelectItem value="private">Private</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Delete FAQ"
                        onClick={async () => {
                          if (
                            await confirmDialog({
                              title: 'Delete this FAQ?',
                              confirmLabel: 'Delete FAQ',
                              destructive: true,
                            })
                          ) {
                            remove.mutate(f.id);
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Policies -------------------------------------------------------
function PoliciesPanel() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['policies'],
    queryFn: () => api.get<{ data: PolicyDto[] }>('/api/v1/business-info/policies'),
  });
  const [kind, setKind] = useState<PolicyKind>('return');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const upsert = useMutation({
    mutationFn: () => api.put('/api/v1/business-info/policies', { kind, title, content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['policies'] });
      toast.success('Policy saved');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/business-info/policies/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['policies'] }),
  });

  // Pre-fill from existing policy of same kind.
  useEffect(() => {
    const existing = list.data?.data.find((p) => p.kind === kind);
    if (existing) {
      setTitle(existing.title);
      setContent(existing.content);
    } else {
      setTitle('');
      setContent('');
    }
  }, [kind, list.data]);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Edit policy</CardTitle>
          <CardDescription>One policy per kind. Saving replaces the existing one.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as PolicyKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POLICY_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Return policy" />
          </div>
          <div className="space-y-1.5">
            <Label>Content</Label>
            <MarkdownEditor
              rows={10}
              value={content}
              placeholder="Use the toolbar for formatting. Stored as markdown."
              onChange={setContent}
            />
          </div>
          <Button onClick={() => upsert.mutate()} loading={upsert.isPending} disabled={!title || !content}>
            <Save className="size-4" /> Save policy
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Existing</CardTitle>
        </CardHeader>
        <CardContent>
          {list.data?.data.length === 0 ? (
            <p className="text-sm text-foreground-muted">No policies yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {list.data?.data.map((p) => (
                <li key={p.id} className="flex items-start justify-between py-3">
                  <div>
                    <p className="text-sm font-medium">{p.title}</p>
                    <Badge variant="muted">{p.kind}</Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete"
                    onClick={async () => {
                      if (
                        await confirmDialog({
                          title: 'Delete this policy?',
                          confirmLabel: 'Delete policy',
                          destructive: true,
                        })
                      ) {
                        remove.mutate(p.id);
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- booking form ---------------------------------------------------
const BOOKING_FIELD_TYPES = ['text', 'email', 'phone', 'date', 'time', 'number', 'long_text'] as const;
type BookingFieldType = (typeof BOOKING_FIELD_TYPES)[number];

interface BookingFieldDraft {
  key: string;
  label: string;
  type: BookingFieldType;
  required: boolean;
}

interface BookingFormDraft {
  enabled: boolean;
  title: string;
  intentKeywords: string[];
  fields: BookingFieldDraft[];
}

function defaultBookingForm(): BookingFormDraft {
  return {
    enabled: false,
    title: 'Book a consultation',
    intentKeywords: ['book', 'appointment', 'consultation', 'reserve', 'schedule'],
    fields: [
      { key: 'name', label: 'Full name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'email', required: true },
      { key: 'date', label: 'Preferred date', type: 'date', required: true },
      { key: 'notes', label: 'Anything else?', type: 'long_text', required: false },
    ],
  };
}

function BookingFormPanel() {
  const queryClient = useQueryClient();
  const infoQuery = useQuery({
    queryKey: ['business-info'],
    queryFn: () => api.get<{ data: BusinessInfoDto | null }>('/api/v1/business-info'),
  });

  const [draft, setDraft] = useState<BookingFormDraft>(defaultBookingForm());
  const [keywordsInput, setKeywordsInput] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!infoQuery.data || loaded) return;
    const incoming = (infoQuery.data.data as { bookingForm?: BookingFormDraft } | null)
      ?.bookingForm;
    if (incoming && Array.isArray(incoming.fields)) {
      setDraft({
        enabled: !!incoming.enabled,
        title: incoming.title || 'Book a consultation',
        intentKeywords: incoming.intentKeywords ?? [],
        fields: incoming.fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: (BOOKING_FIELD_TYPES as readonly string[]).includes(f.type)
            ? (f.type as BookingFieldType)
            : 'text',
          required: f.required !== false,
        })),
      });
      setKeywordsInput((incoming.intentKeywords ?? []).join(', '));
    } else {
      const d = defaultBookingForm();
      setDraft(d);
      setKeywordsInput(d.intentKeywords.join(', '));
    }
    setLoaded(true);
  }, [infoQuery.data, loaded]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/business-info', {
        bookingForm: {
          enabled: draft.enabled,
          title: draft.title.trim() || 'Booking',
          intentKeywords: keywordsInput
            .split(/[,\n]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          fields: draft.fields,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-info'] });
      toast.success('Booking form saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  const setField = (i: number, patch: Partial<BookingFieldDraft>) => {
    setDraft((d) => {
      const next = [...d.fields];
      next[i] = { ...next[i]!, ...patch };
      return { ...d, fields: next };
    });
  };

  const addField = () => {
    setDraft((d) => ({
      ...d,
      fields: [
        ...d.fields,
        { key: `field_${d.fields.length + 1}`, label: '', type: 'text', required: true },
      ],
    }));
  };

  const removeField = (i: number) => {
    setDraft((d) => ({ ...d, fields: d.fields.filter((_, idx) => idx !== i) }));
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Booking form</CardTitle>
          <CardDescription>
            Configure the fields the AI chatbot asks for when a customer wants to book a meeting,
            consultation, or appointment. Each completed booking lands on the{' '}
            <a className="text-brand-600 hover:underline" href="/bookings">
              /bookings
            </a>{' '}
            page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 size-4 accent-brand-600"
              checked={draft.enabled}
              onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
            />
            <div className="text-sm">
              <p className="font-medium">Enable booking flow</p>
              <p className="text-xs text-foreground-muted">
                When on, the AI will offer to collect these fields when a customer asks to book.
              </p>
            </div>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Title (shown in the prompt + on /bookings)</Label>
              <Input
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                placeholder="Book a consultation"
              />
            </div>
            <div>
              <Label>Trigger keywords (comma-separated)</Label>
              <Input
                value={keywordsInput}
                onChange={(e) => setKeywordsInput(e.target.value)}
                placeholder="book, appointment, consultation, reserve"
              />
              <p className="mt-1 text-xs text-foreground-muted">
                The AI starts the booking flow when the customer's message matches one of these.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Fields to collect</Label>
              <Button size="sm" variant="ghost" onClick={addField}>
                <Plus className="mr-1 size-4" /> Add field
              </Button>
            </div>
            {draft.fields.length === 0 ? (
              <p className="rounded border border-dashed border-border bg-surface-muted/40 p-4 text-center text-xs italic text-foreground-muted">
                No fields yet. Add at least one to enable the flow.
              </p>
            ) : (
              <div className="space-y-2">
                {draft.fields.map((f, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-1 gap-2 rounded border border-border bg-surface p-3 sm:grid-cols-[1fr_1.5fr_140px_120px_36px]"
                  >
                    <Input
                      placeholder="key (e.g. name)"
                      value={f.key}
                      onChange={(e) =>
                        setField(i, {
                          key: e.target.value
                            .replace(/[^a-z0-9_]/gi, '_')
                            .toLowerCase()
                            .slice(0, 60),
                        })
                      }
                    />
                    <Input
                      placeholder="Label shown to the customer"
                      value={f.label}
                      onChange={(e) => setField(i, { label: e.target.value.slice(0, 120) })}
                    />
                    <Select
                      value={f.type}
                      onValueChange={(v) => setField(i, { type: v as BookingFieldType })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BOOKING_FIELD_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        className="size-4 accent-brand-600"
                        checked={f.required}
                        onChange={(e) => setField(i, { required: e.target.checked })}
                      />
                      Required
                    </label>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => removeField(i)}
                      aria-label="Remove field"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              <Save className="mr-2 size-4" /> Save booking form
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
