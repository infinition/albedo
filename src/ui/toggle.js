/**
 * A button that is on or off, said once.
 *
 * Every toolbar in this application had grown the same two lines side by side:
 * `setAttribute("aria-pressed", String(on))` for the accessible truth, and
 * `classList.toggle("active", on)` for the one the stylesheet reads. Twenty odd
 * copies of a pair, which is twenty odd chances for a button to be lit and not
 * pressed, or pressed and not lit — and that split is exactly what a screen
 * reader user hits and nobody else ever sees.
 *
 * Reading the state back off the DOM was the other half of the idiom, and the
 * more dangerous one: two listeners on the same click each read `aria-pressed`,
 * each found the value the other had just written, and the button cancelled
 * itself. `isPressed` does not make that safe on its own, but it puts the read
 * in one place, next to the write, where the pairing is visible.
 *
 * Nothing here owns any state. The button is a view of something else — a
 * preference, a channel, a navigation mode — and these two functions only keep
 * its two faces in step.
 */

/** Is this button on? A missing button is off rather than an exception. */
export function isPressed(el) {
  return el?.getAttribute("aria-pressed") === "true";
}

/**
 * Say a button is on, in both the attribute and the class.
 *
 * `active` is opt-out for the handful of buttons whose CSS keys off
 * `[aria-pressed="true"]` directly and would gain a second, wrong highlight
 * from the class — the retopology menu arrow and the library drawer.
 *
 * Returns the state it set, so a caller that computed it inline can pass it on
 * without keeping a variable for it.
 */
export function setPressed(el, on, { active = true } = {}) {
  const state = !!on;
  if (!el) return state;
  el.setAttribute("aria-pressed", String(state));
  if (active) el.classList.toggle("active", state);
  return state;
}

/**
 * The next value in a ring, for a button that has more than two states.
 *
 * A two state button is a toggle and reads as one; past that, a single button
 * stepping through three or four values only works if every click is guaranteed
 * to move and to come back round. A value that is not in the list starts the
 * ring from the top rather than throwing, so a stale preference cannot leave a
 * button that no longer responds to being clicked.
 */
export function cycle(values, current, step = 1) {
  const at = values.indexOf(current);
  return values[(((at < 0 ? -step : at) + step) % values.length + values.length) % values.length];
}
