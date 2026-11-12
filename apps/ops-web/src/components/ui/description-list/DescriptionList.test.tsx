import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { DescriptionList } from './DescriptionList';

describe('DescriptionList', () => {
  // Break caught: facts that are not a description list (a screen reader hears a run of text, not terms and their values).
  it('is a description list of terms and values, in order', () => {
    const { container } = render(
      <DescriptionList
        items={[
          { label: 'Hub', value: 'Accra Central' },
          { label: 'Service date', value: 'Wed 4 Nov 2026' },
        ]}
      />,
    );

    expect([...container.querySelectorAll('dt')].map((term) => term.textContent)).toEqual([
      'Hub',
      'Service date',
    ]);
    expect([...container.querySelectorAll('dd')].map((value) => value.textContent)).toEqual([
      'Accra Central',
      'Wed 4 Nov 2026',
    ]);
  });

  // Break caught: the facts keyed by their label, so that two facts that share one (a second phone, a second address) are drawn as one or not at all, with a
  // warning from React: a record states the same kind of fact twice.
  it('draws two facts that share a label, each once, and without a warning from React', () => {
    const warned = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container } = render(
      <DescriptionList
        items={[
          { label: 'Phone', value: '+233******111' },
          { label: 'Phone', value: '+233******222' },
        ]}
      />,
    );

    expect([...container.querySelectorAll('dd')].map((value) => value.textContent)).toEqual([
      '+233******111',
      '+233******222',
    ]);
    expect(warned).not.toHaveBeenCalled();
    warned.mockRestore();
  });

  // Break caught: a fact the server did not state drawn as a blank, a dash or a 0, any of which reads as an answer.
  it('says a value that was not stated is not recorded, in words', () => {
    const { container } = render(
      <DescriptionList
        items={[
          { label: 'Landmark' },
          { label: 'Packages', value: undefined },
          { label: 'Note', value: null },
        ]}
      />,
    );

    const values = [...container.querySelectorAll('dd')].map((value) => value.textContent);
    expect(values).toEqual(['Not recorded', 'Not recorded', 'Not recorded']);
    expect(container.textContent).not.toMatch(/\b0\b|—/);
  });

  // Break caught: the words for a value not stated fixed in the component, so that a screen with its own wording ("Nothing recorded") is overruled.
  it('says it in the words it is given', () => {
    render(<DescriptionList items={[{ label: 'Landmark' }]} missingText="Nothing recorded" />);

    expect(screen.getByText('Nothing recorded')).toBeVisible();
  });

  // Break caught: a code set in the body face, or cut short: it must be in the monospaced face and whole.
  it('sets a code in the monospaced face, whole', () => {
    const { container } = render(
      <DescriptionList items={[{ label: 'Request', value: 'ACC-PR-7KQ2MZ', code: true }]} />,
    );

    const code = container.querySelector('dd .ui-code');
    expect(code).toHaveTextContent(/^ACC-PR-7KQ2MZ$/);
  });

  // Break caught: a value that is not text (a badge, a link) forced through the code path and drawn as [object Object].
  it('draws a value that is not text as it is given', () => {
    render(
      <DescriptionList
        items={[{ label: 'State', value: <span data-testid="badge">Confirmed</span>, code: true }]}
      />,
    );

    expect(screen.getByTestId('badge')).toHaveTextContent('Confirmed');
  });

  // Break caught: a heading level fixed in the component (the page's outline broken), or a heading drawn when the page gave none.
  it('has a heading at the level the page asks for, and none unless it is given', () => {
    const { rerender } = render(<DescriptionList items={[{ label: 'Hub', value: 'Tema' }]} />);
    expect(screen.queryByRole('heading')).toBeNull();

    rerender(
      <DescriptionList
        heading="Pickup"
        headingLevel={2}
        items={[{ label: 'Hub', value: 'Tema' }]}
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Pickup' })).toBeInTheDocument();
  });

  // Break caught: values drawn before they arrive, or a loading list that is not busy and says nothing to assistive technology.
  it('keeps the labels and draws no value while it loads, and says it is loading', () => {
    const { container } = render(
      <DescriptionList
        loading
        items={[
          { label: 'Hub', value: 'Accra Central' },
          { label: 'Service date', value: 'Wed 4 Nov 2026' },
        ]}
      />,
    );

    expect(container.querySelector('dl')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Hub')).toBeVisible();
    expect(screen.queryByText('Accra Central')).toBeNull();
    expect(screen.queryByText('Not recorded')).toBeNull();
    expect(within(screen.getByRole('status')).getByText('Loading the details')).toBeInTheDocument();
  });

  // Break caught: a structure a rule of WCAG 2.2 can see without a layout engine (a term outside its list, a heading out of order, an unnamed element).
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <DescriptionList
        heading="Pickup"
        items={[{ label: 'Request', value: 'ACC-PR-7KQ2MZ', code: true }, { label: 'Landmark' }]}
      />,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('DescriptionList: the region that says it is loading (task R5.2, M10)', () => {
  // Break caught: a region that arrives with its words: most screen readers announce a change of a region that was there, not one that appears.
  it('has its region in the page before it loads, and the same one says it is loading', () => {
    const items = [{ label: 'Sender', value: 'Sample Fabrics Ltd' }];
    const view = render(<DescriptionList items={items} />);
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');

    view.rerender(<DescriptionList items={items} loading />);

    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Loading the details');
    expect(region).toHaveClass('ui-visually-hidden');
  });
});
