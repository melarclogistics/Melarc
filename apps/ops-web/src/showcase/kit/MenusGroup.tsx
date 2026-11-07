import { Button } from '../../components/ui/button/Button';
import { ActionMenu } from '../../components/ui/action-menu/ActionMenu';
import { OperationalCode } from '../../components/ui/code/OperationalCode';
import { showToast } from '../../components/ui/toast/Toast';
import { RequestMenu } from './PanelsGroup';
import { KitSection, Specimen } from './Section';

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

function ToastSpecimens() {
  return (
    <KitSection
      title="Toast"
      note="A message at the bottom right with its tone, at most one action (Open, or Undo only where the server allows undoing the act), and, with an action, it stays until it is dismissed. An important outcome is never only a toast. Alt+T moves the keyboard to the toasts."
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
        </div>
      </Specimen>
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
