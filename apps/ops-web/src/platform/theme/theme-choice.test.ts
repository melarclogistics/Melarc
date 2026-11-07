import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyThemeChoice,
  currentThemeChoice,
  saveThemeChoice,
  startThemeChoice,
  storedThemeChoice,
  subscribeThemeChoice,
  THEME_STORAGE_KEY,
} from './theme-choice';

const root = document.documentElement;

/** The function that stops the listener of the `storage` event that `startThemeChoice` registered, when a test started it. */
let stopFollowing: () => void = () => undefined;

beforeEach(() => {
  localStorage.clear();
  delete root.dataset.theme;
});

afterEach(() => {
  vi.restoreAllMocks();
  stopFollowing();
  stopFollowing = () => undefined;
  localStorage.clear();
  delete root.dataset.theme;
});

describe('the stored choice of theme', () => {
  // Break caught: a default that is not "follow the system": a person who never chose gets a theme of the portal's picking.
  it('is system when nothing is stored', () => {
    expect(storedThemeChoice()).toBe('system');
  });

  // Break caught: a stored value read as it stands, so that a tampered or stale value ("blue", "") is written onto the root as a theme
  // that no token answers to.
  it.each(['', 'blue', 'LIGHT', 'system', 'null'])(
    'is system when what is stored is %j, which is not a choice that is kept',
    (value) => {
      localStorage.setItem(THEME_STORAGE_KEY, value);

      expect(storedThemeChoice()).toBe('system');
    },
  );

  it.each(['light', 'dark'] as const)('is %s when that is what is stored', (value) => {
    localStorage.setItem(THEME_STORAGE_KEY, value);

    expect(storedThemeChoice()).toBe(value);
  });

  // Break caught: storage that throws on a read (a private window, blocked site data) taking the page down with it.
  it('is system, and does not throw, when the browser refuses to read storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });

    expect(storedThemeChoice()).toBe('system');
  });
});

describe('showing and keeping the choice', () => {
  // Break caught: a choice written to storage and not to the root (a reload shows it and this page does not), or the reverse.
  it('light and dark are put on the root and kept under the one key', () => {
    saveThemeChoice('dark');

    expect(root.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(currentThemeChoice()).toBe('dark');

    saveThemeChoice('light');

    expect(root.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  // Break caught: "System" stored as a word, so that something about the person stays in the browser after they go back to following
  // their system (the approved storage is `light` or `dark` and nothing else), or the attribute left on the root and the system ignored.
  it('system takes the attribute off the root and removes the key', () => {
    saveThemeChoice('dark');

    saveThemeChoice('system');

    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(localStorage).toHaveLength(0);
    expect(currentThemeChoice()).toBe('system');
  });

  // Break caught: the one key being more than one (a second key for a "last chosen" or an "automatic" flag) or the module writing
  // anything else about the person.
  it('keeps nothing but the one key', () => {
    saveThemeChoice('dark');
    saveThemeChoice('light');

    expect(Object.keys(localStorage)).toEqual([THEME_STORAGE_KEY]);
  });

  // Break caught: a refused write undoing the choice for the page the person is on, so that a click in a private window does nothing.
  it('shows the choice for this page even when the browser refuses to keep it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });

    expect(() => {
      saveThemeChoice('dark');
    }).not.toThrow();

    expect(root.dataset.theme).toBe('dark');
  });

  // Break caught: the application starting without applying what is stored, which leaves a page whose pre-paint script did not run
  // (blocked, or a build that lost it) in the system theme for a person who chose another.
  it('is applied to the root when the application starts', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    startThemeChoice();

    expect(root.dataset.theme).toBe('dark');
  });

  it('starts as system when nothing is stored, and leaves the root as the system has it', () => {
    startThemeChoice();

    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('reads an attribute that is not a theme as system', () => {
    root.dataset.theme = 'blue';

    expect(currentThemeChoice()).toBe('system');
  });

  it('applyThemeChoice shows a choice without keeping it', () => {
    applyThemeChoice('dark');

    expect(root.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});

describe('following the choice', () => {
  // Break caught: a control that does not follow the root: a menu that says "Light" while the page is dark.
  it('tells a listener when the root changes theme', async () => {
    const listener = vi.fn();
    const stop = subscribeThemeChoice(listener);

    saveThemeChoice('dark');
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalled();
    });

    stop();
  });

  it('stops telling a listener that has gone', async () => {
    const listener = vi.fn();
    subscribeThemeChoice(listener)();

    saveThemeChoice('dark');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(listener).not.toHaveBeenCalled();
  });

  // Break caught: two tabs of one browser disagreeing: a person chooses dark in one and the other stays light until it is reloaded. Break caught (audit
  // B10, 7 November 2026): the listener registered by each component that watches the choice, so that a page with no theme control on the screen (the
  // pre-sign-in pages, a page that failed) never follows the other tab: it is registered once, when the application starts, and nothing watches here.
  it('shows a choice that another tab of the browser stored, with no component watching it', () => {
    stopFollowing = startThemeChoice();
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'dark' }));

    expect(root.dataset.theme).toBe('dark');
  });

  it('shows system when another tab removed the choice', () => {
    stopFollowing = startThemeChoice();
    saveThemeChoice('dark');

    localStorage.removeItem(THEME_STORAGE_KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: null }));

    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  // Break caught: another key's change in storage (a library's, a later feature's) reading as a change of theme.
  it('ignores a change of another key', () => {
    stopFollowing = startThemeChoice();
    saveThemeChoice('dark');
    localStorage.removeItem(THEME_STORAGE_KEY);

    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else', newValue: 'x' }));

    expect(root.dataset.theme).toBe('dark');
  });

  // Break caught: a watcher that adds a listener of the browser's (one more for every menu that shows the choice, each applying the same thing).
  it('adds no listener of storage by being watched', () => {
    const added = vi.spyOn(window, 'addEventListener');

    subscribeThemeChoice(() => undefined)();

    expect(added.mock.calls.filter(([type]) => type === 'storage')).toHaveLength(0);
  });

  // Break caught: a second call of the start that leaves the first listener behind, so that every change is applied twice for the life of the page; or
  // a stop that leaves the listener on.
  it('replaces the listener when the application is started again, and stops following when it is told to', () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    startThemeChoice();

    stopFollowing = startThemeChoice();

    expect(added.mock.calls.filter(([type]) => type === 'storage')).toHaveLength(2);
    expect(removed.mock.calls.filter(([type]) => type === 'storage')).toHaveLength(1);

    stopFollowing();
    stopFollowing = () => undefined;
    expect(removed.mock.calls.filter(([type]) => type === 'storage')).toHaveLength(2);
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'dark' }));
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});
