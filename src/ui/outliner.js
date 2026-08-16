import { readScene, thumbnail, toggleMap } from "./outline.js";
import { forgetPortraits, portrait } from "./portrait.js";
import { selection, decorId } from "../selection.js";
import { renameNode } from "../naming.js";
import "./tree.css";

/**
 * One list of everything in the scene.
 *
 * There were two, and the split between them was arbitrary in the way that only
 * becomes obvious once somebody says it out loud. One tree held the meshes,
 * their materials and each material's maps. Another, in a tab of its own, held
 * the lights, the stand and the backdrop. So "what is in this scene" had two
 * answers in two places, and the one thing a person actually does with a scene —
 * point at a thing and change it — depended on guessing which of the two lists
 * that thing had been filed under.
 *
 * A light is an object. It has a position, it can be hidden, renamed, deleted
 * and clicked on. So is the stand. So, near enough, is the backdrop: it is the
 * thing behind the model and, when it is an image or a gradient, the thing
 * lighting it. Filing them apart from the meshes was a statement about how the
 * viewer is built, not about what the user is looking at.
 *
 * Four groups, one row shape, one selection:
 *
 * - **Fonds** — studio, gradient or image. Exactly one is in force; the others
 *   are shown so that switching is a click on the thing you want rather than a
 *   trip to a segmented control somewhere else. The studio probe is in here as
 *   an ordinary entry, which is the point of it: it lights every scene by
 *   default and used to be the one light source with no row, no name and no
 *   dial, so "why is my unlit model still lit" had nowhere to be answered.
 * - **Lumières** — every light, with its own colour as its icon.
 * - **Socles** — the stand, if there is one.
 * - **Modèle** — meshes, materials, maps, as before.
 *
 * It is not a tab any more. It sits at the top of the panel, always, because a
 * list of what exists is the thing you navigate *from*: putting it behind a tab
 * meant every trip from one object to another went through the tab bar.
 *
 * The module is still fetched rather than parsed at startup, and that constraint
 * has not moved: this executable is also the Windows shell thumbnail provider,
 * one process per file, and a list that renders a portrait per row is exactly
 * what must not exist during a thumbnail job.
 */

const fr = (n) => n.toLocaleString("fr-FR");

/** The three backdrop sources, in the order they escalate. */
const BACKDROPS = [
  { kind: "studio", label: "Studio", hint: "Éclairage neutre généré, sans fond visible", lights: true },
  { kind: "gradient", label: "Dégradé", hint: "Fond en dégradé, qui éclaire aussi", lights: true },
  { kind: "image", label: "Image", hint: "Panorama 360, HDR ou image", lights: true },
  {
    kind: "picture",
    label: "Toile",
    hint: "Une image fixe derrière le modèle. Elle ne tourne pas avec la caméra et n'éclaire pas.",
    lights: false,
  },
];

/** What the environment's own light looks like, per source. */
const ENV_TINT = { studio: "#e8ecf4", gradient: "#9fb4d0", image: "#ffd9a0" };

const LIGHT_GLYPH = { directional: "☀", point: "●", spot: "▼" };
const LIGHT_LABEL = { directional: "Directionnelle", point: "Ponctuelle", spot: "Projecteur" };

export function createOutliner({ host, viewer, channels, swapTexture, onNotice, actions = {} }) {
  host.textContent = "";
  host.className = "outliner";

  const body = document.createElement("div");
  body.className = "tree-list";
  host.append(body);

  /**
   * Which branches are open.
   *
   * Every group starts open except the model's materials: the first question is
   * always "what is in here", and the maps only matter once a surface is chosen.
   * Kept across repaints, because a list that snaps shut every time you click an
   * eye is a list you stop using.
   */
  const opened = new Set([
    "group:bg", "group:light", "group:fog", "group:stand", "group:model",
  ]);
  /** Whether this model has ever been drawn, so the first paint can open it. */
  let seen = false;
  /** The row being renamed, so a repaint does not tear the input out. */
  let editing = null;

  const notice = (text) => onNotice?.(text);
  const env = () => viewer.scene?.environment || null;

  // ---------------------------------------------------------------------------
  // The pieces every row is made of
  // ---------------------------------------------------------------------------

  function caret(id, has) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tree-caret" + (has ? "" : " empty");
    b.textContent = has ? (opened.has(id) ? "▾" : "▸") : "";
    if (has) {
      b.title = opened.has(id) ? "Replier" : "Déplier";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        opened.has(id) ? opened.delete(id) : opened.add(id);
        paint();
      });
    }
    return b;
  }

  function eye(on, title, act) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tree-eye" + (on ? "" : " off");
    b.title = title;
    b.textContent = on ? "◉" : "◌";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      act();
    });
    return b;
  }

  function trash(title, act) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tree-trash";
    b.title = title;
    b.textContent = "🗑";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      act();
    });
    return b;
  }

  /**
   * The name, and the way to change it.
   *
   * Double click to edit, which is where everyone already looks for it, and
   * Enter or blur to commit. The input is created rather than the text made
   * `contenteditable`, so Escape genuinely cancels: the old name is still in the
   * model and a repaint restores it untouched.
   *
   * `rename` returns the name actually applied, which is not always the one
   * typed — a mesh name is uniquified against the rest of the scene — and the
   * row shows what it got rather than what it asked for.
   */
  function nameCell(text, rename) {
    const span = document.createElement("span");
    span.className = "tree-name";
    span.textContent = text;
    if (!rename) return span;

    span.title = `${text} — double-clic pour renommer`;
    span.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      editing = null;
      const input = document.createElement("input");
      input.className = "tree-rename";
      input.value = text;
      span.replaceWith(input);
      input.focus();
      input.select();

      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        editing = null;
        if (commit) {
          const applied = rename(input.value);
          if (applied && applied !== text) notice(`Renommé en ${applied}`);
        }
        paint();
      };
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") finish(true);
        if (ev.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
      editing = input;
    });
    return span;
  }

  /** A group header: caret, folder, label, count, and sometimes a plus. */
  function groupHead(key, label, count, add) {
    const id = `group:${key}`;
    const row = document.createElement("div");
    row.className = "tree-row tree-group";
    row.appendChild(caret(id, true));
    row.insertAdjacentHTML(
      "beforeend",
      `<span class="tree-folder">▤</span><span class="tree-name"></span>` +
        `<span class="tree-num">${count}</span>`
    );
    row.querySelector(".tree-name").textContent = label;
    row.addEventListener("click", () => {
      opened.has(id) ? opened.delete(id) : opened.add(id);
      paint();
    });
    if (add) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tree-mini";
      b.textContent = "+";
      b.title = add.title;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        add.act();
      });
      row.appendChild(b);
    }
    return { row, open: opened.has(id) };
  }

  // ---------------------------------------------------------------------------
  // Fonds
  // ---------------------------------------------------------------------------

  /** A chip showing what the backdrop actually looks like. */
  function backdropChip(kind) {
    const chip = document.createElement("span");
    chip.className = "mat-chip";
    if (kind === "gradient" && viewer.gradientCanvas) {
      // The gradient's own canvas, which is already drawn and already correct;
      // redrawing it here would be a second implementation of the same colours.
      try {
        chip.style.backgroundImage = `url(${viewer.gradientCanvas.toDataURL()})`;
        chip.style.backgroundSize = "cover";
        return chip;
      } catch {
        /* falls through to the flat swatch */
      }
    }
    if (kind === "image") {
      const url = thumbnail(viewer.panoramaSource, 22);
      if (url) {
        chip.style.backgroundImage = `url(${url})`;
        chip.style.backgroundSize = "cover";
        return chip;
      }
      chip.style.background = "linear-gradient(135deg,#3a4150,#20242c)";
      return chip;
    }
    if (kind === "gradient") {
      chip.style.background = "linear-gradient(180deg,#4a5568,#1b1f26)";
      return chip;
    }
    // The studio has no picture of itself — it is a generated room, and drawing
    // a fake photograph of one would be a worse lie than a plain swatch.
    chip.style.background = "radial-gradient(circle at 35% 30%,#dfe4ec,#6d7787 60%,#2b3038)";
    return chip;
  }

  function backgroundRows() {
    const rows = [];
    for (const source of BACKDROPS) {
      const id = decorId("bg", source.kind);
      const active = (viewer.envKind || "studio") === source.kind;
      const row = document.createElement("div");
      row.className =
        "tree-row tree-child" + (selection.has(id) ? " picked" : "") + (active ? " on" : " muted");
      row.appendChild(caret(id, false));
      row.appendChild(backdropChip(source.kind));
      row.appendChild(nameCell(source.label, null));
      row.title = source.hint;

      // What it is doing right now, said on the row: a backdrop that lights the
      // model and one that merely sits behind it are two different things and
      // used to be told apart only by a checkbox in another panel.
      const state = document.createElement("span");
      state.className = "tree-num";
      state.textContent = !active
        ? ""
        : !source.lights
          ? "fond seul"
          : viewer.envLighting !== false
            ? "éclaire"
            : "fond";
      row.appendChild(state);

      row.addEventListener("click", (e) => {
        // Selecting shows its dials; a backdrop that is not in force is switched
        // to by the same click, because "look at this one" and "use this one"
        // are the same intention for a thing there can only be one of.
        if (!active) actions.setBackground?.(source.kind);
        selection.choose(id, "bg", e.ctrlKey || e.metaKey);
      });

      if (active) {
        row.appendChild(
          eye(
            viewer.showEnvBackground !== false,
            viewer.showEnvBackground !== false ? "Masquer le fond" : "Afficher le fond",
            () => {
              actions.setBackgroundVisible?.(!(viewer.showEnvBackground !== false));
              paint();
            }
          )
        );
      }
      rows.push(row);
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Lumières
  // ---------------------------------------------------------------------------

  /**
   * What the environment contributes, listed among the lights.
   *
   * The studio probe lights every scene by default and had no row here, only an
   * entry under Fonds — so "why is my model still lit with every light off" had
   * nowhere to be answered, and the one source doing most of the work was the
   * one thing in the application you could not point at.
   *
   * It is not the Fonds row said twice. That one answers *what is behind*; this
   * one answers *what lights*, and for the studio those are completely
   * different: it lights and shows nothing at all. They share a selection id
   * because they are one object with two questions asked of it, so choosing
   * either opens the same dials.
   *
   * Written for all three sources rather than for the studio alone: an HDR's
   * contribution deserves the same row, and a rule with one exception in it is a
   * rule somebody has to remember.
   */
  function environmentRow() {
    const chosen = BACKDROPS.find((b) => b.kind === viewer.envKind) || BACKDROPS[0];
    // A backdrop that does not light leaves the studio probe doing the work, so
    // that is what this row must name. Saying "Toile" here would credit the
    // light to a flat picture that casts nothing.
    const source = chosen.lights ? chosen : BACKDROPS[0];
    const on = viewer.envLighting !== false;
    const id = decorId("bg", source.kind);

    const row = document.createElement("div");
    row.className = "tree-row tree-child" + (selection.has(id) ? " picked" : "") + (on ? "" : " muted");
    row.appendChild(caret(id, false));

    const bulb = document.createElement("span");
    bulb.className = "tree-bulb";
    bulb.style.background = ENV_TINT[source.kind] || "#e8ecf4";
    bulb.textContent = "◍";
    bulb.title = "La lumière qui vient de l'environnement";
    row.appendChild(bulb);

    row.appendChild(nameCell("Environnement", null));
    const which = document.createElement("span");
    which.className = "tree-num";
    which.textContent = source.label;
    row.appendChild(which);
    row.title = `${source.label} — ${source.hint}`;

    row.addEventListener("click", (e) => selection.choose(id, "bg", e.ctrlKey || e.metaKey));
    row.appendChild(
      eye(on, on ? "Éteindre l'environnement" : "Rallumer l'environnement", () => {
        actions.setEnvLighting?.(!on);
        paint();
      })
    );
    return row;
  }

  function lightRows() {
    return [environmentRow(), ...(viewer.lights || []).map((entry) => {
      const id = decorId("light", entry.id);
      const row = document.createElement("div");
      row.className =
        "tree-row tree-child" + (selection.has(id) ? " picked" : "") + (entry.enabled ? "" : " muted");
      row.appendChild(caret(id, false));

      // The icon *is* the colour. On a rig of four lights that is the only thing
      // that tells the warm key from the cold rim without clicking each one.
      const bulb = document.createElement("span");
      bulb.className = "tree-bulb";
      bulb.style.background = entry.colour || "#ffffff";
      bulb.textContent = LIGHT_GLYPH[entry.kind] || "☀";
      bulb.title = LIGHT_LABEL[entry.kind] || entry.kind;
      row.appendChild(bulb);

      row.appendChild(
        nameCell(entry.name || `light${entry.id}`, (next) => {
          const clean = String(next || "").trim();
          if (!clean) return entry.name;
          entry.name = clean;
          actions.onLightRenamed?.(entry);
          return clean;
        })
      );

      const power = document.createElement("span");
      power.className = "tree-num";
      power.textContent = entry.intensity.toFixed(1);
      row.appendChild(power);

      // No framing on a light. A mesh is somewhere in a model and finding it is
      // the question the click was asking; a light is somewhere around it, and
      // swinging the camera off the subject to look at a marker loses the one
      // thing you were judging the light *by*.
      row.addEventListener("click", (e) =>
        selection.choose(id, "light", e.ctrlKey || e.metaKey)
      );
      row.appendChild(
        eye(entry.enabled, entry.enabled ? "Éteindre" : "Allumer", () => {
          viewer.setLight(entry.id, { enabled: !entry.enabled });
          notice(`${entry.name} ${entry.enabled ? "allumée" : "éteinte"}`);
          paint();
        })
      );
      row.appendChild(
        trash("Supprimer cette lumière", () => {
          viewer.removeLight(entry.id);
          selection.delete(id);
          notice(`${entry.name} supprimée`);
          actions.onLightsChanged?.();
          paint();
        })
      );
      return row;
    })];
  }

  // ---------------------------------------------------------------------------
  // Atmosphère
  // ---------------------------------------------------------------------------

  /**
   * The fog, listed like the object it is.
   *
   * It has a position, a colour and an extent, it can be switched off, and it
   * can be dragged. Everything on that list is true of a light, and a thing that
   * behaves like an object belongs in the list of objects rather than only in a
   * card of sliders somewhere else. The card stays: it is where the *look* is
   * set. This row is where it *is*.
   */
  function fogRows() {
    const state = actions.fogState?.();
    if (!state) return [];
    const id = decorId("fog", "main");
    const row = document.createElement("div");
    row.className =
      "tree-row tree-child" + (selection.has(id) ? " picked" : "") + (state.on ? "" : " muted");
    row.appendChild(caret(id, false));

    const chip = document.createElement("span");
    chip.className = "tree-bulb";
    chip.style.background = state.colour || "#aebdd0";
    chip.textContent = "≈";
    chip.title = "Brouillard volumétrique";
    row.appendChild(chip);

    row.appendChild(nameCell("Brouillard", null));
    const num = document.createElement("span");
    num.className = "tree-num";
    num.textContent = state.on ? state.density.toFixed(1) : "";
    row.appendChild(num);

    row.addEventListener("click", (e) => selection.choose(id, "fog", e.ctrlKey || e.metaKey));
    row.appendChild(
      eye(state.on, state.on ? "Éteindre le brouillard" : "Allumer le brouillard", () => {
        actions.setFog?.(!state.on);
        paint();
      })
    );
    return [row];
  }

  // ---------------------------------------------------------------------------
  // Socles
  // ---------------------------------------------------------------------------

  /** The biggest mesh in a subtree, which is the one worth drawing. */
  function largestMesh(object) {
    let best = null;
    let most = -1;
    object?.traverse?.((o) => {
      const count = o.geometry?.attributes?.position?.count || 0;
      if ((o.isMesh || o.isSkinnedMesh) && count > most) {
        most = count;
        best = o;
      }
    });
    return best;
  }

  function pedestalRows() {
    const stand = viewer.pedestal;
    if (!stand) return [];
    const id = decorId("stand", "main");
    const row = document.createElement("div");
    row.className =
      "tree-row tree-child" + (selection.has(id) ? " picked" : "") + (stand.visible ? "" : " muted");
    row.appendChild(caret(id, false));

    const face = portrait(viewer.renderer, largestMesh(stand), -1, { environment: env() });
    row.insertAdjacentHTML(
      "beforeend",
      face
        ? `<span class="tree-face" style="background-image:url(${face})"></span>`
        : `<span class="tree-glyph">▬</span>`
    );
    row.appendChild(
      nameCell(stand.name || "Socle", (next) => renameNode(viewer.root, stand, next))
    );
    // Same as a light: the stand is scenery around the subject, and framing it
    // takes the subject off screen.
    row.addEventListener("click", (e) => selection.choose(id, "stand", e.ctrlKey || e.metaKey));
    row.appendChild(
      eye(stand.visible, stand.visible ? "Masquer le socle" : "Afficher le socle", () => {
        stand.visible = !stand.visible;
        viewer.invalidate?.();
        paint();
      })
    );
    row.appendChild(
      trash("Retirer le socle", () => {
        actions.removePedestal?.();
        selection.delete(id);
        paint();
      })
    );
    return [row];
  }

  // ---------------------------------------------------------------------------
  // Modèle
  // ---------------------------------------------------------------------------

  function meshNode(mesh) {
    const group = document.createElement("div");
    group.className = "tree-node";

    const row = document.createElement("div");
    row.className = "tree-row tree-mesh" + (selection.has(mesh.id) ? " picked" : "");
    row.appendChild(caret(mesh.id, mesh.materials.length > 0));
    // The mesh draws itself, with its own textures on it. On a file whose parts
    // are called Object_12 through Object_47 this is the only thing that tells
    // one row from another.
    const face = portrait(viewer.renderer, mesh.node, -1, {
      materials: mesh.materials.map((m) => m.material),
      environment: env(),
    });
    row.insertAdjacentHTML(
      "beforeend",
      face
        ? `<span class="tree-face" style="background-image:url(${face})"></span>`
        : `<span class="tree-glyph">▦</span>`
    );
    row.appendChild(
      nameCell(mesh.name, (next) => renameNode(viewer.root, mesh.node, next))
    );
    const num = document.createElement("span");
    num.className = "tree-num";
    num.textContent = fr(mesh.triangles);
    row.appendChild(num);
    row.title = `${mesh.name} · ${fr(mesh.triangles)} triangles`;
    row.addEventListener("click", (e) => {
      selection.choose(mesh.id, "mesh", e.ctrlKey || e.metaKey);
      // Choosing a row says which one it is and nothing about where. On a model
      // of forty meshes that is the question the click was asking.
      if (!(e.ctrlKey || e.metaKey)) actions.focus?.({ object: mesh.node });
    });
    row.appendChild(
      eye(mesh.visible, mesh.visible ? "Masquer ce maillage" : "Afficher ce maillage", () => {
        mesh.node.visible = !mesh.node.visible;
        notice(`${mesh.name} ${mesh.node.visible ? "affiché" : "masqué"}`);
        viewer.invalidate?.();
        paint();
      })
    );
    row.appendChild(
      trash("Supprimer ce maillage", () => {
        viewer.removeMesh(mesh.node);
        selection.delete(mesh.id);
        notice(`${mesh.name} supprimé`);
        viewer.invalidate?.();
        paint();
      })
    );
    group.appendChild(row);

    if (!opened.has(mesh.id)) return group;
    for (const mat of mesh.materials) group.append(...materialRows(mesh, mat));
    return group;
  }

  function materialRows(mesh, mat) {
    const rows = [];
    const row = document.createElement("div");
    row.className =
      "tree-row tree-mat" + (selection.has(mat.id) ? " picked" : "") + (mat.hidden ? " muted" : "");
    // The material's own portrait: this mesh with every other material ghosted
    // out, which says *where on the part* it sits. A colour swatch says "this
    // one is blue", which is a different and lesser fact.
    const shown = mesh.materials.indexOf(mat);
    const face = portrait(viewer.renderer, mesh.node, mesh.materials.length > 1 ? shown : -1, {
      materials: mesh.materials.map((m) => m.material),
      environment: env(),
    });
    const url = face || thumbnail(mat.material.map);
    row.appendChild(caret(mat.id, mat.maps.length > 0));
    row.insertAdjacentHTML(
      "beforeend",
      `<span class="${face ? "tree-face" : "mat-chip"}"${
        url
          ? ` style="background-image:url(${url})"`
          : ` style="background:${
              mat.material.color ? "#" + mat.material.color.getHexString() : "#3a3f48"
            }"`
      }></span>`
    );
    row.appendChild(
      nameCell(mat.name, (next) => {
        const clean = String(next || "").trim();
        if (!clean) return mat.name;
        mat.material.name = clean;
        return clean;
      })
    );
    const num = document.createElement("span");
    num.className = "tree-num";
    num.textContent = fr(mat.triangles);
    row.appendChild(num);
    row.title = `${mat.name} · ${fr(mat.triangles)} triangles`;
    row.addEventListener("click", (e) =>
      selection.choose(mat.id, "material", e.ctrlKey || e.metaKey)
    );
    row.appendChild(
      eye(!mat.hidden, mat.hidden ? "Afficher cette matière" : "Masquer cette matière", () => {
        channels?.setMaterialHidden?.(mat.id, !mat.hidden);
        notice(`${mat.name} ${mat.hidden ? "affichée" : "masquée"}`);
        viewer.invalidate?.();
        paint();
      })
    );
    rows.push(row);

    if (!opened.has(mat.id)) return rows;
    for (const map of mat.maps) rows.push(mapRow(mat, map));
    return rows;
  }

  function mapRow(mat, map) {
    const row = document.createElement("div");
    row.className = "tree-row tree-map" + (map.hidden ? " muted" : "");
    const url = thumbnail(map.texture, 18);
    row.insertAdjacentHTML(
      "beforeend",
      `<span class="mat-chip small"${url ? ` style="background-image:url(${url})"` : ""}></span>` +
        `<span class="tree-name"></span>`
    );
    row.querySelector(".tree-name").textContent = map.label;

    const size = document.createElement("span");
    size.className = "tree-num";
    const img = map.texture?.image;
    size.textContent = img?.width ? `${img.width}×${img.height}` : "";

    // Replacing lives on the row of the map it replaces, rather than in a second
    // list somewhere else saying the same things about the same slots.
    const swap = document.createElement("button");
    swap.type = "button";
    swap.className = "tree-swap";
    swap.textContent = "⇄";
    swap.title = `Remplacer ${map.label}`;
    swap.addEventListener("click", (e) => {
      e.stopPropagation();
      swapTexture?.(mat.id, map.slot);
    });

    row.append(
      size,
      swap,
      eye(!map.hidden, map.hidden ? "Rebrancher cette carte" : "Débrancher cette carte", () => {
        const off = toggleMap(mat.material, map.slot);
        notice(`${map.label} ${off ? "débranchée" : "rebranchée"}`);
        viewer.invalidate?.();
        paint();
      })
    );
    return row;
  }

  // ---------------------------------------------------------------------------
  // The whole list
  // ---------------------------------------------------------------------------

  function paint() {
    // A repaint in the middle of a rename would tear the input out from under
    // the caret. The rename commits on blur and repaints itself, so skipping
    // here loses nothing: the list is redrawn a moment later either way.
    if (editing && document.contains(editing)) return;

    const meshes = viewer.current ? readScene(viewer, channels) : [];

    // The first paint of a model opens every mesh, so the shape of the file is
    // visible without a single click.
    if (!seen && meshes.length) {
      forgetPortraits();
      for (const m of meshes) opened.add(m.id);
      seen = true;
    }
    if (!meshes.length) seen = false;

    // Anything selected that the current model does not contain is gone: a
    // selection kept across a load points at objects that were disposed. Only
    // the model's own kinds are judged — see `prune`, which is where a light
    // used to be swept away by a list that had never heard of lights.
    const alive = new Set();
    for (const m of meshes) {
      alive.add(m.id);
      for (const mat of m.materials) alive.add(mat.id);
    }
    if (meshes.length) selection.prune(alive);

    body.textContent = "";

    /*
     * The model first, the room after it, in that order.
     *
     * It read backdrop, lights, fog, stand, model — the order the viewer builds
     * them in, which is a fact about the code. What somebody opens this list for
     * is the thing they loaded, and it was at the bottom, under four groups of
     * scenery, needing a scroll on any file with more than a few meshes. The
     * subject leads and the room follows it, roughly in the order you would set
     * one up: the thing, what it stands on, the air around it, what lights it,
     * and what is behind it.
     */
    const groups = [
      { key: "model", label: "Modèle", rows: meshes.map(meshNode) },
      {
        key: "stand",
        label: "Socles",
        rows: pedestalRows(),
        add: { title: "Choisir un socle", act: () => actions.pickPedestal?.() },
      },
      { key: "fog", label: "Atmosphère", rows: fogRows() },
      {
        key: "light",
        label: "Lumières",
        rows: lightRows(),
        add: { title: "Ajouter une lumière", act: () => actions.addLight?.() },
      },
      { key: "bg", label: "Fonds", rows: backgroundRows() },
    ];

    for (const group of groups) {
      const { row, open } = groupHead(group.key, group.label, group.rows.length, group.add);
      body.appendChild(row);
      if (open) for (const child of group.rows) body.appendChild(child);
    }

    if (!meshes.length) {
      const hint = document.createElement("p");
      hint.className = "hint tree-empty";
      hint.textContent = "Ouvre un modèle pour voir ce qu'il contient.";
      body.appendChild(hint);
    }
  }

  /** Hide everything that is not selected. */
  function isolate() {
    if (!selection.size) return;
    let hidden = 0;
    for (const mesh of readScene(viewer, channels)) {
      const keepMesh =
        selection.has(mesh.id) || mesh.materials.some((m) => selection.has(m.id));
      mesh.node.visible = keepMesh;
      if (!keepMesh) hidden++;
      for (const mat of mesh.materials) {
        channels?.setMaterialHidden?.(mat.id, !(selection.has(mesh.id) || selection.has(mat.id)));
      }
    }
    notice(`Isolé : ${hidden} maillage${hidden > 1 ? "s" : ""} masqué${hidden > 1 ? "s" : ""}`);
    viewer.invalidate?.();
    paint();
  }

  /** Everything visible again and nothing selected: the way back, in one call. */
  function reveal() {
    for (const mesh of readScene(viewer, channels)) {
      mesh.node.visible = true;
      for (const mat of mesh.materials) channels?.setMaterialHidden?.(mat.id, false);
    }
    selection.clear();
    viewer.invalidate?.();
    paint();
    notice("Tout affiché");
  }

  paint();
  return {
    paint,
    isolate,
    reveal,
    /** A new model: forget the portraits, the open branches and the first paint. */
    reset() {
      forgetPortraits();
      for (const id of [...opened]) if (!id.startsWith("group:")) opened.delete(id);
      seen = false;
      paint();
    },
  };
}
