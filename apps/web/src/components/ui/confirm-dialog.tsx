'use client';

/**
 * Imperative confirm dialog. Replaces native window.confirm() with an in-app
 * modal that matches the rest of the UI.
 *
 * Usage:
 *   if (await confirmDialog({ title: 'Delete "Foo"?' })) {
 *     deleteFoo();
 *   }
 *
 *   if (
 *     await confirmDialog({
 *       title: 'Suspend this organisation?',
 *       body: "Members won't be able to sign in until you reactivate it.",
 *       confirmLabel: 'Suspend',
 *       destructive: true,
 *     })
 *   ) {
 *     suspend();
 *   }
 *
 * <ConfirmDialogRoot /> must be mounted once near the app root.
 */

import { useEffect, useState } from 'react';

import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

type PendingRequest = { opts: ConfirmOptions; resolve: (ok: boolean) => void };

let present: ((req: PendingRequest) => void) | null = null;
const waiting: PendingRequest[] = [];

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req: PendingRequest = { opts, resolve };
    if (present) {
      present(req);
    } else if (typeof window !== 'undefined') {
      // Root hasn't mounted yet — fall back so nothing hangs at boot.
      resolve(window.confirm(`${opts.title}${opts.body ? `\n\n${opts.body}` : ''}`));
    } else {
      resolve(false);
    }
  });
}

export function ConfirmDialogRoot() {
  const [current, setCurrent] = useState<PendingRequest | null>(null);

  useEffect(() => {
    present = (req) => {
      if (current) waiting.push(req);
      else setCurrent(req);
    };
    return () => {
      present = null;
    };
  }, [current]);

  const close = (ok: boolean) => {
    if (!current) return;
    current.resolve(ok);
    const next = waiting.shift() ?? null;
    setCurrent(next);
  };

  return (
    <Dialog
      open={!!current}
      onOpenChange={(v) => {
        if (!v) close(false);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{current?.opts.title ?? ''}</DialogTitle>
          {current?.opts.body ? (
            <DialogDescription>{current.opts.body}</DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="secondary" onClick={() => close(false)}>
            {current?.opts.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            variant={current?.opts.destructive ? 'danger' : 'primary'}
            onClick={() => close(true)}
            autoFocus
          >
            {current?.opts.confirmLabel ??
              (current?.opts.destructive ? 'Delete' : 'Confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
