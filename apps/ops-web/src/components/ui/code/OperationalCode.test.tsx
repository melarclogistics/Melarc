import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { VisuallyHidden } from '../visually-hidden/VisuallyHidden';
import { OperationalCode } from './OperationalCode';

describe('OperationalCode', () => {
  // Break caught: a code shortened, re-cased or re-punctuated on its way to the screen, which people read aloud on calls (COMPONENT_PATTERNS section 24.1).
  it('draws the code exactly as it was given, whole', () => {
    render(<OperationalCode>ACC-PR-7KQ2MZ</OperationalCode>);

    expect(screen.getByText('ACC-PR-7KQ2MZ')).toHaveClass('ui-code');
    expect(document.body.textContent).toBe('ACC-PR-7KQ2MZ');
  });

  // Break caught: a code drawn in a way that fails a rule of WCAG 2.2 which can be seen without a layout engine (a role on a span, a name that hides the code).
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <p>
        <OperationalCode>ACC-PR-7KQ2MZ</OperationalCode>
      </p>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('VisuallyHidden', () => {
  // Break caught: words for assistive technology put in an attribute (which not every element may carry), or dropped from the page so that a screen reader
  // never finds them.
  it('keeps its words in the page as text, with no role', () => {
    render(
      <button type="button">
        Open <VisuallyHidden>request ACC-PR-7KQ2MZ</VisuallyHidden>
      </button>,
    );

    expect(screen.getByRole('button', { name: 'Open request ACC-PR-7KQ2MZ' })).toBeInTheDocument();
    expect(screen.getByText('request ACC-PR-7KQ2MZ')).toHaveClass('ui-visually-hidden');
    expect(screen.getByText('request ACC-PR-7KQ2MZ')).not.toHaveAttribute('role');
  });
});
