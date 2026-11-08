import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { ForbiddenPage, ForbiddenState, type ForbiddenKind } from './ForbiddenState';

const KINDS: readonly ForbiddenKind[] = [
  'permission-missing',
  'insufficient-authority',
  'outside-hubs',
  'approval-required',
  'unavailable-here',
];

const KEY = 'pickup.exception.approve';

describe('ForbiddenState', () => {
  // Break caught: a refusal that says only "access denied". Each kind is a different remedy, and the sentence says which.
  it('says a different thing for each kind of refusal', () => {
    const sentences = KINDS.map((kind) => {
      const { container, unmount } = render(<ForbiddenState kind={kind} permission={KEY} />);
      const text = container.textContent;
      unmount();
      return text;
    });

    expect(new Set(sentences).size).toBe(KINDS.length);
  });

  // Break caught: the permission missing from the refusal. "The page names the permission, never a role" (ops-portal.md section 7).
  it('names the permission the refusal is about, as text', () => {
    render(<ForbiddenState kind="permission-missing" permission="staff.read" />);

    expect(screen.getByText('staff.read')).toBeVisible();
    expect(screen.getByText('staff.read').tagName).toBe('CODE');
  });

  it('reads an approval as an approver who holds the permission deciding it', () => {
    render(<ForbiddenState kind="approval-required" permission={KEY} />);

    expect(screen.getByText(KEY)).toBeVisible();
    expect(document.body.textContent).toMatch(/approver/i);
    expect(document.body.textContent).not.toMatch(/you lack access|do not have access/i);
  });

  it('copes with an approval that names no permission', () => {
    render(<ForbiddenState kind="approval-required" />);

    expect(document.body.textContent).toMatch(/different approver/i);
  });

  // Break caught: a refusal that names a role. A role is not a thing the client may know or decide on, and authority is a held key.
  it.each(KINDS)('names no role in the refusal %s', (kind) => {
    for (const permission of [undefined, KEY]) {
      const { container, unmount } = render(
        <ForbiddenState
          {...(kind === 'permission-missing'
            ? { kind, permission: permission ?? KEY }
            : { kind, ...(permission === undefined ? {} : { permission }) })}
        />,
      );
      expect(container.textContent).not.toMatch(/admin|role|bundle|officer|senior ops|ops staff/i);
      unmount();
    }
  });

  // Break caught: a permission key taken for markup, or one that lets a hostile string into the page as anything but text.
  it('shows a key as text, whatever it holds', () => {
    const hostile = '<img src=x onerror="document.title=1">';
    const { container } = render(<ForbiddenState kind="permission-missing" permission={hostile} />);

    expect(screen.getByText(hostile)).toBeVisible();
    expect(container.querySelector('img')).toBeNull();
  });

  it('is an alert in the page, with no heading of its own level and no live region unless it is announced', () => {
    const { rerender } = render(
      <ForbiddenState kind="permission-missing" permission="staff.read" />,
    );

    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    rerender(<ForbiddenState kind="permission-missing" permission="staff.read" announce />);

    expect(screen.getByRole('alert')).toHaveTextContent('staff.read');
  });

  it('requires the permission for a missing permission and for nothing else', () => {
    // @ts-expect-error a missing permission is a refusal about a key, and it must name it
    render(<ForbiddenState kind="permission-missing" />);
    render(<ForbiddenState kind="outside-hubs" />);
    render(<ForbiddenState kind="insufficient-authority" permission={KEY} />);

    expect(screen.getAllByText(/./).length).toBeGreaterThan(0);
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <>
        {KINDS.map((kind) => (
          <ForbiddenState key={kind} kind={kind} permission={KEY} />
        ))}
      </>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('ForbiddenPage', () => {
  // Break caught: a refusal page that is not a page: no title for the tab, or a heading that is not the page's one level-one
  // heading, which the router moves focus to after a navigation.
  it.each(KINDS)('is a page with its own title and one level-one heading for %s', (kind) => {
    render(<ForbiddenPage kind={kind} permission={KEY} />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.title).toBe('No access · Melarc Ops Portal');
  });

  it('keeps the wording the guard has always had for a missing permission', () => {
    render(<ForbiddenPage kind="permission-missing" permission="staff.read" />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'You do not have access to this page' }),
    ).toBeVisible();
    expect(screen.getByText('staff.read')).toBeVisible();
  });

  it('says what is wrong in the heading for a record outside the hubs', () => {
    render(<ForbiddenPage kind="outside-hubs" />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'This is outside your hubs' }),
    ).toBeVisible();
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <ForbiddenPage kind="permission-missing" permission="staff.read" />,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
