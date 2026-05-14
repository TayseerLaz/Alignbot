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

  // Reference's input style: rounded, dark gray fill (#1a1a1d), no
  // visible border except on focus.
  const inputClass =
    'w-full rounded-lg border border-white/[0.06] bg-[#19191c] px-3.5 py-2.5 text-sm text-white placeholder:text-white/30 outline-none transition focus:border-white/30 focus:bg-[#1c1c20]';

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center">
      <div className="mb-7 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Sign in to Account</h1>
        <p className="mt-1.5 text-sm text-white/60">
          Welcome back. Enter your details to continue.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Email" error={form.formState.errors.email?.message}>
          <input
            type="email"
            autoComplete="email"
            placeholder="eg. john@gmail.com"
            className={inputClass}
            aria-invalid={!!form.formState.errors.email}
            {...form.register('email')}
          />
        </Field>

        <Field
          label="Password"
          error={form.formState.errors.password?.message}
          hint="Must be at least 8 characters."
        >
          <div className="relative">
            <input
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
        </Field>

        <div className="flex justify-end">
          <Link
            href="/forgot-password"
            className="text-xs text-white/60 hover:text-white hover:underline focus-visible:underline"
          >
            Forgot password?
          </Link>
        </div>

        <button
          type="submit"
          disabled={form.formState.isSubmitting}
          className="mt-2 w-full rounded-lg bg-white py-3 text-sm font-semibold text-black transition hover:bg-white/90 disabled:opacity-60"
        >
          {form.formState.isSubmitting ? 'Signing in…' : 'Sign In'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-white/60">
        New to ALIGNED?{' '}
        <Link href="/signup" className="font-semibold text-white hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-white/80">{label}</label>
      {children}
      {error ? (
        <p className="text-[11px] text-rose-300">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-white/40">{hint}</p>
      ) : null}
    </div>
  );
}
