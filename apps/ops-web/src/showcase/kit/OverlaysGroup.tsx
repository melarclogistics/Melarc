import { useContext, useState } from 'react';

import { Button } from '../../components/ui/button/Button';
import { AlertDialog } from '../../components/ui/dialog/AlertDialog';
import { Dialog, DialogActions } from '../../components/ui/dialog/Dialog';
import { DialogContainer } from '../../components/ui/dialog/dialog-container';
import { Field } from '../../components/ui/field/Field';
import { Popover } from '../../components/ui/popover/Popover';
import { Textarea } from '../../components/ui/textarea/Textarea';
import { Tooltip } from '../../components/ui/tooltip/Tooltip';
import { KitSection, Specimen } from './Section';

const SIDES = [
  { side: 'top', label: 'Above', words: 'Seen above what it is about.' },
  { side: 'right', label: 'Right', words: 'Seen to the right.' },
  { side: 'bottom', label: 'Below', words: 'Seen below.' },
  { side: 'left', label: 'Left', words: 'Seen to the left.' },
] as const;

function TooltipSpecimens() {
  return (
    <KitSection
      title="Tooltip"
      note="A hint on something that can be pointed at or focused. It names an icon or adds a hint; it never replaces the name of what it is on. It appears after 300ms under the pointer and at once on keyboard focus, stands 8px away on the one floating shadow, stays while the pointer is on it and goes with Escape. It holds words only."
    >
      <div className="showcase-kit-grid">
        <Specimen label="A hint on a button (hover it, or press Tab)">
          <Tooltip content="Tells the vendor that the hub has confirmed this pickup.">
            <Button type="button">Confirm the request</Button>
          </Tooltip>
        </Specimen>
        <Specimen label="The four sides">
          <div className="showcase-kit-row">
            {SIDES.map((one) => (
              <Tooltip key={one.side} side={one.side} content={one.words}>
                <Button type="button" variant="secondary">
                  {one.label}
                </Button>
              </Tooltip>
            ))}
          </div>
        </Specimen>
      </div>
    </KitSection>
  );
}

const HUBS = ['Accra Central', 'Tema', 'Kumasi'] as const;

function PopoverSpecimens() {
  return (
    <KitSection
      title="Popover"
      note="A small panel that opens under what opened it, 8px away, on the floating shadow. It is a dialog with a name, Escape closes it and focus goes back to what opened it. It is for a choice or a few controls; a decision that must not be missed is a dialog."
    >
      <div className="showcase-kit-grid">
        <Specimen label="Opened from a button (a choice of service date)">
          <Popover
            trigger={
              <Button type="button" variant="secondary">
                Service date
              </Button>
            }
            label="Choose a service date"
          >
            <div className="showcase-kit-stack">
              <p>Show requests for</p>
              <div className="showcase-kit-row">
                <Button type="button" variant="secondary">
                  Today
                </Button>
                <Button type="button" variant="secondary">
                  This week
                </Button>
              </div>
            </div>
          </Popover>
        </Specimen>
        <Specimen label="Aligned to its end, at the right edge of its room">
          <div className="showcase-kit-row showcase-kit-row--end">
            <Popover
              align="end"
              trigger={
                <Button type="button" variant="secondary">
                  Hub
                </Button>
              }
              label="Choose a hub"
            >
              <ul className="showcase-kit-choices">
                {HUBS.map((hub) => (
                  <li key={hub}>{hub}</li>
                ))}
              </ul>
            </Popover>
          </div>
        </Specimen>
      </div>
    </KitSection>
  );
}

/** A popover opened inside a dialog is drawn into the dialog, or it would open under it, unseen. */
function HubChoiceInDialog() {
  const container = useContext(DialogContainer);
  return (
    <Popover
      container={container}
      trigger={
        <Button type="button" variant="secondary">
          Choose a hub
        </Button>
      }
      label="Choose a hub for the note"
    >
      <ul className="showcase-kit-choices">
        {HUBS.map((hub) => (
          <li key={hub}>{hub}</li>
        ))}
      </ul>
    </Popover>
  );
}

function DialogSpecimens() {
  const [noteOpen, setNoteOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [answer, setAnswer] = useState('Nothing was asked yet.');
  return (
    <KitSection
      title="Dialog"
      note="The modal dialog and the question before a hard-to-undo act are the portal's own, on the browser's native dialog: the page behind it cannot be reached, Escape asks the page to close it, and focus goes back to what opened it. Pages use these two and never a primitive."
    >
      <div className="showcase-kit-grid">
        <Specimen label="A dialog with a form (a note on a request)">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setNoteOpen(true);
            }}
          >
            Add a note
          </Button>
          <Dialog
            open={noteOpen}
            title="Add a note"
            description="The note is kept with the request, and the staff of its hub can read it."
            onRequestClose={() => {
              setNoteOpen(false);
            }}
          >
            <div className="showcase-kit-stack">
              <Field label="Note">
                <Textarea />
              </Field>
              <HubChoiceInDialog />
            </div>
            <DialogActions>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setNoteOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setNoteOpen(false);
                }}
              >
                Save the note
              </Button>
            </DialogActions>
          </Dialog>
        </Specimen>
        <Specimen label="A question before an act that cannot be undone">
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              setAskOpen(true);
            }}
          >
            Cancel a request
          </Button>
          <p className="showcase-kit-opened">{answer}</p>
          <AlertDialog
            open={askOpen}
            title="Cancel request ACC-PR-7KQ2MZ?"
            confirmLabel="Cancel the request"
            cancelLabel="Keep the request"
            onConfirm={() => {
              setAskOpen(false);
              setAnswer('The sample request was cancelled.');
            }}
            onCancel={() => {
              setAskOpen(false);
              setAnswer('The sample request was kept.');
            }}
          >
            The vendor is told that the pickup will not happen. This cannot be undone.
          </AlertDialog>
        </Specimen>
      </div>
    </KitSection>
  );
}

/** Tooltips, popovers and dialogs (COMPONENT_PATTERNS, *Tooltip*, *Popover* and *Dialog*; the second half of redesign step R5). */
export function OverlaysGroup() {
  return (
    <>
      <TooltipSpecimens />
      <PopoverSpecimens />
      <DialogSpecimens />
    </>
  );
}
