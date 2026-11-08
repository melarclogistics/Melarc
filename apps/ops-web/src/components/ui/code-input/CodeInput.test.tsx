import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Field } from '../field/Field';
import { CodeInput } from './CodeInput';

function Controlled({ onValue }: { readonly onValue?: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <Field label="Code from your authenticator app" required help="Six digits.">
      <CodeInput
        name="code"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          onValue?.(event.target.value);
        }}
      />
    </Field>
  );
}

const field = () =>
  screen.getByRole('textbox', { name: 'Code from your authenticator app (required)' });

describe('CodeInput: what it asks of the browser', () => {
  // Break caught: a code field that opens a full keyboard on a phone, or that is not offered the code that arrived by
  // message or from the authenticator.
  it('asks for the numeric keyboard and for a one-time code', () => {
    render(<Controlled />);

    expect(field()).toHaveAttribute('inputmode', 'numeric');
    expect(field()).toHaveAttribute('autocomplete', 'one-time-code');
    expect(field()).toHaveAttribute('pattern', '[0-9]*');
  });

  // Break caught: the browser "correcting" a code, or storing it as a form entry to suggest later.
  it('turns off capitalisation, correction and spell checking', () => {
    render(<Controlled />);

    expect(field()).toHaveAttribute('autocapitalize', 'off');
    expect(field()).toHaveAttribute('autocorrect', 'off');
    expect(field()).toHaveAttribute('spellcheck', 'false');
  });

  it('is named by its label and described by its help and error', () => {
    render(
      <Field label="Code" help="Six digits." error="That code is not right.">
        <CodeInput />
      </Field>,
    );

    expect(screen.getByRole('textbox', { name: 'Code' })).toHaveAccessibleDescription(
      'Six digits. That code is not right.',
    );
    expect(screen.getByRole('textbox', { name: 'Code' })).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('CodeInput: the value is digits, and at most the length', () => {
  it('takes digits as they are typed', async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(field(), '123456');

    expect(field()).toHaveValue('123456');
  });

  // Break caught: letters and punctuation accepted into a code that can only be digits, which fails later with an error
  // about a value the person cannot see.
  it('ignores what is not a digit', async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(field(), '1a2-b3 4.5!6');

    expect(field()).toHaveValue('123456');
  });

  // Break caught: a pasted code like "123 456", which authenticator apps display with a space, being refused or keeping
  // its space.
  it('strips spaces and separators from a pasted code', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.click(field());

    await user.paste('123 456');

    expect(field()).toHaveValue('123456');
  });

  // Break caught: a longer value, such as a pasted sentence, filling the field.
  it('keeps no more digits than the length', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.click(field());

    await user.paste('1234567890');

    expect(field()).toHaveValue('123456');
  });

  it('takes the length it is given', async () => {
    const user = userEvent.setup();
    render(
      <Field label="Code">
        <CodeInput length={8} />
      </Field>,
    );

    await user.type(screen.getByRole('textbox', { name: 'Code' }), '1234567890');

    expect(screen.getByRole('textbox', { name: 'Code' })).toHaveValue('12345678');
  });

  // Break caught: the change handler hearing the raw value, so the screen's own state holds what the field does not.
  it('tells its change handler the cleaned value only', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Controlled onValue={onValue} />);

    await user.type(field(), '1x2');

    expect(onValue.mock.calls.map(([value]) => value as string)).toEqual(['1', '1', '12']);
  });

  it('works without being controlled', async () => {
    const user = userEvent.setup();
    render(
      <Field label="Code">
        <CodeInput defaultValue="12" />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Code' });

    await user.type(input, 'x34');

    expect(input).toHaveValue('1234');
  });
});

describe('CodeInput: accessibility', () => {
  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <>
        <Controlled />
        <Field label="Disabled code">
          <CodeInput disabled />
        </Field>
      </>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
