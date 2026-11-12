import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pressWithoutFocus } from '../../../test-support/press';
import { openerOf } from './opener';

/** A page of the shapes a press can land on. */
function draw(): void {
  document.body.innerHTML = `
    <button id="plain" type="button">Plain</button>
    <button id="with-icon" type="button"><span id="icon">★</span> With an icon</button>
    <button id="off" type="button" disabled><span id="off-icon">★</span> Not available</button>
    <a id="link" href="/somewhere"><span id="link-text">A link</span></a>
    <input id="field" type="text" />
    <p id="words">Words, which are not a control.</p>
    <div id="region" tabindex="0"><p id="in-region">In a region that can take focus.</p></div>
  `;
}

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`No #${id}.`);
  return element;
};

beforeEach(() => {
  // A key says the person is on the keyboard: it forgets any press an earlier test made.
  fireEvent.keyDown(document.body, { key: 'Shift' });
  draw();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('openerOf', () => {
  // Break caught: the element that has focus read as the opener, which in Safari's engine is the body after a press, so that a dialog had nothing to give focus back to.
  it('is the control that was pressed, though the engine gave it no focus', () => {
    pressWithoutFocus($('plain'));

    expect(document.body).toHaveFocus();
    expect(openerOf()).toBe($('plain'));
  });

  // Break caught: the target of the press taken as it is, which is the icon or the span inside the button, an element focus cannot go back to.
  it('is the control that holds the element that was pressed', () => {
    pressWithoutFocus($('icon'));
    expect(openerOf()).toBe($('with-icon'));

    pressWithoutFocus($('link-text'));
    expect(openerOf()).toBe($('link'));
  });

  // Break caught: a press seen only when it is a pointer's: a key, a script and assistive technology open a dialog with a click that has no pointer press before it.
  it('is the control of a click that no pointer press came before', () => {
    fireEvent.click($('plain'));

    expect(openerOf()).toBe($('plain'));
  });

  // Break caught: a press seen only when its click has finished: a control that opens something on the press itself (a menu's button opens on the pointer going down).
  it('is the control of a pointer press that has not been followed by a click', () => {
    fireEvent.pointerDown($('with-icon'));

    expect(openerOf()).toBe($('with-icon'));
  });

  // Break caught: a press that is noticed only after the page's own handler has run: the dialog opens from the handler, and asks then. The click is one that no pointer
  // press came before (a key's, a script's), so that nothing but the listener of the click itself can have seen it.
  it('is known by the time a handler of the page runs, and a handler that stops the click cannot hide it', () => {
    let known: HTMLElement | null = null;
    $('plain').addEventListener('click', (event) => {
      event.stopPropagation();
      known = openerOf();
    });

    fireEvent.click($('plain'));

    expect(known).toBe($('plain'));
  });

  // Break caught: the last press forgotten, or the first one kept.
  it('is the control that was pressed last', () => {
    pressWithoutFocus($('plain'));
    pressWithoutFocus($('with-icon'));

    expect(openerOf()).toBe($('with-icon'));
  });

  // Break caught (run 7, Stage 2.4; the Product Owner's review of 198e5be): the press remembered until any key is pressed, so a dialog opened later by something other than a press (a timer, a
  // route, a message from the server) gave focus back to a control pressed some time ago. A press belongs to the dialog that takes it: it is forgotten when the turn it was taken in is over.
  it('is forgotten once a dialog has taken it, so that one opened later by something that was no press has the control that has focus', async () => {
    pressWithoutFocus($('plain'));
    expect(openerOf()).toBe($('plain'));
    await Promise.resolve();

    expect(openerOf()).toBeNull();
    $('field').focus();
    expect(openerOf()).toBe($('field'));
  });

  // Break caught: a press forgotten at the first asking, so that what asks twice in one turn (effects that run twice in development, a dialog and a panel opened by one press) is told
  // nothing the second time.
  it('is the same control for everything that asks in the turn it was taken in', async () => {
    pressWithoutFocus($('with-icon'));

    expect([openerOf(), openerOf()]).toEqual([$('with-icon'), $('with-icon')]);
    await Promise.resolve();
    expect(openerOf()).toBeNull();
  });

  // Break caught: a press forgotten on being taken that also forgets the next one: a new press is a new opener.
  it('is the control of a new press after one has been taken', async () => {
    pressWithoutFocus($('plain'));
    openerOf();
    await Promise.resolve();

    pressWithoutFocus($('with-icon'));
    expect(openerOf()).toBe($('with-icon'));
  });

  // Break caught (run 7, Stage 2.4): a control that is connected but hidden accepted as the place to give focus back to, where focus cannot go: the control has to be shown.
  it.each([
    [
      'its own display',
      (button: HTMLElement) => {
        button.style.setProperty('display', 'none');
      },
    ],
    [
      'its own visibility',
      (button: HTMLElement) => {
        button.style.setProperty('visibility', 'hidden');
      },
    ],
    [
      'the hidden attribute',
      (button: HTMLElement) => {
        button.setAttribute('hidden', '');
      },
    ],
    [
      'an ancestor that is not drawn',
      (button: HTMLElement) => button.parentElement?.setAttribute('style', 'display: none'),
    ],
    [
      'an ancestor that is inert',
      (button: HTMLElement) => button.parentElement?.setAttribute('inert', ''),
    ],
  ])('is not a control that is connected but hidden by %s', (_how, hide) => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<button id="inner" type="button">Inner</button>';
    document.body.append(wrapper);
    $('field').focus();
    pressWithoutFocus($('inner'));
    $('field').focus();
    hide($('inner'));

    expect(openerOf()).toBe($('field'));
  });

  // Break caught: the check of what is shown taken too far: a control inside a region that is drawn is a control.
  it('is a control that is shown, inside a region that is shown', () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<button id="shown" type="button">Shown</button>';
    document.body.append(wrapper);
    pressWithoutFocus($('shown'));

    expect(openerOf()).toBe($('shown'));
  });

  // Break caught: no fallback, so a dialog opened by a keyboard (nothing was pressed) has nothing to give focus back to.
  it('is the control that has focus when nothing was pressed', () => {
    $('field').focus();

    expect(openerOf()).toBe($('field'));
  });

  // Break caught: the body (where focus is when nothing has it) offered as a place to go back to.
  it('is nothing when nothing was pressed and nothing has focus', () => {
    expect(document.body).toHaveFocus();

    expect(openerOf()).toBeNull();
  });

  // Break caught: a press that outlives the keyboard: a person who pressed a button and then went on by keyboard is on the control they reached, not on the button they pressed.
  it('is the control that has focus once a key has been pressed since the press', () => {
    pressWithoutFocus($('plain'));
    $('field').focus();
    fireEvent.keyDown($('field'), { key: 'k', ctrlKey: true });

    expect(openerOf()).toBe($('field'));
  });

  // Break caught: a control that has gone from the page offered as the place to go back to: focus has to be given to something that is there.
  it('is not a control that has been removed from the page', () => {
    $('field').focus();
    pressWithoutFocus($('plain'));
    $('field').focus();
    $('plain').remove();

    expect(openerOf()).toBe($('field'));
  });

  // Break caught: a press on words read as a press on a control, or one on a control that cannot be used.
  it('is not a press on what is not a control, or on a control that is disabled', () => {
    $('field').focus();

    pressWithoutFocus($('words'));
    $('field').focus();
    expect(openerOf()).toBe($('field'));

    pressWithoutFocus($('off-icon'));
    $('field').focus();
    expect(openerOf()).toBe($('field'));
  });

  // Break caught: an element that can take focus by a script (a region the page made focusable) not counted as a control: a press in it is the engine's to focus.
  it('is a region that can take focus, for a press on what it holds', () => {
    pressWithoutFocus($('in-region'));

    expect(openerOf()).toBe($('region'));
  });
});
