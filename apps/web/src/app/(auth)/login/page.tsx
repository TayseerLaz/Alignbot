'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginBodySchema, type LoginBody } from '@aligned/shared';
import { Eye, EyeOff, Github } from 'lucide-react';
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

      {/* SSO row */}
      <div className="mt-7 grid grid-cols-2 gap-3">
        <SsoButton
          onClick={() => toast('SSO sign-in is coming soon.', { description: 'Use email + password for now.' })}
          icon={<GoogleG />}
          label="Google"
        />
        <SsoButton
          onClick={() => toast('SSO sign-in is coming soon.', { description: 'Use email + password for now.' })}
          icon={<Github className="size-4" />}
          label="Github"
        />
      </div>

      {/* Or divider */}
      <div className="my-5 flex items-center gap-3 text-xs text-white/40">
        <span className="h-px flex-1 bg-white/10" />
        <span>Or</span>
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
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

      <p className="mt-5 text-center text-sm text-white/60">
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

function SsoButton({
  onClick,
  icon,
  label,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-[#19191c] py-2.5 text-sm font-medium text-white transition hover:bg-[#1f1f24]"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// Tiny Google G in brand colours so we don't pull in an icon font.
function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" className="size-4" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.3l-6.2-5.2C29.2 35.2 26.7 36 24 36c-5.3 0-9.7-3.4-11.3-8l-6.5 5C9.6 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4-4 5.3l6.2 5.2c-.4.4 6.5-4.7 6.5-14.5 0-1.2-.1-2.4-.4-3.5z" />
    </svg>
  );
}
