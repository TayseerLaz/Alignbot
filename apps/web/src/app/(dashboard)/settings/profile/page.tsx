'use client';

import { Download, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError, getAccessToken } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function ProfilePage() {
  const { session, refresh } = useSession();
  const router = useRouter();
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Name form state — seeded from session; re-seeded whenever session changes.
  const [firstName, setFirstName] = useState(session?.user.firstName ?? '');
  const [lastName, setLastName] = useState(session?.user.lastName ?? '');
  const [savingName, setSavingName] = useState(false);

  // Password form state.
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  if (!session) return null;
  const { user, organization } = session;

  const displayName =
    [firstName, lastName].filter(Boolean).join(' ') || user.email;

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setSavingName(true);
    try {
      await api.patch('/api/v1/auth/me', { firstName, lastName });
      await refresh();
      toast.success('Profile updated.');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error("Couldn't save. Please try again.");
    } finally {
      setSavingName(false);
    }
  }

  async function exportMyData() {
    setExporting(true);
    try {
      const url = `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/account/export`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `aligned-account-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      toast.success('Your data has been downloaded.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  async function deleteMyAccount() {
    const confirmed = await confirmDialog({
      title: 'Delete your account?',
      body:
        'This is permanent. Your sessions end immediately, your memberships are revoked, and your profile is anonymised. ' +
        'If you are the last admin of any organization this will be refused — transfer admin first.',
      confirmLabel: 'Delete my account',
      destructive: true,
    });
    if (!confirmed) return;
    setDeleting(true);
    try {
      await api.delete('/api/v1/account');
      toast.success('Account deleted. You will be signed out.');
      router.push('/login');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error('Delete failed.');
      setDeleting(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("New password and confirmation don't match.");
      return;
    }
    setSavingPassword(true);
    try {
      await api.post('/api/v1/auth/change-password', {
        currentPassword,
        newPassword,
      });
      toast.success('Password changed. Other devices have been signed out.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error("Couldn't change password. Please try again.");
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Profile"
        description={`Signed in as ${displayName}.`}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Your name</CardTitle>
            <CardDescription>
              Displayed in the top bar and in activity logs.
            </CardDescription>
          </CardHeader>
          <form onSubmit={saveName}>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="profile-firstName">First name</Label>
                  <Input
                    id="profile-firstName"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    required
                    maxLength={80}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="profile-lastName">Last name</Label>
                  <Input
                    id="profile-lastName"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    required
                    maxLength={80}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="profile-email">Email</Label>
                <Input id="profile-email" value={user.email} readOnly />
                <p className="text-xs text-foreground-subtle">
                  Email can&apos;t be changed from here. Contact support if you
                  need to transfer ownership.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="profile-org">Organization</Label>
                <Input
                  id="profile-org"
                  value={`${organization.name} (${organization.role})`}
                  readOnly
                />
              </div>
              {user.isAlignedAdmin ? (
                <p className="text-xs text-brand-500">
                  You have ALIGNED super-admin access across all tenants.
                </p>
              ) : null}
            </CardContent>
            <CardFooter>
              <Button type="submit" loading={savingName}>
                Save changes
              </Button>
            </CardFooter>
          </form>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>
              Other devices will be signed out after a successful change.
            </CardDescription>
          </CardHeader>
          <form onSubmit={changePassword}>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="current-password">Current password</Label>
                <Input
                  id="current-password"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={12}
                />
                <p className="text-xs text-foreground-subtle">
                  12+ characters with uppercase, lowercase, and a number.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
            </CardContent>
            <CardFooter>
              <Button type="submit" loading={savingPassword}>
                Change password
              </Button>
            </CardFooter>
          </form>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Export your data</CardTitle>
            <CardDescription>
              Download a JSON file containing your profile, memberships, sessions, issued API keys, and the audit entries you authored. Does not include other tenants&apos; data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="secondary" loading={exporting} onClick={exportMyData}>
              <Download className="size-4" /> Download my data
            </Button>
          </CardContent>
        </Card>

        <Card className="border-red-200">
          <CardHeader>
            <CardTitle className="text-red-700">Delete your account</CardTitle>
            <CardDescription>
              Permanently anonymise your profile, revoke every session, and deactivate every membership. Refused if you are the last admin of any organization.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="danger" loading={deleting} onClick={deleteMyAccount}>
              <Trash2 className="size-4" /> Delete my account
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
