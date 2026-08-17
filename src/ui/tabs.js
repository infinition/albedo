/**
 * The tab strip: one open model per tab.
 *
 * Albedo held exactly one scene, and every route to a second one replaced the
 * first without a word. Tabs are the answer the application had been missing:
 * opening a model no longer costs you the one you were working on, and the work
 * you are being asked about before closing is work that still exists.
 *
 * This module is the strip and nothing else. The documents themselves, meaning
 * what is in each scene, which of them is modified and what the engine did to
 * it, live where that state lives. They are handed here only as the five things
 * a tab needs to draw itself: an id, a title, whether it is modified, whether it
 * is only being looked through, and whether it is the active one.
 *
 * It takes the place of the file name that used to sit alone in the corner,
 * which is why it lives in the top left cluster rather than in a bar of its own:
 * everything in this application floats over the viewport and nothing is docked,
 * and a full width title bar would be the first thing to break that.
 */

import { t } from "../i18n/index.js";

const MAX_TITLE = 28;

export function createTabs({ host, onActivate, onClose, onNew, onKeep }) {
  host.textContent = "";
  host.className = "tabs-strip";

  const rail = document.createElement("div");
  rail.className = "tabs-rail";
  rail.setAttribute("role", "tablist");
  rail.setAttribute("aria-label", t("tabs.openModels"));

  /*
   * Two arrows, and they only exist when there is somewhere to go.
   *
   * The rail already scrolled: it has `overflow-x: auto` with the bar hidden,
   * so a strip too long for its corner could be reached with a trackpad and by
   * no other means. Nothing said so, which makes a tab that has fallen off the
   * end a tab that is gone. A pair of chevrons is the smallest thing that says
   * "there is more this way", and they take no room at all when they are not
   * needed, which is most of the time.
   */
  const arrow = (dir, glyph, label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `tabs-arrow tabs-arrow-${dir}`;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.hidden = true;
    b.innerHTML = `<svg viewBox="0 0 24 24"><path d="${glyph}" /></svg>`;
    b.addEventListener("click", () => {
      // Most of a tab rather than all of one, so the tab you were reading stays
      // half in view and you keep your place in the row.
      rail.scrollBy({ left: dir === "left" ? -140 : 140, behavior: "smooth" });
    });
    return b;
  };
  const back = arrow("left", "M15 6l-6 6 6 6", t("tabs.prevTitle"));
  const fwd = arrow("right", "M9 6l6 6-6 6", t("tabs.nextTitle"));

  const add = document.createElement("button");
  add.type = "button";
  add.className = "tabs-new";
  add.title = t("tabs.newTitle");
  add.setAttribute("aria-label", t("tabs.newAria"));
  add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>';
  add.addEventListener("click", () => onNew?.());

  host.append(back, rail, fwd, add);

  // The strip is built once; these four are outside the per-paint loop below,
  // so a language switch has to reach them by hand.
  window.addEventListener("i18n", () => {
    rail.setAttribute("aria-label", t("tabs.openModels"));
    back.title = t("tabs.prevTitle");
    back.setAttribute("aria-label", t("tabs.prevTitle"));
    fwd.title = t("tabs.nextTitle");
    fwd.setAttribute("aria-label", t("tabs.nextTitle"));
    add.title = t("tabs.newTitle");
    add.setAttribute("aria-label", t("tabs.newAria"));
    paint(lastDocs, lastActive);
  });

  /**
   * Whether the rail has anything hidden off either end, and say so.
   *
   * Read after every paint and on every scroll, because both change the answer
   * and neither is worth a listener of its own beyond this.
   */
  function paintArrows() {
    // One pixel of slack: a rail that fits can still report a scrollWidth a
    // fraction larger from sub-pixel layout, and an arrow that is always on is
    // an arrow nobody believes.
    const over = rail.scrollWidth - rail.clientWidth > 1;
    back.hidden = !over || rail.scrollLeft <= 1;
    fwd.hidden = !over || rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 1;
  }
  rail.addEventListener("scroll", paintArrows, { passive: true });

  /*
   * The row is redrawn when the window changes shape, because how much room
   * there is is exactly the question its layout answers. Coalesced to one frame:
   * dragging the library divider fires this continuously, and rebuilding a
   * handful of nodes per pointer move is work nobody sees.
   */
  let lastDocs = [];
  let lastActive = null;
  let pending = 0;
  window.addEventListener("resize", () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      paint(lastDocs, lastActive);
    });
  });

  /**
   * Draw the whole strip from the list it is given.
   *
   * Rebuilt rather than patched. A strip is at most a handful of small nodes,
   * and reconciling them by hand is how a close button ends up wired to the tab
   * that took the closed one's place.
   */
  function paint(docs, activeId) {
    lastDocs = docs;
    lastActive = activeId;
    rail.textContent = "";
    for (const doc of docs) {
      const tab = document.createElement("div");
      tab.className =
        "tabs-tab" + (doc.id === activeId ? " active" : "") + (doc.preview ? " preview" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(doc.id === activeId));
      tab.tabIndex = 0;

      /*
       * An eye on a preview tab.
       *
       * The italic name says it too, but italics are a difference you only see
       * once you already know to look for one. The eye is Albedo's own, the same
       * glyph the texture rows use for "this is being shown", so it reads
       * without a legend: you are looking through this tab rather than working
       * in it.
       */
      const label = doc.title || "Sans titre";
      if (doc.preview) {
        const eye = document.createElement("span");
        eye.className = "tabs-eye";
        /*
         * Clicking the eye keeps the tab.
         *
         * The eye says "this one is temporary and the next model will take its
         * place". Pointing at the thing that says it, to say no, is the obvious
         * gesture, and until now it did nothing. Double-clicking the tab already
         * does the same; this is the version you find without being told.
         */
        eye.title = t("tabs.keepTitle");
        eye.addEventListener("click", (e) => {
          e.stopPropagation();
          onKeep?.(doc.id);
        });
        eye.innerHTML =
          '<svg viewBox="0 0 24 24"><path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7z"/>' +
          '<circle cx="12" cy="12" r="2.6"/></svg>';
        tab.appendChild(eye);
      }
      /*
       * The model itself, in place of most of its name.
       *
       * A truncated file name is the worst of both worlds: it takes the room a
       * name needs and delivers none of what a name is for. Half the assets in a
       * library begin with the same twenty characters, so the strip ends up
       * reading `A_10-meter_secti…` four times over. The snapshot is the view you
       * left the tab on, which is the thing you actually remember it by.
       *
       * The name stays on the active tab. Icon-only everywhere would save more
       * room and cost too much: two variants of one model are indistinguishable
       * as pictures, and that is exactly the case where several tabs are open.
       * So the tab you are working in keeps its words, and the rest keep their
       * pictures, with the full path in the tooltip on all of them.
       */
      if (doc.thumb) {
        const shot = document.createElement("span");
        shot.className = "tabs-thumb";
        shot.style.backgroundImage = `url(${doc.thumb})`;
        tab.appendChild(shot);
      }
      const name = document.createElement("span");
      name.className = "tabs-name";
      name.textContent = label.length > MAX_TITLE ? label.slice(0, MAX_TITLE - 1) + "…" : label;
      // Everyone keeps their name for now. Whether they get to keep it is a
      // question about the whole row, so it is asked once, below, after the row
      // exists and can be measured.
      name.hidden = false;
      // The whole path, because two files called `scene.glb` in two folders is
      // the ordinary case and the tab can only show one of those words.
      tab.title = doc.dirty
        ? t("tabs.titleModified").replace("{path}", doc.path || label)
        : doc.preview
          ? t("tabs.titlePreview").replace("{path}", doc.path || label)
          : doc.path || label;

      /*
       * A dot for modified, and it takes the close button's place until you
       * reach for it.
       *
       * Two marks side by side in a narrow tab is one too many, and the dot is
       * the one you read at a glance while the cross is the one you aim at.
       */
      const mark = document.createElement("span");
      mark.className = "tabs-dot";
      mark.hidden = !doc.dirty;

      const shut = document.createElement("button");
      shut.type = "button";
      shut.className = "tabs-close";
      shut.title = t("tabs.closeTitle");
      shut.setAttribute("aria-label", t("tabs.closeAria").replace("{label}", label));
      shut.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>';
      shut.addEventListener("click", (e) => {
        e.stopPropagation();
        onClose?.(doc.id);
      });

      tab.addEventListener("click", () => onActivate?.(doc.id));
      tab.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate?.(doc.id);
        }
      });
      // Double clicking a preview keeps it, the way it does in an editor: it is
      // the gesture for "this one, actually".
      tab.addEventListener("dblclick", () => onKeep?.(doc.id));
      // The middle button closes a tab everywhere else that has tabs.
      tab.addEventListener("auxclick", (e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose?.(doc.id);
        }
      });

      tab.append(name, mark, shut);
      rail.appendChild(tab);
    }
    // A single tab is not a choice, so the strip stops looking like one. The
    // name still shows, because it is also the file name.
    host.classList.toggle("alone", docs.length < 2);

    /*
     * Names for everyone, if the row can afford it.
     *
     * The rule used to be flat: any tab with a snapshot and no focus lost its
     * name, whether or not there was room for it. With two files open in a wide
     * window that threw away the one piece of information a tab exists to carry,
     * to save space nothing else wanted. A picture tells two variants of one
     * model apart about as well as no label at all.
     *
     * So it is measured instead of assumed. Everything is drawn with its name,
     * and the names only come off if the row does not fit, which is the case
     * they were the answer to. Measured after the row is in the document, since
     * a node that is not laid out has no width to report.
     */
    if (rail.scrollWidth - rail.clientWidth > 1) {
      for (const tab of rail.children) {
        if (tab.classList.contains("active")) continue;
        const shot = tab.querySelector(".tabs-thumb");
        const label = tab.querySelector(".tabs-name");
        // Hidden rather than absent, so the tab keeps its width when it becomes
        // the active one and the strip does not jump under the cursor.
        if (shot && label) label.hidden = true;
      }
    }

    const live = rail.querySelector(".tabs-tab.active");
    live?.scrollIntoView({ block: "nearest", inline: "nearest" });
    paintArrows();
  }

  return { paint };
}
