import type { ChangeEvent } from 'react';

import { Input, type InputProps } from '../input/Input';

export interface CodeInputProps extends Omit<
  InputProps,
  'type' | 'inputMode' | 'autoComplete' | 'maxLength' | 'pattern'
> {
  /** How many digits the code has. The contract's one-time codes are six. */
  readonly length?: number;
}

/**
 * A field for a code of digits, such as the six digits from an authenticator app (COMPONENT_PATTERNS section 6). It asks
 * the browser for the numeric keyboard and for a one-time code, and keeps only digits, at most `length` of them: what is
 * typed that is not a digit is dropped, a pasted "123 456" becomes "123456", and a longer paste is cut. The change
 * handler hears the cleaned value only, so a screen's own state never holds what the field does not.
 *
 * It does not check the code; the server does. It is a text field and not a password field on purpose: a code is used
 * once, and being able to see it is what lets a person catch a slip before the code expires.
 */
export function CodeInput({ length = 6, onChange, ...rest }: CodeInputProps) {
  const clean = (event: ChangeEvent<HTMLInputElement>): void => {
    const digits = event.target.value.replaceAll(/\D/g, '').slice(0, length);
    if (digits !== event.target.value) event.target.value = digits;
    onChange?.(event);
  };

  return (
    <Input
      {...rest}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="one-time-code"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      onChange={clean}
    />
  );
}
