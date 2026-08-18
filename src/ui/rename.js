/**
 * Renaming something in place, said once.
 *
 * The scene tree grew this first: a name becomes a text field where it sits,
 * Entrée keeps it, Échap puts the old one back, and clicking away keeps it too
 * because that is what every other list in Windows does. The library needed the
 * same gesture for its roots — `library_rename` had been sitting in the Rust
 * dispatcher with nothing on the other end of it — and a second copy of this
 * would have been a second set of keyboard rules to drift apart.
 *
 * The field replaces the node it is given and nothing else: what to do with the
 * new text, and what to redraw afterwards, belong to the list that called.
 */

/**
 * Swap `node` for a text field holding `text`.
 *
 * `commit` is handed the typed value when the edit is kept, and is not called
 * at all when it is abandoned. `after` runs either way, once, and is where the
 * caller repaints — the field is gone from the document by then, so a repaint
 * that rebuilds the row is safe.
 *
 * Returns the field, so a list that has to know whether an edit is in flight —
 * to hold off a repaint that would yank the cursor — can keep hold of it.
 */
export function inlineRename(node, text, { commit, after, className = "inline-rename" } = {}) {
  const input = document.createElement("input");
  input.className = className;
  input.value = text;
  node.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    if (keep) commit?.(input.value);
    after?.();
  };

  input.addEventListener("keydown", (e) => {
    // The lists this sits in are full of single key shortcuts. Typing a name
    // that contains an `r` must not open the retopology mode.
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  return input;
}
