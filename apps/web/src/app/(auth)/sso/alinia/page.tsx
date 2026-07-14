'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { api, ApiError, setAccessToken } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * "Sign in with Alinia" landing.
 *
 * Alinia redirects here with a short-lived RS256 federation token in the URL
 * fragment (#token=…). We POST it to /auth/alinia, which verifies it against
 * Alinia's JWKS, links the federated user, and issues a normal Hader session
 * (sets the refresh cookie + returns an access token). Then we bootstrap the
 * session exactly like a password login and land on the dashboard.
 */
export default function AliniaSsoPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    const token = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('token');
    if (!token) {
      setError('Missing sign-in token. Return to Alinia and click “Open Hader” again.');
      return;
    }
    // Drop the token from the address bar immediately — it is single-use + short-lived.
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', window.location.pathname);
    }

    void (async () => {
      try {
        const res = await api.post<{ accessToken: string; expiresAt: string }>(
          '/api/v1/auth/alinia',
          { token },
          { anonymous: true },
        );
        setAccessToken(res.accessToken, res.expiresAt);
        await refresh();
        router.replace('/dashboard');
      } catch (err) {
        if (err instanceof ApiError) setError(err.payload.message);
        else setError('Sign-in with Alinia failed. Please try again from Alinia.');
      }
    })();
  }, [refresh, router]);

  return (
    <div className="flex w-full max-w-sm flex-col items-center text-center">
      {error ? (
        <>
          <h1 className="mt-8 text-2xl font-semibold text-[#cfc0a9]">Couldn’t sign you in</h1>
          <p className="mt-3 text-sm text-[#cfc0a9]/80">{error}</p>
        </>
      ) : (
        <>
          <div className="mt-8 h-8 w-8 animate-spin rounded-full border-2 border-[#cfc0a9] border-t-transparent" />
          <p className="mt-4 text-sm text-[#cfc0a9]/80">Signing you in with Alinia…</p>
        </>
      )}
    </div>
  );
}
