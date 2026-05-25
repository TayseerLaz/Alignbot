'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginBodySchema, type LoginBody } from '@aligned/shared';
import { ArrowLeft, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { api, ApiError, setAccessToken } from '@/lib/api';
import { useSession } from '@/lib/session';

type Step = 'credentials' | 'totp';

// Literal hexes — bypass the portal theme tokens because brand-500
// flips to Signal Red in dark mode. The auth shell is locked to the
// brand-book Oxblood + Desert Sand pairing regardless of system theme.
const OXBLOOD = '#360516';
const SAND = '#cfc0a9';

function HaderIconMark({ size = 96 }: { size?: number }) {
  return (
    <span
      role="img"
      aria-label="Hader AI"
      className="inline-block"
      style={{
        width: size,
        height: size,
        backgroundColor: SAND,
        WebkitMaskImage: 'url(/hader-icon.png)',
        maskImage: 'url(/hader-icon.png)',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
      }}
    />
  );
}

// Inputs: transparent on Oxblood with Sand border + Sand text. Focus
// ramps the border to full Sand with a soft Sand ring.
const INPUT =
  'w-full rounded-lg border border-[#cfc0a9]/40 bg-transparent px-4 py-3 text-[15px] text-[#cfc0a9] placeholder:text-[#cfc0a9]/45 outline-none transition focus:border-[#cfc0a9] focus:ring-2 focus:ring-[#cfc0a9]/25';

// Outline pill — Sand border + Sand text → hover inverts to filled
// Sand with Oxblood text.
const PRIMARY_BTN =
  'w-full rounded-lg border-2 border-[#cfc0a9] bg-transparent px-6 py-3 text-[15px] font-semibold text-[#cfc0a9] transition hover:bg-[#cfc0a9] hover:text-[#360516] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[#cfc0a9]';

const LINK =
  'rounded px-1.5 py-0.5 font-semibold text-[#cfc0a9] transition hover:bg-[#cfc0a9] hover:text-[#360516]';

const LINK_SUBTLE =
  'rounded px-1.5 py-0.5 font-medium text-[#cfc0a9]/70 transition hover:bg-[#cfc0a9] hover:text-[#360516]';

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [showPassword, setShowPassword] = useState(false);
  const [step, setStep] = useState<Step>('credentials');

  const stash = useRef<{ email: string; password: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpError, setTotpError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const totpInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<LoginBody>({
    resolver: zodResolver(loginBodySchema),
    defaultValues: { email: '', password: '' },
  });

  useEffect(() => {
    if (step === 'totp') totpInputRef.current?.focus();
  }, [step]);

  const finishLogin = async (res: { accessToken: string; expiresAt: string }) => {
    setAccessToken(res.accessToken, res.expiresAt);
    await refresh();
    router.push('/dashboard');
  };

  const onSubmitCredentials = form.handleSubmit(async (values) => {
    try {
      const res = await api.post<{ accessToken: string; expiresAt: string }>(
        '/api/v1/auth/login',
        values,
        { anonymous: true },
      );
      await finishLogin(res);
    } catch (err) {
      if (err instanceof ApiError && err.payload.code === 'TOTP_REQUIRED') {
        stash.current = { email: values.email, password: values.password };
        setTotpCode('');
        setTotpError(null);
        setStep('totp');
        return;
      }
      if (err instanceof ApiError) toast.error(err.payload.message);
      else toast.error('Could not sign in. Please try again.');
    }
  });

  const onSubmitTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stash.current) {
      setStep('credentials');
      return;
    }
    const value = totpCode.trim();
    if (value.length < 6) {
      setTotpError('Enter your 6-digit code (or an 8-character recovery code).');
      return;
    }
    setVerifying(true);
    setTotpError(null);
    try {
      const res = await api.post<{ accessToken: string; expiresAt: string }>(
        '/api/v1/auth/login',
        { ...stash.current, totpCode: value },
        { anonymous: true },
      );
      stash.current = null;
      await finishLogin(res);
    } catch (err) {
      if (err instanceof ApiError && err.payload.code === 'TOTP_INVALID') {
        setTotpError('Invalid code. Try again — or use a recovery code.');
      } else if (err instanceof ApiError) {
        setTotpError(err.payload.message);
      } else {
        setTotpError('Could not verify the code. Please try again.');
      }
    } finally {
      setVerifying(false);
    }
  };

  if (step === 'credentials') {
    return (
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <HaderIconMark size={96} />
        <h1
          className="mt-8 text-5xl font-extrabold leading-[0.95] tracking-[-0.04em] text-[#cfc0a9] sm:text-6xl"
        >
          Welcome{' '}
          <span
            className="font-normal"
            style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}
          >
            back.
          </span>
        </h1>
        <p className="mt-3 text-sm text-[#cfc0a9]/70">
          Sign in to continue to your Hader workspace.
        </p>

        <form onSubmit={onSubmitCredentials} className="mt-10 w-full space-y-4 text-left">
          <Field label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              className={INPUT}
              aria-invalid={!!form.formState.errors.email}
              {...form.register('email')}
            />
          </Field>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <label htmlFor="password" className="text-sm font-medium text-[#cfc0a9]">
                Password
              </label>
              <Link href="/forgot-password" className={`text-xs ${LINK_SUBTLE}`}>
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Enter your password"
                className={`${INPUT} pr-12`}
                aria-invalid={!!form.formState.errors.password}
                {...form.register('password')}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-[#cfc0a9]/60 transition hover:bg-[#cfc0a9] hover:text-[#360516]"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {form.formState.errors.password ? (
              <p className="text-xs font-medium text-[#cfc0a9]/90">
                {form.formState.errors.password.message}
              </p>
            ) : null}
          </div>

          <button
            type="submit"
            disabled={form.formState.isSubmitting}
            className={`${PRIMARY_BTN} mt-2`}
          >
            {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-8 text-sm text-[#cfc0a9]/70">
          New to Hader?{' '}
          <Link href="/signup" className={LINK}>
            Create an account
          </Link>
        </p>
      </div>
    );
  }

  // Two-factor — same pattern. Sand shield ring on Oxblood.
  return (
    <div className="flex w-full max-w-sm flex-col items-center text-center">
      <div className="flex size-24 items-center justify-center rounded-full border-2 border-[#cfc0a9]/40">
        <ShieldCheck className="size-10 text-[#cfc0a9]" />
      </div>
      <h1 className="mt-8 text-5xl font-extrabold leading-[0.95] tracking-[-0.04em] text-[#cfc0a9] sm:text-6xl">
        Verify it's{' '}
        <span
          className="font-normal"
          style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}
        >
          you.
        </span>
      </h1>
      <p className="mt-3 text-sm text-[#cfc0a9]/70">
        Open your authenticator app and enter the 6-digit code.
      </p>
      <p className="mt-1 text-xs text-[#cfc0a9]/60">
        Signing in as <span className="font-medium text-[#cfc0a9]">{stash.current?.email}</span>
      </p>

      <form onSubmit={onSubmitTotp} className="mt-10 w-full space-y-4">
        <input
          ref={totpInputRef}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={20}
          placeholder="000000"
          value={totpCode}
          onChange={(e) => {
            setTotpCode(e.target.value);
            setTotpError(null);
          }}
          className={`${INPUT} text-center font-mono text-lg tracking-[0.5em]`}
          aria-invalid={!!totpError}
        />
        {totpError ? (
          <p className="text-center text-xs font-medium text-[#cfc0a9]/90">{totpError}</p>
        ) : (
          <p className="text-center text-xs text-[#cfc0a9]/60">
            Lost your authenticator? Type an 8-character recovery code.
          </p>
        )}

        <button
          type="submit"
          disabled={verifying || totpCode.trim().length < 6}
          className={PRIMARY_BTN}
        >
          {verifying ? 'Verifying…' : 'Verify & continue'}
        </button>

        <button
          type="button"
          onClick={() => {
            stash.current = null;
            setTotpCode('');
            setTotpError(null);
            setStep('credentials');
          }}
          className="flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-sm text-[#cfc0a9]/70 transition hover:bg-[#cfc0a9] hover:text-[#360516]"
        >
          <ArrowLeft className="size-3.5" /> Use a different account
        </button>
      </form>
    </div>
  );
}

// Silence eslint about unused constants — they document the locked
// palette + can be imported elsewhere.
void OXBLOOD;
void SAND;

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-[#cfc0a9]">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs font-medium text-[#cfc0a9]/90" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
