import type { ReactNode } from 'react';

/**
 * The page's one level-one heading. It can take programmatic focus, which is how a client-side
 * navigation tells a screen reader that the page changed.
 */
export function PageHeading({ children }: { readonly children: ReactNode }) {
  return (
    <h1 className="page-heading" tabIndex={-1}>
      {children}
    </h1>
  );
}
