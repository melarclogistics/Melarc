import type { ComponentPropsWithoutRef } from 'react';

import { useFieldControl } from '../field/Field';
import './textarea.css';

export type TextareaProps = Omit<ComponentPropsWithoutRef<'textarea'>, 'className' | 'style'>;

/**
 * The Textarea (S0.60; COMPONENT_PATTERNS section 7, recorded as the multi-line sibling of the Input): a native `<textarea>` with the Input's
 * recipe, for the text a person writes in their own words and that does not fit a line, such as how a rider's identity was verified. It is
 * a control and nothing more: it holds no value of its own, counts nothing and decides no rule about what may be written (the screen and the
 * server do). Inside a Field it takes its id, its description and its invalid and required state from the Field; on its own it needs a name
 * from `aria-label` or `aria-labelledby`. It grows only downwards (the user may resize it vertically, and never past the width of its
 * container), starts at three rows and, like the Input, never clips enlarged text.
 */
export function Textarea({
  id,
  rows = 3,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  'aria-required': ariaRequired,
  ...rest
}: TextareaProps) {
  const field = useFieldControl();
  const description = [describedBy, field?.describedBy]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
  return (
    <textarea
      {...rest}
      rows={rows}
      // Inside a Field the Field owns the id, because its label points at it; a caller's id would orphan the label.
      id={field?.id ?? id}
      className="ui-textarea"
      aria-describedby={description === '' ? undefined : description}
      aria-invalid={field?.invalid === true ? true : ariaInvalid}
      aria-required={field?.required === true ? true : ariaRequired}
    />
  );
}
