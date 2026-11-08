import { useId, type ComponentPropsWithoutRef } from 'react';

import './checkbox.css';

export type CheckboxProps = Omit<
  ComponentPropsWithoutRef<'input'>,
  'className' | 'style' | 'type' | 'id' | 'children' | 'size'
> & {
  /** What ticking it means, in a short sentence-case phrase. It is the accessible name; nothing replaces it. */
  readonly label: string;
  /** What the choice does and does not do, for the person deciding. Linked with `aria-describedby`. */
  readonly help?: string;
};

/**
 * The Checkbox (COMPONENT_PATTERNS section 7.10): one native `<input type="checkbox">` with a real `<label>` that is part of its target, so the
 * whole phrase can be clicked or tapped, and optional help beneath it. It is a choice the person makes, never a state the page decides: it is
 * off unless the person turns it on (`defaultChecked` is for a choice that was already theirs), and it is read from the form at submit time
 * (`fieldChecked`). It takes no part in a Field, which is for a text control; a checkbox that needs an error says it in an Alert of the form.
 */
export function Checkbox({ label, help, 'aria-describedby': describedBy, ...rest }: CheckboxProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const hasHelp = help !== undefined && help !== '';
  const description = [describedBy, hasHelp ? helpId : undefined]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
  return (
    <div className="ui-checkbox">
      <input
        {...rest}
        id={id}
        type="checkbox"
        className="ui-checkbox__input"
        aria-describedby={description === '' ? undefined : description}
      />
      <label className="ui-checkbox__label" htmlFor={id}>
        {label}
      </label>
      {hasHelp ? (
        <p id={helpId} className="ui-checkbox__help">
          {help}
        </p>
      ) : null}
    </div>
  );
}
