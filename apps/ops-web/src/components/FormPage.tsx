import type { ReactNode } from 'react';

import './form-page.css';

/**
 * The measure of a single-column form page (DESIGN_SYSTEM section 13.3: a normal form stays within about 560 to 720 px). A page that is a form,
 * or a short statement beside one, sits in this and not across the whole content width, where a line would be too long to read and a field too
 * wide to scan.
 */
export function FormPage({ children }: { readonly children: ReactNode }) {
  return <div className="ui-form-page">{children}</div>;
}
