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

  return (
    <div className="relative flex flex-1 flex-col">
      {/* Headline — large, light weight, like the reference. */}
      <h1 className="text-5xl font-light tracking-tight text-white sm:text-6xl">Login</h1>

      {/* Two underline-only inputs side by side. */}
      <form onSubmit={onSubmit} className="mt-12 max-w-2xl">
        <div className="grid gap-10 sm:grid-cols-2">
          <UnderlineField label="Email">
            <input
              type="email"
              autoComplete="email"
              placeholder="name@company.com"
              className="w-full border-0 border-b border-white/40 bg-transparent py-2 text-base text-white placeholder:text-white/30 focus:border-white focus:outline-none focus:ring-0"
              aria-invalid={!!form.formState.errors.email}
              {...form.register('email')}
            />
            {form.formState.errors.email ? (
              <p className="mt-1 text-[11px] text-rose-300">
                {form.formState.errors.email.message}
              </p>
            ) : null}
          </UnderlineField>
          <UnderlineField label="Password">
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="••••••••••"
                className="w-full border-0 border-b border-white/40 bg-transparent py-2 pr-8 text-base text-white placeholder:text-white/30 focus:border-white focus:outline-none focus:ring-0"
                aria-invalid={!!form.formState.errors.password}
                {...form.register('password')}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-0 top-1/2 -translate-y-1/2 text-white/50 hover:text-white"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {form.formState.errors.password ? (
              <p className="mt-1 text-[11px] text-rose-300">
                {form.formState.errors.password.message}
              </p>
            ) : null}
          </UnderlineField>
        </div>

        {/* Remember me + forgot — under the field row. */}
        <div className="mt-6 grid items-center gap-4 sm:grid-cols-2">
          <label className="inline-flex items-center gap-2 text-sm text-white/80">
            <input
              type="checkbox"
              className="size-4 rounded-full border border-white/40 bg-transparent accent-white"
            />
            <span>Remember me</span>
          </label>
          <div className="sm:text-right">
            <Link
              href="/forgot-password"
              className="text-sm text-white/70 hover:text-white hover:underline focus-visible:underline"
            >
              Forgot?
            </Link>
          </div>
        </div>

        {/* Big circular SIGN IN button anchored bottom-right of the
            form column, like the reference. We keep it submit-typed
            so Enter on the inputs still submits. */}
        <div className="mt-20 flex justify-end sm:absolute sm:bottom-0 sm:right-0 sm:mt-0">
          <button
            type="submit"
            disabled={form.formState.isSubmitting}
            className="flex size-24 items-center justify-center rounded-full bg-white text-xs font-semibold tracking-[0.18em] text-black transition-transform hover:scale-[1.03] disabled:opacity-60 sm:size-28"
          >
            {form.formState.isSubmitting ? 'SIGNING IN…' : 'SIGN IN'}
          </button>
        </div>
      </form>
    </div>
  );
}

// Underlined field group: tiny label above an underlined input.
function UnderlineField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-white/60">{label}</span>
      {children}
    </div>
  );
}
