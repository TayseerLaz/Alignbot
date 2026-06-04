'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, ListChecks, X } from 'lucide-react';
import Link from 'next/link';

import { cn } from '@/lib/utils';
import { getOnboardingChecklist } from '@/lib/dashboard-api';

import { useEditMode } from '../edit-mode-context';

// Onboarding banner has TWO independent dismiss paths per spec:
//   1) Edit mode's KEEP/ADD toggle (removes it from the layout entirely)
//   2) The X button on the banner itself (hides it for this user even
//      if the widget stays in their layout — they may still want it
//      back later but don't want it nagging today)
// Both states persist in localStorage so the next visit honours them.

export function OnboardingChecklistWidget() {
  const { editing, layout } = useEditMode();
  const q = useQuery({
    queryKey: ['dashboard', 'onboarding'],
    queryFn: getOnboardingChecklist,
    staleTime: 60_000,
  });

  if (layout.onboardingDismissed && !editing) return null;

  if (q.isLoading) {
    return (
      <div className="h-[80px] animate-pulse rounded-lg border-2 border-dashed border-brand-200 bg-brand-50/40" />
    );
  }
  if (q.isError || !q.data) return null;

  const { steps, complete } = q.data;
  if (complete && !editing) return null; // spec: "Only show when onboarding is incomplete"

  return (
    <div
      role="region"
      aria-label="Getting-started checklist"
      className="relative flex flex-col gap-3 rounded-lg border-2 border-dashed border-brand-200 bg-brand-50/40 p-4 sm:flex-row sm:items-center"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ListChecks className="size-5 text-brand-500" aria-hidden />
        <span>Getting-started checklist:</span>
      </div>
      <ol className="flex flex-1 flex-wrap items-center gap-x-1 gap-y-2 text-sm">
        {steps.map((step, i) => (
          <li key={step.id} className="flex items-center gap-1.5">
            {i > 0 ? <span className="text-foreground-subtle" aria-hidden>→</span> : null}
            <Link
              href={step.href}
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition hover:bg-brand-100',
                step.completed
                  ? 'text-emerald-700 line-through decoration-emerald-300'
                  : 'text-foreground',
              )}
              aria-label={`${step.label} — ${step.completed ? 'done' : 'not done'}`}
            >
              {step.completed ? (
                <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden />
              ) : (
                <Circle className="size-3.5 text-foreground-subtle" aria-hidden />
              )}
              {step.label}
            </Link>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2">
        {editing ? (
          <button
            type="button"
            onClick={() => layout.remove('onboarding')}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 transition hover:bg-emerald-200"
            aria-label="Remove onboarding checklist widget"
          >
            KEEP <X className="size-3" aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => layout.dismissOnboarding()}
          className="inline-flex items-center gap-1 rounded-full p-1 text-foreground-subtle hover:bg-brand-100 hover:text-foreground"
          aria-label="Hide getting-started checklist"
          title="Hide"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

