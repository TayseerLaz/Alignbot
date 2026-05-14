'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginBodySchema, type LoginBody } from '@aligned/shared';
import { Eye, EyeOff } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { api, ApiError, setAccessToken } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [showPassword, setShowPassword] = useState(false);

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

  const inputClass =
    'w-full rounded-lg border border-white/[0.06] bg-[#19191c] px-3.5 py-2.5 text-sm text-white placeholder:text-white/30 outline-none transition focus:border-white/30 focus:bg-[#1c1c20]';

  return (
    <div className="flex flex-col">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight text-white">Sign in to Account</h1>
        <p className="mt-2 text-sm text-white/60">Enter your details to continue.</p>
      </div>

      <form onSubmit={onSubmit} className="mt-7 space-y-4">
        <Field label="Email" error={form.formState.errors.email?.message}>
          <input
            type="email"
            autoComplete="email"
            placeholder="eg. johnfrans@gmail.com"
            className={inputClass}
            aria-invalid={!!form.formState.errors.email}
            {...form.register('email')}
          />
        </Field>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <label htmlFor="password" className="block text-xs font-medium text-white/80">
              Password
            </label>
            <Link
              href="/forgot-password"
              className="text-[11px] text-white/60 hover:text-white hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="Enter your password"
              className={`${inputClass} pr-10`}
              aria-invalid={!!form.formState.errors.password}
              {...form.register('password')}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50 hover:text-white"
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {form.formState.errors.password ? (
            <p className="text-[11px] text-rose-300">{form.formState.errors.password.message}</p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={form.formState.isSubmitting}
          className="mt-2 w-full rounded-lg bg-white py-3 text-sm font-semibold text-black transition hover:bg-white/90 disabled:opacity-60"
        >
          {form.formState.isSubmitting ? 'Signing in…' : 'Sign In'}
        </button>
      </form>

    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-white/80">{label}</label>
      {children}
      {error ? <p className="text-[11px] text-rose-300">{error}</p> : null}
    </div>
  );
}

