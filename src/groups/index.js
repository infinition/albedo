import { applyStaticIn, num, register, t } from "../i18n/index.js";
import { setPressed } from "../ui/toggle.js";
import grFr from "./fr.json";
import grEn from "./en.json";
import "./groups.css";

/*
 * This mode's strings live with this mode, like Retopo's and the library's do.
 * The two dictionaries in `src/i18n` are parsed before the window exists, and
 * every Explorer thumbnail process pays for whatever is in them.
 */
register({ fr: grFr, en: grEn });

/**
 * The Groupes mode.
 *
 * Answers one question — which parts is this model made of — for the input that
 * has nobody else to ask: a mesh out of Hunyuan3D or Meshy, one shell, one
 * material, one atlas, with nothing in the file admitting it has parts at all.
 *
 * ## Why there is a slider and not a button
 *
 * The engine does not decide how many parts the model has, because nothing
 * about a rock sitting on a patch of ground says whether that is two parts or a
 * rock and eleven tufts of grass. It produces the whole hierarchy instead, and
 * the level is chosen here, by the person looking at the model, who can answer
 * in a second and can also change their mind.
 *
 * Moving the slider replays a prefix of the engine's merge order through a
 * union-find and uploads the result as a small lookup texture. No geometry is
 * touched, no attribute is rewritten, nothing is asked of the engine. The whole
 * cost is a few thousand numbers, which is why it keeps up with a drag.
 *
 * ## What it does not do yet
 *
 * Editing a group by hand, and splitting the model along the groups. Both are
 * built on what is here — a stable per-triangle id and a partition that can be
 * read back — and neither changes the shape of it.
 */
export function createGroups({
  wire,
  tauri,
  viewer,
  onBusy,
  toast,
  channels,
  showPane,
  onOpenChange,
}) {
  const SHELL = `
<div class="gr-bar" data-el="bar">
  <button class="tb-i gr-menu-toggle" type="button" data-el="menuToggle" aria-pressed="false"
          data-i18n-title="gr.menuTitle" title="Réglages de la segmentation">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10l5-5 5 5"/></svg>
  </button>

  <button class="wide" type="button" data-el="run" data-i18n="gr.run">Segmenter</button>

  <!--
    The slider is the mode, so it sits in the bar and not in the panel. Putting
    it behind the settings toggle would hide the one control somebody opens this
    for behind the ones they will touch once.
  -->
  <label class="gr-slider" data-el="countWrap" hidden>
    <span data-i18n="gr.groups">Groupes</span>
    <input type="range" data-el="count" min="1" max="2" step="1" value="1" />
    <span class="gr-num" data-el="countValue">—</span>
  </label>

  <div class="segment gr-views" role="group" data-i18n-aria="gr.view" aria-label="Affichage" data-el="views" hidden>
    <button class="seg" type="button" data-view="0" data-i18n="gr.viewOff">Aucun</button>
    <button class="seg active" type="button" data-view="1" data-i18n="gr.viewFlat">Aplats</button>
    <button class="seg" type="button" data-view="2" data-i18n="gr.viewTint">Teinte</button>
    <button class="seg" type="button" data-view="3" data-i18n="gr.viewEdges">Contours</button>
  </div>

  <span class="gr-note" data-el="note"></span>
  <button class="wide" type="button" data-el="close" data-i18n="gr.close">Fermer</button>
  <div class="gr-progress"><i data-el="fill"></i></div>

  <div class="gr-menu" data-el="menu" hidden>
    <p class="gr-sub" data-i18n="gr.weights">Ce qui sépare deux parts</p>
    <label class="gr-field">
      <span><span data-i18n="gr.wColour">Couleur</span> <span class="gr-num" data-el="wColourValue">—</span></span>
      <input type="range" data-el="wColour" min="0" max="3" step="0.1" value="1.4" />
    </label>
    <label class="gr-field">
      <span><span data-i18n="gr.wConcave">Creux</span> <span class="gr-num" data-el="wConcaveValue">—</span></span>
      <input type="range" data-el="wConcave" min="0" max="3" step="0.1" value="1" />
    </label>
    <label class="gr-field">
      <span><span data-i18n="gr.wConvex">Arêtes</span> <span class="gr-num" data-el="wConvexValue">—</span></span>
      <input type="range" data-el="wConvex" min="0" max="3" step="0.05" value="0.25" />
    </label>
    <label class="gr-field">
      <span><span data-i18n="gr.wNormal">Orientation</span> <span class="gr-num" data-el="wNormalValue">—</span></span>
      <input type="range" data-el="wNormal" min="0" max="3" step="0.1" value="0.5" />
    </label>

    <p class="gr-sub" data-i18n="gr.barriers">Ce qu'un groupe ne franchit jamais</p>
    <label class="gr-check"><input type="checkbox" data-el="bMaterial" checked /><span data-i18n="gr.bMaterial">Le matériau</span></label>
    <label class="gr-check"><input type="checkbox" data-el="bIslands" /><span data-i18n="gr.bIslands">Les coutures UV</span></label>
    <p class="gr-hint" data-i18n="gr.islandsHint">Sur un atlas généré, les îlots sont découpés pour le rangement et pas pour le sens.</p>

    <p class="gr-sub" data-i18n="gr.premerge">Pré-fusion</p>
    <label class="gr-field">
      <span><span data-i18n="gr.sColour">Écart de couleur</span> <span class="gr-num" data-el="sColourValue">—</span></span>
      <input type="range" data-el="sColour" min="0.005" max="0.08" step="0.005" value="0.03" />
    </label>
    <label class="gr-field">
      <span><span data-i18n="gr.sAngle">Angle</span> <span class="gr-num" data-el="sAngleValue">—</span></span>
      <input type="range" data-el="sAngle" min="1" max="25" step="1" value="6" />
    </label>
  </div>
</div>
`;

  const PANEL = `
<section>
  <h2 data-i18n="gr.paneTitle">Groupes</h2>
  <p class="hint" data-i18n="gr.paneEmpty" data-el="paneEmpty">Rien n'a encore été segmenté.</p>
  <dl class="gr-stats" data-el="stats" hidden>
    <div><dt data-i18n="gr.statGroups">Groupes</dt><dd data-el="sGroups">—</dd></div>
    <div><dt data-i18n="gr.statRange">Étendue</dt><dd data-el="sRange">—</dd></div>
    <div><dt data-i18n="gr.statTriangles">Triangles</dt><dd data-el="sTriangles">—</dd></div>
    <div><dt data-i18n="gr.statSuperfaces">Superfaces</dt><dd data-el="sSuper">—</dd></div>
    <div><dt data-i18n="gr.statShells">Coquilles</dt><dd data-el="sShells">—</dd></div>
    <div><dt data-i18n="gr.statTime">Durée</dt><dd data-el="sTime">—</dd></div>
  </dl>
  <p class="gr-warn" data-el="warnColour" hidden data-i18n="gr.warnColour">Aucun matériau ne porte de texture de couleur : la couleur ne peut rien dire de plus que le matériau.</p>
  <p class="gr-warn" data-el="warnManifold" hidden></p>
</section>
`;

  const host = document.createElement("div");
  host.id = "groups";
  host.innerHTML = SHELL;
  document.getElementById("app").appendChild(host);

  const pane = document.getElementById("pane-groups");
  if (pane) pane.innerHTML = PANEL;
  const tab = document.querySelector('.tab[data-pane="groups"]');

  // Two roots, one name space, the same idiom the other modes use.
  const el = {};
  for (const root of [host, pane].filter(Boolean)) {
    for (const node of root.querySelectorAll("[data-el]")) el[node.dataset.el] = node;
  }
  const wireU = wire.uniforms;

  let open = false;
  let running = false;
  let stop = null;
  /** Everything the last run produced. Null until there has been one. */
  let data = null;
  let view = 1;

  const translate = () => {
    for (const root of [host, pane].filter(Boolean)) applyStaticIn(root);
  };
  translate();

  // --- the settings, read straight off the inputs -------------------------
  //
  // The markup is the state, as it is in Retopo. Every read below goes through
  // these nodes, so there is no second copy to keep in step with them.

  const number = (name, fallback) => {
    const v = parseFloat(el[name]?.value);
    return Number.isFinite(v) ? v : fallback;
  };

  function request() {
    return {
      weights: {
        colour: number("wColour", 1.4),
        concavity: number("wConcave", 1),
        convexity: number("wConvex", 0.25),
        normal: number("wNormal", 0.5),
        sdf: 0.6,
      },
      barriers: {
        material: !!el.bMaterial?.checked,
        shell: true,
        uvIsland: !!el.bIslands?.checked,
      },
      superfaceColour: number("sColour", 0.03),
      superfaceAngleDeg: number("sAngle", 6),
      maxSuperfaceFaces: 2048,
      minAreaRatio: 0.0015,
      sdf: false,
      sdfRays: 24,
      sdfConeDeg: 60,
    };
  }

  /** Every value readout beside a slider, redrawn from the slider. */
  function paintValues() {
    const set = (name, text) => {
      if (el[`${name}Value`]) el[`${name}Value`].textContent = text;
    };
    set("wColour", number("wColour", 1.4).toFixed(1));
    set("wConcave", number("wConcave", 1).toFixed(1));
    set("wConvex", number("wConvex", 0.25).toFixed(2));
    set("wNormal", number("wNormal", 0.5).toFixed(1));
    set("sColour", number("sColour", 0.03).toFixed(3));
    set("sAngle", `${number("sAngle", 6)}°`);
  }
  for (const node of host.querySelectorAll('.gr-menu input[type="range"]')) {
    node.addEventListener("input", paintValues);
  }
  paintValues();

  el.menuToggle?.addEventListener("click", () => {
    const on = el.menu.hidden;
    el.menu.hidden = !on;
    setPressed(el.menuToggle, on);
  });

  // --- which meshes a run covers ------------------------------------------

  /**
   * The meshes a run reads, in the order the exporter will write them.
   *
   * Collected once and used twice: to decide what goes into the GLB, and to
   * decide which triangle each returned id belongs to. Those two have to be the
   * same list in the same order or every id after the first hidden mesh lands
   * on the wrong triangle — a segmentation that looks entirely plausible and is
   * shifted. `traverse` walks children in order, which is the order
   * `GLTFExporter` writes in, and `onlyVisible` is why the filter is here.
   */
  function sourceMeshes() {
    const list = [];
    viewer.root?.traverse?.((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      if (!o.geometry?.attributes?.position) return;
      let node = o;
      while (node) {
        if (!node.visible) return;
        node = node.parent;
      }
      list.push(o);
    });
    return list;
  }

  const triangleCount = (meshes) =>
    meshes.reduce((n, m) => {
      const g = m.geometry;
      return n + (g.index ? g.index.count : g.attributes.position.count) / 3;
    }, 0);

  // --- the cut, which is the whole interaction ----------------------------

  /**
   * The partition into `k` groups, by replaying the first `n - k` merges.
   *
   * A union-find over a `Uint32Array` with path halving. Twenty thousand unions
   * is tens of microseconds, so this runs on every pointer move of the slider
   * with room to spare.
   *
   * Which element ends up as the representative does not matter and is not the
   * same one the engine picked: a partition is a partition, and the labels are
   * renumbered densely afterwards anyway.
   */
  function cutTo(k) {
    const n = data.superCount;
    const pairs = data.merges.length / 2;
    const take = Math.max(0, Math.min(pairs, n - k));

    const parent = new Uint32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    for (let i = 0; i < take; i++) {
      const a = find(data.merges[i * 2]);
      const b = find(data.merges[i * 2 + 1]);
      if (a !== b) parent[b] = a;
    }

    const dense = new Int32Array(n).fill(-1);
    const label = new Float32Array(n);
    let next = 0;
    for (let s = 0; s < n; s++) {
      const r = find(s);
      if (dense[r] < 0) dense[r] = next++;
      label[s] = dense[r];
    }
    return { label, count: next };
  }

  function applyCut(k) {
    if (!data) return;
    const { label, count } = cutTo(k);
    wire.setGroupLut(label);
    data.groups = count;
    if (el.countValue) el.countValue.textContent = num(count);
    if (el.sGroups) el.sGroups.textContent = num(count);
    viewer.invalidate?.();
  }

  el.count?.addEventListener("input", () => {
    // The slider counts groups, so it reads left to right as "fewer, more". The
    // merge order runs the other way, which is the cut's problem and not the
    // reader's.
    applyCut(parseInt(el.count.value, 10));
  });

  function setView(next) {
    view = next;
    wireU.uGroupView.value = next;
    for (const b of el.views?.children || []) {
      b.classList.toggle("active", Number(b.dataset.view) === next);
    }
    viewer.invalidate?.();
  }
  el.views?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (b) setView(Number(b.dataset.view));
  });

  // --- running -------------------------------------------------------------

  function say(text, fraction) {
    if (el.note) el.note.textContent = text || "";
    if (el.fill) el.fill.style.width = `${Math.max(0, Math.min(1, fraction ?? 0)) * 100}%`;
  }

  /** Read one sidecar as a typed array, straight out of the response bytes. */
  async function blob(base, kind, Kind) {
    const raw = await tauri.core.invoke("segment_blob", { base, kind });
    // A byte response arrives as an ArrayBuffer; other shapes are normalised for
    // the price of one copy on a path that should not be taken.
    const bytes =
      raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : ArrayBuffer.isView(raw)
          ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
          : Uint8Array.from(raw);
    /*
     * A four byte view has to start on a four byte boundary.
     *
     * Nothing promises the bytes arrive at offset zero of their buffer, and a
     * `Uint32Array` built on an offset that is not a multiple of four throws
     * rather than misreading — which is the good failure, but only if somebody
     * has thought about it. Copying when it happens costs one allocation on a
     * path that is usually not taken, and the alternative is a run that dies
     * after all the work is done.
     */
    const aligned =
      bytes.byteOffset % 4 === 0 ? bytes : new Uint8Array(bytes);
    return new Kind(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
  }

  async function run() {
    if (!tauri) {
      toast?.(t("gr.needsApp"), 4000);
      return;
    }
    const meshes = sourceMeshes();
    if (!meshes.length) {
      toast?.(t("gr.nothing"), 3000);
      return;
    }

    running = true;
    onBusy?.(true);
    el.run.textContent = t("gr.cancel");
    say(t("gr.exporting"), 0);

    try {
      const dirs = await tauri.core.invoke("segment_workdir");

      const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
      const { withoutWireAttributes } = await import("../viewer/wire.js");
      const glb = await withoutWireAttributes(viewer.root, () =>
        new GLTFExporter().parseAsync(viewer.root, {
          binary: true,
          includeCustomExtensions: true,
          // The default, said out loud because `sourceMeshes` above depends on
          // it and the two must not drift apart.
          onlyVisible: true,
        })
      );
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(dirs.input, new Uint8Array(glb));

      stop = await tauri.event.listen("segment://progress", (e) => {
        say(t("gr.working"), e.payload || 0);
      });

      const report = await tauri.core.invoke("segment_run", {
        input: dirs.input,
        base: dirs.base,
        request: request(),
      });

      /*
       * The one check that catches every way the two halves can disagree.
       *
       * The ids come back as one flat array and are laid onto the meshes in the
       * order they were exported. Anything that changes the triangle count
       * between here and there — a hidden mesh, a multi-material mesh the
       * exporter split differently, a loader that dropped a degenerate — shifts
       * every id after it and produces a segmentation that is wrong everywhere
       * and looks fine. Counting is cheap; being wrong quietly is not.
       */
      const mine = Math.round(triangleCount(meshes));
      if (report.triangles !== mine) {
        throw new Error(
          t("gr.mismatch").replace("{a}", num(mine)).replace("{b}", num(report.triangles))
        );
      }

      const [superOfFace, nbrOfFace, merges, costs] = await Promise.all([
        blob(dirs.base, "super", Uint32Array),
        blob(dirs.base, "nbr", Uint32Array),
        blob(dirs.base, "merges", Uint32Array),
        blob(dirs.base, "costs", Float32Array),
      ]);

      data = {
        report,
        superCount: report.superfaces,
        merges,
        costs,
        groups: 0,
      };

      const { ensureGroupAttributes } = await import("../viewer/wire.js");
      // `prepareWire` first, because it is what un-indexes the geometry, and the
      // group attributes are one value per *corner* of a non-indexed triangle.
      wire.prepare(viewer.root);
      ensureGroupAttributes(meshes, superOfFace, nbrOfFace);
      // Re-hand the materials, so the ones already on the meshes go through the
      // patch and learn the new uniforms.
      if (channels) channels.apply(channels.mode);

      paintReport(report);
      const k = Math.max(report.floor, Math.min(report.suggested, report.superfaces));
      el.count.min = String(Math.max(1, report.floor));
      el.count.max = String(Math.max(1, report.superfaces));
      el.count.value = String(k);
      el.countWrap.hidden = false;
      el.views.hidden = false;
      applyCut(k);
      setView(view || 1);
      say("", 0);
    } catch (e) {
      const message = String(e?.message || e).trim();
      if (message === "annulé") {
        say(t("gr.cancelled"), 0);
      } else {
        say("", 0);
        toast?.(message || t("gr.failed"), 6000);
      }
    } finally {
      stop?.();
      stop = null;
      running = false;
      onBusy?.(false);
      el.run.textContent = t("gr.run");
    }
  }

  function paintReport(r) {
    if (el.paneEmpty) el.paneEmpty.hidden = true;
    if (el.stats) el.stats.hidden = false;
    const set = (name, text) => {
      if (el[name]) el[name].textContent = text;
    };
    set("sRange", `${num(r.floor)} – ${num(r.superfaces)}`);
    set("sTriangles", num(r.triangles));
    set("sSuper", num(r.superfaces));
    set("sShells", num(r.shells));
    set("sTime", `${(r.ms / 1000).toFixed(2)} s`);
    if (el.warnColour) el.warnColour.hidden = !!r.colourTextured;
    if (el.warnManifold) {
      el.warnManifold.hidden = !r.nonManifoldEdges;
      el.warnManifold.textContent = t("gr.warnManifold").replace(
        "{n}",
        num(r.nonManifoldEdges)
      );
    }
  }

  el.run?.addEventListener("click", () => {
    if (running) tauri?.core.invoke("segment_cancel").catch(() => {});
    else run();
  });
  el.close?.addEventListener("click", () => api.hide());

  window.addEventListener("i18n", () => {
    translate();
    el.run.textContent = running ? t("gr.cancel") : t("gr.run");
    paintValues();
    if (data) paintReport(data.report);
  });

  const api = {
    get open() {
      return open;
    },
    show() {
      open = true;
      host.classList.add("open");
      document.body.classList.add("groups-open");
      if (tab) tab.hidden = false;
      onOpenChange?.(true);
      // The overlay is a property of the model and not of the panel, so it goes
      // back up exactly as it was left rather than starting from off.
      if (data) setView(view);
    },
    hide() {
      open = false;
      host.classList.remove("open");
      document.body.classList.remove("groups-open");
      if (tab) tab.hidden = true;
      /*
       * The colours come off with the bar.
       *
       * They are a uniform on materials that stay on the meshes, so closing the
       * mode without this leaves a model painted in flat hues and no control
       * anywhere on screen that explains why. `view` is deliberately kept: it is
       * what reopening restores.
       */
      wireU.uGroupView.value = 0;
      viewer.invalidate?.();
      onOpenChange?.(false);
    },
    toggle() {
      open ? api.hide() : api.show();
    },
    /**
     * The result belongs to a document, not to the mode.
     *
     * It is a partition of one particular model's triangles, so carrying it
     * across a tab switch would paint one model with another's answer.
     */
    saveState() {
      return { data, view };
    },
    loadState(state) {
      data = state?.data ?? null;
      view = state?.view ?? 1;
      if (data) {
        paintReport(data.report);
        el.count.min = String(Math.max(1, data.report.floor));
        el.count.max = String(Math.max(1, data.report.superfaces));
        el.countWrap.hidden = false;
        el.views.hidden = false;
        applyCut(parseInt(el.count.value, 10));
      } else {
        if (el.stats) el.stats.hidden = true;
        if (el.paneEmpty) el.paneEmpty.hidden = false;
        el.countWrap.hidden = true;
        el.views.hidden = true;
        wireU.uGroupLutSize.value.set(0, 0);
      }
      if (open) setView(data ? view : 0);
    },
    /** The model changed underneath: whatever was segmented is not this. */
    forget() {
      data = null;
      wireU.uGroupView.value = 0;
      wireU.uGroupLutSize.value.set(0, 0);
      import("../viewer/wire.js").then((m) => m.clearGroupAttributes(viewer.root));
      if (el.stats) el.stats.hidden = true;
      if (el.paneEmpty) el.paneEmpty.hidden = false;
      el.countWrap.hidden = true;
      el.views.hidden = true;
    },
  };
  return api;
}
