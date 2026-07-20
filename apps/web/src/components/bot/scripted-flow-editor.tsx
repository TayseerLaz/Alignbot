'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';

interface FlowButton {
  title: string;
  next: string;
}
interface ScriptedNode {
  text?: string;
  buttons?: FlowButton[];
  [k: string]: unknown;
}
export interface ScriptedFlowValue {
  enabled?: boolean;
  entry: string;
  nodes: Record<string, ScriptedNode>;
  [k: string]: unknown;
}

// Friendly, editable labels for the known Fatme nodes; falls back to the id.
const NODE_LABELS: Record<string, string> = {
  // S0 — welcome burst (3 bubbles sent one after another)
  s0_welcome: 'الترحيب · Welcome (bubble 1)',
  s0_team: 'شرح الفريق · Team explainer (bubble 2)',
  s0_safe: 'محفوظ وآمن · Safe & private (bubble 3)',
  // Safety check — right after the opening
  safety_check: 'فحص الأمان · Safety check (after opening)',
  // S1–S4 — one question per message
  s1_origin: 'سؤال ١: من وين · Q1: where from',
  s2_age: 'سؤال ٢: العمر · Q2: age',
  s3_how_found: 'سؤال ٣: كيف وصلتك · Q3: how found',
  s4_what_caught: 'سؤال ٤: شو لفتك · Q4: what caught you',
  // S5–S6 — thanks, then the audio + drawing task
  s5_thanks: 'شكراً · Thanks',
  s6_intro: 'تمهيد التسجيل · Audio intro (bubble 1)',
  s6_audio: 'التسجيل + مهمة الرسم · Voice note + draw prompt',
  // S8 — drawing received → handoff to Fatima
  s8_received: 'وصلتني رسمتك · Drawing received (bubble 1)',
  s8_expect: 'شو رح يصير · What happens next (bubble 2)',
  s8_wait: 'استنّيها · Wait for Fatima (handoff)',
  // Safety branch (distress diversion)
  safety: 'الأمان · Safety (distress)',
  safety_resources: 'خطوط الدعم · Support lines + handoff',
};

/**
 * Edits the MESSAGES + BUTTON LABELS of a deterministic scripted flow. The
 * branch structure (targets, actions, order) is preserved — only the wording is
 * editable, which is what a non-technical operator needs. Saves the whole flow
 * back to BotConfig.scriptedFlow.
 */
export function ScriptedFlowEditor({
  flow,
  onSaved,
}: {
  flow: ScriptedFlowValue;
  onSaved: () => void;
}) {
  const [nodes, setNodes] = useState<Record<string, ScriptedNode>>(() =>
    JSON.parse(JSON.stringify(flow.nodes ?? {})),
  );
  const [saving, setSaving] = useState(false);

  const setText = (id: string, text: string) =>
    setNodes((n) => ({ ...n, [id]: { ...n[id], text } }));
  const setBtn = (id: string, i: number, title: string) =>
    setNodes((n) => {
      const node: ScriptedNode = { ...n[id] };
      const buttons = [...(node.buttons ?? [])];
      buttons[i] = { ...buttons[i]!, title };
      node.buttons = buttons;
      return { ...n, [id]: node };
    });

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/api/v1/bot/config', { scriptedFlow: { ...flow, nodes } });
      toast.success('Flow saved — live now');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const order = Object.keys(nodes);

  return (
    <div className="space-y-3">
      {order.map((id) => {
        const node = nodes[id]!;
        const buttons = node.buttons ?? [];
        return (
          <div key={id} className="space-y-2 rounded-lg border border-border p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
              {NODE_LABELS[id] ?? id}
            </div>
            <textarea
              dir="auto"
              value={node.text ?? ''}
              onChange={(e) => setText(id, e.target.value)}
              rows={Math.min(12, Math.max(3, (node.text ?? '').split('\n').length + 1))}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm leading-relaxed outline-none focus:border-brand-400"
              placeholder="Message text…"
            />
            {buttons.length > 0 ? (
              <div className="space-y-1.5">
                <Label className="text-[11px] text-foreground-muted">Buttons (tappable)</Label>
                <div className="flex flex-wrap gap-2">
                  {buttons.map((b, i) => (
                    <input
                      key={i}
                      dir="auto"
                      value={b.title}
                      maxLength={20}
                      onChange={(e) => setBtn(id, i, e.target.value)}
                      className="rounded-full border border-border bg-surface px-3 py-1 text-xs outline-none focus:border-brand-400"
                    />
                  ))}
                </div>
                <p className="text-[10px] text-foreground-subtle">
                  Max 20 characters per button (WhatsApp limit). Editing here changes the wording
                  only, not where each button leads.
                </p>
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <Button onClick={save} loading={saving}>
          Save flow
        </Button>
        <span className="text-[11px] text-foreground-subtle">
          Edits go live immediately for new conversations.
        </span>
      </div>
    </div>
  );
}
