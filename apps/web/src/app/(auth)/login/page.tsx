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

  // Dark form on translucent card. Inputs override the default light
  // theme via className so they read correctly over the magenta smear.
  const inputClass =
    'border-white/15 bg-white/[0.06] text-white placeholder:text-white/30 focus-visible:border-white/40 focus-visible:ring-white/20';

  return (
    <div className="space-y-7">
      <div>
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{
              background:
                'radial-gradient(circle at 50% 50%, #f9a8d4 0%, #d946ef 40%, #7c3aed 80%)',
            }}
          />
          <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/70">
            ALIGNED
          </span>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Sign in</h1>
        <p className="mt-2 text-sm text-white/60">
          Welcome back. Manage your catalog and chatbot from one place.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email" className="text-white/80">
            Email
          </Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            className={inputClass}
            {...form.register('email')}
            aria-invalid={!!form.formState.errors.email}
            aria-describedby={form.formState.errors.email ? 'email-error' : undefined}
          />
          {form.formState.errors.email ? (
            <p id="email-error" role="alert" className="text-xs text-rose-300">
              {form.formState.errors.email.message}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="password" className="text-white/80">
              Password
            </Label>
            <Link
              href="/forgot-password"
              className="text-xs text-white/60 hover:text-white hover:underline focus-visible:underline"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            className={inputClass}
            {...form.register('password')}
            aria-invalid={!!form.formState.errors.password}
            aria-describedby={form.formState.errors.password ? 'password-error' : undefined}
          />
          {form.formState.errors.password ? (
            <p id="password-error" role="alert" className="text-xs text-rose-300">
              {form.formState.errors.password.message}
            </p>
          ) : null}
        </div>

        <Button
          type="submit"
          className="w-full rounded-full bg-white text-slate-900 hover:bg-white/90 focus-visible:ring-white/40"
          loading={form.formState.isSubmitting}
        >
          Sign in
        </Button>
      </form>

      <p className="text-sm text-white/60">
        New to ALIGNED?{' '}
        <Link href="/signup" className="font-medium text-white hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}
