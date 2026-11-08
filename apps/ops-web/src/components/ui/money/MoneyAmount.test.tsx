import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MoneyAmount } from './MoneyAmount';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MoneyAmount', () => {
  it('shows the amount the server sent in cedis, as text', () => {
    render(
      <p>
        Charge as applied: <MoneyAmount amountMinor={2000} currency="GHS" />
      </p>,
    );

    expect(screen.getByText('GH₵20.00')).toBeVisible();
    expect(screen.getByText(/Charge as applied/)).toHaveTextContent('Charge as applied: GH₵20.00');
  });

  // It is text and takes no focus of its own: a keyboard passes it by, as it passes any other words of a sentence.
  it('is not a stop for the keyboard', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Before</button>
        <MoneyAmount amountMinor={2550} currency="GHS" />
        <button type="button">After</button>
      </>,
    );

    await user.tab();
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  // Break caught: a float drawn as an amount, which a page would only produce by computing one.
  it('refuses an amount that is not a whole number of pesewas', () => {
    // React reports the error it is about to throw; the test is about the throw.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(<MoneyAmount amountMinor={20.5} currency="GHS" />)).toThrow(RangeError);
  });
});
