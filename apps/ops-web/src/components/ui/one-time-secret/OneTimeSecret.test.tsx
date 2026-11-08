import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { OneTimeSecret } from './OneTimeSecret';

const KEY = 'JBSWY3DPEHPK3PXP';

describe('OneTimeSecret: what it shows', () => {
  // Break caught: a key shown without a name, or in a form a person cannot read aloud or type: the manual key is the
  // accessible alternative to the QR code, so it has to be usable by a person who cannot scan.
  it('shows the key in groups, in a read-only field named by its label', () => {
    render(
      <OneTimeSecret
        label="Setup key"
        secret={KEY}
        help="Type this key into your authenticator app."
      />,
    );

    const field = screen.getByRole('textbox', { name: 'Setup key' });
    expect(field).toHaveValue('JBSW Y3DP EHPK 3PXP');
    expect(field).toHaveAttribute('readonly');
    expect(field).toHaveAccessibleDescription('Type this key into your authenticator app.');
  });

  it('can show the key ungrouped', () => {
    render(<OneTimeSecret label="Setup key" secret={KEY} groupSize={0} />);

    expect(screen.getByRole('textbox', { name: 'Setup key' })).toHaveValue(KEY);
  });

  // Break caught: the field being selectable and focusable, which a read-only field must be, and not editable.
  it('can be reached by Tab and read, and cannot be edited', async () => {
    const user = userEvent.setup();
    render(<OneTimeSecret label="Setup key" secret={KEY} />);
    const field = screen.getByRole('textbox', { name: 'Setup key' });

    await user.tab();
    expect(field).toHaveFocus();
    await user.keyboard('x');

    expect(field).toHaveValue('JBSW Y3DP EHPK 3PXP');
  });
});

describe('OneTimeSecret: where it goes', () => {
  // Break caught: the secret submitted with the form it sits in (a field with a name is part of the form data), so a
  // form around it sends it to the server a second time.
  it('is not part of the form around it', () => {
    render(
      <form aria-label="Enrolment">
        <OneTimeSecret label="Setup key" secret={KEY} />
        <input name="code" defaultValue="123456" />
      </form>,
    );
    const form = screen.getByRole<HTMLFormElement>('form', { name: 'Enrolment' });

    const data = new FormData(form);

    expect([...data.keys()]).toEqual(['code']);
    expect(JSON.stringify([...data.entries()])).not.toContain('JBSW');
  });

  // Break caught: the browser or a password manager offering to remember the key, or to fill it somewhere else.
  it('asks the browser not to remember it, complete it or check its spelling', () => {
    render(<OneTimeSecret label="Setup key" secret={KEY} />);
    const field = screen.getByRole('textbox', { name: 'Setup key' });

    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).toHaveAttribute('spellcheck', 'false');
    expect(field).not.toHaveAttribute('name');
  });

  // Break caught: a "copy" button, which puts a bearer secret on the system clipboard, where clipboard history and other
  // programs keep it. The key is typed by hand: that is what the QR code's alternative is for.
  it('offers no copy button and writes nothing to the clipboard', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<OneTimeSecret label="Setup key" secret={KEY} />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });

  // Break caught: the key also written to a tooltip, an accessible name, a data attribute or a link, each of which is read,
  // copied or indexed by things that a field's value is not.
  it('has the key in the value of its one field and in no other attribute or element of the page', () => {
    const { container } = render(<OneTimeSecret label="Setup key" secret={KEY} />);

    const holders = [...container.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes]
        .filter((attribute) => attribute.value.includes('JBSW'))
        .map((attribute) => `${element.tagName.toLowerCase()}[${attribute.name}]`),
    );
    expect(holders).toEqual(['input[value]']);
    expect(container.textContent).not.toContain('JBSW');
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('OneTimeSecret: accessibility', () => {
  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <OneTimeSecret label="Setup key" secret={KEY} help="Type this key into your app." />,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
