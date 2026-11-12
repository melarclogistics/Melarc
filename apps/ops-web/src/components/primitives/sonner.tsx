import type { CSSProperties } from 'react';
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { toast, Toaster as Sonner, type ToasterProps } from 'sonner';

import { useResolvedTheme } from '@/platform/theme/use-resolved-theme';

/*
 * The toaster. The registry's version reads the theme from `next-themes`, a package this application does not have and a second owner of
 * the theme besides tokens.css; it is told the resolved theme here instead (`data-theme`, then the system setting), and every colour it draws
 * is a reference to a token through the shadcn names. The icons carry the status colour of the tokens, and the words carry the meaning.
 * Sonner adds a stylesheet of its own to the page when it loads, which is why the content security policy allows inline styles (SECURITY_DESIGN).
 *
 * `toast` is re-exported from here, which the registry's file does not do: only the primitives may import `sonner` (the door in eslint.config.mjs), so the
 * function that raises a toast has to come through this file.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useResolvedTheme();

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4 text-(color:--color-status-success-foreground)" />
        ),
        info: <InfoIcon className="size-4 text-(color:--color-status-info-foreground)" />,
        warning: (
          <TriangleAlertIcon className="size-4 text-(color:--color-status-warning-foreground)" />
        ),
        error: <OctagonXIcon className="size-4 text-(color:--color-status-danger-foreground)" />,
        loading: <Loader2Icon className="size-4 motion-safe:animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius-lg)',
        } as CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster, toast };
