import { useEffect, useRef, useState } from 'react';

import { IconButton } from '../icon-button/IconButton';
import { Input, type InputProps } from '../input/Input';
import './password-input.css';

export interface PasswordInputProps extends Omit<InputProps, 'type' | 'autoComplete'> {
  /**
   * Always stated, because the browser and the password manager cannot tell a sign-in from a new password without it:
   * `current-password` for a field that proves a password, `new-password` for one that sets it.
   */
  readonly autoComplete: 'current-password' | 'new-password';
  /** Offer to show what was typed. On unless a screen has a reason to leave it out. */
  readonly revealable?: boolean;
}

/**
 * A password field (COMPONENT_PATTERNS section 6). It is an `Input` that hides what is typed, with the settings a password
 * wants: no capitalisation, correction or spell checking, and the value exactly as typed. It does not trim, truncate or
 * change case (the credential rule is the server's and counts what was typed), it does not block paste, and it holds no
 * copy of the value: a screen reads it from the form when it is submitted and does not keep it.
 *
 * "Show password" is an eye in the field, an icon button the person presses (its name says what it does: "Show password", then
 * "Hide password", with the open and the crossed eye), announced when it changes what is on the screen, and it hides the
 * password again when the form is submitted. Inside a Field the field's label names the input and its help and error
 * describe it.
 */
export function PasswordInput({ autoComplete, revealable = true, ...rest }: PasswordInputProps) {
  const [shown, setShown] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const container = useRef<HTMLDivElement>(null);

  // A password that was shown does not stay on the screen once the form has been sent.
  useEffect(() => {
    if (!shown) return;
    const form = container.current?.closest('form');
    if (form === null || form === undefined) return;
    const hide = (): void => {
      setShown(false);
      setAnnouncement('Password hidden');
    };
    form.addEventListener('submit', hide);
    return () => {
      form.removeEventListener('submit', hide);
    };
  }, [shown]);

  return (
    <div className="ui-password" ref={container}>
      <Input
        {...rest}
        type={shown ? 'text' : 'password'}
        autoComplete={autoComplete}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {revealable ? (
        <IconButton
          type="button"
          icon={shown ? 'hide-password' : 'show-password'}
          label={shown ? 'Hide password' : 'Show password'}
          disabled={rest.disabled}
          onClick={() => {
            setShown(!shown);
            setAnnouncement(shown ? 'Password hidden' : 'Password shown');
          }}
        />
      ) : null}
      <span className="ui-password__status" role="status">
        {announcement}
      </span>
    </div>
  );
}
