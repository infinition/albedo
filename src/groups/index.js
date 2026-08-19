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
 * Answers one question, which parts is this model made of, for the input that
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
 * ## Two questions, not one
 *
 * The hierarchy only ever produces *connected* parts, because two rocks lying
 * apart on the same ground share no edge and no merging will ever join them.
 * That is why the first slider has a floor it cannot go below, and why there is
 * a second one: which parts *look* alike is a different question, asked of
 * their mean colours rather than of what they touch, and answered above the
 * engine rather than inside it.
 *
 * ## What it does not do yet
 *
 * Editing a group by hand, clicking one to select it, merging two, painting a
 * boundary. All of it is built on what is here, a stable per-triangle id and a
 * partition that can be read back, and none of it changes the shape of this.
 */
export function createGroups({
  wire,
  tauri,
  viewer,
  onBusy,
  toast,
  channels,
  showPane,
  markDirty,
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
    <input type="range" data-el="count" min="0" max="1000" step="1" value="0" />
    <span class="gr-num" data-el="countValue">, </span>
  </label>

  <!--
    The second question, and it really is a second one.
    ------------------------------------------------------------------
    The slider above cuts the hierarchy, and the hierarchy only ever produces
    *connected* parts: two rocks lying apart on the same ground share no edge,
    so no amount of merging will ever put them together. That is topology, not
    a setting, which is why the first slider has a floor it cannot go below.

    Grouping things that look alike is the other question, the one somebody
    asks when they want one rock material rather than two hundred rock objects
, and it is asked here, in the same colour units as the pre-merge tolerance
    so the two numbers mean the same thing.
  -->
  <label class="gr-slider" data-el="famWrap" hidden>
    <span data-i18n="gr.families">Familles</span>
    <input type="range" data-el="fam" min="0" max="0.30" step="0.005" value="0" />
    <span class="gr-num" data-el="famValue">, </span>
  </label>

  <div class="segment gr-views" role="group" data-i18n-aria="gr.view" aria-label="Affichage" data-el="views" hidden>
    <button class="seg" type="button" data-view="0" data-i18n="gr.viewOff">Aucun</button>
    <button class="seg active" type="button" data-view="1" data-i18n="gr.viewFlat">Aplats</button>
    <button class="seg" type="button" data-view="2" data-i18n="gr.viewTint">Teinte</button>
    <button class="seg" type="button" data-view="3" data-i18n="gr.viewEdges">Contours</button>
  </div>

  <span class="gr-note" data-el="pickNote" hidden></span>
  <button class="tb-i" type="button" data-el="invert" data-i18n-title="gr.invert" title="Inverser la sélection" hidden>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h8l-2-2M13 10H5l2 2"/></svg>
  </button>
  <button class="tb-i" type="button" data-el="clearPick" data-i18n-title="gr.clearPick" title="Tout désélectionner" hidden>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
  </button>
  <button class="wide" type="button" data-el="map" data-i18n="gr.map" hidden>Carte</button>
  <button class="wide" type="button" data-el="split" data-i18n="gr.split" hidden>Découper</button>
  <button class="wide" type="button" data-el="unsplit" data-i18n="gr.unsplit" hidden>Annuler la découpe</button>
  <span class="gr-note" data-el="note"></span>
  <button class="wide" type="button" data-el="close" data-i18n="gr.close">Fermer</button>
  <div class="gr-progress"><i data-el="fill"></i></div>

  <div class="gr-menu" data-el="menu" hidden>
    <p class="gr-sub" data-i18n="gr.weights">Ce qui sépare deux parts</p>
    <label class="gr-field">
      <span><span data-i18n="gr.wColour">Couleur</span> <span class="gr-num" data-el="wColourValue">, </span></span>
      <input type="range" data-el="wColour" min="0" max="3" step="0.1" value="1.4" />
    </label>
    <label class="gr-field">
      <span><span data-i18n="gr.wConcave">Creux</span> <span class="gr-num" data-el="wConcaveValue">, </span></span>
      <input type="range" data-el="wConcave" min="0" max="3" step="0.1" value="1" />
    </label>
    <label class="gr-field">
      <span><span data-i18n="gr.wConvex">Arêtes</span> <span class="gr-num" data-el="wConvexValue">, </span></span>
      <input type="range" data-el="wConvex" min="0" max="3" step="0.05" value="0.25" />
    </label>
    <label class="gr-field">
      <span><span data-i18n="gr.wNormal">Orientation</span> <span class="gr-num" data-el="wNormalValue">, </span></span>
      <input type="range" data-el="wNormal" min="0" max="3" step="0.1" value="0.5" />
    </label>

    <p class="gr-sub" data-i18n="gr.barriers">Ce qu'un groupe ne franchit jamais</p>
    <label class="gr-check"><input type="checkbox" data-el="bMaterial" checked /><span data-i18n="gr.bMaterial">Le matériau</span></label>
    <label class="gr-check"><input type="checkbox" data-el="bIslands" /><span data-i18n="gr.bIslands">Les coutures UV</span></label>
    <p class="gr-hint" data-i18n="gr.islandsHint">Sur un atlas généré, les îlots sont découpés pour le rangement et pas pour le sens.</p>

    <p class="gr-sub" data-i18n="gr.nnTitle">Étiquettes importées</p>
    <button class="mini" type="button" data-el="pickLabels" data-i18n="gr.nnPick">Choisir un fichier…</button>
    <p class="gr-note gr-nn" data-el="labelNote" hidden></p>
    <p class="gr-hint" data-i18n="gr.nnHint">Une étiquette par triangle, produite par PartField, P3-SAM ou SAMesh. Elle devient une barrière : le découpage ne réunira jamais deux parts qu'elle sépare, et tout le reste continue de s'appliquer par-dessus.</p>

    <p class="gr-sub" data-i18n="gr.mapTitle">Carte d'identité</p>
    <label class="gr-field">
      <span><span data-i18n="gr.mapSize">Taille</span> <span class="gr-num" data-el="mapSizeValue">, </span></span>
      <input type="range" data-el="mapSize" min="9" max="13" step="1" value="11" />
    </label>
    <label class="gr-field">
      <span><span data-i18n="gr.mapBleed">Bavure</span> <span class="gr-num" data-el="mapBleedValue">, </span></span>
      <input type="range" data-el="mapBleed" min="0" max="32" step="1" value="8" />
    </label>
    <label class="gr-field">
      <span><span data-i18n="gr.mapSmooth">Adoucir</span> <span class="gr-num" data-el="mapSmoothValue">, </span></span>
      <input type="range" data-el="mapSmooth" min="0" max="8" step="1" value="0" />
    </label>
    <p class="gr-hint" data-i18n="gr.mapHint">Bords durs pour sélectionner une part par sa couleur, adoucis pour s'en servir comme masque de fondu.</p>

    <p class="gr-sub" data-i18n="gr.premerge">Pré-fusion</p>
    <label class="gr-field">
      <span><span data-i18n="gr.sColour">Écart de couleur</span> <span class="gr-num" data-el="sColourValue">, </span></span>
      <input type="range" data-el="sColour" min="0.005" max="0.08" step="0.005" value="0.03" />
    </label>
    <label class="gr-field">
      <span><span data-i18n="gr.sAngle">Angle</span> <span class="gr-num" data-el="sAngleValue">, </span></span>
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
    <div><dt data-i18n="gr.statGroups">Groupes</dt><dd data-el="sGroups">, </dd></div>
    <div><dt data-i18n="gr.statFamilies">Familles</dt><dd data-el="sFamilies">, </dd></div>
    <div><dt data-i18n="gr.statRange">Étendue</dt><dd data-el="sRange">, </dd></div>
    <div><dt data-i18n="gr.statTriangles">Triangles</dt><dd data-el="sTriangles">, </dd></div>
    <div><dt data-i18n="gr.statSuperfaces">Superfaces</dt><dd data-el="sSuper">, </dd></div>
    <div><dt data-i18n="gr.statShells">Coquilles</dt><dd data-el="sShells">, </dd></div>
    <div><dt data-i18n="gr.statLabels">Étiquettes</dt><dd data-el="sLabels">, </dd></div>
    <div><dt data-i18n="gr.statTime">Durée</dt><dd data-el="sTime">, </dd></div>
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
    set("mapSize", `${1 << number("mapSize", 11)}`);
    set("mapBleed", `${number("mapBleed", 8)}`);
    const smooth = number("mapSmooth", 0);
    set("mapSmooth", smooth ? String(smooth) : t("gr.hard"));
  }
  for (const node of host.querySelectorAll('.gr-menu input[type="range"]')) {
    node.addEventListener("input", paintValues);
  }
  paintValues();
  paintLabels();

  /*
   * A setting changes, the result follows.
   *
   * On `change` rather than `input`, so a slider re-runs once when it is let go
   * instead of on every pixel of the drag: the engine is fast but it is not
   * free, and a hundred runs on the way to a value nobody wanted is a hundred
   * runs. The checkboxes fire `change` on the click, which is the same moment.
   *
   * A run already going is left alone and the request is remembered, because
   * two engines writing the same sidecars is a race with no winner.
   */
  let pending = 0;
  let missed = false;

  function retune() {
    if (!data || !cached || !tauri) return;
    if (running) {
      missed = true;
      return;
    }
    clearTimeout(pending);
    pending = setTimeout(() => run({ reuse: true }), 180);
  }

  /*
   * Only the settings the *engine* reads re-run it.
   *
   * The map's size, bleed and softening live in the same menu and change
   * nothing about the segmentation, they describe a picture drawn from a result
   * that already exists. Wiring them to a re-run would spend seconds of engine
   * time producing an identical answer, which is the sort of waste that only
   * shows up on a large model and looks like the tool being slow.
   */
  const MAP_ONLY = new Set(["mapSize", "mapBleed", "mapSmooth"]);
  for (const node of host.querySelectorAll(".gr-menu input")) {
    if (MAP_ONLY.has(node.dataset.el)) continue;
    node.addEventListener("change", retune);
  }

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
   * on the wrong triangle, a segmentation that looks entirely plausible and is
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

  /**
   * How many parts may be compared by appearance before the control gives up.
   *
   * The pairing is quadratic, so this is where "instant" stops. It is not a
   * limitation worth engineering around: past a couple of thousand parts the
   * question "which of these look alike" has stopped being one anybody can act
   * on, and the answer is to ask for fewer parts first.
   */
  const MOST_COMPARABLE = 2500;

  /*
   * The group slider steps through a *ladder* of counts rather than over a
   * range, and every rung is a number of groups somebody might actually want.
   *
   * It was a plain linear range first, which is unusable on anything real: a
   * mesh with a hundred thousand superfaces spread over two hundred pixels puts
   * five hundred groups under every pixel, so two groups, five and ten, the
   * answers people are looking for, all sit inside the first pixel and cannot
   * be reached at all.
   *
   * A logarithmic range fixes the ceiling and not the floor: it spends an even
   * share of the travel on each decade, so getting from one group to two still
   * takes a dozen presses of an arrow key. A ladder that grows by six percent
   * but never by less than one gives 1, 2, 3, … one rung at a time where the
   * counts are small, and 40, 000 → 42, 400 where they are not. Around two hundred
   * rungs cover any mesh, and every one of them is a different answer.
   */
  let rungs = [1];

  function buildLadder() {
    const lo = Math.max(1, data?.report?.floor ?? 1);
    const hi = Math.max(lo, data?.report?.superfaces ?? lo);
    const out = [];
    let v = lo;
    while (v < hi) {
      out.push(v);
      v = Math.max(v + 1, Math.round(v * 1.06));
    }
    out.push(hi);
    rungs = out;
    el.count.max = String(rungs.length - 1);
  }

  const groupsAt = (position) =>
    rungs[Math.min(rungs.length - 1, Math.max(0, position | 0))] ?? 1;

  /** The rung nearest a group count. The inverse, as far as one exists. */
  function positionOf(k) {
    let best = 0;
    for (let i = 1; i < rungs.length; i++) {
      if (Math.abs(rungs[i] - k) < Math.abs(rungs[best] - k)) best = i;
    }
    return best;
  }

  /**
   * Merge parts that look alike, whether or not they touch.
   *
   * Cheapest pair first, and each merge is re-checked against the two clusters'
   * *current* mean colours rather than against the original pair. Without that
   * re-check this is single linkage, which chains: a smooth run of two hundred
   * slightly different greys has no single pair above the tolerance anywhere
   * along it, so the whole run collapses into one family and the tolerance
   * stops meaning anything.
   */
  function familiesOf(label, parts, tol) {
    const { feat, superCount } = data;
    const col = new Float64Array(parts * 3);
    const area = new Float64Array(parts);
    for (let s = 0; s < superCount; s++) {
      const p = label[s];
      const a = feat[s * 4 + 3];
      area[p] += a;
      col[p * 3] += feat[s * 4] * a;
      col[p * 3 + 1] += feat[s * 4 + 1] * a;
      col[p * 3 + 2] += feat[s * 4 + 2] * a;
    }
    // Sums become means, and the area is kept: merging two families has to
    // weight them by how much surface each one actually is.
    for (let p = 0; p < parts; p++) {
      const inv = area[p] > 0 ? 1 / area[p] : 0;
      col[p * 3] *= inv;
      col[p * 3 + 1] *= inv;
      col[p * 3 + 2] *= inv;
    }

    const pairs = [];
    for (let i = 0; i < parts; i++) {
      for (let j = i + 1; j < parts; j++) {
        const dx = col[i * 3] - col[j * 3];
        const dy = col[i * 3 + 1] - col[j * 3 + 1];
        const dz = col[i * 3 + 2] - col[j * 3 + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d <= tol) pairs.push([d, i, j]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);

    const parent = new Uint32Array(parts);
    for (let i = 0; i < parts; i++) parent[i] = i;
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    for (const [, i, j] of pairs) {
      const a = find(i);
      const b = find(j);
      if (a === b) continue;
      const dx = col[a * 3] - col[b * 3];
      const dy = col[a * 3 + 1] - col[b * 3 + 1];
      const dz = col[a * 3 + 2] - col[b * 3 + 2];
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) > tol) continue;
      const wa = area[a];
      const wb = area[b];
      const total = wa + wb || 1;
      for (let c = 0; c < 3; c++) {
        col[a * 3 + c] = (col[a * 3 + c] * wa + col[b * 3 + c] * wb) / total;
      }
      area[a] = total;
      parent[b] = a;
    }

    const dense = new Int32Array(parts).fill(-1);
    const of = new Uint32Array(parts);
    let next = 0;
    for (let p = 0; p < parts; p++) {
      const r = find(p);
      if (dense[r] < 0) dense[r] = next++;
      of[p] = dense[r];
    }
    return { of, count: next };
  }

  function applyCut(k) {
    if (!data) return;
    const { label, count } = cutTo(k);

    const tol = number("fam", 0);
    const comparable = count <= MOST_COMPARABLE;
    let shown = label;
    let families = count;
    if (tol > 0 && comparable) {
      const fam = familiesOf(label, count, tol);
      families = fam.count;
      // The lookup table is fed whichever partition is being *shown*, so the
      // outlines follow it too and no third mechanism is needed for them.
      shown = new Float32Array(label.length);
      for (let s = 0; s < label.length; s++) shown[s] = fam.of[label[s]];
    }
    /*
     * The pick travels in the lookup table beside the group id.
     *
     * Picked groups are named, not superfaces, so a cut that renumbers
     * everything would throw the selection away. It is dropped deliberately
     * instead, below, whenever the partition changes under it, keeping ids
     * that mean something else now is worse than losing them.
     */
    let marks = null;
    if (picked.size) {
      marks = new Uint8Array(shown.length);
      for (let s = 0; s < shown.length; s++) marks[s] = picked.has(shown[s]) ? 1 : 0;
    }
    wire.setGroupLut(shown, marks);
    // Kept, because the split cuts along whatever is *being shown* rather than
    // along some other partition the person never saw.
    data.shown = shown;
    data.showingFamilies = tol > 0 && comparable;

    data.groups = count;
    data.families = families;
    if (el.countValue) el.countValue.textContent = num(count);
    if (el.sGroups) el.sGroups.textContent = num(count);
    if (el.sFamilies) {
      el.sFamilies.textContent = tol > 0 && comparable ? num(families) : ", ";
    }
    if (el.famValue) {
      el.famValue.textContent = !comparable
        ? t("gr.tooMany")
        : tol > 0
          ? num(families)
          : t("gr.famOff");
    }
    if (el.fam) el.fam.disabled = !comparable;
    viewer.invalidate?.();
  }

  /*
   * Which groups have been picked, by group id at the level being shown.
   *
   * By id and not by superface, which means a cut that renumbers everything
   * invalidates it. Dropped on purpose when that happens rather than carried:
   * ids that mean something else now are worse than no ids at all, and silently
   * keeping five of them pointing at whatever landed on those numbers is the
   * kind of wrong nobody would ever suspect.
   */
  const picked = new Set();

  function paintPick() {
    const any = picked.size > 0;
    el.pickNote.hidden = !any;
    el.pickNote.textContent = any
      ? t("gr.picked").replace("{n}", num(picked.size))
      : "";
    el.invert.hidden = !any;
    el.clearPick.hidden = !any;
    el.split.textContent = any ? t("gr.splitPicked") : t("gr.split");
  }

  const recut = () => applyCut(groupsAt(parseInt(el.count.value, 10)));

  /** Forget the selection, because the numbers it holds no longer mean anything. */
  function dropPick() {
    if (!picked.size) return;
    picked.clear();
    paintPick();
  }

  /**
   * A click in the viewport landed on a triangle. Work out which group.
   *
   * `faceIndex` has been on every hit this application produces since the
   * beginning and was read by nothing. The group is taken from the geometry
   * itself rather than from a parallel array kept in step with it, so it stays
   * right through any reordering.
   */
  function pickFace(hit, additive) {
    if (!data || !open || wireU.uGroupView.value < 0.5) return false;
    const attribute = hit?.object?.geometry?.attributes?.aGroup;
    if (!attribute || hit.faceIndex === undefined) return false;
    const superface = attribute.getX(hit.faceIndex * 3);
    if (!(superface >= 0)) return false;
    const group = data.shown?.[superface];
    if (group === undefined) return false;

    if (!additive) {
      const alone = picked.size === 1 && picked.has(group);
      picked.clear();
      if (!alone) picked.add(group);
    } else if (picked.has(group)) {
      picked.delete(group);
    } else {
      picked.add(group);
    }
    paintPick();
    recut();
    return true;
  }

  el.invert?.addEventListener("click", () => {
    const total = data?.groups ?? 0;
    const flipped = new Set();
    for (let g = 0; g < total; g++) if (!picked.has(g)) flipped.add(g);
    picked.clear();
    for (const g of flipped) picked.add(g);
    paintPick();
    recut();
  });
  el.clearPick?.addEventListener("click", () => {
    dropPick();
    recut();
  });
  // The slider counts groups, so it reads left to right as "fewer, more". The
  // merge order runs the other way, which is the cut's problem and not the
  // reader's.
  // Both of these renumber every group, so the selection stops meaning anything.
  el.count?.addEventListener("input", () => {
    dropPick();
    recut();
  });
  el.fam?.addEventListener("input", () => {
    dropPick();
    recut();
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
     * rather than misreading, which is the good failure, but only if somebody
     * has thought about it. Copying when it happens costs one allocation on a
     * path that is usually not taken, and the alternative is a run that dies
     * after all the work is done.
     */
    const aligned =
      bytes.byteOffset % 4 === 0 ? bytes : new Uint8Array(bytes);
    return new Kind(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
  }

  /**
   * Take a segmentation, wherever it came from, and put it on screen.
   *
   * Separate from `run` because a run is only one of the ways one arrives. A
   * per-face label array produced by PartField or P3-SAM outside this
   * application is the same thing in a different envelope, and it should get the
   * same display, the same sliders and the same split rather than a parallel
   * path that drifts from this one.
   *
   * `meshes` is the list the ids are indexed against, and it has to be the same
   * list, in the same order, that produced them.
   */
  async function adopt(payload, meshes) {
    const { report, superOfFace, nbrOfFace, merges, costs, feat } = payload;
    // A new segmentation describes the meshes as they are now, so an undo
    // pointing at meshes that were replaced before it is no longer an undo.
    cut = null;
    el.unsplit.hidden = true;
    dropPick();
    data = {
      report,
      superCount: report.superfaces,
      merges,
      costs,
      // Four per superface: mean colour in OkLab, then area.
      feat,
      groups: 0,
      families: 0,
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
    buildLadder();
    const k = Math.max(report.floor, Math.min(report.suggested, report.superfaces));
    el.count.value = String(positionOf(k));
    el.countWrap.hidden = false;
    el.famWrap.hidden = false;
    el.views.hidden = false;
    el.split.hidden = false;
    el.map.hidden = false;
    applyCut(k);
    setView(view || 1);
  }

  /*
   * The exported model, kept between runs.
   *
   * Every setting in the menu changes how the engine *reads* the mesh and none
   * of them change the mesh, so the file it reads is the same file. Exporting is
   * also by far the expensive half, tens of megabytes through three's exporter
   * and out to disk, while the engine itself is hundredths of a second on a
   * small model and a few on a large one.
   *
   * Keeping it is what turns the weights from something you commit to before a
   * run into something you turn while looking at the result. Dropped the moment
   * the scene stops matching it: a split, a new model, a mode that forgot.
   */
  let cached = null;
  /** A per-face label file somebody else produced, or null. See the CLI's --labels. */
  let labels = null;

  function paintLabels() {
    if (!el.labelNote) return;
    el.labelNote.hidden = !labels;
    el.labelNote.textContent = labels ? labels.split(/[\/]/).pop() : "";
    el.pickLabels.textContent = labels ? t("gr.nnDrop") : t("gr.nnPick");
  }

  el.pickLabels?.addEventListener("click", async () => {
    if (labels) {
      labels = null;
      paintLabels();
      retune();
      return;
    }
    if (!tauri) {
      toast?.(t("gr.needsApp"), 4000);
      return;
    }
    const chosen = await tauri.dialog.open({
      multiple: false,
      filters: [{ name: t("gr.nnFilter"), extensions: ["json", "bin", "npy", "raw"] }],
    });
    if (!chosen) return;
    labels = typeof chosen === "string" ? chosen : chosen?.path;
    paintLabels();
    // A run is what applies them, and the model is already exported, so this is
    // the cheap half.
    retune();
  });

  async function run({ reuse = false } = {}) {
    if (!tauri) {
      toast?.(t("gr.needsApp"), 4000);
      return;
    }
    const meshes = reuse && cached ? cached.meshes : sourceMeshes();
    if (!meshes.length) {
      toast?.(t("gr.nothing"), 3000);
      return;
    }

    running = true;
    onBusy?.(true);
    el.run.textContent = t("gr.cancel");
    say(reuse ? t("gr.working") : t("gr.exporting"), 0);

    try {
      const dirs =
        reuse && cached
          ? { input: cached.input, base: cached.base }
          : await tauri.core.invoke("segment_workdir");

      if (!reuse || !cached) {
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
        cached = { input: dirs.input, base: dirs.base, meshes };
      }

      stop = await tauri.event.listen("segment://progress", (e) => {
        say(t("gr.working"), e.payload || 0);
      });

      const report = await tauri.core.invoke("segment_run", {
        input: dirs.input,
        base: dirs.base,
        request: request(),
        labels,
      });

      /*
       * The one check that catches every way the two halves can disagree.
       *
       * The ids come back as one flat array and are laid onto the meshes in the
       * order they were exported. Anything that changes the triangle count
       * between here and there, a hidden mesh, a multi-material mesh the
       * exporter split differently, a loader that dropped a degenerate, shifts
       * every id after it and produces a segmentation that is wrong everywhere
       * and looks fine. Counting is cheap; being wrong quietly is not.
       */
      const mine = Math.round(triangleCount(meshes));
      if (report.triangles !== mine) {
        throw new Error(
          t("gr.mismatch").replace("{a}", num(mine)).replace("{b}", num(report.triangles))
        );
      }

      const [superOfFace, nbrOfFace, merges, costs, feat] = await Promise.all([
        blob(dirs.base, "super", Uint32Array),
        blob(dirs.base, "nbr", Uint32Array),
        blob(dirs.base, "merges", Uint32Array),
        blob(dirs.base, "costs", Float32Array),
        blob(dirs.base, "feat", Float32Array),
      ]);

      await adopt({ report, superOfFace, nbrOfFace, merges, costs, feat }, meshes);
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
      // A setting moved while this was in flight. Serve it now, once, rather
      // than queueing every intermediate value the slider passed through.
      if (missed) {
        missed = false;
        retune();
      }
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
    set("sLabels", r.labels ? num(r.labels) : ", ");
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

  // --- the split ----------------------------------------------------------

  /** The last split, so it can be put back. Null when there is nothing to undo. */
  let cut = null;

  async function doSplit() {
    if (!data?.shown) return;
    const meshes = sourceMeshes();
    const { splitByGroup } = await import("./split.js");

    const label = data.showingFamilies ? "gr.familyName" : "gr.groupName";

    /*
     * A selection is expressed as a relabelling, not as a second code path.
     *
     * Everything unpicked collapses onto one shared id, so the split produces a
     * mesh per picked group plus a single remainder, which is what "keep these
     * parts" means, and `splitByGroup` never learns that selection exists.
     */
    let labelOfSuper = data.shown;
    const rest = data.groups;
    if (picked.size) {
      labelOfSuper = new Float32Array(data.shown.length);
      for (let i = 0; i < data.shown.length; i++) {
        labelOfSuper[i] = picked.has(data.shown[i]) ? data.shown[i] : rest;
      }
    }

    const result = splitByGroup({
      root: viewer.root,
      meshes,
      labelOfSuper,
      name: (n) => (n === rest && picked.size ? t("gr.restName") : t(label).replace("{n}", String(n + 1))),
    });

    if (!result.created.length) {
      toast?.(t("gr.splitNothing"), 4000);
      return;
    }
    cut = result;
    // The scene no longer matches the file that was exported from it.
    cached = null;

    /*
     * The overlay goes off, and that is the point rather than tidiness.
     *
     * The parts are objects now. Painting them in group colours would be the
     * tool still answering a question that has been settled, and the new meshes
     * do not carry the attributes to do it with anyway: the split deliberately
     * leaves this application's scaffolding behind.
     */
    wireU.uGroupView.value = 0;
    el.split.hidden = true;
    el.unsplit.hidden = false;
    // The scene gained and lost objects. `absorb` is the call for that; `reset`
    // here would corrupt the channel view's record of the original materials.
    channels?.absorb?.();
    markDirty?.();
    viewer.invalidate?.();
    toast?.(t("gr.splitDone").replace("{n}", num(result.created.length)), 3500);
  }

  async function undoSplit() {
    if (!cut) return;
    const { unsplit } = await import("./split.js");
    unsplit(cut);
    cut = null;
    el.split.hidden = !data;
    el.unsplit.hidden = true;
    channels?.absorb?.();
    markDirty?.();
    // The restored meshes still carry their group attributes, so the overlay
    // comes back exactly where it was rather than needing another run.
    if (data) setView(view || 1);
    viewer.invalidate?.();
  }

  /**
   * Draw the segmentation into the atlas and write it out.
   *
   * The one output that leaves the application. A split gives objects inside
   * Albedo; this gives a file every texturing tool already understands, and it
   * touches nothing in the scene on the way.
   */
  async function saveMap() {
    if (!data?.shown) return;
    const meshes = cached?.meshes?.length ? cached.meshes : sourceMeshes();
    onBusy?.(true);
    say(t("gr.mapping"), 0.35);
    try {
      const { paintGroupMaps } = await import("./idmap.js");
      const maps = paintGroupMaps({
        meshes,
        labelOfSuper: data.shown,
        size: 1 << number("mapSize", 11),
        bleed: number("mapBleed", 8),
        smooth: number("mapSmooth", 0),
      });
      if (!maps.length) {
        toast?.(t("gr.mapNothing"), 4500);
        return;
      }

      // One file per atlas. The name carries the material only when there is
      // more than one, so the ordinary case stays a single tidy `groupes.png`.
      const many = maps.length > 1;
      let written = 0;
      let groups = 0;
      // Groups that shared UV space with another and were overwritten by it.
      let lost = 0;
      for (const [i, map] of maps.entries()) {
        groups = Math.max(groups, map.groups);
        lost += Math.max(0, map.groups - map.resolved);
        const stem = many ? `${t("gr.mapFile")}-${map.label || i + 1}` : t("gr.mapFile");
        const name = `${stem.replace(/[\/:*?"<>|]/g, "_")}.png`;
        const url = map.canvas.toDataURL("image/png");
        if (tauri) {
          const path = await tauri.dialog.save({
            defaultPath: name,
            filters: [{ name: t("dlg.pngImage"), extensions: ["png"] }],
          });
          if (!path) continue;
          const bytes = Uint8Array.from(atob(url.slice(url.indexOf(", ") + 1)), (c) =>
            c.charCodeAt(0)
          );
          const { writeFile } = await import("@tauri-apps/plugin-fs");
          await writeFile(path, bytes);
        } else {
          const a = document.createElement("a");
          a.href = url;
          a.download = name;
          a.click();
        }
        written++;
      }
      if (!written) return;
      toast?.(
        t(many ? "gr.mapDoneMany" : "gr.mapDone")
          .replace("{n}", num(groups))
          .replace("{k}", num(written)),
        4500
      );
      /*
       * Said out loud, and after the success rather than instead of it.
       *
       * A map missing two thirds of its groups is still a usable map for the
       * ones it has; what makes it dangerous is believing it holds them all.
       */
      if (lost > 0) {
        toast?.(t("gr.mapOverlap").replace("{n}", num(lost)), 9000);
      }
    } catch (e) {
      toast?.(String(e?.message || e), 5000);
    } finally {
      say("", 0);
      onBusy?.(false);
    }
  }

  el.map?.addEventListener("click", () => saveMap());
  el.split?.addEventListener("click", () => doSplit());
  el.unsplit?.addEventListener("click", () => undoSplit());

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
    /** Display a segmentation this mode did not compute. See `adopt`. */
    adopt,
    sourceMeshes,
    /** A viewport click. Returns true when it was a group, and was handled. */
    pick: pickFace,
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
        buildLadder();
        el.countWrap.hidden = false;
        el.famWrap.hidden = false;
        el.views.hidden = false;
        el.split.hidden = false;
        el.map.hidden = false;
        recut();
      } else {
        if (el.stats) el.stats.hidden = true;
        if (el.paneEmpty) el.paneEmpty.hidden = false;
        el.countWrap.hidden = true;
        el.famWrap.hidden = true;
        el.views.hidden = true;
        el.split.hidden = true;
        el.map.hidden = true;
        wireU.uGroupLutSize.value.set(0, 0);
      }
      if (open) setView(data ? view : 0);
    },
    /** The model changed underneath: whatever was segmented is not this. */
    forget() {
      data = null;
      cached = null;
      dropPick();
      wireU.uGroupView.value = 0;
      wireU.uGroupLutSize.value.set(0, 0);
      import("../viewer/wire.js").then((m) => m.clearGroupAttributes(viewer.root));
      if (el.stats) el.stats.hidden = true;
      if (el.paneEmpty) el.paneEmpty.hidden = false;
      el.countWrap.hidden = true;
      el.famWrap.hidden = true;
      el.views.hidden = true;
      el.split.hidden = true;
      el.map.hidden = true;
      el.unsplit.hidden = true;
      cut = null;
    },
  };
  return api;
}
