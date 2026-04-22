'use client';

import type { NotificationDto } from '@aligned/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Bell,
  CheckCheck,
  CheckCircle2,
  Info,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

const SEVERITY_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertCircle,
  error: XCircle,
} as const;

const SEVERITY_TEXT = {
  info: 'text-foreground-muted',
  success: 'text-emerald-600',
  warning: 'text-amber-600',
  error: 'text-red-600',
} as const;

export function NotificationsBell() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['notifications'],
    queryFn: () =>
      api.get<{ data: NotificationDto[]; unreadCount: number }>('/api/v1/notifications?limit=20'),
    refetchInterval: 30_000,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/notifications/${id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markAll = useMutation({
    mutationFn: () => api.post('/api/v1/notifications/read-all'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const unread = list.data?.unreadCount ?? 0;
  const items = list.data?.data ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Notifications" className="relative">
          <Bell className="size-4" />
          {unread > 0 ? (
            <span
              aria-hidden
              className="absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96 max-w-[95vw]">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Notifications</span>
          {unread > 0 ? (
            <button
              type="button"
              onClick={() => markAll.mutate()}
              className="inline-flex items-center gap-1 text-xs text-brand-500 hover:underline"
            >
              <CheckCheck className="size-3.5" /> Mark all read
            </button>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-foreground-muted">
            You're all caught up.
          </p>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {items.map((n) => {
              const Icon = SEVERITY_ICON[n.severity];
              const Body = (
                <div className={cn('flex gap-3 px-3 py-2.5', !n.isRead && 'bg-brand-50/40')}>
                  <Icon className={cn('mt-0.5 size-4 shrink-0', SEVERITY_TEXT[n.severity])} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm">{n.title}</p>
                    {n.body ? (
                      <p className="mt-0.5 text-xs text-foreground-muted">{n.body}</p>
                    ) : null}
                    <p className="mt-1 text-[10px] uppercase tracking-wide text-foreground-subtle">
                      {formatRelative(n.createdAt)}
                    </p>
                  </div>
                </div>
              );
              return (
                <li
                  key={n.id}
                  className="border-b border-border last:border-0"
                  onClick={() => !n.isRead && markRead.mutate(n.id)}
                >
                  {n.link ? (
                    <Link href={n.link} className="block hover:bg-surface-muted/50">
                      {Body}
                    </Link>
                  ) : (
                    <div className="hover:bg-surface-muted/50">{Body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
