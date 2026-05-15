'use client';

import { Building2, ChevronsUpDown, LogOut, Settings, User } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSession } from '@/lib/session';
import { fullName, initials } from '@/lib/utils';

import { ThemeToggle } from '../theme-toggle';

import { NotificationsBell } from './notifications-bell';

export function TopBar() {
  const { session, signOut, switchOrg } = useSession();
  if (!session) return null;

  const { user, organization, availableOrganizations } = session;

  return (
    <div className="flex flex-1 items-center justify-between gap-3">
      {/* Org switcher */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-2 px-2 text-sm">
            <Building2 className="size-4 text-foreground-muted" />
            <span className="font-medium">{organization.name}</span>
            <span className="hidden text-xs text-foreground-subtle sm:inline">
              {organization.role}
            </span>
            <ChevronsUpDown className="size-3.5 text-foreground-subtle" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-64">
          <DropdownMenuLabel>Switch organization</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {availableOrganizations.map((org) => (
            <DropdownMenuItem
              key={org.id}
              disabled={org.id === organization.id}
              onSelect={async () => {
                if (org.id === organization.id) return;
                try {
                  await switchOrg(org.id);
                  toast.success(`Switched to ${org.name}`);
                } catch {
                  toast.error('Could not switch organization.');
                }
              }}
            >
              <div className="flex flex-1 items-center justify-between">
                <span>{org.name}</span>
                <span className="text-xs text-foreground-subtle">{org.role}</span>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex items-center gap-1">
        <ThemeToggle />
        <NotificationsBell />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2 px-1.5">
              <Avatar className="size-7">
                <AvatarFallback>{initials(user.firstName, user.lastName, user.email)}</AvatarFallback>
              </Avatar>
              <span className="hidden text-sm font-medium sm:inline">
                {fullName(user.firstName, user.lastName, user.email)}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>
              <div className="flex flex-col">
                <span className="font-medium">{fullName(user.firstName, user.lastName, user.email)}</span>
                <span className="text-xs font-normal text-foreground-subtle">{user.email}</span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings/profile">
                <User className="size-4" />
                Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <Settings className="size-4" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()}>
              <LogOut className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
