import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { ConnectionBanner } from './ConnectionBanner';

/**
 * The connection banner of the kit (COMPONENT_PATTERNS, *ConnectionBanner*): it tells a person at the hub floor that **what they do now is not saved**, because the browser says it is offline or because the page
 * has seen a request fail for the network. A person who is typing a count into a tablet in a stockroom must not find out only when they press send. **It is generic and routes nothing**: a page draws it where
 * it wants it, and says when a request failed. It is a polite status that is in the page before it has anything to say (so that what it says is announced), it has no way to be dismissed (it goes when the
 * connection is back, and only then), and it never blocks the page: it is a line of the page, not a layer over it.
 */
const WORDS = 'No connection. What you do now is not saved.';

const browserSays = (online: boolean): void => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
};
const goes = (event: 'online' | 'offline', online: boolean): void => {
  browserSays(online);
  act(() => {
    window.dispatchEvent(new Event(event));
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConnectionBanner', () => {
  // Break caught: a banner that is drawn for a person who is online, which is noise on every page and taught to be ignored.
  it('says nothing while the browser is online and no request has failed', () => {
    browserSays(true);

    render(<ConnectionBanner />);

    expect(screen.queryByText(WORDS)).toBeNull();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  // Break caught: a banner that does not come when the browser goes offline, or one that says what is not true (that nothing is lost).
  it('says that nothing is saved when the browser goes offline, and no more when it is back online', () => {
    browserSays(true);
    render(<ConnectionBanner />);

    goes('offline', false);
    expect(screen.getByText(WORDS)).toBeVisible();

    goes('online', true);
    expect(screen.queryByText(WORDS)).toBeNull();
  });

  // Break caught: a banner that waits for an event while the browser was offline from the start.
  it('says it at once when the page is drawn while the browser is offline', () => {
    browserSays(false);

    render(<ConnectionBanner />);

    expect(screen.getByText(WORDS)).toBeVisible();
  });

  // Break caught: a page that has seen its own request fail for the network (the browser said online all the while: a captive portal, a dead mobile signal) and is silent about it.
  it('says it when the page says a request failed for the network, though the browser says it is online', () => {
    browserSays(true);
    const view = render(<ConnectionBanner requestFailed={false} />);
    expect(screen.queryByText(WORDS)).toBeNull();

    view.rerender(<ConnectionBanner requestFailed />);
    expect(screen.getByText(WORDS)).toBeVisible();

    view.rerender(<ConnectionBanner requestFailed={false} />);
    expect(screen.queryByText(WORDS)).toBeNull();
  });

  // Break caught: a banner that goes when the browser says online while the page's own request still fails (the browser's word is not the only one), or one that stays when both are well.
  it('stays while either says the connection is gone', () => {
    browserSays(false);
    const view = render(<ConnectionBanner requestFailed />);

    goes('online', true);
    expect(screen.getByText(WORDS)).toBeVisible();

    view.rerender(<ConnectionBanner requestFailed={false} />);
    expect(screen.queryByText(WORDS)).toBeNull();
  });

  // Break caught: a banner with a close button, so that a person dismisses the one thing that tells them their work is not being saved and goes on typing into a void.
  it('has no way to be dismissed: nothing to press, and it goes only when the connection is back', () => {
    browserSays(false);

    render(<ConnectionBanner />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  // Break caught: a banner drawn as a status that is added to the page with its words (a region that appears with its text is not announced reliably): the region is there first.
  it('is one polite status region that is in the page before it has anything to say, and says it in that region', () => {
    browserSays(true);
    render(<ConnectionBanner />);
    const region = screen.getByRole('status');

    goes('offline', false);

    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent(WORDS);
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  // Break caught: a banner told by an icon alone, or an icon that is read as well as the words.
  it('has an icon and the words, and the icon is not read', () => {
    browserSays(false);

    const { container } = render(<ConnectionBanner />);

    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('status')).toHaveAccessibleName('');
    expect(screen.getByText(WORDS)).toBeVisible();
  });

  // Break caught: a banner that traps focus or takes the page away from a person: it is not a dialog and it makes nothing inert.
  it('never blocks the page: it is not a dialog and it takes no focus', () => {
    browserSays(false);

    render(<ConnectionBanner />);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('status').closest('[aria-modal], [inert]')).toBeNull();
    expect(document.body).toHaveFocus();
  });

  // Break caught: words that are fixed in the component, when a page has its own (the receiving screens name what is not saved).
  it('says the page’s own words when it has some', () => {
    browserSays(false);

    render(<ConnectionBanner words="No connection. The count you are entering is not saved." />);

    expect(
      screen.getByText('No connection. The count you are entering is not saved.'),
    ).toBeVisible();
    expect(screen.queryByText(WORDS)).toBeNull();
  });

  // Break caught: a violation of its own, offline or not: contrast, a region without a name that it needs, an icon read as an image.
  it('has no accessibility violations, online or offline', async () => {
    browserSays(true);
    const view = render(<ConnectionBanner />);
    expect(await wcagViolations(view.container)).toEqual([]);

    goes('offline', false);
    expect(await wcagViolations(view.container)).toEqual([]);
  });
});
