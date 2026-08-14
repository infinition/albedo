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

const MAX_TITLE = 28;

export function createTabs({ host, onActivate, onClose, onNew, onKeep }) {
  host.textContent = "";
  host.className = "tabs-strip";

  const rail = document.createElement("div");
  rail.className = "tabs-rail";
  rail.setAttribute("role", "tablist");
  rail.setAttribute("aria-label", "Modèles ouverts");

  const add = document.createElement("button");
  add.type = "button";
  add.className = "tabs-new";
  add.title = "Nouvel onglet vide, pour composer une scène (Ctrl+T)";
  add.setAttribute("aria-label", "Nouvel onglet");
  add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>';
  add.addEventListener("click", () => onNew?.());

  host.append(rail, add);

  /**
   * Draw the whole strip from the list it is given.
   *
   * Rebuilt rather than patched. A strip is at most a handful of small nodes,
   * and reconciling them by hand is how a close button ends up wired to the tab
   * that took the closed one's place.
   */
  function paint(docs, activeId) {
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
      // Hidden rather than absent, so the tab keeps its width when it becomes
      // the active one and the strip does not jump under the cursor.
      name.hidden = !!doc.thumb && doc.id !== activeId;
      // The whole path, because two files called `scene.glb` in two folders is
      // the ordinary case and the tab can only show one of those words.
      tab.title = doc.dirty
        ? `${doc.path || label} · modifié`
        : doc.preview
          ? `${doc.path || label} · aperçu, remplacé par le prochain modèle regardé`
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
      shut.title = "Fermer cet onglet";
      shut.setAttribute("aria-label", `Fermer ${label}`);
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
    const live = rail.querySelector(".tabs-tab.active");
    live?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  return { paint };
}
