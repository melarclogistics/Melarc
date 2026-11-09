import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { QueuePager, type QueuePagerProps } from './QueuePager';

function renderPager(overrides: Partial<QueuePagerProps> = {}) {
  const props: QueuePagerProps = {
    label: 'Pages of pickup requests',
    noun: { one: 'request', other: 'requests' },
    shown: 2,
    page: 1,
    hasNext: false,
    onNext: () => undefined,
    onPrevious: () => undefined,
    ...overrides,
  };
  return render(<QueuePager {...props} />);
}

describe('QueuePager', () => {
  // Break caught: a total the server never gave, or a count that does not say it is of the page.
  it('counts the page and never claims a total, and says when more follow', () => {
    const { rerender } = renderPager();
    expect(screen.getByRole('status')).toHaveTextContent(/^Showing 2 requests\.$/);

    rerender(
      <QueuePager
        label="Pages of pickup requests"
        noun={{ one: 'request', other: 'requests' }}
        shown={1}
        page={2}
        hasNext
        onNext={() => undefined}
        onPrevious={() => undefined}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing 1 request on page 2. More follow on the next page.',
    );
  });

  // Break caught: pager buttons for pages that are not there (a previous page from the first, a next page the server did not give).
  it('offers the pages that exist and no other', () => {
    const { rerender } = renderPager();
    expect(screen.queryByRole('navigation')).toBeNull();

    rerender(
      <QueuePager
        label="Pages of pickup requests"
        noun={{ one: 'request', other: 'requests' }}
        shown={2}
        page={1}
        hasNext
        onNext={() => undefined}
        onPrevious={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Next page' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Previous page' })).toBeNull();

    rerender(
      <QueuePager
        label="Pages of pickup requests"
        noun={{ one: 'request', other: 'requests' }}
        shown={2}
        page={2}
        hasNext={false}
        onNext={() => undefined}
        onPrevious={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  });

  it('asks for the next page and the previous page, and names the pages', async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    renderPager({ page: 2, hasNext: true, onNext, onPrevious });

    expect(screen.getByRole('navigation', { name: 'Pages of pickup requests' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violation', async () => {
    const { container } = renderPager({ page: 2, hasNext: true });

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('QueuePager: the region that speaks (the review of 5edada2)', () => {
  // Break caught: a status region that arrives with its words in it, which most screen readers do not announce: "Showing 25 requests" was heard only from the second page.
  it('is in the page empty on the first paint, and has its words afterwards', () => {
    const first = renderToStaticMarkup(
      <QueuePager
        label="Pages of pickup requests"
        noun={{ one: 'request', other: 'requests' }}
        shown={25}
        page={1}
        hasNext
        onNext={() => undefined}
        onPrevious={() => undefined}
      />,
    );
    expect(first).toMatch(/<p[^>]*role="status"[^>]*><\/p>/);
    expect(first).not.toContain('Showing 25');

    renderPager({ shown: 25, hasNext: true });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing 25 requests. More follow on the next page.',
    );
  });
});
