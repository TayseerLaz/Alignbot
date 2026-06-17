'use client';

import { ORG_ROLE_LABELS, ORG_ROLES, type OrgRole } from '@aligned/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { fullName, initials } from '@/lib/utils';

interface Member {
  membershipId: string;
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  role: OrgRole;
  status: 'pending' | 'active' | 'disabled';
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface Invitation {
  id: string;
  email: string;
  role: OrgRole;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  invitedById: string;
  invitedByName: string | null;
  acceptedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

const STATUS_BADGE: Record<Member['status'], { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-emerald-50 text-emerald-700' },
  pending: { label: 'Pending', className: 'bg-amber-50 text-amber-700' },
  disabled: { label: 'Disabled', className: 'bg-slate-100 text-slate-600' },
};

export default function MembersPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const isAdmin = session?.organization.role === 'admin';

  const membersQuery = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<{ data: Member[] }>('/api/v1/members'),
  });

  const invitesQuery = useQuery({
    queryKey: ['invitations'],
    queryFn: () => api.get<{ data: Invitation[] }>('/api/v1/invitations'),
    enabled: isAdmin,
  });

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: OrgRole }) =>
      api.patch(`/api/v1/members/${id}/role`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members'] });
      toast.success('Role updated');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Update failed'),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/members/${id}/deactivate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members'] });
      toast.success('Member deactivated');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Deactivate failed'),
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/members/${id}/reactivate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members'] });
      toast.success('Member reactivated');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Reactivate failed'),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/members/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members'] });
      toast.success('Member removed');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Remove failed'),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/invitations/${id}/revoke`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invitations'] });
      toast.success('Invitation revoked');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Revoke failed'),
  });

  return (
    <>
      <PageHeader
        title="Members"
        description="Manage who has access to this organization and what they can do."
        actions={
          isAdmin ? (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus className="size-4" /> Invite member
            </Button>
          ) : null
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Team</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                <tr>
                  <th className="px-6 py-3">Member</th>
                  <th className="px-6 py-3">Role</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Last login</th>
                  <th className="w-12 px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {membersQuery.isLoading ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-foreground-muted">
                      Loading…
                    </td>
                  </tr>
                ) : null}

                {membersQuery.data?.data.map((m) => {
                  const badge = STATUS_BADGE[m.status];
                  const isSelf = session?.user.id === m.userId;
                  return (
                    <tr key={m.membershipId} className="border-b border-border last:border-0">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <Avatar className="size-9">
                            <AvatarFallback>{initials(m.firstName, m.lastName, m.email)}</AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium">
                              {fullName(m.firstName, m.lastName, m.email)}
                              {isSelf ? <span className="ml-2 text-xs text-foreground-subtle">(you)</span> : null}
                            </p>
                            <p className="text-xs text-foreground-subtle">{m.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {isAdmin && !isSelf ? (
                          <Select
                            value={m.role}
                            onValueChange={(role) =>
                              roleMutation.mutate({ id: m.membershipId, role: role as OrgRole })
                            }
                          >
                            <SelectTrigger className="h-8 w-32">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ORG_ROLES.map((r) => (
                                <SelectItem key={r} value={r}>
                                  {ORG_ROLE_LABELS[r]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-foreground-muted">{ORG_ROLE_LABELS[m.role]}</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${badge.className}`}>
                          {badge.label}
                        </span>
                        {!m.isActive ? (
                          <span className="ml-2 text-xs text-foreground-subtle">deactivated</span>
                        ) : null}
                      </td>
                      <td className="px-6 py-4 text-foreground-muted">
                        {m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString() : '—'}
                      </td>
                      <td className="px-6 py-4 text-right">
                        {isAdmin && !isSelf ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>Actions</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              {m.isActive ? (
                                <DropdownMenuItem
                                  onSelect={() => deactivateMutation.mutate(m.membershipId)}
                                >
                                  Deactivate
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem
                                  onSelect={() => reactivateMutation.mutate(m.membershipId)}
                                >
                                  Reactivate
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-red-600 focus:text-red-700"
                                onSelect={async () => {
                                  const confirmed = await confirmDialog({
                                    title: `Remove ${fullName(m.firstName, m.lastName, m.email)}?`,
                                    body:
                                      'They will lose access to this organization immediately and their sessions will be revoked. ' +
                                      'Their account is not deleted — you can re-invite them later.',
                                    confirmLabel: 'Remove member',
                                    destructive: true,
                                  });
                                  if (confirmed) removeMutation.mutate(m.membershipId);
                                }}
                              >
                                Remove from organization
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {isAdmin ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {invitesQuery.data?.data.filter((i) => i.status === 'pending').length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-foreground-muted">
                No pending invitations.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    <tr>
                      <th className="px-6 py-3">Email</th>
                      <th className="px-6 py-3">Role</th>
                      <th className="px-6 py-3">Invited by</th>
                      <th className="px-6 py-3">Expires</th>
                      <th className="w-12 px-6 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {invitesQuery.data?.data
                      .filter((i) => i.status === 'pending')
                      .map((i) => (
                        <tr key={i.id} className="border-b border-border last:border-0">
                          <td className="px-6 py-4">{i.email}</td>
                          <td className="px-6 py-4 text-foreground-muted">{ORG_ROLE_LABELS[i.role]}</td>
                          <td className="px-6 py-4 text-foreground-muted">{i.invitedByName ?? '—'}</td>
                          <td className="px-6 py-4 text-foreground-muted">
                            {new Date(i.expiresAt).toLocaleDateString()}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => revokeMutation.mutate(i.id)}
                              aria-label="Revoke invitation"
                            >
                              <X className="size-4" />
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
      ) : null}

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </>
  );
}

function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('editor');

  const inviteMutation = useMutation({
    mutationFn: (vars: { email: string; role: OrgRole }) =>
      api.post('/api/v1/invitations', vars),
    onSuccess: () => {
      toast.success('Invitation sent');
      queryClient.invalidateQueries({ queryKey: ['invitations'] });
      onOpenChange(false);
      setEmail('');
      setRole('editor');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Could not invite'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>
            They'll receive an email with a link to join this organization. Invitations expire in 7 days.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            inviteMutation.mutate({ email, role });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as OrgRole)}>
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORG_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ORG_ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={inviteMutation.isPending}>
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
