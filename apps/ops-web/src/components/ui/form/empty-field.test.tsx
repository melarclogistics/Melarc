import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { emptyField, fieldChecked } from './use-submission';

/** A form as a screen builds one: named fields read at submit time. */
function formOf(markup: React.ReactElement): HTMLFormElement {
  const { container } = render(markup);
  const form = container.querySelector('form');
  if (form === null) throw new Error('no form');
  return form;
}

describe('emptyField: a secret typed into a form is not left there', () => {
  it('empties the named text field, hands it back, and leaves the others alone', () => {
    const form = formOf(
      <form>
        <input name="email" defaultValue="officer@example.test" />
        <input name="password" type="password" defaultValue="a long enough passphrase" />
      </form>,
    );

    const field = emptyField(form, 'password');

    expect(field).toBe(form.elements.namedItem('password'));
    expect(field?.value).toBe('');
    expect((form.elements.namedItem('email') as HTMLInputElement).value).toBe(
      'officer@example.test',
    );
  });

  // Break caught: a field that is not there being treated as emptied, or a control that is not a text field being touched.
  it('does nothing, and says so, for a name the form does not have or a control that is not an input', () => {
    const form = formOf(
      <form>
        <select name="choice" defaultValue="b">
          <option value="a">A</option>
          <option value="b">B</option>
        </select>
      </form>,
    );

    expect(emptyField(form, 'missing')).toBeUndefined();
    expect(emptyField(form, 'choice')).toBeUndefined();
    expect((form.elements.namedItem('choice') as HTMLSelectElement).value).toBe('b');
  });
});

describe('fieldChecked: a choice is read at submit time', () => {
  // Break caught: a box that is off read as on (a default the person never made), or a box the form does not have read as on.
  it('is true for a box that is on, false for one that is off, and false for a name the form does not have', () => {
    const form = formOf(
      <form>
        <input type="checkbox" name="on" defaultChecked />
        <input type="checkbox" name="off" />
        <input type="text" name="text" defaultValue="" />
      </form>,
    );

    expect(fieldChecked(form, 'on')).toBe(true);
    expect(fieldChecked(form, 'off')).toBe(false);
    expect(fieldChecked(form, 'missing')).toBe(false);
  });
});
