'use client';

import {
  type CreateBroadcastBody,
  type VariableMapping,
  type VariableSource,
} from '@aligned/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ChevronLeft, Send } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, getAccessToken } from '@/lib/api';

interface Template {
  id: string;
  name: string;
  language: string;
  category: string;
  bodyText: string;
  status: string;
}

interface Channel {
  id: string;
  displayPhoneNumber: string | null;
  isActive: boolean;
}

type AudienceKind = 'contacts' | 'csv' | 'tags' | 'manual';

const STEPS = ['Basics', 'Audience', 'Personalization', 'Review'] as const;

// Extract {{1}}, {{2}}, ... from a template body. Returns sorted unique indices.
function extractTemplateParams(body: string): number[] {
  const matches = body.matchAll(/\{\{(\d+)\}\}/g);
  const set = new Set<number>();
  for (const m of matches) set.add(Number(m[1]));
  return [...set].sort((a, b) => a - b);
}

export default function NewBroadcastPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);

  // Step 1 state
  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState<string | null>(null);
  const [variantATemplateId, setVariantATemplateId] = useState<string | null>(null);
  const [abTest, setAbTest] = useState(false);
  const [variantBTemplateId, setVariantBTemplateId] = useState<string | null>(null);

  // Step 2 state
  const [audienceKind, setAudienceKind] = useState<AudienceKind>('manual');
  const [csvAssetId, setCsvAssetId] = useState<string | null>(null);
  const [csvFilename, setCsvFilename] = useState<string | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  // Tag-based audience: list of tag strings + OR/AND mode.
  const [tagAudience, setTagAudience] = useState<string[]>([]);
  const [tagAudienceMode, setTagAudienceMode] = useState<'any' | 'all'>('any');
  const [manualPhonesRaw, setManualPhonesRaw] = useState('');
  // Contacts audience: pick from the saved contact list (select all, or some).
  const [contactSearch, setContactSearch] = useState('');
  const [selectAllContacts, setSelectAllContacts] = useState(false);
  // id → phone/name, so selections persist across searches and we have the
  // phone to send (resolved to manualPhones on submit).
  const [selectedContacts, setSelectedContacts] = useState<
    Map<string, { phone: string; name: string | null }>
  >(new Map());

  // Step 3 state
  const [variantAVariables, setVariantAVariables] = useState<VariableMapping>({});
  const [variantBVariables, setVariantBVariables] = useState<VariableMapping>({});

  // Step 4
  const [scheduleLater, setScheduleLater] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');

  // Data
  const channelsQuery = useQuery({
    queryKey: ['whatsapp-channel'],
    queryFn: () => api.get<{ data: Channel }>('/api/v1/whatsapp'),
  });

  useEffect(() => {
    if (channelsQuery.data?.data.id && !channelId) setChannelId(channelsQuery.data.data.id);
  }, [channelsQuery.data, channelId]);

  const templatesQuery = useQuery({
    queryKey: ['whatsapp-templates'],
    queryFn: () => api.get<{ data: Template[] }>('/api/v1/whatsapp/templates'),
  });
  const approvedTemplates = useMemo(
    () => (templatesQuery.data?.data ?? []).filter((t) => t.status === 'approved'),
    [templatesQuery.data],
  );

  // Tag buckets shown by /api/v1/contacts/tags — `{ tag, count }`.
  const tagBucketsQuery = useQuery({
    queryKey: ['contacts', 'tags'],
    queryFn: () => api.get<{ data: { tag: string; count: number }[] }>('/api/v1/contacts/tags'),
  });

  // Contacts picker — first 100 matching the search box (for "select some").
  const contactsPickerQuery = useQuery({
    queryKey: ['contacts', 'picker', contactSearch],
    queryFn: () =>
      api.get<{ data: { id: string; phoneE164: string; displayName: string | null }[] }>(
        `/api/v1/contacts?limit=100${
          contactSearch.trim() ? `&search=${encodeURIComponent(contactSearch.trim())}` : ''
        }`,
      ),
    enabled: audienceKind === 'contacts',
  });
  const toggleContact = (c: { id: string; phoneE164: string; displayName: string | null }) =>
    setSelectedContacts((prev) => {
      const next = new Map(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.set(c.id, { phone: c.phoneE164, name: c.displayName });
      return next;
    });

  const variantATemplate = approvedTemplates.find((t) => t.id === variantATemplateId);
  const variantBTemplate = approvedTemplates.find((t) => t.id === variantBTemplateId);
  const paramsA = variantATemplate ? extractTemplateParams(variantATemplate.bodyText) : [];
  const paramsB = variantBTemplate ? extractTemplateParams(variantBTemplate.bodyText) : [];

  // Wipe variable mapping if template changes.
  useEffect(() => {
    setVariantAVariables({});
  }, [variantATemplateId]);
  useEffect(() => {
    setVariantBVariables({});
  }, [variantBTemplateId]);

  const sendMutation = useMutation({
    mutationFn: async () => {
      // The "contacts" picker resolves to a manual phone list: either every
      // matching contact ("select all", fetched from /contacts/phones) or just
      // the ticked ones. The backend has no 'contacts' kind, so we send 'manual'.
      let manualPhones: string[] | undefined;
      // 'contacts' is a UI-only audience; it always sends a resolved manual list.
      const effectiveKind: CreateBroadcastBody['audienceKind'] =
        audienceKind === 'contacts' ? 'manual' : audienceKind;
      if (audienceKind === 'manual') {
        manualPhones = manualPhonesRaw
          .split(/[\n,;]/)
          .map((p) => p.trim())
          .filter(Boolean);
      } else if (audienceKind === 'contacts') {
        if (selectAllContacts) {
          const res = await api.get<{ data: string[] }>(
            `/api/v1/contacts/phones${
              contactSearch.trim() ? `?search=${encodeURIComponent(contactSearch.trim())}` : ''
            }`,
          );
          manualPhones = res.data;
        } else {
          // Only real phone numbers — IG/Messenger contacts store a PSID here.
          manualPhones = [...selectedContacts.values()]
            .map((v) => v.phone)
            .filter((p) => p.startsWith('+'));
        }
      }
      const body: CreateBroadcastBody = {
        name,
        channelId: channelId!,
        audienceKind: effectiveKind,
        csvAssetId: audienceKind === 'csv' ? csvAssetId ?? undefined : undefined,
        audienceTags: audienceKind === 'tags' ? tagAudience : undefined,
        audienceTagsMode: audienceKind === 'tags' ? tagAudienceMode : undefined,
        manualPhones,
        abTest,
        variantATemplateId: variantATemplateId!,
        variantBTemplateId: abTest ? variantBTemplateId ?? undefined : undefined,
        variantAVariables,
        variantBVariables: abTest ? variantBVariables : undefined,
      };
      const created = await api.post<{ data: { id: string } }>('/api/v1/broadcasts', body);
      const sendBody = scheduleLater && scheduleAt
        ? { scheduledFor: new Date(scheduleAt).toISOString() }
        : {};
      await api.post(`/api/v1/broadcasts/${created.data.id}/send`, sendBody);
      return created.data.id;
    },
    onSuccess: (id) => {
      toast.success('Broadcast queued');
      router.push(`/broadcasts/${id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Send failed'),
  });

  // ---- Validation per step
  const canAdvance = useMemo(() => {
    if (step === 0) {
      return Boolean(name && channelId && variantATemplateId && (!abTest || variantBTemplateId));
    }
    if (step === 1) {
      if (audienceKind === 'csv') return Boolean(csvAssetId);
      if (audienceKind === 'tags') return tagAudience.length > 0;
      if (audienceKind === 'contacts') return selectAllContacts || selectedContacts.size > 0;
      return manualPhonesRaw.split(/[\n,;]/).filter((p) => p.trim()).length > 0;
    }
    if (step === 2) {
      return paramsA.every((p) => variantAVariables[String(p)]) &&
        (!abTest || paramsB.every((p) => variantBVariables[String(p)]));
    }
    return true;
  }, [
    step,
    name,
    channelId,
    variantATemplateId,
    abTest,
    variantBTemplateId,
    audienceKind,
    csvAssetId,
    tagAudience,
    manualPhonesRaw,
    selectAllContacts,
    selectedContacts,
    paramsA,
    paramsB,
    variantAVariables,
    variantBVariables,
  ]);

  return (
    <>
      <PageHeader
        title="New broadcast"
        description={`Step ${step + 1} of ${STEPS.length} — ${STEPS[step]}`}
        actions={
          <Link href="/broadcasts">
            <Button variant="ghost">
              <ChevronLeft className="size-4" /> Back to list
            </Button>
          </Link>
        }
      />

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-sm">
        {STEPS.map((s, idx) => (
          <div
            key={s}
            className={`flex items-center gap-2 rounded px-3 py-1 ${
              idx === step
                ? 'bg-primary text-primary-foreground'
                : idx < step
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-surface-muted text-foreground-muted'
            }`}
          >
            <span className="font-mono text-xs">{idx + 1}</span> {s}
          </div>
        ))}
      </div>

      {step === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Basics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Campaign name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring sale" />
            </div>
            <div>
              <Label>Channel</Label>
              <Input
                disabled
                value={channelsQuery.data?.data.displayPhoneNumber ?? 'Loading…'}
                className="font-mono text-sm"
              />
            </div>
            <div>
              <Label>Template (variant A)</Label>
              <Select value={variantATemplateId ?? ''} onValueChange={(v) => setVariantATemplateId(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick an approved template…" />
                </SelectTrigger>
                <SelectContent>
                  {approvedTemplates.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-foreground-muted">
                      No approved templates. Create + submit one first.
                    </div>
                  ) : null}
                  {approvedTemplates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} <span className="ml-1 text-xs text-foreground-subtle">· {t.language} · {t.category}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {variantATemplate ? (
                <pre className="mt-2 max-h-32 overflow-y-auto rounded bg-surface-muted p-3 text-xs">
                  {variantATemplate.bodyText}
                </pre>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <input
                id="abtest"
                type="checkbox"
                checked={abTest}
                onChange={(e) => setAbTest(e.target.checked)}
              />
              <Label htmlFor="abtest" className="cursor-pointer">A/B test (split 50/50)</Label>
            </div>

            {abTest ? (
              <div>
                <Label>Template (variant B)</Label>
                <Select
                  value={variantBTemplateId ?? ''}
                  onValueChange={(v) => setVariantBTemplateId(v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick variant B template…" />
                  </SelectTrigger>
                  <SelectContent>
                    {approvedTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {variantBTemplate ? (
                  <pre className="mt-2 max-h-32 overflow-y-auto rounded bg-surface-muted p-3 text-xs">
                    {variantBTemplate.bodyText}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>Audience</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              {(['contacts', 'tags', 'csv', 'manual'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setAudienceKind(k)}
                  className={`flex-1 rounded border px-4 py-3 text-center text-sm ${
                    audienceKind === k
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:bg-surface-muted'
                  }`}
                >
                  <div className="font-medium capitalize">{k}</div>
                  <div className="text-xs text-foreground-muted">
                    {k === 'contacts'
                      ? 'Select from contacts'
                      : k === 'manual'
                        ? 'Paste phone numbers'
                        : k === 'csv'
                          ? 'Upload a CSV'
                          : 'Pick contact tags'}
                  </div>
                </button>
              ))}
            </div>

            {audienceKind === 'contacts' ? (
              <div className="space-y-3">
                <label className="flex items-center gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={selectAllContacts}
                    onChange={(e) => setSelectAllContacts(e.target.checked)}
                  />
                  <span className="font-medium">Select ALL contacts</span>
                  <span className="text-xs text-foreground-muted">
                    {contactSearch.trim()
                      ? '(all contacts matching the search below)'
                      : '(everyone in your contact list)'}
                  </span>
                </label>

                {!selectAllContacts ? (
                  <>
                    <Input
                      placeholder="Search contacts by name or number…"
                      value={contactSearch}
                      onChange={(e) => setContactSearch(e.target.value)}
                    />
                    <div className="max-h-72 overflow-y-auto rounded-md border border-border divide-y divide-border">
                      {contactsPickerQuery.isLoading ? (
                        <div className="space-y-2 p-3">
                          <Skeleton className="h-4 w-3/4" />
                          <Skeleton className="h-4 w-2/3" />
                          <Skeleton className="h-4 w-4/5" />
                        </div>
                      ) : (contactsPickerQuery.data?.data ?? []).filter((c) =>
                          c.phoneE164.startsWith('+'),
                        ).length === 0 ? (
                        <p className="p-3 text-sm italic text-foreground-muted">
                          No contacts with a phone number found. (Instagram/Messenger-only contacts
                          can't receive WhatsApp broadcasts.)
                        </p>
                      ) : (
                        (contactsPickerQuery.data?.data ?? [])
                          .filter((c) => c.phoneE164.startsWith('+'))
                          .map((c) => (
                          <label
                            key={c.id}
                            className="flex cursor-pointer items-center gap-3 p-2.5 text-sm hover:bg-surface-muted/50"
                          >
                            <input
                              type="checkbox"
                              className="size-4"
                              checked={selectedContacts.has(c.id)}
                              onChange={() => toggleContact(c)}
                            />
                            <span className="min-w-0 flex-1 truncate">
                              {c.displayName || c.phoneE164}
                            </span>
                            <span className="font-mono text-xs text-foreground-muted">
                              {c.phoneE164}
                            </span>
                          </label>
                        ))
                      )}
                    </div>
                    <p className="text-xs text-foreground-muted">
                      {selectedContacts.size} contact{selectedContacts.size === 1 ? '' : 's'} selected
                      {contactsPickerQuery.data?.data.length === 100
                        ? ' · showing first 100 — use search to narrow, or pick “Select ALL contacts”.'
                        : ''}
                    </p>
                  </>
                ) : (
                  <p className="rounded-md border border-dashed border-border bg-surface-muted/40 p-3 text-xs text-foreground-muted">
                    Every matching contact will receive this broadcast (opted-out contacts are
                    automatically skipped at send time). You can narrow with a search by unticking
                    “Select ALL contacts”.
                  </p>
                )}
              </div>
            ) : null}

            {audienceKind === 'manual' ? (
              <div>
                <Label>Phone numbers (one per line, E.164)</Label>
                <Textarea
                  rows={8}
                  value={manualPhonesRaw}
                  onChange={(e) => setManualPhonesRaw(e.target.value)}
                  placeholder="+14155551234&#10;+14155555678"
                  className="font-mono text-sm"
                />
                <p className="mt-1 text-xs text-foreground-muted">
                  {manualPhonesRaw.split(/[\n,;]/).filter((p) => p.trim()).length} numbers entered
                </p>
              </div>
            ) : null}

            {audienceKind === 'csv' ? (
              <CsvAudienceStep
                onPicked={(assetId, filename, headers) => {
                  setCsvAssetId(assetId);
                  setCsvFilename(filename);
                  setCsvHeaders(headers);
                }}
                currentFilename={csvFilename}
              />
            ) : null}

            {audienceKind === 'tags' ? (
              <div className="space-y-3">
                <div>
                  <Label>Tags</Label>
                  <p className="mt-0.5 text-xs text-foreground-muted">
                    Send to every contact carrying the selected tag(s). Tags are added in the
                    inbox or on the contact list.
                  </p>
                </div>
                {(tagBucketsQuery.data?.data ?? []).length === 0 ? (
                  <p className="rounded-md border border-dashed border-border bg-surface-muted/40 p-3 text-xs italic text-foreground-muted">
                    No tags yet. Add tags in the inbox or on the contact list, then come back.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {(tagBucketsQuery.data?.data ?? []).map((t) => {
                      const on = tagAudience.includes(t.tag);
                      return (
                        <button
                          key={t.tag}
                          type="button"
                          onClick={() =>
                            setTagAudience((prev) =>
                              on ? prev.filter((x) => x !== t.tag) : [...prev, t.tag],
                            )
                          }
                          className={`rounded-full border px-3 py-1 text-xs ${
                            on
                              ? 'border-brand-400 bg-brand-50 text-brand-700'
                              : 'border-border bg-surface text-foreground hover:bg-surface-muted'
                          }`}
                        >
                          {t.tag}{' '}
                          <span className="opacity-60">({t.count})</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {tagAudience.length > 1 ? (
                  <div className="flex items-center gap-2 rounded-md border border-border bg-surface-muted/40 px-3 py-2 text-xs">
                    <span className="font-medium">Match:</span>
                    <button
                      type="button"
                      onClick={() => setTagAudienceMode('any')}
                      className={`rounded px-2 py-1 ${
                        tagAudienceMode === 'any'
                          ? 'bg-brand-50 font-medium text-brand-700'
                          : 'text-foreground-muted hover:text-foreground'
                      }`}
                    >
                      Any of these tags
                    </button>
                    <button
                      type="button"
                      onClick={() => setTagAudienceMode('all')}
                      className={`rounded px-2 py-1 ${
                        tagAudienceMode === 'all'
                          ? 'bg-brand-50 font-medium text-brand-700'
                          : 'text-foreground-muted hover:text-foreground'
                      }`}
                    >
                      All of these tags
                    </button>
                  </div>
                ) : null}
                {tagAudience.length > 0 ? (
                  <p className="text-xs text-foreground-muted">
                    Selected:{' '}
                    <span className="font-mono">{tagAudience.join(', ')}</span>
                    {tagAudience.length > 1 ? (
                      <>
                        {' · matching '}
                        <span className="font-medium">
                          {tagAudienceMode === 'all' ? 'all tags' : 'any tag'}
                        </span>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card>
          <CardHeader>
            <CardTitle>Personalization</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {paramsA.length === 0 ? (
              <p className="text-sm text-foreground-muted">
                Variant A template has no variables. Nothing to map here.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm font-medium">Variant A · {variantATemplate?.name}</p>
                {paramsA.map((p) => (
                  <VariableRow
                    key={`a-${p}`}
                    paramIndex={p}
                    audienceKind={audienceKind}
                    csvHeaders={csvHeaders}
                    value={variantAVariables[String(p)]}
                    onChange={(src) =>
                      setVariantAVariables((prev) => ({ ...prev, [String(p)]: src }))
                    }
                  />
                ))}
              </div>
            )}
            {abTest && variantBTemplate ? (
              <div className="space-y-3 border-t border-border pt-4">
                <p className="text-sm font-medium">Variant B · {variantBTemplate.name}</p>
                {paramsB.map((p) => (
                  <VariableRow
                    key={`b-${p}`}
                    paramIndex={p}
                    audienceKind={audienceKind}
                    csvHeaders={csvHeaders}
                    value={variantBVariables[String(p)]}
                    onChange={(src) =>
                      setVariantBVariables((prev) => ({ ...prev, [String(p)]: src }))
                    }
                  />
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card>
          <CardHeader>
            <CardTitle>Review &amp; send</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <SummaryRow label="Name" value={name} />
            <SummaryRow
              label="Template"
              value={`${variantATemplate?.name ?? ''} (${variantATemplate?.language ?? ''})`}
            />
            <SummaryRow label="A/B test" value={abTest ? 'Yes — split 50/50' : 'No'} />
            <SummaryRow label="Audience" value={audienceKind} />
            {audienceKind === 'manual' ? (
              <SummaryRow
                label="Recipients"
                value={`${manualPhonesRaw.split(/[\n,;]/).filter((p) => p.trim()).length} numbers`}
              />
            ) : null}
            {audienceKind === 'csv' && csvFilename ? (
              <SummaryRow label="CSV" value={csvFilename} />
            ) : null}

            <div className="border-t border-border pt-4">
              <div className="flex items-center gap-2">
                <input
                  id="schedule"
                  type="checkbox"
                  checked={scheduleLater}
                  onChange={(e) => setScheduleLater(e.target.checked)}
                />
                <Label htmlFor="schedule" className="cursor-pointer">Schedule for later</Label>
              </div>
              {scheduleLater ? (
                <Input
                  type="datetime-local"
                  value={scheduleAt}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  className="mt-2 max-w-xs"
                />
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Wizard nav */}
      <div className="flex justify-between">
        <Button
          variant="ghost"
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
        >
          <ArrowLeft className="size-4" /> Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button disabled={!canAdvance} onClick={() => setStep((s) => s + 1)}>
            Next <ArrowRight className="size-4" />
          </Button>
        ) : (
          <Button
            disabled={sendMutation.isPending}
            onClick={() => {
              const phrase = scheduleLater ? 'Schedule this broadcast?' : 'Send this broadcast now?';
              if (window.confirm(phrase)) sendMutation.mutate();
            }}
          >
            <Send className="size-4" />{' '}
            {sendMutation.isPending ? 'Submitting…' : scheduleLater ? 'Schedule' : 'Send now'}
          </Button>
        )}
      </div>
    </>
  );
}

// ---------- Variable row -------------------------------------------------
function VariableRow({
  paramIndex,
  audienceKind,
  csvHeaders,
  value,
  onChange,
}: {
  paramIndex: number;
  audienceKind: AudienceKind;
  csvHeaders: string[];
  value: VariableSource | undefined;
  onChange: (src: VariableSource) => void;
}) {
  const kind = value?.kind ?? 'static';
  return (
    <div className="grid grid-cols-12 items-center gap-2 text-sm">
      <div className="col-span-1 font-mono text-foreground-muted">{`{{${paramIndex}}}`}</div>
      <div className="col-span-3">
        <Select
          value={kind}
          onValueChange={(v) => {
            if (v === 'static') onChange({ kind: 'static', value: '' });
            else if (v === 'csv') onChange({ kind: 'csv', column: csvHeaders[0] ?? '' });
            else if (v === 'attribute') onChange({ kind: 'attribute', key: '', fallback: '' });
            else if (v === 'field')
              onChange({ kind: 'field', field: 'display_name', fallback: '' });
          }}
        >
          <SelectTrigger className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="static">Static value</SelectItem>
            {audienceKind === 'csv' ? <SelectItem value="csv">CSV column</SelectItem> : null}
            <SelectItem value="attribute">Contact attribute</SelectItem>
            <SelectItem value="field">Contact field</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="col-span-8">
        {value?.kind === 'static' ? (
          <Input
            value={value.value}
            onChange={(e) => onChange({ kind: 'static', value: e.target.value })}
            placeholder="Hello!"
          />
        ) : value?.kind === 'csv' ? (
          <Select
            value={value.column}
            onValueChange={(v) => onChange({ kind: 'csv', column: v })}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {csvHeaders.map((h) => (
                <SelectItem key={h} value={h}>
                  {h}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : value?.kind === 'attribute' ? (
          <div className="flex gap-2">
            <Input
              value={value.key}
              onChange={(e) => onChange({ kind: 'attribute', key: e.target.value, fallback: value.fallback })}
              placeholder="attribute key (e.g. first_name)"
            />
            <Input
              value={value.fallback ?? ''}
              onChange={(e) =>
                onChange({ kind: 'attribute', key: value.key, fallback: e.target.value })
              }
              placeholder="fallback (optional)"
              className="w-40"
            />
          </div>
        ) : value?.kind === 'field' ? (
          <Select
            value={value.field}
            onValueChange={(v) =>
              onChange({
                kind: 'field',
                field: v as 'display_name' | 'phone_e164' | 'locale',
                fallback: value.fallback,
              })
            }
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="display_name">Display name</SelectItem>
              <SelectItem value="phone_e164">Phone</SelectItem>
              <SelectItem value="locale">Locale</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
      </div>
    </div>
  );
}

// ---------- CSV upload step ------------------------------------------------
function CsvAudienceStep({
  onPicked,
  currentFilename,
}: {
  onPicked: (assetId: string, filename: string, headers: string[]) => void;
  currentFilename: string | null;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/assets/upload-csv`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
          body: fd,
          credentials: 'include',
        },
      );
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { data: { assetId: string; filename: string } };
      // Quick header parse via FileReader (saves a roundtrip).
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? '');
        const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
        const headers = firstLine
          .split(',')
          .map((s) => s.trim().replace(/^"|"$/g, ''))
          .filter(Boolean);
        onPicked(data.data.assetId, data.data.filename, headers);
        toast.success(`Uploaded — ${headers.length} columns detected`);
      };
      reader.readAsText(file.slice(0, 8192));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <Input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <Button onClick={submit} disabled={!file || busy}>
        {busy ? 'Uploading…' : 'Upload CSV'}
      </Button>
      {currentFilename ? (
        <p className="text-sm text-foreground-muted">Uploaded: {currentFilename}</p>
      ) : null}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-border py-2 text-sm">
      <span className="text-foreground-muted">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
