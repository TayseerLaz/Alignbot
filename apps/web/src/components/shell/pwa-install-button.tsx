'use client';

import { Download } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { usePwaInstall } from '@/lib/pwa';

// "Open in app" — sits beside the search bar. Always visible in a browser tab;
// hidden once the portal is running as the installed app (standalone). Clicking
// fires the native install prompt; if the browser doesn't offer one (iOS Safari,
// already dismissed), it shows how to install manually.
export function PwaInstallButton() {
  const pwa = usePwaInstall();

  // Wait for client mount (standalone is only knowable client-side) and hide
  // when already in the installed app.
  if (!pwa.mounted || pwa.isStandalone) return null;

  const onClick = async () => {
    const fired = await pwa.promptInstall();
    if (!fired) {
      toast.info(
        'To install: open your browser menu and choose “Install app” (or, on iPhone, Share → “Add to Home Screen”).',
      );
    }
  };

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={onClick}
      className="h-8 shrink-0 gap-1.5 whitespace-nowrap"
      aria-label="Open in app"
      title="Install / open the Hader app"
    >
      <Download className="size-4" />
      <span className="hidden md:inline">Open in app</span>
    </Button>
  );
}
