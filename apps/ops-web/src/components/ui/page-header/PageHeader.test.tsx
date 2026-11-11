import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Button } from '../button/Button';
import { FreshnessLine, PageHeader, type PageHeaderProps } from './PageHeader';

function renderHeader(props: PageHeaderProps) {
  return render(
    <MemoryRouter>
      <PageHeader {...props} />
    </MemoryRouter>,
  );
}

describe('PageHeader', () => {
  // Break caught: a page title that is not the page's one level-one heading, or that cannot take focus after a navigation, which is how a screen
  // reader is told the page changed (COMPONENT_PATTERNS section 11.3).
  it('is the page one level-one heading, and it can take focus', () => {
    renderHeader({ title: 'Pickup requests' });

    const heading = screen.getByRole('heading', { level: 1, name: 'Pickup requests' });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });

  // Break caught: a number the server did not give, drawn as 0 for want of an answer, or a count with no words for whoever hears the page.
  it('draws a count only when it is given, and says what it counts', () => {
    const { container, rerender } = renderHeader({ title: 'Pickup requests' });
    expect(container.querySelector('.ui-page-head__count')).toBeNull();

    rerender(
      <MemoryRouter>
        <PageHeader title="Pickup requests" count={{ value: 12480, noun: 'pickup requests' }} />
      </MemoryRouter>,
    );
    expect(screen.getByText('12,480', { selector: '[aria-hidden="true"]' })).toBeVisible();
    expect(screen.getByText('12,480 pickup requests')).toBeInTheDocument();
    // The count is not part of the heading: the heading is the title.
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Pickup requests');
  });

  // Break caught: a count of nothing dropped as if it were missing (a queue worked to empty is an answer), or drawn like a count of work.
  it('draws a count of 0 that was read, quietly', () => {
    const { container } = renderHeader({
      title: 'Pickup requests',
      count: { value: 0, noun: 'pickup requests' },
    });

    expect(screen.getByText('0 pickup requests')).toBeInTheDocument();
    expect(container.querySelector('.ui-page-head__count')).toHaveAttribute('data-quiet', 'true');
  });

  // Break caught: the actions drawn before the title (a keyboard and a screen reader meet a button before the page's name) or the description lost.
  it('shows the description and the actions when it has them, the actions after the title', () => {
    const { container } = renderHeader({
      title: 'Pickup requests',
      description: 'Requests waiting for a decision.',
      actions: <Button type="button">Book a pickup</Button>,
    });

    expect(screen.getByText('Requests waiting for a decision.')).toBeVisible();
    const header = container.querySelector<HTMLElement>('.ui-page-head');
    const order = [...(header?.querySelectorAll('h1, button') ?? [])].map(
      (element) => element.tagName,
    );
    expect(order).toEqual(['H1', 'BUTTON']);
  });

  // Break caught: an empty bar, line or trail left in the page, which assistive technology still walks through.
  it('draws nothing for what it was not given', () => {
    const { container } = renderHeader({ title: 'Pickup requests' });

    for (const part of ['trail', 'count', 'description', 'freshness', 'actions']) {
      expect(container.querySelector(`.ui-page-head__${part}`), part).toBeNull();
    }
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  describe('the freshness line', () => {
    // Break caught: a line for a page that was never read, which would say it is up to date for want of any word, or hold a Refresh with nothing to refresh.
    it('says nothing before the first read has been answered', () => {
      const { container } = renderHeader({
        title: 'Pickup requests',
        freshness: { onRefresh: vi.fn() },
      });

      expect(container.querySelector('.ui-page-head__freshness')).toBeNull();
    });

    // Break caught: a freshness line that does not say when the page was last read, or offers no way to read it again.
    it('says when the page was last read, and offers to refresh it', async () => {
      const user = userEvent.setup();
      const onRefresh = vi.fn();
      renderHeader({ title: 'Pickup requests', freshness: { updatedAt: '09:42', onRefresh } });

      expect(screen.getByRole('status')).toHaveTextContent('Updated 09:42');
      await user.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    // Break caught: a press during a read that starts another one (the queue asks one read at a time), or a button that loses its place while busy.
    it('is busy while a read is under way: Refresh stays, says it is busy and ignores a press', async () => {
      const user = userEvent.setup();
      const onRefresh = vi.fn();
      renderHeader({
        title: 'Pickup requests',
        freshness: { state: 'refreshing', updatedAt: '09:42', onRefresh },
      });

      const refresh = screen.getByRole('button', { name: 'Refresh' });
      expect(refresh).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByRole('status')).toHaveTextContent('Checking…');
      await user.click(refresh);
      expect(onRefresh).not.toHaveBeenCalled();
      refresh.focus();
      expect(refresh).toHaveFocus();
    });

    // Break caught (run 7, Stage 2.4; the Product Owner's review of 198e5be): a Refresh that is pressed and ignored while the page cannot be read again (the builder's pool while the pickup run
    // is made), the person left to wonder why nothing happens. The line says why in words, and the button is disabled, not silent.
    it('says in words why Refresh cannot be used for now, and disables it', async () => {
      const user = userEvent.setup();
      const onRefresh = vi.fn();
      renderHeader({
        title: 'Pickup requests',
        freshness: {
          updatedAt: '09:42',
          unavailable: 'Refresh waits until the pickup run is made.',
          onRefresh,
        },
      });

      const refresh = screen.getByRole('button', { name: 'Refresh' });
      expect(refresh).toBeDisabled();
      expect(screen.getByRole('status')).toHaveTextContent(
        'Updated 09:42. Refresh waits until the pickup run is made.',
      );
      await user.click(refresh);
      expect(onRefresh).not.toHaveBeenCalled();
    });

    // Break caught: the disabled state kept after the reason has gone.
    it('is enabled again once nothing stops it', () => {
      renderHeader({
        title: 'Pickup requests',
        freshness: { updatedAt: '09:42', onRefresh: vi.fn() },
      });

      expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
      expect(screen.getByRole('status')).toHaveTextContent(/^Updated 09:42$/);
    });

    // Break caught: a failed read told as if the page were current, or its last good time lost, or no way to try again.
    it('says a read failed with the last time it worked, and offers to try again', async () => {
      const user = userEvent.setup();
      const onRefresh = vi.fn();
      renderHeader({
        title: 'Pickup requests',
        freshness: { state: 'failed', updatedAt: '09:42', onRefresh },
      });

      expect(screen.getByRole('status')).toHaveTextContent(
        'Refresh failed. Last successful check: 09:42',
      );
      await user.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    // Break caught: a time invented for a page that was never read ("last successful check: " with nothing after it, or now), which would be a lie.
    it('says a read failed without inventing a time when none ever worked', () => {
      renderHeader({
        title: 'Pickup requests',
        freshness: { state: 'failed', onRefresh: vi.fn() },
      });

      expect(screen.getByRole('status')).toHaveTextContent(/^Refresh failed\.$/);
    });
  });

  describe('the breadcrumb', () => {
    // Break caught: a trail that is not a navigation landmark with a name, or whose links go nowhere.
    it('is a named navigation of links, in order', () => {
      renderHeader({
        title: 'ACC-PR-7KQ2MZ',
        breadcrumb: [
          { label: 'Pickups', to: '/pickups' },
          { label: 'Pickup requests', to: '/pickup-requests' },
        ],
      });

      const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
      const links = within(trail).getAllByRole('link');
      expect(links.map((link) => link.textContent)).toEqual(['Pickups', 'Pickup requests']);
      expect(links.map((link) => link.getAttribute('href'))).toEqual([
        '/pickups',
        '/pickup-requests',
      ]);
    });

    // Break caught: the steps of a trail keyed by their address, so that two steps that share one (a list and its filtered view) are drawn as one or not
    // at all, and React says so in the console (found by the browser run of the showcase, whose trail did exactly this).
    it('draws two steps that share an address, each once, and without a warning from React', () => {
      const warned = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      renderHeader({
        title: 'Run ACC-MF-Q92422',
        breadcrumb: [
          { label: 'Dispatch', to: '/runs' },
          { label: 'Pickup runs', to: '/runs' },
        ],
      });

      const links = within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole(
        'link',
      );
      expect(links.map((link) => link.textContent)).toEqual(['Dispatch', 'Pickup runs']);
      expect(warned).not.toHaveBeenCalled();
      warned.mockRestore();
    });
  });

  // Break caught: a trail, a status line or a heading that a rule of WCAG 2.2 can see is wrong without a layout engine (an unnamed navigation, a list outside its parent).
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = renderHeader({
      title: 'Pickup requests',
      description: 'Requests waiting for a decision.',
      count: { value: 12, noun: 'pickup requests' },
      freshness: { updatedAt: '09:42', onRefresh: vi.fn() },
      breadcrumb: [{ label: 'Pickups', to: '/pickups' }],
      actions: <Button type="button">Book a pickup</Button>,
    });

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('FreshnessLine', () => {
  // Break caught (the Product Owner, 10 November 2026): a pane that is not a page header (the builder's pool) writing its own words for how current it is and for the way to read it again
  // ("Last checked 09:42. Refresh the pool"), so that two screens say it two ways. The line is the header's own, drawn alone: the same words in each of its states, and the same button.
  it('says how current the results are in the words of the page header, drawn alone', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const { rerender } = render(<FreshnessLine freshness={{ updatedAt: '09:42', onRefresh }} />);

    expect(screen.getByRole('status')).toHaveTextContent('Updated 09:42');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(<FreshnessLine freshness={{ state: 'refreshing', updatedAt: '09:42', onRefresh }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking…');
    // One read at a time: a press while a read is under way is that read's.
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(<FreshnessLine freshness={{ state: 'failed', updatedAt: '09:42', onRefresh }} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Refresh failed. Last successful check: 09:42',
    );
  });

  it('says nothing of a pane that was never read', () => {
    const { container } = render(<FreshnessLine freshness={{ onRefresh: vi.fn() }} />);

    expect(container).toBeEmptyDOMElement();
  });
});
