import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';

import { ErrorFallback } from '../../components/ErrorFallback';

/**
 * Shown inside the frame when a page fails. The router clears a page's error when the location changes,
 * and revalidating does not change it, so retry goes to the same place again, replacing the history
 * entry rather than adding one. A query that threw its failure to this page keeps the failure in its cache entry
 * until it is told that the failure was seen, so retry tells it first: otherwise the page that is rendered
 * again reads the same failure and throws it again without asking the server.
 */
export function RouteErrorPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { reset } = useQueryErrorResetBoundary();
  return (
    <ErrorFallback
      onRetry={() => {
        reset();
        const { pathname, search, hash } = location;
        void navigate(
          { pathname, search, hash },
          { replace: true, state: location.state as unknown },
        );
      }}
    />
  );
}

/**
 * Shown, in place of the frame, when the frame itself fails. Without it the router library would show
 * its own error screen, which prints the error message and stack.
 */
export function FrameErrorPage() {
  return (
    <main className="app-main" tabIndex={-1}>
      <RouteErrorPage />
    </main>
  );
}
