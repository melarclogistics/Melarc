import type { ComponentPropsWithoutRef } from 'react';

import { useFieldControl } from '../field/Field';
import './input.css';

export type InputProps = Omit<ComponentPropsWithoutRef<'input'>, 'className' | 'style' | 'size'>;

/**
 * The initial Input (COMPONENT_PATTERNS section 7): a native single-line `<input>` at medium size, with no aesthetic
 * variants. Inside a Field it takes its id, its description and its invalid and required state from the Field; on its
 * own it needs a name from `aria-label` or `aria-labelledby`. Disabled and read-only are the native attributes, and they
 * look different on purpose.
 */
export function Input({
  id,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  'aria-required': ariaRequired,
  ...rest
}: InputProps) {
  const field = useFieldControl();
  const description = [describedBy, field?.describedBy]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
  return (
    <input
      {...rest}
      // Inside a Field the Field owns the id, because its label points at it; a caller's id would orphan the label.
      id={field?.id ?? id}
      className="ui-input"
      aria-describedby={description === '' ? undefined : description}
      aria-invalid={field?.invalid === true ? true : ariaInvalid}
      aria-required={field?.required === true ? true : ariaRequired}
    />
  );
}
