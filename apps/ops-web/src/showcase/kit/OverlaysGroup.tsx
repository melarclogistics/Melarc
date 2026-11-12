import { useState } from 'react';

import { ActionMenu } from '../../components/ui/action-menu/ActionMenu';
import { Button } from '../../components/ui/button/Button';
import { AlertDialog } from '../../components/ui/dialog/AlertDialog';
import { Dialog, DialogActions } from '../../components/ui/dialog/Dialog';
import { Field } from '../../components/ui/field/Field';
import { FilterBar } from '../../components/ui/filter-bar/FilterBar';
import { Popover } from '../../components/ui/popover/Popover';
import { Textarea } from '../../components/ui/textarea/Textarea';
import { showToast } from '../../components/ui/toast/Toast';
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

/** A popover opened inside a dialog is drawn into the dialog by the kit itself (no container is given: the component reads it), or it would open under it, unseen. */
function HubChoiceInDialog() {
  return (
    <Popover
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

/** The four overlays of the kit that open from a control, inside one dialog: each is drawn into the dialog, reachable, and closes on its own. */
function OverlaysInDialog() {
  const [open, setOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [chips, setChips] = useState([{ id: 'hub', label: 'Hub: Accra Central' }]);
  return (
    <Specimen label="A menu, a popover, a filter and a tooltip inside a dialog">
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open the request
      </Button>
      <Dialog
        open={open}
        title="Request ACC-PR-7KQ2MZ"
        description="Every overlay below opens in front of this dialog and can be reached."
        onRequestClose={() => {
          setOpen(false);
        }}
      >
        <div className="showcase-kit-stack">
          <div className="showcase-kit-row">
            <ActionMenu
              label="More actions for ACC-PR-7KQ2MZ"
              items={[
                { id: 'note', label: 'Add a note', onSelect: () => undefined },
                {
                  id: 'cancel',
                  label: 'Cancel request',
                  destructive: true,
                  confirm: {
                    title: 'Cancel request ACC-PR-7KQ2MZ?',
                    description: 'The vendor is told. A cancellation charge may apply.',
                    confirmLabel: 'Cancel the request',
                  },
                  onSelect: () => undefined,
                },
              ]}
            />
            <Tooltip content="What the staff of the hub can read.">
              <Button type="button" variant="secondary">
                Who can read this
              </Button>
            </Tooltip>
            <HubChoiceInDialog />
          </div>
          <FilterBar
            label="Filters of the request"
            chips={chips}
            onRemove={(id) => {
              setChips((current) => current.filter((chip) => chip.id !== id));
            }}
            filterLabel="Filter the notes"
            filterOpen={filterOpen}
            onFilterOpenChange={setFilterOpen}
            filterPanel={
              <Field label="Written by">
                <Textarea />
              </Field>
            }
          />
        </div>
        <DialogActions>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setOpen(false);
            }}
          >
            Close the request
          </Button>
        </DialogActions>
      </Dialog>
    </Specimen>
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
                  // The toast is raised while the dialog is still open: it is held until the dialog has closed, and then shown, so that it is never behind the scrim.
                  showToast({ tone: 'success', message: 'The note is saved.', id: 'note-saved' });
                  setNoteOpen(false);
                }}
              >
                Save the note
              </Button>
            </DialogActions>
          </Dialog>
        </Specimen>
        <OverlaysInDialog />
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
