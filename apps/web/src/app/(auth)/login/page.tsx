'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginBodySchema, type LoginBody } from '@aligned/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError, setAccessToken } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useSession();

  const form = useForm<LoginBody>({
    resolver: zodResolver(loginBodySchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const res = await api.post<{ accessToken: string; expiresAt: string }>(
        '/api/v1/auth/login',
        values,
        { anonymous: true },
      );
      setAccessToken(res.accessToken, res.expiresAt);
      await refresh();
      router.push('/dashboard');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error('Could not sign in. Please try again.');
    }
  });

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 flex items-center gap-2">
          {/* Mini concentric dot — a tiny echo of the page's halo. */}
          <span
            aria-hidden
            className="inline-block size-2.5 rounded-full"
            style={{
              background:
                'radial-gradient(circle at 50% 50%, #1e1b4b 0%, #7c3aed 40%, #ec4899 65%, #facc15 90%)',
            }}
          />
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground-subtle">
            ALIGNED
          </span>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Sign in</h1>
        <p className="mt-2 text-sm text-foreground-muted">
          Welcome back. Manage your catalog and chatbot from one place.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            {...form.register('email')}
            aria-invalid={!!form.formState.errors.email}
            aria-describedby={form.formState.errors.email ? 'email-error' : undefined}
          />
          {form.formState.errors.email ? (
            <p id="email-error" role="alert" className="text-xs text-red-600">
              {form.formState.errors.email.message}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="password">Password</Label>
            <Link
              href="/forgot-password"
              className="text-xs text-brand-500 hover:underline focus-visible:underline"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            {...form.register('password')}
            aria-invalid={!!form.formState.errors.password}
            aria-describedby={form.formState.errors.password ? 'password-error' : undefined}
          />
          {form.formState.errors.password ? (
            <p id="password-error" role="alert" className="text-xs text-red-600">
              {form.formState.errors.password.message}
            </p>
          ) : null}
        </div>

        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Sign in
        </Button>
      </form>

      <p className="text-sm text-foreground-muted">
        New to ALIGNED?{' '}
        <Link href="/signup" className="text-brand-500 hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}
