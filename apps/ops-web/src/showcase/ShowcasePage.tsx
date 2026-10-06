import { useEffect, useRef, useState, type ReactNode } from 'react';

import { PageHeader } from '../components/PageHeader';
import { Alert } from '../components/ui/alert/Alert';
import { Button } from '../components/ui/button/Button';
import { Field } from '../components/ui/field/Field';
import { Input } from '../components/ui/input/Input';
import { Link } from '../components/ui/link/Link';
import { LoadingIndicator } from '../components/ui/loading/LoadingIndicator';
import './showcase.css';

/**
 * The development-only component showcase (COMPONENT_PATTERNS section 27). It exists to look at the tokens and the
 * components in every state, and to give the browser tests real components to drive. Everything on it is synthetic
 * and says so; no production-looking data appears. Its code, its route and its styles are absent from the production
 * build, which test/build.test.ts proves. It is not a second specification of any component.
 */

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="showcase-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Buttons() {
  const [pressed, setPressed] = useState(0);
  return (
    <Section title="Buttons">
      <p>
        Primary action pressed <span>{pressed}</span> times.
      </p>
      <div className="showcase-row">
        <Button
          type="button"
          onClick={() => {
            setPressed((count) => count + 1);
          }}
        >
          Primary action
        </Button>
        <Button type="button" variant="secondary">
          Secondary action
        </Button>
        <Button type="button" disabled>
          Disabled action
        </Button>
        <Button type="button" loading>
          Saving…
        </Button>
        <Button type="button" variant="secondary" loading>
          Saving…
        </Button>
      </div>
    </Section>
  );
}

function DemoForm() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [accepted, setAccepted] = useState(false);
  const [failures, setFailures] = useState(0);
  const form = useRef<HTMLFormElement>(null);

  // After a failed submit, focus goes to the first invalid field, which reads its error once (DESIGN_SYSTEM section 14).
  useEffect(() => {
    if (failures > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [failures]);

  return (
    <Section title="Form fields">
      <form
        ref={form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === '') {
            setAccepted(false);
            setError('Enter a demo name.');
            setFailures((count) => count + 1);
            return;
          }
          setError(undefined);
          setAccepted(true);
        }}
      >
        <Field label="Demo name" required help="Any text. Nothing is sent or stored." error={error}>
          <Input
            name="demo-name"
            autoComplete="off"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <Field label="Demo read-only value">
          <Input readOnly defaultValue="Synthetic value" />
        </Field>
        <Field label="Demo disabled value">
          <Input disabled defaultValue="Synthetic value" />
        </Field>
        <Button type="submit">Submit demo</Button>
      </form>
      {accepted ? (
        <Alert variant="success" announce>
          The demo form was accepted. Nothing was saved.
        </Alert>
      ) : null}
    </Section>
  );
}

function Surface({ name, className }: { readonly name: string; readonly className: string }) {
  return (
    <div className={`showcase-surface ${className}`}>
      <h3>{name}</h3>
      <p>Primary text on this surface.</p>
      <p className="showcase-secondary">Secondary text on this surface.</p>
      <p>
        <Link to="/">A link on this surface</Link>
      </p>
      <Input aria-label={`Demo input on ${name}`} defaultValue="Synthetic value" />
    </div>
  );
}

/** The route's page. The showcase sits inside the neutral frame like any other page. */
export function ShowcasePage() {
  return (
    <>
      <title>Component showcase · Melarc Ops Portal</title>
      <PageHeader
        title="Component showcase"
        description="Development only. Every example here is synthetic and none of it is product data."
        actions={
          <Button type="button" variant="secondary">
            Demo page action
          </Button>
        }
      />
      <Buttons />
      <Section title="Links">
        <p>
          A link sits inside a sentence, as in <Link to="/">go to the start page</Link>, and is
          underlined so that colour does not carry it alone.
        </p>
      </Section>
      <Section title="Alerts">
        <div className="showcase-stack">
          <Alert variant="danger" title="Demo error">
            This is a synthetic error message with an icon and words.
          </Alert>
          <Alert variant="danger" action={<Link to="/">Go to the start page</Link>}>
            A synthetic error with an action after the message.
          </Alert>
          <Alert variant="success" title="Demo success">
            This is a synthetic success message with an icon and words.
          </Alert>
        </div>
      </Section>
      <DemoForm />
      <Section title="Loading">
        <div className="showcase-row">
          <LoadingIndicator />
          <LoadingIndicator spinner={false} label="Still waiting…" />
        </div>
      </Section>
      <Section title="Surfaces">
        <div className="showcase-surfaces">
          <Surface name="The page surface" className="showcase-surface--page" />
          <Surface name="The default surface" className="showcase-surface--default" />
          <Surface name="The subtle surface" className="showcase-surface--subtle" />
          <Surface name="The selected surface" className="showcase-surface--selected" />
        </div>
      </Section>
    </>
  );
}
