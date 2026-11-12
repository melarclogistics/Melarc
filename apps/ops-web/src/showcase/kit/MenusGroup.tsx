import { useRef, useState } from 'react';

import { ActionMenu, type ActionOutcome } from '../../components/ui/action-menu/ActionMenu';
import { Button } from '../../components/ui/button/Button';
import { Dialog, DialogActions } from '../../components/ui/dialog/Dialog';
import { Field } from '../../components/ui/field/Field';
import { Textarea } from '../../components/ui/textarea/Textarea';
import { OperationalCode } from '../../components/ui/code/OperationalCode';
import { showToast } from '../../components/ui/toast/Toast';
import { useToastClearance } from '../../components/ui/toast/toast-clearance';
import { RequestMenu } from './PanelsGroup';
import { KitSection, Specimen } from './Section';

/** An act that takes its time, and one that fails, in the page's own words: the question stays open and busy, and tells the failure. */
function after(milliseconds: number, outcome: ActionOutcome): () => Promise<ActionOutcome> {
  return () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(outcome);
      }, milliseconds);
    });
}

/** A reason to give before an act: the act's own dialog, which the menu opens in place of its own question. */
function RevokeDialog({ onClose }: { readonly onClose: () => void }) {
  return (
    <Dialog
      open
      role="alertdialog"
      title="Revoke access for Demo Person?"
      description="Every session of this person ends. This cannot be undone."
      onRequestClose={onClose}
    >
      <Field label="Reason" required>
        <Textarea />
      </Field>
      <DialogActions>
        <Button type="button" variant="secondary" data-initial-focus onClick={onClose}>
          Go back
        </Button>
        <Button type="button" variant="danger" onClick={onClose}>
          Revoke access
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ActionMenuSpecimens() {
  return (
    <KitSection
      title="ActionMenu"
      note="The overflow menu of a record's acts. Destructive acts are always last, in the vermilion of danger, and always confirmed. An act that cannot be taken stays in the menu and says why, on hover, on focus and when it is chosen."
    >
      <div className="showcase-kit-grid">
        <Specimen label="Plain acts only">
          <ActionMenu
            label="More actions for ACC-MF-Q92422"
            items={[
              { id: 'print', label: 'Print the run', onSelect: () => undefined },
              { id: 'copy', label: 'Copy the code', onSelect: () => undefined },
            ]}
          />
        </Specimen>
        <Specimen label="An act that cannot be taken, and a destructive one (open the menu)">
          <RequestMenu code="ACC-PR-7KQ2MZ" />
        </Specimen>
        <Specimen label="A destructive act that takes its time, and one that fails (open the menu)">
          <ActionMenu
            label="More actions for ACC-PR-5MN3XB"
            items={[
              {
                id: 'cancel-slow',
                label: 'Cancel request',
                destructive: true,
                confirm: {
                  title: 'Cancel request ACC-PR-5MN3XB?',
                  description: 'The vendor is told. A cancellation charge may apply.',
                  confirmLabel: 'Cancel the request',
                },
                onSelect: after(1500, { ok: true }),
              },
              {
                id: 'cancel-fail',
                label: 'Remove from the run',
                destructive: true,
                confirm: {
                  title: 'Remove ACC-PR-5MN3XB from the run?',
                  description: 'The stop is taken off the rider’s list.',
                  confirmLabel: 'Remove the stop',
                },
                onSelect: after(600, {
                  ok: false,
                  message: 'The rider has already started this stop. Nothing was removed.',
                }),
              },
            ]}
          />
        </Specimen>
        <Specimen label="An act with its own dialog, a reason to give (open the menu)">
          <ActionMenu
            label="More actions for Demo Person"
            items={[
              { id: 'note', label: 'Add a note', onSelect: () => undefined },
              {
                id: 'revoke',
                label: 'Revoke access',
                destructive: true,
                dialog: ({ onClose }) => <RevokeDialog onClose={onClose} />,
              },
            ]}
          />
        </Specimen>
        <Specimen label="Every act unavailable, each with its reason">
          <ActionMenu
            label="More actions for ACC-PR-4HT9WD"
            items={[
              {
                id: 'hub',
                label: 'Change the hub',
                disabled: { reason: 'A rider already holds this request.' },
                onSelect: () => undefined,
              },
              {
                id: 'escalate',
                label: 'Escalate',
                disabled: { reason: 'An approver decides this.' },
                onSelect: () => undefined,
              },
            ]}
          />
        </Specimen>
      </div>
    </KitSection>
  );
}

/** A bar that sticks to the bottom of the window (a page's submit bar): it tells the toasts where it is, so that under 600px a toast stands above it and never covers it. */
function StickyBar() {
  const bar = useRef<HTMLDivElement>(null);
  useToastClearance(bar);
  return (
    <div ref={bar} className="showcase-kit-sticky-bar" data-testid="sticky-bar">
      <Button type="button">Book the pickup</Button>
    </div>
  );
}

function StickyBarSpecimen() {
  const [shown, setShown] = useState(false);
  return (
    <Specimen label="A bar at the bottom of the window (under 600px a toast stands above it)">
      <div className="showcase-kit-row">
        <Button
          type="button"
          variant="secondary"
          aria-pressed={shown}
          onClick={() => {
            setShown((now) => !now);
          }}
        >
          {shown ? 'Take the bar away' : 'Show a submit bar'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            showToast({
              tone: 'info',
              message: 'The booking is saved as a draft.',
              id: 'draft-saved',
            });
          }}
        >
          Raise a toast
        </Button>
      </div>
      {shown ? <StickyBar /> : null}
    </Specimen>
  );
}

function ToastSpecimens() {
  return (
    <KitSection
      title="Toast"
      note="A message at the bottom right with its tone and up to two actions under it: a primary one (Open, or Undo only where the server allows undoing the act) and a secondary one in the screen's own words (Book another, as the task form's success has it). With any action it stays until it is dismissed, and using either takes it away. An important outcome is never only a toast. Alt+T moves the keyboard to the toasts."
    >
      <Specimen label="Press a button to raise one">
        <div className="showcase-kit-row">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              showToast({ tone: 'success', message: 'Request ACC-PR-7KQ2MZ confirmed.' });
            }}
          >
            Success
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              showToast({
                tone: 'info',
                message: 'The run is being built. This can take a minute.',
              });
            }}
          >
            Information
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              showToast({
                tone: 'warning',
                message: 'Booked after the cut-off: it waits for an Ops decision.',
              });
            }}
          >
            Warning
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              showToast({
                tone: 'danger',
                message: 'The request could not be confirmed. Nothing was changed.',
              });
            }}
          >
            Danger
          </Button>
          <Button
            type="button"
            onClick={() => {
              showToast({
                tone: 'success',
                message: 'Request ACC-PR-7KQ2MZ booked.',
                action: { label: 'Open', onClick: () => undefined },
              });
            }}
          >
            With Open
          </Button>
          <Button
            type="button"
            onClick={() => {
              showToast({
                tone: 'success',
                message: (
                  <>
                    Pickup run <OperationalCode>ACC-MF-Q92422</OperationalCode> dispatched.
                  </>
                ),
                action: { label: 'Undo', onClick: () => undefined },
              });
            }}
          >
            With Undo
          </Button>
          <Button
            type="button"
            onClick={() => {
              showToast({
                tone: 'success',
                message: 'Request ACC-PR-4HT9WD booked.',
                action: { label: 'Open', onClick: () => undefined },
                secondaryAction: { label: 'Book another', onClick: () => undefined },
              });
            }}
          >
            With two actions
          </Button>
        </div>
      </Specimen>
      <StickyBarSpecimen />
    </KitSection>
  );
}

export function MenusGroup() {
  return (
    <>
      <ActionMenuSpecimens />
      <ToastSpecimens />
    </>
  );
}
