import { useId, useRef, type ReactNode, type Ref, type SubmitEvent } from 'react';

import { Button as LinkButton } from '../../primitives/button';
import { Button } from '../button/Button';
import { OperationalCode } from '../code/OperationalCode';
import { DescriptionList, type DescriptionItem } from '../description-list/DescriptionList';
import { Icon } from '../icon/Icon';
import { PageHeader, type PageHeaderProps } from '../page-header/PageHeader';
import { Panel } from '../panel/Panel';
import { UnsavedChangesGuard } from './unsaved-changes-guard';
import './builder.css';

/** One row of the run: a request the person chose, in the order the run will take. */
export interface BuilderRunItem {
  /** Tells the row from the others: the record's id. Unique in a run. */
  readonly id: string;
  /** The record's code, whole. */
  readonly code: string;
  /** The line under the code: a name. */
  readonly title: string;
  /** A second quiet line: an address, a day. */
  readonly detail?: string;
  /**
   * What the server refused about **this row**, in the page's words (never the API's `message`): it is drawn on the row it names, so that the person sees which request to
   * change, and the row stays. A refusal that names no row is the page's banner (`alerts`).
   */
  readonly refusal?: string;
  /**
   * The row's record has changed since it was chosen (it is no longer waiting, another run took it), in the page's words. **A stale row is flagged and kept**: it is never
   * dropped silently, and the person removes it or goes on knowing it.
   */
  readonly stale?: string;
  /** Takes the row out of the choice. Its name says which row ("Remove ACC-PR-7KQ2MZ from the choice"). */
  readonly remove?: {
    readonly label: string;
    readonly onClick: () => void;
    readonly disabled?: boolean;
  };
}

/** The rows chosen for the run, in order, each with its own refusal or staleness. */
export function BuilderRunList({
  label,
  items,
  emptyText,
}: {
  /** Names the list: "The requests chosen, in order". */
  readonly label: string;
  readonly items: readonly BuilderRunItem[];
  /** What is said while nothing is chosen. */
  readonly emptyText: string;
}) {
  const prefix = useId();
  if (items.length === 0) return <p className="ui-builder__empty">{emptyText}</p>;
  return (
    <ol className="ui-builder__run-list" aria-label={label}>
      {items.map((item) => {
        const noteId = `${prefix}-${item.id}`;
        const noted = item.refusal !== undefined || item.stale !== undefined;
        return (
          <li
            key={item.id}
            className="ui-builder__run-row"
            data-refused={item.refusal === undefined ? undefined : 'true'}
            data-stale={item.stale === undefined ? undefined : 'true'}
            aria-describedby={noted ? noteId : undefined}
          >
            <span className="ui-builder__run-text">
              <span>
                <OperationalCode>{item.code}</OperationalCode>
                {`: ${item.title}`}
              </span>
              {item.detail === undefined ? null : (
                <span className="ui-builder__run-detail">{item.detail}</span>
              )}
              {noted ? (
                <span id={noteId} className="ui-builder__run-notes">
                  {item.stale === undefined ? null : (
                    <span className="ui-builder__run-note" data-kind="stale">
                      <Icon name="warning" size="sm" />
                      {item.stale}
                    </span>
                  )}
                  {item.refusal === undefined ? null : (
                    <span className="ui-builder__run-note" data-kind="refusal">
                      <Icon name="warning" size="sm" />
                      {item.refusal}
                    </span>
                  )}
                </span>
              ) : null}
            </span>
            {item.remove === undefined ? null : (
              <Button
                type="button"
                variant="secondary"
                aria-label={item.remove.label}
                disabled={item.remove.disabled === true}
                onClick={item.remove.onClick}
              >
                Remove
              </Button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export interface BuilderPoolProps {
  /** What the pool is, in a few words: "The pool of confirmed pickups". */
  readonly title: string;
  /** The rule that decides what is in it, in one line ("the hub's confirmed pickups that no manifest holds"). */
  readonly description?: ReactNode;
  /** Freshness and its refresh, and the filters: the strip above the rows. */
  readonly toolbar?: ReactNode;
  /** The rows to choose from: a `DataTable` with a box on each row. The pool is the page's reading, and a row of another hub is never in it. */
  readonly children: ReactNode;
}

export interface BuilderRunProps {
  /** What the run is, in a few words: "The run". */
  readonly title: string;
  /** What the person has chosen, in order: `BuilderRunList`, and the entries the run asks for beside the rows (a reason, a note). */
  readonly children: ReactNode;
  /** What has been chosen, said as it is for the live region and the link on a narrow screen ("3 requests chosen"). The page's count of its own choice, never a server total. */
  readonly summary: string;
  /** The totals of the run that the server states, as facts. A total that was not stated says so in words and is never drawn as 0. */
  readonly totals?: readonly DescriptionItem[];
  /** The run's actions: the one primary (the submit `Button`, in Ink), and the others (a link back, a retry). */
  readonly actions: ReactNode;
}

export interface BuilderProps {
  readonly header: Pick<PageHeaderProps, 'title' | 'description' | 'breadcrumb'>;
  /** Banners that belong to the whole build (an outcome that did not answer, a refusal that names no row), above everything. */
  readonly alerts?: ReactNode;
  /** The run's own fields above the panes: the hub and the day. **One hub per build**: a run is for one hub, and the pool is that hub's. */
  readonly setup?: ReactNode;
  /** The two panes. Without them (no hub chosen yet) `note` says why. */
  readonly panes?: { readonly pool: BuilderPoolProps; readonly run: BuilderRunProps };
  /** Said in place of the panes while they are not drawn ("Choose the hub first: the pool is that hub's"). */
  readonly note?: ReactNode;
  /** Something is chosen that is not sent: leaving asks first. */
  readonly dirty?: boolean;
  readonly busy?: boolean;
  readonly onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  readonly formRef?: Ref<HTMLFormElement>;
  /** Dialogs and other things that must stay **outside the form**, so that their own submit never reaches the build's. */
  readonly outside?: ReactNode;
}

/**
 * The builder template (PRODUCT_DESIGN_DIRECTION section 6.4; COMPONENT_PATTERNS, *Builder*): putting a run together from a pool, the pickup run and the delivery run. Two panes: the **pool**
 * (the rows to choose from, with their filters and freshness) and the **run** (what was chosen, in order, its totals and its actions, which stays in view beside the pool from 80rem
 * and follows it below, with a way to jump to it). **One hub per build**, which the page's `setup` holds and the pool obeys. **A refusal is shown on the row it names and a stale row
 * is flagged and never dropped silently** (`BuilderRunList`). The totals are the server's and a missing one is not 0. Leaving with a choice that was not sent asks first. It owns the
 * structure and decides nothing: which rows may be chosen, in what order they go and what the server accepts are the page's and the server's.
 */
export function Builder({
  header,
  alerts,
  setup,
  panes,
  note,
  dirty = false,
  busy = false,
  onSubmit,
  formRef,
  outside,
}: BuilderProps) {
  const runHeading = useRef<HTMLHeadingElement>(null);
  const runId = useId();
  return (
    <div className="ui-builder">
      <PageHeader {...header} />
      <form
        ref={formRef}
        noValidate
        className="ui-builder__form"
        aria-busy={busy ? true : undefined}
        onSubmit={onSubmit}
      >
        {alerts}
        {setup === undefined ? null : <div className="ui-builder__setup">{setup}</div>}
        {panes === undefined ? (
          note === undefined ? null : (
            <p className="ui-builder__note">{note}</p>
          )
        ) : (
          <div className="ui-builder__panes">
            <section className="ui-builder__pool" aria-label={panes.pool.title}>
              <Panel title={panes.pool.title} headingLevel={2}>
                <p className="ui-builder__to-run">
                  <LinkButton
                    type="button"
                    variant="link"
                    onClick={() => {
                      runHeading.current?.focus();
                      runHeading.current?.scrollIntoView({ block: 'start' });
                    }}
                  >
                    {`Go to the run: ${panes.run.summary}`}
                  </LinkButton>
                </p>
                {panes.pool.description === undefined ? null : (
                  <p className="ui-builder__rule">{panes.pool.description}</p>
                )}
                {panes.pool.toolbar === undefined ? null : (
                  <div className="ui-builder__toolbar">{panes.pool.toolbar}</div>
                )}
                {panes.pool.children}
              </Panel>
            </section>
            <section className="ui-builder__run" aria-labelledby={`${runId}-run`}>
              <Panel variant="page">
                <h2
                  id={`${runId}-run`}
                  ref={runHeading}
                  tabIndex={-1}
                  className="ui-builder__run-title"
                >
                  {panes.run.title}
                </h2>
                <p role="status" className="ui-builder__summary">
                  {panes.run.summary}
                </p>
                {panes.run.totals === undefined ? null : (
                  <DescriptionList items={panes.run.totals} />
                )}
                {panes.run.children}
                <div className="ui-builder__actions">{panes.run.actions}</div>
              </Panel>
            </section>
          </div>
        )}
      </form>
      <UnsavedChangesGuard when={dirty} />
      {outside}
    </div>
  );
}
