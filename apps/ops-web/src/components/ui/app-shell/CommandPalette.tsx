import type { ReactNode } from 'react';

import { Button } from '../../primitives/button';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '../../primitives/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../primitives/dialog';
import { Icon } from '../icon/Icon';
import type { IconName } from '../icon/icons';
import { Spinner } from '../loading/Spinner';
import './palette.css';

/** A page the palette goes to: a built page the session may open, or one of the New menu's actions. */
export interface PaletteLink {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
  /** Words that find the page and are not drawn (what it is for). */
  readonly keywords?: string;
}

/** One record found by the search, with the line under its title already written (the portal's words: the server gave facts). */
export interface PaletteRecord {
  readonly id: string;
  readonly to: string;
  readonly title: string;
  /** The title is an operational code (a pickup's or a run's), drawn in the monospace face. */
  readonly isCode: boolean;
  readonly subtitle: string;
  readonly icon: IconName;
}

/** What the search of records is in, and what the palette says about it. Each state is told in plain words. */
export type PaletteRecords =
  /** Fewer than two characters: nothing was asked. */
  | { readonly state: 'hint' }
  /** More characters than the search takes (`limit`): nothing was asked, and the person is told to shorten the text. */
  | { readonly state: 'too-long'; readonly limit: number }
  /** The text is being asked of the server (or has not stood still long enough to be). */
  | { readonly state: 'loading' }
  /**
   * The session has asked too often (a `429`, or the hold of the automatic reads that follows it): a calm note in the status line and never an
   * alert (audit A2, 7 November 2026; surfaces/ops-portal.md section 8). The typed search resumes by itself once the wait is over, and a read
   * the person asks for (`onRetry`, *Try again*) is never held.
   */
  | { readonly state: 'slow'; readonly message: string; readonly onRetry?: () => void }
  /** The server answered with nothing. */
  | { readonly state: 'empty'; readonly text: string }
  /** The search could not be completed; the person may ask again. Nothing is tried again by itself. */
  | { readonly state: 'error'; readonly message: string; readonly onRetry: () => void }
  | { readonly state: 'results'; readonly items: readonly PaletteRecord[] };

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly goTo: readonly PaletteLink[];
  readonly create: readonly PaletteLink[];
  readonly records: PaletteRecords;
  /** The person chose a page or a record: the address to go to. The palette closes itself; the shell navigates. */
  readonly onSelect: (to: string) => void;
  /** What happens to focus when the palette has closed: the shell puts it back where the person was, unless they went to a page. */
  readonly onCloseAutoFocus: (event: Event) => void;
}

/** The block that says, under the list, what the search of records is in: the heading of the group it stands for, and a note. */
function Status({ children }: { readonly children: ReactNode }) {
  return (
    <div className="ui-palette__status">
      <p className="ui-palette__heading">Records</p>
      {children}
    </div>
  );
}

/** How many records the search found, said in words: the list shows them, and a screen reader is told that they arrived. */
const foundWords = (count: number): string =>
  `${String(count)} ${count === 1 ? 'record' : 'records'} found.`;

/**
 * **What the search of records is in, told in plain words, in one polite live region that is in the document through every state** (WCAG 4.1.3):
 * a region that is inserted with its text is announced by few screen readers, and one that changes its role or is removed when the results arrive
 * says nothing of them. It says what is drawn for the states that draw a note (a hint, "Searching…", no match, a text too long), and **how many
 * records were found** when there are results, which are drawn in the list and need no note. A failure is not in that region: it is told in an alert
 * container **of its own, that is also in the document through every state** (audit B3, 7 November 2026), so that the failure is spoken at once when it
 * is put in, with *Try again*; the status beside it is empty then.
 */
function RecordsStatus({ records }: { readonly records: PaletteRecords }) {
  return (
    <>
      <div role="status">
        {records.state === 'hint' ? (
          <Status>
            <p className="ui-palette__note">Type two letters or more to search records.</p>
          </Status>
        ) : null}
        {records.state === 'too-long' ? (
          <Status>
            <p className="ui-palette__note">
              {`Use ${String(records.limit)} characters or fewer to search records.`}
            </p>
          </Status>
        ) : null}
        {records.state === 'loading' ? (
          <Status>
            <p className="ui-palette__note">
              <Spinner /> Searching…
            </p>
          </Status>
        ) : null}
        {records.state === 'slow' ? (
          <Status>
            <p className="ui-palette__note">{records.message}</p>
            {records.onRetry === undefined ? null : (
              <Button type="button" variant="secondary" size="sm" onClick={records.onRetry}>
                Try again
              </Button>
            )}
          </Status>
        ) : null}
        {records.state === 'empty' ? (
          <Status>
            <p className="ui-palette__note">No record matches “{records.text}”.</p>
          </Status>
        ) : null}
        {records.state === 'results' ? (
          <p className="sr-only">{foundWords(records.items.length)}</p>
        ) : null}
      </div>
      <div role="alert">
        {records.state === 'error' ? (
          <div className="ui-palette__status">
            <p className="ui-palette__heading">Records</p>
            <p className="ui-palette__note">{records.message}</p>
            <Button type="button" variant="secondary" size="sm" onClick={records.onRetry}>
              Try again
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * The command palette (Ctrl or ⌘ K; surfaces/ops-portal.md section 4; the shadcn `command` primitive in a dialog): one place to go to a page, to
 * create something, and to find a record by its code, a name or a phone number. Three groups, in this order: **Go to** (the built pages the session
 * may open), **Create** (the New menu's actions) and **Records** (the search of `lookupRecords`).
 *
 * - **The palette filters nothing of the server's.** Go to and Create are filtered here by what is typed; the records are the server's answer to
 *   the text and are never filtered again (a record found by a phone number does not contain the number). The primitive's own filter is off.
 * - **Every state of the search is told in plain words**: a hint under two characters, "Searching…", "No record matches …", and a failure with
 *   *Try again* (never tried again by itself). They sit under the list, outside it: a listbox holds options and nothing else.
 * - **Keyboard**: the arrows move, Enter opens, Escape closes. Focus goes into the field when it opens and, when it closes, back to where the person
 *   was (`onCloseAutoFocus`, the shell's).
 */
export function CommandPalette({
  open,
  onOpenChange,
  query,
  onQueryChange,
  goTo,
  create,
  records,
  onSelect,
  onCloseAutoFocus,
}: CommandPaletteProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="ui-palette w-[min(40rem,calc(100vw-var(--space-8)))] translate-y-0 gap-0 p-0"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>
            Go to a page, create something, or find a record by its code, a name or a phone number.
          </DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} loop label="Search">
          {/* The field has room at its sides (`px-2`), so that the focus ring the frame draws around it does not hug the text (review of 7 November 2026). */}
          <CommandInput
            className="px-2"
            value={query}
            onValueChange={onQueryChange}
            placeholder="Search a code, name or phone"
          />
          <CommandList className="ui-palette__list">
            {goTo.length === 0 ? null : (
              <CommandGroup heading="Go to">
                {goTo.map((page) => (
                  <CommandItem
                    key={page.to}
                    value={`go:${page.to}`}
                    onSelect={() => {
                      onSelect(page.to);
                    }}
                  >
                    <Icon name={page.icon} size="sm" />
                    {page.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {create.length === 0 ? null : (
              <>
                {goTo.length === 0 ? null : <CommandSeparator />}
                <CommandGroup heading="Create">
                  {create.map((action) => (
                    <CommandItem
                      key={action.to}
                      value={`create:${action.to}`}
                      onSelect={() => {
                        onSelect(action.to);
                      }}
                    >
                      <Icon name={action.icon} size="sm" />
                      {action.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
            {records.state === 'results' ? (
              <>
                {goTo.length + create.length === 0 ? null : <CommandSeparator />}
                <CommandGroup heading="Records">
                  {records.items.map((record) => (
                    <CommandItem
                      key={record.id}
                      value={`record:${record.id}`}
                      className="ui-palette__record"
                      onSelect={() => {
                        onSelect(record.to);
                      }}
                    >
                      <Icon name={record.icon} size="sm" />
                      <span className="ui-palette__text">
                        <span
                          className={
                            record.isCode
                              ? 'ui-palette__title ui-palette__code'
                              : 'ui-palette__title'
                          }
                        >
                          {record.title}
                        </span>
                        {record.subtitle === '' ? null : (
                          <span className="ui-palette__subtitle">{record.subtitle}</span>
                        )}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
          <RecordsStatus records={records} />
        </Command>
      </DialogContent>
    </Dialog>
  );
}
