import { useId } from 'react';

import { Icon } from '../icon/Icon';
import './radio.css';

/** One choice of a group: what it is called, and a line of help under it when the name alone does not say what choosing it does. */
export interface RadioOption {
  readonly value: string;
  readonly label: string;
  readonly help?: string;
  /** The choice exists and cannot be made here. Say why in the group's help: a greyed-out choice explains nothing by itself. */
  readonly disabled?: boolean;
}

export interface RadioGroupProps {
  /** What the group asks, as its legend: short, specific, sentence case. It names every choice in it for assistive technology. */
  readonly legend: string;
  /** The name the choices share in the form. Unique in a form. */
  readonly name: string;
  readonly options: readonly RadioOption[];
  /** The value chosen, or null when none is: a group never chooses for the person, so nothing is checked until they choose. */
  readonly value: string | null;
  readonly onChange: (value: string) => void;
  /** What choosing means, or what the choices depend on. Not for errors. */
  readonly help?: string;
  /** What is wrong and how to correct it. Its presence makes every choice invalid, so the form's focus goes to the group. */
  readonly error?: string;
  readonly required?: boolean;
  /** No choice can be changed now, for example while what was chosen is being sent. */
  readonly disabled?: boolean;
}

const present = (text: string | undefined): text is string => text !== undefined && text !== '';

/**
 * A group of mutually exclusive choices (COMPONENT_PATTERNS section 7, the Field's rules applied to a group): a native `<fieldset>` named by its
 * `<legend>`, of native radio buttons each with a real `<label>`, so the browser gives the keyboard (Tab enters the group at the chosen
 * choice, or the first, and the arrow keys move and choose), the names and the forced-colours drawing. **It has no default**: until the person
 * chooses, nothing is checked, because a choice made by the page would be accepted unread (an option preselected by inertia is a decision
 * nobody made). Help and error are tied to every choice with `aria-describedby`, and an error marks each choice invalid, so the form's
 * focus goes to the group and its error is read. It decides nothing about what the choices mean: the screen says that.
 */
export function RadioGroup({
  legend,
  name,
  options,
  value,
  onChange,
  help,
  error,
  required = false,
  disabled = false,
}: RadioGroupProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const hasHelp = present(help);
  const hasError = present(error);
  const values = new Set<string>();
  for (const option of options) {
    if (values.has(option.value)) {
      throw new Error(`Two choices of the group "${legend}" have the value "${option.value}".`);
    }
    values.add(option.value);
  }

  return (
    <fieldset
      className={hasError ? 'ui-radio-group ui-radio-group--invalid' : 'ui-radio-group'}
      disabled={disabled}
    >
      <legend className="ui-radio-group__legend">
        {legend}
        {required ? (
          <>
            {/* A text node of its own: a space inside the span is dropped from the accessible name. */}{' '}
            <span className="ui-radio-group__required">(required)</span>
          </>
        ) : null}
      </legend>
      {hasHelp ? (
        <p id={helpId} className="ui-radio-group__help">
          {help}
        </p>
      ) : null}
      <div className="ui-radio-group__choices">
        {options.map((option, index) => {
          const optionId = `${id}-${String(index)}`;
          const optionHelpId = `${optionId}-help`;
          const describedBy = [
            present(option.help) ? optionHelpId : undefined,
            hasHelp ? helpId : undefined,
            hasError ? errorId : undefined,
          ]
            .filter((part) => part !== undefined)
            .join(' ');
          return (
            <div key={option.value} className="ui-radio">
              <input
                id={optionId}
                className="ui-radio__input"
                type="radio"
                name={name}
                value={option.value}
                checked={value === option.value}
                disabled={option.disabled === true}
                required={required}
                aria-invalid={hasError ? true : undefined}
                aria-describedby={describedBy === '' ? undefined : describedBy}
                onChange={() => {
                  onChange(option.value);
                }}
              />
              <label className="ui-radio__label" htmlFor={optionId}>
                {option.label}
              </label>
              {present(option.help) ? (
                <p id={optionHelpId} className="ui-radio__help">
                  {option.help}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      {hasError ? (
        <p id={errorId} className="ui-radio-group__error">
          <Icon name="warning" size="sm" className="ui-radio-group__error-icon" />
          <span>{error}</span>
        </p>
      ) : null}
    </fieldset>
  );
}
