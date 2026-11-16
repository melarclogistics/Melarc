import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Button } from '../button/Button';
import { LockIndicator } from './LockIndicator';

describe('LockIndicator', () => {
  // Break caught: a holder told in colour alone, or one told as another's: the words are what say who holds the lock.
  it.each([
    ['free', undefined, 'Not held', 'Nobody holds the lock on this intake.'],
    ['yours', undefined, 'Held by you', 'You hold the lock on this intake.'],
    [
      'other',
      'Another receiver',
      'Held by someone else',
      'Another receiver holds the lock on this intake.',
    ],
    ['unknown', undefined, 'Not known', 'Who holds the lock on this intake is not known.'],
  ] as const)(
    'says in words who holds it when the holder is %s',
    (holder, who, label, sentence) => {
      render(
        <LockIndicator
          holder={holder}
          subject="this intake"
          {...(who === undefined ? {} : { who })}
        />,
      );

      const status = screen.getByRole('status');
      expect(within(status).getByText(label)).toBeVisible();
      expect(within(status).getByText(sentence)).toBeVisible();
    },
  );

  it('says someone else when the page has no words for who', () => {
    render(<LockIndicator holder="other" />);
    expect(screen.getByText('Someone else holds the lock.')).toBeVisible();
  });

  // Break caught: the moment of the last refresh read out every minute because it sits in the live region: it is outside it, and only for a holder.
  it('draws when the holder was last active outside the live region, and only for a holder', () => {
    const { rerender } = render(
      <LockIndicator holder="other" who="Another receiver" since="09:12" />,
    );
    const status = screen.getByRole('status');
    expect(screen.getByText('Last active 09:12.')).toBeVisible();
    expect(status).not.toHaveTextContent('09:12');

    for (const holder of ['free', 'unknown'] as const) {
      rerender(<LockIndicator holder={holder} since="09:12" />);
      expect(screen.queryByText(/09:12/)).toBeNull();
    }
    rerender(<LockIndicator holder="yours" since="09:13" />);
    expect(screen.getByText('Last active 09:13.')).toBeVisible();
  });

  // Break caught: a lock drawn as a gate, with a note or an action the page did not give, or one that drops what the page said it is not.
  it('draws the page’s note and its action, and nothing it was not given', async () => {
    const onAsk = vi.fn();
    const { container, rerender } = render(
      <LockIndicator
        holder="other"
        note="A lock only shows who is working."
        action={
          <Button type="button" onClick={onAsk}>
            Ask again
          </Button>
        }
      />,
    );
    expect(screen.getByText('A lock only shows who is working.')).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ask again' }));
    expect(onAsk).toHaveBeenCalledTimes(1);

    rerender(<LockIndicator holder="free" />);
    expect(container.querySelector('.ui-lock-indicator__note')).toBeNull();
    expect(container.querySelector('.ui-lock-indicator__action')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  // Break caught: a free lock drawn with the closed padlock, so that a picture says the opposite of the words.
  it('draws an open padlock for a lock nobody holds and a closed one for any other', () => {
    const { container, rerender } = render(<LockIndicator holder="free" />);
    expect(container.querySelector('svg.lucide-lock-open')).not.toBeNull();
    rerender(<LockIndicator holder="other" />);
    expect(container.querySelector('svg.lucide-lock')).not.toBeNull();
    expect(container.querySelector('svg.lucide-lock-open')).toBeNull();
  });

  it('has no accessibility violations in any state', async () => {
    for (const holder of ['free', 'yours', 'other', 'unknown'] as const) {
      const { container, unmount } = render(
        <LockIndicator holder={holder} subject="this intake" since="09:12" note="Advisory." />,
      );
      expect(await wcagViolations(container)).toEqual([]);
      unmount();
    }
  });
});
