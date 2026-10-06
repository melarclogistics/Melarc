import { Component, type ReactNode } from 'react';

import { ErrorFallback } from './ErrorFallback';

interface State {
  readonly failed: boolean;
}

/**
 * The outermost safety net: it catches a failure that happens outside any route, in the providers or the
 * router itself, so the user never sees a blank page. Failures inside a route are handled by the route
 * tree (app/routes.tsx), which keeps the frame around the message.
 */
export class AppErrorBoundary extends Component<{ readonly children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="app-main" tabIndex={-1}>
          <ErrorFallback
            onRetry={() => {
              this.setState({ failed: false });
            }}
          />
        </main>
      );
    }
    return this.props.children;
  }
}
