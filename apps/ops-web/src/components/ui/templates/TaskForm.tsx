import { useId, type ReactNode, type Ref, type SubmitEvent } from 'react';

import { Button } from '../button/Button';
import { PageHeader, type PageHeaderProps } from '../page-header/PageHeader';
import { Panel } from '../panel/Panel';
import { showToast } from '../toast/Toast';
import { UnsavedChangesGuard } from './unsaved-changes-guard';
import './task-form.css';

/**
 * A section of the form: what this part of the task asks, under a heading of its own. The fields in it are laid out in a grid of two columns on a desk and one at 768px and below, each
 * as wide as its content needs; a field that needs the whole row (an address, a note, a group of choices) is wrapped in `TaskFormWide`.
 */
export function TaskFormSection({
  title,
  description,
  children,
}: {
  /** What the section is, in one to three words: "The sender". It is a level-two heading. */
  readonly title: string;
  /** A rule that changes a choice, in one line. A longer explanation sits behind an info control. */
  readonly description?: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="ui-task-form__section" aria-labelledby={id}>
      <h2 id={id} className="ui-task-form__section-title">
        {title}
      </h2>
      {description === undefined ? null : (
        <p className="ui-task-form__section-note">{description}</p>
      )}
      <div className="ui-task-form__grid">{children}</div>
    </section>
  );
}

/** A field, or a group of them, that takes the whole row of the section's grid. */
export function TaskFormWide({ children }: { readonly children: ReactNode }) {
  return <div className="ui-task-form__wide">{children}</div>;
}

/** The review before the task is sent: what will be created or changed, and what the server decides. It is a review, not a second form. */
export interface TaskFormReview {
  /** True while the review is shown in place of the sections. The sections stay in the page, hidden, so nothing that was entered is lost by looking at the review. */
  readonly active: boolean;
  /** What will be created or changed, in the server's words and numbers where it gave them, and what it decides. */
  readonly children: ReactNode;
  /** Goes back to the sections to change something. */
  readonly onBack: () => void;
  /** What the way back says. Default "Go back and change". */
  readonly backLabel?: string;
  /** What the review is called. Default "Review". */
  readonly title?: string;
}

/** The summary rail: what the server states for this task (an estimate, a cut-off, a window, a fee, a limit) in the server's words and numbers. The page never works one out. */
export interface TaskFormSummary {
  /** Default "Summary". */
  readonly title?: string;
  readonly children: ReactNode;
}

export interface TaskFormProps {
  /** The page's header: the title, its one-line description and the breadcrumb. The page's actions are the form's, below. */
  readonly header: Pick<PageHeaderProps, 'title' | 'description' | 'breadcrumb'>;
  /** Banners that belong to the whole form (the outcome of a send that did not answer, a refusal that names no field), above the sections. */
  readonly alerts?: ReactNode;
  /** The sections, in the order the officer thinks of the task: `TaskFormSection`s, and anything between them that the task needs. */
  readonly children: ReactNode;
  readonly summary?: TaskFormSummary;
  readonly review?: TaskFormReview;
  /** The form's actions: the one primary (the submit `Button`, in Ink), and the others (a link back, a retry). The page words them: the dismiss never repeats the act's verb. */
  readonly actions: ReactNode;
  /** The person has entered something that is not saved: leaving asks first. Turn it off once the task is sent. */
  readonly dirty?: boolean;
  /** The form is being sent. */
  readonly busy?: boolean;
  /** Validates and sends. The form never validates by itself (`noValidate`): the page checks the fields and tells each in place. */
  readonly onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  /** For the page to find a field, as it does after a refusal (the first invalid field takes focus). */
  readonly formRef?: Ref<HTMLFormElement>;
}

/**
 * The task form template (PRODUCT_DESIGN_DIRECTION section 6.3; COMPONENT_PATTERNS, *TaskForm*): creating or completing a unit of work. It composes the kit into: the page header; sections in
 * the order the officer thinks, each a grid sized to its fields (two columns on a desk, one at 768px and below); a **sticky summary** rail beside them with what the server states
 * (it follows the sections, **before the button that sends them**, on a narrow screen); an optional **review** before anything is sent; the form's actions at the foot of the sections; and a guard against leaving with
 * unsaved changes. Validation is inline and the page's: it passes each field its own error, and the form is `noValidate`. **It owns the structure and the behaviour of the shape and
 * decides nothing**: what a field accepts, what the summary says and what happens on send are the page's and the server's, and a figure that was not given is not drawn.
 * Its success is `announceTaskDone` (a toast with *Open* and a way to do another).
 */
export function TaskForm({
  header,
  alerts,
  children,
  summary,
  review,
  actions,
  dirty = false,
  busy = false,
  onSubmit,
  formRef,
}: TaskFormProps) {
  const reviewing = review?.active === true;
  return (
    <div className="ui-task-form" data-rail={summary === undefined ? undefined : ''}>
      <PageHeader {...header} />
      <div className="ui-task-form__layout">
        <form
          ref={formRef}
          noValidate
          className="ui-task-form__form"
          aria-busy={busy ? true : undefined}
          onSubmit={onSubmit}
        >
          <div className="ui-task-form__main">
            {alerts}
            <div className="ui-task-form__sections" hidden={reviewing}>
              {children}
            </div>
            {review === undefined || !reviewing ? null : (
              <section className="ui-task-form__review" aria-labelledby="ui-task-form-review">
                <h2 id="ui-task-form-review" className="ui-task-form__section-title">
                  {review.title ?? 'Review'}
                </h2>
                <div className="ui-task-form__review-body">{review.children}</div>
                <div>
                  <Button type="button" variant="secondary" onClick={review.onBack}>
                    {review.backLabel ?? 'Go back and change'}
                  </Button>
                </div>
              </section>
            )}
          </div>
          {/* The summary is in the form, between what is entered and the button that sends it: what the booking comes to is read before it is sent, on a narrow page, where it stands
              after the sections; where the page has room it stands beside them (the stylesheet), and the order of the page does not change. */}
          {summary === undefined ? null : (
            <aside className="ui-task-form__rail" aria-label={summary.title ?? 'Summary'}>
              <Panel title={summary.title ?? 'Summary'} headingLevel={2}>
                {summary.children}
              </Panel>
            </aside>
          )}
          <div className="ui-task-form__actions">{actions}</div>
        </form>
      </div>
      <UnsavedChangesGuard when={dirty} />
    </div>
  );
}

/**
 * Says that the task was done (PRODUCT_DESIGN_DIRECTION section 6.3): a toast with **Open** (what was made) and a way to do another, in the screen's own words ("Book another"). A
 * toast raised while a dialog is open is held until the dialog has closed, and a toast with an action stays until it is dismissed (COMPONENT_PATTERNS, *Toast*). The message says what was made, in
 * the page's words, and is the server's answer: never worded before it came.
 */
export function announceTaskDone({
  message,
  open,
  another,
  id,
}: {
  readonly message: string;
  readonly open: () => void;
  readonly another: { readonly label: string; readonly onClick: () => void };
  /** Tells this toast from another of the same act, so that a repeat of it does not stack. */
  readonly id?: string;
}): void {
  showToast({
    tone: 'success',
    message,
    action: { label: 'Open', onClick: open },
    secondaryAction: another,
    ...(id === undefined ? {} : { id }),
  });
}
