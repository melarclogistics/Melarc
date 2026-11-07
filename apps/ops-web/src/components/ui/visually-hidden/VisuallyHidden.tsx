import type { ReactNode } from 'react';

import './visually-hidden.css';

/**
 * Words for whoever hears the page, kept out of the way of the eye: a state told in words beside a colour, the name of what a figure counts, an
 * instruction for a keyboard. It is text in the page (read in order, found by a screen reader, kept by copy), not an `aria-label`, which not every
 * element is allowed to carry and which some readers skip. The component adds no role.
 */
export function VisuallyHidden({ children }: { readonly children: ReactNode }) {
  return <span className="ui-visually-hidden">{children}</span>;
}
