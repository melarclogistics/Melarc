import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { Button } from '../button/Button';
import { Field } from '../field/Field';
import { Input } from '../input/Input';
import { ReadState, type ReadQuery } from '../read-state/ReadState';
import './picker.css';

/** One thing a search found: what to call it, a line that tells it from others of the same name, and the value a form keeps. */
export interface PickerOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface PickerProps {
  /** What is being chosen, as the group's legend: "Vendor". */
  readonly label: string;
  /** The label of the search field: "Search by name or account". */
  readonly searchLabel: string;
  /** Format expectations for the search, under the field. */
  readonly searchHelp?: string;
  /** The keyboard a phone shows for the search: `tel` for a phone number. */
  readonly inputMode?: 'text' | 'tel';
  readonly maxLength?: number;
  /** The words of the button that searches: "Search", "Find the sender". */
  readonly searchAction: string;
  /** The person asked for this text. The screen reads the server with it and hands the read back as `results`. Blank is no search. */
  readonly onSearch: (text: string) => void;
  /** The read of the last search, or nothing before the first. The picker holds no list of its own. */
  readonly results: ReadQuery<readonly PickerOption[]> | undefined;
  /** What to say when the search found nothing: the screen's words, with what to do next. */
  readonly noResults: ReactNode;
  /** More matched than the read returned: the person is told to narrow the search, never shown a part as if it were the whole. */
  readonly moreResults?: boolean;
  /** The choice the form holds, or none. */
  readonly value: PickerOption | null;
  readonly onChange: (option: PickerOption | null) => void;
  /** The words of the button that chooses a result: "Choose", "Use this sender". Each result's button is named with its label too. */
  readonly chooseAction: string;
  /** The words of the button that sets a choice aside to search again: "Choose another vendor". */
  readonly changeAction: string;
  /** What is wrong: nothing is chosen, or the choice was refused. It goes on the search field, where focus goes to correct it. */
  readonly error?: string;
  readonly required?: boolean;
  /** Nothing can be changed now, for example while what was chosen is being sent. */
  readonly disabled?: boolean;
  /** The `operationId` of the read and the permission it needs, so that its failures are worded for it and a refusal names the key. */
  readonly operation?: string;
  readonly context?: string;
  readonly permission?: string;
}

/**
 * A searchable picker (the vendor of a booking, a returning sender found by phone): a search field, the results as a list with a button to
 * choose each, and once one is chosen, that choice with a button to choose another. It is made of native parts (an input, a list, buttons), so
 * nothing about it needs a library: Enter in the field searches and never submits the form around it, Tab goes through the results in order,
 * and a choice is a press of a button, never a side effect of moving through a list. The server searches; the picker shows what it was given,
 * says how many there are, and never fills the field or chooses for the person. Focus follows the person: to the choice once made, and back to
 * the field when they set it aside.
 */
export function Picker({
  label,
  searchLabel,
  searchHelp,
  inputMode = 'text',
  maxLength,
  searchAction,
  onSearch,
  results,
  noResults,
  moreResults = false,
  value,
  onChange,
  chooseAction,
  changeAction,
  error,
  required = false,
  disabled = false,
  operation,
  context,
  permission,
}: PickerProps) {
  const id = useId();
  const [text, setText] = useState('');
  const chosenBox = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  // Where focus goes after the person's last act, counted, so that the same move made twice moves focus twice.
  const [moved, setMoved] = useState<{
    readonly to: 'chosen' | 'search';
    readonly count: number;
  }>();
  const move = (to: 'chosen' | 'search'): void => {
    setMoved((last) => ({ to, count: (last?.count ?? 0) + 1 }));
  };

  // Focus follows the person's own act, after it is drawn: the choice they made, or the field they went back to.
  useEffect(() => {
    if (moved?.to === 'chosen') chosenBox.current?.focus();
    if (moved?.to === 'search') field.current?.querySelector('input')?.focus();
  }, [moved]);

  function search(): void {
    if (disabled) return;
    onSearch(text.trim());
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // Enter in the search field searches. It must not reach the form around the picker, which would send a half-filled booking.
    if (event.key !== 'Enter') return;
    event.preventDefault();
    search();
  }

  const legend = (
    <legend className="ui-picker__legend">
      {label}
      {required ? (
        <>
          {/* A text node of its own: a space inside the span is dropped from the accessible name. */}{' '}
          <span className="ui-picker__required">(required)</span>
        </>
      ) : null}
    </legend>
  );

  if (value !== null) {
    return (
      <fieldset className="ui-picker" disabled={disabled}>
        {legend}
        <div className="ui-picker__chosen" ref={chosenBox} tabIndex={-1}>
          <p className="ui-picker__chosen-label">{value.label}</p>
          {value.description === undefined ? null : (
            <p className="ui-picker__description">{value.description}</p>
          )}
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            onChange(null);
            move('search');
          }}
        >
          {changeAction}
        </Button>
      </fieldset>
    );
  }

  return (
    <fieldset className="ui-picker" disabled={disabled}>
      {legend}
      <div className="ui-picker__search" ref={field}>
        <div className="ui-picker__field">
          {/* The choice is what is required, and the legend says so; the text of a search is not. */}
          <Field
            label={searchLabel}
            {...(searchHelp === undefined ? {} : { help: searchHelp })}
            {...(error === undefined ? {} : { error })}
          >
            <Input
              type="search"
              value={text}
              inputMode={inputMode}
              autoComplete="off"
              {...(maxLength === undefined ? {} : { maxLength })}
              onChange={(event) => {
                setText(event.target.value);
              }}
              onKeyDown={onKeyDown}
            />
          </Field>
        </div>
        <div className="ui-picker__action">
          <Button type="button" variant="secondary" onClick={search}>
            {searchAction}
          </Button>
        </div>
      </div>
      {results === undefined ? null : (
        <ReadState
          query={results}
          isEmpty={(options) => options.length === 0}
          empty={
            <div className="ui-picker__none" role="status">
              {noResults}
            </div>
          }
          loadingLabel="Searching…"
          {...(operation === undefined ? {} : { operation })}
          {...(context === undefined ? {} : { context })}
          {...(permission === undefined ? {} : { permission })}
        >
          {(options) => (
            <>
              <p className="ui-picker__count" role="status" id={`${id}-count`}>
                {`${String(options.length)} found.${moreResults ? ' More match: add to the search to narrow it.' : ''}`}
              </p>
              <ul className="ui-picker__results" aria-labelledby={`${id}-count`}>
                {options.map((option) => (
                  <li key={option.value} className="ui-picker__result">
                    <div className="ui-picker__result-text">
                      <p className="ui-picker__result-label">{option.label}</p>
                      {option.description === undefined ? null : (
                        <p className="ui-picker__description">{option.description}</p>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      aria-label={`${chooseAction}: ${option.label}`}
                      onClick={() => {
                        onChange(option);
                        move('chosen');
                      }}
                    >
                      {chooseAction}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </ReadState>
      )}
    </fieldset>
  );
}
