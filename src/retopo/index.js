import { applyWire, makeWireUniforms, setSide, setWireColor } from "./wire.js";
import "./retopo.css";

/**
 * The Retopo mode.
 *
 * A third mode beside the inspector and the library, and not a pane inside the
 * inspector: the tool has a triangle budget, three guards, a bake with eight
 * knobs and a per material selection to come, and none of that fits a 324 pixel
 * column. It is chrome around the viewport rather than a screen in front of it,
 * because you cannot judge a retopology without looking at it.
 *
 * The panel is four tabs and not one long column. It was one long column first
 * and that was wrong twice over: you had to scroll past the bake to reach the
 * result, and an error message written at the bottom of it was invisible, so a
 * run that failed looked exactly like a button that did nothing.
 *
 * This module, its stylesheet and the exporter it reaches for are one lazy
 * chunk. Nothing here is parsed until the mode is opened for the first time,
 * which matters more than usual: this executable is also the Explorer thumbnail
 * provider, one process per file.
 */

const SHELL = `
<div class="rt-stack">
<dl class="rt-hud" data-el="hud">
  <div><dt>Source</dt><dd data-el="hudSource">—</dd></div>
  <div><dt>Résultat</dt><dd data-el="hudResult">—</dd></div>
  <div><dt>Réduction</dt><dd data-el="hudCut">—</dd></div>
  <div><dt>Quads</dt><dd data-el="hudQuads">—</dd></div>
</dl>

<div class="rt-top" data-el="top">
  <div class="rt-tgroup">
    <span class="rt-tlabel">Affichage</span>
    <div class="segment" role="group" aria-label="Affichage">
      <button class="seg active" type="button" data-ch="shaded" title="Rendu physique">Rendu</button>
      <button class="seg" type="button" data-ch="unlit" title="Texture telle qu'elle a été peinte, sans éclairage">Peint</button>
      <button class="seg" type="button" data-ch="albedo" title="Couleur de base seule">Albedo</button>
      <button class="seg" type="button" data-ch="normalGeom" title="Normales de géométrie, pour lire la facettisation">Normales</button>
      <button class="seg" type="button" data-ch="uv" title="Damier d'UV, pour juger l'atlas">UV</button>
    </div>
  </div>

  <span class="rt-tsep"></span>

  <div class="rt-tgroup">
    <span class="rt-tlabel">Arêtes</span>
    <div class="segment" role="group" aria-label="Arêtes">
      <button class="seg active" type="button" data-wire="off" title="Aucune arête">Aucune</button>
      <button class="seg" type="button" data-wire="dark" title="Traits sombres, pour un modèle clair">Sombres</button>
      <button class="seg" type="button" data-wire="light" title="Traits clairs, pour un modèle sombre">Claires</button>
    </div>
  </div>

  <span class="rt-tsep"></span>

  <div class="rt-tgroup">
    <span class="rt-tlabel">Facettes</span>
    <button class="seg" type="button" data-el="flat" aria-pressed="false"
            title="Ombrage plat : chaque triangle sa normale, pour lire la facettisation">◈</button>
  </div>

  <span class="rt-tsep"></span>

  <div class="rt-tgroup">
    <span class="rt-tlabel">Comparer</span>
    <div class="segment" role="group" aria-label="Comparer">
      <button class="seg" type="button" data-ab="source" title="La source seule">Source</button>
      <button class="seg" type="button" data-ab="result" title="Le résultat seul">Résultat</button>
      <button class="seg active" type="button" data-ab="both" title="Les deux dans la scène">Les deux</button>
      <button class="seg" type="button" data-ab="split" title="Rideau déplaçable : source à gauche, résultat à droite">Rideau</button>
      <button class="seg" type="button" data-ab="ghost" title="Résultat plein, source en transparence par-dessus">Fantôme</button>
    </div>
  </div>

  <span class="rt-tsep"></span>

  <div class="rt-tgroup">
    <span class="rt-tlabel">Caméra</span>
    <button class="seg" type="button" data-el="frame" title="Recadrer">⌖</button>
  </div>
</div>
</div>

<div class="rt-split" data-el="splitLine" hidden><i></i></div>

<div class="rt-panel" data-el="panel">
  <nav class="rt-tabs" role="tablist">
    <button class="rt-tab active" type="button" data-tab="method" role="tab">Méthode</button>
    <button class="rt-tab" type="button" data-tab="clean" role="tab">Nettoyage</button>
    <button class="rt-tab" type="button" data-tab="maps" role="tab">Cartes</button>
    <button class="rt-tab" type="button" data-tab="atlas" role="tab">Atlas</button>
    <button class="rt-tab" type="button" data-tab="result" role="tab">Bilan</button>
  </nav>

  <div class="rt-body">

  <section class="rt-page active" data-tab="method">
    <div class="segment" role="group" aria-label="Méthode">
      <button class="seg active" type="button" data-el="mDecimate" title="Dépenser le budget là où la silhouette en a besoin">Décimer</button>
      <button class="seg" type="button" data-el="mIsotropic" title="Reconstruire vers des arêtes régulières et une valence de six">Reconstruire</button>
    </div>
    <label class="rt-field">
      <span>Triangles <span class="rt-num" data-el="targetValue">—</span></span>
      <input type="range" data-el="target" min="1" max="90" step="1" value="10" />
    </label>
    <p class="rt-hint" data-el="methodHint"></p>

    <p class="rt-sub">Quads</p>
    <label class="rt-check"><input type="checkbox" data-el="quads" /><span>Apparier les triangles en quads</span></label>
    <p class="rt-hint">glTF n'a pas de quads, donc l'appairage voyage à côté du
      fichier comme un masque de diagonale, un entier par triangle.</p>
  </section>

  <section class="rt-page" data-tab="clean">
    <label class="rt-check"><input type="checkbox" data-el="holes" /><span>Combler les trous d'abord</span></label>
    <label class="rt-check"><input type="checkbox" data-el="boundary" checked /><span>Épingler les bords ouverts</span></label>
    <label class="rt-field">
      <span>Angle de pli <span class="rt-num" data-el="angleValue">40°</span></span>
      <input type="range" data-el="angle" min="5" max="90" step="1" value="40" />
    </label>
    <label class="rt-field">
      <span>Coût d'une couture <span class="rt-num" data-el="seamValue">4</span></span>
      <input type="range" data-el="seam" min="0" max="20" step="1" value="4" />
    </label>
    <p class="rt-hint">Une arête plus pliée que l'angle compte comme un pli et
      résiste. Le coût d'une couture protège les bords d'UV, dont la rupture se
      voit dans la texture bien avant de se voir dans la forme.</p>

    <p class="rt-sub">Lissage</p>
    <label class="rt-field">
      <span>Passes <span class="rt-num" data-el="relaxValue">0</span></span>
      <input type="range" data-el="relax" min="0" max="10" step="1" value="0" />
    </label>
    <label class="rt-field">
      <span>Angle de pli du lissage <span class="rt-num" data-el="relaxAngleValue">75°</span></span>
      <input type="range" data-el="relaxAngle" min="20" max="150" step="5" value="75" />
    </label>
    <p class="rt-hint">Chaque passe est reprojetée sur la source, sinon une sphère
      dégonfle un peu à chaque fois. Cet angle n'est pas celui du dessus, et c'est
      voulu : un maillage réduit cinquante fois est facetté partout, donc l'angle
      qui veut dire « pli » pour un décimateur veut dire « tout le modèle » pour
      un lisseur.</p>
  </section>

  <section class="rt-page" data-tab="maps">
    <p class="rt-hint">Le maillage réduit porte encore la disposition d'UV de
      l'original, et passé un certain point cette disposition ne décrit plus la
      surface sur laquelle elle est posée. L'interrupteur est en bas, à côté du
      bouton dont il change le coût.</p>

    <div data-el="bakeTools">
      <label class="rt-field">
        <span>Taille de l'atlas <span class="rt-num" data-el="mapSizeValue">2048</span></span>
        <input type="range" data-el="mapSize" min="8" max="13" step="1" value="11" />
      </label>

      <p class="rt-sub">Cartes produites</p>
      <label class="rt-check"><input type="checkbox" checked disabled /><span>Couleur de base</span></label>
      <label class="rt-check"><input type="checkbox" data-el="mMR" checked /><span>Métal et rugosité</span></label>
      <label class="rt-check"><input type="checkbox" data-el="mNormal" checked /><span>Normale</span></label>
      <label class="rt-check"><input type="checkbox" data-el="mEmissive" checked /><span>Émissif</span></label>
      <label class="rt-check"><input type="checkbox" data-el="mAo" /><span>Occlusion ambiante</span></label>
      <p class="rt-hint">La couleur de base seule ne suffit pas : sans métal ni
        rugosité, tout le résultat hérite d'une seule paire de scalaires, et une
        boucle en laiton sur un manche en bois revient en bois mat. L'émissif est
        abandonné tout seul quand rien n'émet.</p>

      <div data-el="aoTools">
        <label class="rt-field">
          <span>Rayons par texel <span class="rt-num" data-el="aoSamplesValue">16</span></span>
          <input type="range" data-el="aoSamples" min="4" max="128" step="4" value="16" />
        </label>
        <label class="rt-field">
          <span>Portée de l'occlusion <span class="rt-num" data-el="aoDistanceValue">0.15</span></span>
          <input type="range" data-el="aoDistance" min="0.01" max="1" step="0.01" value="0.15" />
        </label>
        <p class="rt-hint">Courte, seuls les creux s'assombrissent ; longue, toute
          la silhouette s'ombre elle-même. La séquence de tirage est déterministe,
          donc comparer deux réglages n'est pas une devinette.</p>
      </div>
    </div>
  </section>

  <section class="rt-page" data-tab="atlas">
    <div data-el="atlasTools">
      <p class="rt-sub">Cage</p>
      <label class="rt-field">
        <span>Vers l'extérieur <span class="rt-num" data-el="cageOutValue">0.020</span></span>
        <input type="range" data-el="cageOut" min="0.001" max="0.2" step="0.001" value="0.02" />
      </label>
      <label class="rt-field">
        <span>Vers l'intérieur <span class="rt-num" data-el="cageInValue">0.020</span></span>
        <input type="range" data-el="cageIn" min="0.001" max="0.2" step="0.001" value="0.02" />
      </label>
      <p class="rt-hint">Trop courte, le rayon rate ce qui dépasse du maillage
        réduit ; trop longue, il traverse un vide et touche la pièce d'à côté.</p>

      <p class="rt-sub">Atlas</p>
      <label class="rt-field">
        <span>Écart entre îlots <span class="rt-num" data-el="gutterValue">4</span></span>
        <input type="range" data-el="gutter" min="0" max="32" step="1" value="4" />
      </label>
      <label class="rt-field">
        <span>Bavure hors des îlots <span class="rt-num" data-el="bleedValue">8</span></span>
        <input type="range" data-el="bleed" min="0" max="32" step="1" value="8" />
      </label>
      <label class="rt-field">
        <span>Angle de rupture d'îlot <span class="rt-num" data-el="islandValue">50°</span></span>
        <input type="range" data-el="island" min="10" max="120" step="1" value="50" />
      </label>
      <p class="rt-hint">Ce sont deux choses différentes et les deux comptent :
        l'écart est du vide entre les îlots pour qu'aucun niveau de mip ne les
        mélange, la bavure est de la couleur peinte au-delà de chaque bord pour
        que le filtrage n'aille jamais chercher le fond.</p>
    </div>
  </section>

  <section class="rt-page" data-tab="result">
    <p class="rt-hint" data-el="report">Rien encore.</p>
    <p class="rt-hint rt-err" data-el="err" hidden></p>
    <p class="rt-hint" data-el="sourceNote"></p>
  </section>

  </div>
</div>

<div class="rt-bar" data-el="bar">
  <label class="rt-switch" title="Reprojeter les textures de la source sur le résultat">
    <input type="checkbox" data-el="bake" /><i></i><span>Projeter</span>
  </label>
  <button class="wide" type="button" data-el="run">Décimer</button>
  <button class="wide" type="button" data-el="rebake" disabled
          title="Refaire seulement les cartes, sans retoucher la géométrie">Cuire</button>
  <span class="rt-note" data-el="note"></span>
  <button class="wide" type="button" data-el="close">Fermer</button>
  <div class="rt-progress"><i data-el="fill"></i></div>
</div>
`;

/** Triangles actually drawn, which is not the same as vertices. */
function countTriangles(root) {
  let total = 0;
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const g = o.geometry;
    if (!g) return;
    // An indexed geometry draws its index buffer; a soup draws its positions.
    total += (g.index ? g.index.count : g.attributes.position?.count || 0) / 3;
  });
  return Math.round(total);
}

const fr = (n) => n.toLocaleString("fr-FR");
const isGltf = (p) => /\.(glb|gltf)$/i.test(p || "");

export function createRetopo({
  tauri,
  viewer,
  importPart,
  onBusy,
  onOpenChange,
  toast,
  sourcePath,
  applyChannel,
  setWireframe,
}) {
  const host = document.createElement("div");
  host.id = "retopo";
  host.innerHTML = SHELL;
  document.getElementById("app").appendChild(host);

  const el = {};
  for (const node of host.querySelectorAll("[data-el]")) el[node.dataset.el] = node;

  let source = 0;
  let last = null;
  let running = false;
  let open = false;
  let method = "decimate";
  /** The two files the last run left behind, so a bake can be redone alone. */
  let lastRun = null;

  const METHOD_HINT = {
    decimate:
      "L'erreur quadrique met les triangles là où la silhouette en a besoin, pas " +
      "régulièrement. C'est ce que veut un accessoire figé.",
    isotropic:
      "Des arêtes de longueur égale et une valence de six, ce qui donne des boucles " +
      "prévisibles autour d'une articulation. C'est ce que veut un modèle qui va se " +
      "déformer ou se subdiviser, et c'est aussi ce dont l'appairage en quads a besoin.",
  };

  // --- tabs ---------------------------------------------------------------

  function showTab(name) {
    for (const t of host.querySelectorAll(".rt-tab")) {
      t.classList.toggle("active", t.dataset.tab === name);
    }
    for (const p of host.querySelectorAll(".rt-page")) {
      p.classList.toggle("active", p.dataset.tab === name);
    }
  }
  for (const t of host.querySelectorAll(".rt-tab")) {
    t.addEventListener("click", () => showTab(t.dataset.tab));
  }

  // --- seeing the quads ---------------------------------------------------

  /** Shared by every patched material, so a toggle is an assignment. */
  const wireU = makeWireUniforms();
  /** True once a result carrying a pairing has been prepared. */
  let hasQuads = false;

  /**
   * Teach the result's materials to draw their own edges.
   *
   * The pairing has to be visible or it is a number in a report: glTF has no
   * quads, so the result really is a triangle soup and any ordinary wireframe
   * draws it as one, every quad crossed out by its own diagonal. The mask that
   * travelled beside the file says which edges are real, and the shader hides
   * the rest.
   */
  async function dressResult(object, path) {
    if (!object) return;
    let mask = null;
    if (tauri) {
      try {
        mask = await tauri.core.invoke("retopo_quad_mask", { output: path });
      } catch {
        mask = null;
      }
    }
    hasQuads = !!mask?.length;
    wireU.uQuads.value = hasQuads ? 1 : 0;
    applyWire(object, wireU, mask);
    // The source gets the same treatment, with no mask: without it the curtain
    // has nothing to cut on its own side and the left half stays empty.
    const src = viewer.parts?.[0]?.object;
    if (src && src !== object) applyWire(src, wireU, null);
    syncViewport();
    // A new result has to join whatever comparison was already on screen.
    setAB(compareMode);
    viewer.invalidate?.();
  }

  // --- the top bar --------------------------------------------------------

  for (const b of host.querySelectorAll("[data-ch]")) {
    b.addEventListener("click", () => {
      for (const o of host.querySelectorAll("[data-ch]")) o.classList.toggle("active", o === b);
      applyChannel?.(b.dataset.ch);
    });
  }

  for (const b of host.querySelectorAll("[data-wire]")) {
    b.addEventListener("click", () => {
      for (const o of host.querySelectorAll("[data-wire]")) o.classList.toggle("active", o === b);
      const mode = b.dataset.wire;
      wireU.uWire.value = mode === "off" ? 0 : 1;
      setWireColor(wireU, mode === "light");
      viewer.invalidate?.();
    });
  }

  /*
   * Flat shading, which is not a stylistic choice here.
   *
   * A decimated mesh keeps the smooth normals it inherited, and those normals
   * lie: they draw a curve across a face that is now dead flat. Flat shading
   * shows the faces you actually have, which is the only honest way to judge how
   * far a budget went.
   */
  el.flat.addEventListener("click", () => {
    const on = el.flat.getAttribute("aria-pressed") !== "true";
    el.flat.setAttribute("aria-pressed", String(on));
    el.flat.classList.toggle("active", on);
    viewer.root.traverse((n) => {
      if (!n.isMesh && !n.isSkinnedMesh) return;
      for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
        if (!m || !("flatShading" in m)) continue;
        m.flatShading = on;
        m.needsUpdate = true;
      }
    });
    viewer.invalidate?.();
  });

  el.frame.addEventListener("click", () => viewer.frameCurrent?.());

  /**
   * How the source and the result share the viewport.
   *
   * Five modes rather than three, because "is this good enough" is not one
   * question. The curtain answers "did the silhouette move", the ghost answers
   * "did the low poly sink inside the original surface", and neither is
   * answerable by looking at the two meshes one after the other: the eye is very
   * good at spotting a change under a moving edge and very bad at comparing two
   * things it has to look back and forth between.
   */
  let compareMode = "both";
  /** Materials whose transparency the ghost borrowed, and what to give back. */
  let ghosted = [];

  function unghost() {
    for (const { m, transparent, opacity, depthWrite } of ghosted) {
      m.transparent = transparent;
      m.opacity = opacity;
      m.depthWrite = depthWrite;
      m.needsUpdate = true;
    }
    ghosted = [];
  }

  function ghost(object) {
    object.traverse((n) => {
      if (!n.isMesh && !n.isSkinnedMesh) return;
      for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
        if (!m) continue;
        ghosted.push({ m, transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite });
        m.transparent = true;
        m.opacity = 0.28;
        // Without this the shell writes depth and hides the very thing it is
        // drawn over, which makes the mode useless in the one case it exists
        // for: the result poking out through the original surface.
        m.depthWrite = false;
        m.needsUpdate = true;
      }
    });
  }

  function setAB(mode) {
    compareMode = mode;
    const parts = viewer.parts || [];
    unghost();
    for (const p of parts) {
      p.object.visible = true;
      setSide(p.object, 0);
    }
    el.splitLine.hidden = mode !== "split";

    // With nothing to compare against, every mode is "both".
    const src = parts[0]?.object;
    const res = parts.length > 1 ? parts.at(-1).object : null;
    if (src && res) {
      if (mode === "source") res.visible = false;
      else if (mode === "result") src.visible = false;
      else if (mode === "split") {
        setSide(src, -1);
        setSide(res, 1);
      } else if (mode === "ghost") ghost(src);
    }
    viewer.invalidate?.();
  }

  for (const b of host.querySelectorAll("[data-ab]")) {
    b.addEventListener("click", () => {
      for (const o of host.querySelectorAll("[data-ab]")) o.classList.toggle("active", o === b);
      setAB(b.dataset.ab);
    });
  }

  /*
   * Dragging the curtain.
   *
   * Pointer events rather than mouse events, so a stylus and a touch screen work
   * without a second code path, and capture so the drag survives the pointer
   * leaving the thin line it started on.
   */
  {
    let dragging = false;
    const place = (clientX) => {
      const r = (viewer.renderer?.domElement || host).getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(r.width, 1)));
      wireU.uSplit.value = t;
      el.splitLine.style.left = `${t * 100}%`;
      viewer.invalidate?.();
    };
    el.splitLine.addEventListener("pointerdown", (e) => {
      dragging = true;
      el.splitLine.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    el.splitLine.addEventListener("pointermove", (e) => dragging && place(e.clientX));
    el.splitLine.addEventListener("pointerup", (e) => {
      dragging = false;
      el.splitLine.releasePointerCapture(e.pointerId);
    });
  }

  /*
   * The shader needs the viewport in pixels to turn gl_FragCoord into a
   * fraction, and it is the drawing buffer size that matters rather than the CSS
   * size: on a high density display the two differ by the pixel ratio, and using
   * the wrong one puts the curtain at half the position asked for.
   */
  function syncViewport() {
    const c = viewer.renderer?.domElement;
    if (c) wireU.uViewport.value.set(c.width, c.height);
  }
  syncViewport();
  window.addEventListener("resize", syncViewport);

  // --- painting -----------------------------------------------------------

  /** The budget in triangles, from the slider's percentage. */
  const budget = () => Math.max(4, Math.round((source * Number(el.target.value)) / 100));

  /** The atlas side, from the slider's exponent. The useful sizes are powers of
   *  two and a linear 256..8192 slider spends its travel on values nobody picks. */
  const mapSize = () => 2 ** Number(el.mapSize.value);

  function setMethod(next) {
    method = next;
    el.mDecimate.classList.toggle("active", next === "decimate");
    el.mIsotropic.classList.toggle("active", next === "isotropic");
    el.methodHint.textContent = METHOD_HINT[next];
    paint();
  }

  /** A stat nobody has filled in yet should not read as loudly as a real one. */
  function setStat(node, text) {
    node.textContent = text ?? "—";
    node.classList.toggle("rt-void", text == null);
  }

  function paint() {
    el.targetValue.textContent = source ? `${fr(budget())} · ${el.target.value} %` : `${el.target.value} %`;
    el.angleValue.textContent = `${el.angle.value}°`;
    el.seamValue.textContent = el.seam.value;
    el.relaxValue.textContent = el.relax.value;
    el.relaxAngleValue.textContent = `${el.relaxAngle.value}°`;
    el.mapSizeValue.textContent = String(mapSize());
    el.cageOutValue.textContent = Number(el.cageOut.value).toFixed(3);
    el.cageInValue.textContent = Number(el.cageIn.value).toFixed(3);
    el.gutterValue.textContent = el.gutter.value;
    el.bleedValue.textContent = el.bleed.value;
    el.islandValue.textContent = `${el.island.value}°`;
    el.aoSamplesValue.textContent = el.aoSamples.value;
    el.aoDistanceValue.textContent = Number(el.aoDistance.value).toFixed(2);

    el.bakeTools.classList.toggle("rt-off", !el.bake.checked);
    el.atlasTools.classList.toggle("rt-off", !el.bake.checked);
    el.aoTools.classList.toggle("rt-off", !el.mAo.checked);

    setStat(el.hudSource, source ? fr(source) : null);
    setStat(el.hudResult, last ? fr(last.outputTriangles) : null);
    setStat(
      el.hudCut,
      last ? `${(100 - (last.outputTriangles / last.inputTriangles) * 100).toFixed(1)} %` : null
    );
    setStat(el.hudQuads, last?.quads ? `${(last.quadFraction * 100).toFixed(0)} %` : null);

    // The button says what it will do, unless it is currently the cancel button,
    // in which case what it will do is stop.
    if (!running) el.run.textContent = runLabel();
  }

  function refresh() {
    source = viewer.current ? countTriangles(viewer.root) : 0;
    // Never disabled while running: it is the cancel button then.
    el.run.disabled = running ? false : source === 0 || !tauri;
    el.run.title = running
      ? "Tuer le calcul en cours"
      : source === 0
        ? "Ouvre un modèle d'abord"
        : "";
    el.rebake.disabled = !lastRun || running || !tauri;
    el.rebake.title = lastRun
      ? "Refaire seulement les cartes, sans retoucher la géométrie"
      : "Il faut un résultat avant de pouvoir le cuire";

    // A dead button should say why it is dead, in the bar rather than in a
    // tooltip nobody hovers. "Nothing happens" is not a diagnosis anyone should
    // have to make from the outside.
    if (!running) {
      const why = !tauri
        ? "Pont natif absent : ouvert hors de l'application."
        : source === 0
          ? "Aucun modèle chargé."
          : "";
      if (why || el.note.textContent.startsWith("Aucun") || el.note.textContent.startsWith("Pont")) {
        say(why);
      }
    }

    // Say where the geometry will come from, because the two paths behave
    // differently and the difference is worth a sentence rather than a surprise.
    const p = sourcePath?.();
    el.sourceNote.textContent = !source
      ? ""
      : isGltf(p)
        ? "Le moteur lira le fichier d'origine directement."
        : "La scène sera exportée en glTF avant d'être lue, ce qui prend un moment sur un gros modèle.";
    paint();
  }

  const LIVE = [
    "target", "angle", "seam", "relax", "relaxAngle",
    "mapSize", "cageOut", "cageIn", "gutter", "bleed", "island",
    "aoSamples", "aoDistance",
  ];
  for (const k of LIVE) el[k].addEventListener("input", paint);
  for (const k of ["bake", "mAo", "holes", "boundary", "quads", "mMR", "mNormal", "mEmissive"]) {
    el[k].addEventListener("change", paint);
  }
  el.mDecimate.addEventListener("click", () => setMethod("decimate"));
  el.mIsotropic.addEventListener("click", () => setMethod("isotropic"));

  // --- running ------------------------------------------------------------

  /**
   * What the run button says when it is not the cancel button.
   *
   * The method segment moved to another tab and the bake switch sits at the far
   * end of the bar, so the button naming both is the only place the two are
   * visible at once.
   */
  const runLabel = () => {
    const verb = method === "isotropic" ? "Reconstruire" : "Décimer";
    return el.bake.checked ? `${verb} et projeter` : verb;
  };

  /** The bake half of the request, shared by a full run and a bake on its own. */
  const bakeRequest = () => ({
    bake: true,
    mapSize: mapSize(),
    cageOut: Number(el.cageOut.value),
    cageIn: Number(el.cageIn.value),
    gutter: Number(el.gutter.value),
    bleed: Number(el.bleed.value),
    islandAngleDeg: Number(el.island.value),
    bakeNormal: el.mNormal.checked,
    bakeMetallicRoughness: el.mMR.checked,
    bakeEmissive: el.mEmissive.checked,
    bakeAo: el.mAo.checked,
    aoSamples: Number(el.aoSamples.value),
    aoDistance: Number(el.aoDistance.value),
  });

  /**
   * Write up what a run did, on the Résultat tab.
   *
   * The refusals are shown rather than swallowed. A run with a large refusal
   * count and a barely moved triangle count is a guard firing on every
   * candidate, and it looks exactly like a run that simply had nothing left to
   * collapse unless the numbers are on screen.
   */
  function reportOn(r, bakeOnly = false) {
    const lines = [];
    if (!bakeOnly) {
      lines.push(
        `${fr(r.inputTriangles)} → ${fr(r.outputTriangles)} triangles en ` +
          `${(r.millis / 1000).toFixed(2)} s, déviation maximum ` +
          `${r.deviationMax.toPrecision(3)} unité.`
      );
      if (r.holesFilled || r.holesLeft) {
        lines.push(`Trous : ${fr(r.holesFilled)} comblés, ${fr(r.holesLeft)} laissés ouverts.`);
      }
      if (r.rejectedTopology || r.rejectedFlip) {
        lines.push(
          `${fr(r.collapses)} fusions, refus : ${fr(r.rejectedTopology)} topologie, ` +
            `${fr(r.rejectedFlip)} retournement.`
        );
      }
      // The mean, never the worst. The worst triangle sits on a crease, which
      // relaxation pins on purpose, so it barely moves even when the mesh
      // improved throughout.
      if (r.aspectAfter > 0) {
        lines.push(
          `Rapport d'aspect moyen : ${r.aspectBefore.toFixed(2)} → ${r.aspectAfter.toFixed(2)}.`
        );
      }
      if (r.quads) {
        lines.push(`${fr(r.quads)} quads, ${(r.quadFraction * 100).toFixed(0)} % de la surface.`);
      }
    } else {
      lines.push(`Cartes refaites en ${(r.millis / 1000).toFixed(2)} s, géométrie inchangée.`);
    }
    if (r.charts) {
      const total = r.hits + r.misses;
      const miss = total ? (r.misses / total) * 100 : 0;
      lines.push(
        `Atlas : ${fr(r.charts)} îlots, ${(r.utilisation * 100).toFixed(0)} % occupé, ` +
          `${miss.toFixed(1)} % de rayons manqués.`
      );
      lines.push(`Cartes : ${r.maps.join(", ")}.`);
      // A miss is a ray that fell back to the nearest surface point rather than
      // finding the high poly. A few are normal; a lot means the cage is too
      // tight for this pair of meshes, or a chart wrapped around something thin.
      if (miss > 15) lines.push("Beaucoup de manques : essaie une cage plus longue.");
    }
    el.report.textContent = lines.join(" ");
    showTab("result");
  }

  /** The bar, the fill and the note, in one place so they cannot disagree. */
  function say(text, fraction) {
    el.note.textContent = text || "";
    el.bar.classList.toggle("busy", running);
    if (typeof fraction === "number") el.fill.style.width = `${Math.round(fraction * 100)}%`;
  }

  /**
   * An error has to be impossible to miss.
   *
   * It used to be written into the report at the bottom of a long scrolling
   * panel, where a run that failed looked exactly like a button that did
   * nothing. Now it goes to the bar, to a toast, to its own line on the Résultat
   * tab, to that tab being brought forward, and to the console.
   */
  function fail(e) {
    const text = String(e?.message || e);
    // A cancel arrives as a failure, because that is what it is at the process
    // level, but it is not a failure to the person who asked for it. Painting it
    // red and shouting about it would be reporting their own decision back to
    // them as a fault.
    if (text.trim() === "annulé") {
      say("Calcul annulé.");
      return;
    }
    console.error("[retopo]", e);
    el.err.textContent = text;
    el.err.hidden = false;
    showTab("result");
    say("");
    toast?.("La retopologie a échoué", 2600);
  }

  /**
   * The file the engine should read.
   *
   * When the model came off disk as glTF, hand over that path and let the engine
   * open it: retopology does not care about the scene transform, and pushing a
   * forty megabyte export back across the bridge is exactly what this module
   * says elsewhere it will not do. Every other format still has to be exported,
   * which is what makes a NIF or a USD retopologisable at all.
   */
  async function inputFor(dirs) {
    const p = sourcePath?.();
    if (isGltf(p)) return p;

    say("Export de la scène…", 0);
    // The group, not the object inside it: the orientation buttons and the edit
    // handles both write to the group.
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const glb = await new GLTFExporter().parseAsync(viewer.root, {
      binary: true,
      includeCustomExtensions: true,
    });
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(dirs.input, new Uint8Array(glb));
    return dirs.input;
  }

  async function run() {
    if (running || !tauri || !viewer.current) return;
    running = true;

    let stop = null;
    try {
      // Everything that touches state lives inside the try, so a throw on the
      // way in cannot leave `running` stuck true and the button disabled for the
      // rest of the session.
      el.run.textContent = "Annuler";
      el.rebake.disabled = true;
      el.err.hidden = true;
      el.fill.style.width = "0%";
      say("Préparation…", 0);
      onBusy?.(true);

      const dirs = await tauri.core.invoke("retopo_workdir");
      const input = await inputFor(dirs);

      const verb = method === "isotropic" ? "Reconstruction" : "Décimation";
      say(`${verb}…`, 0);
      stop = await tauri.event.listen("retopo://progress", (e) => {
        const f = e.payload || 0;
        // The engine apportions its own bar by what each stage costs, so the
        // wording follows the fraction rather than being timed here.
        const what = !el.bake.checked || f < 0.5 ? verb : "Projection des textures";
        say(`${what}… ${Math.round(f * 100)} %`, f);
      });

      const r = await tauri.core.invoke("retopo_decimate", {
        input,
        output: dirs.output,
        request: {
          method,
          targetTriangles: budget(),
          fillHoles: el.holes.checked,
          preserveBoundary: el.boundary.checked,
          sharpAngleDeg: Number(el.angle.value),
          seamPenalty: Number(el.seam.value),
          relaxIterations: Number(el.relax.value),
          relaxAngleDeg: Number(el.relaxAngle.value),
          pairQuads: el.quads.checked,
          ...bakeRequest(),
          bake: el.bake.checked,
        },
      });

      say("Chargement du résultat…", 1);
      await importPart(dirs.output);
      last = r;
      // Both files stay named, so the bake can be redone on its own without
      // touching the geometry again.
      lastRun = { high: input, low: dirs.output };
      await dressResult(viewer.parts.at(-1)?.object, dirs.output);
      reportOn(r);

      const cut = (100 - (r.outputTriangles / r.inputTriangles) * 100).toFixed(0);
      toast?.(`${fr(r.outputTriangles)} triangles, ${cut} % de moins`);
      say("");
    } catch (e) {
      fail(e);
    } finally {
      stop?.();
      running = false;
      el.run.textContent = runLabel();
      onBusy?.(false);
      el.bar.classList.remove("busy");
      refresh();
    }
  }

  /**
   * Bake again, and nothing else.
   *
   * Baking is its own operation on two meshes that already exist, not a stage of
   * the retopology job, so changing a map size or a cage distance costs a bake
   * rather than a whole decimation. On a big model that is the difference
   * between seconds and a minute, which is what makes iterating on a bad map
   * bearable at all.
   */
  async function rebake() {
    if (running || !tauri || !lastRun) return;
    running = true;

    let stop = null;
    try {
      el.run.textContent = "Annuler";
      el.rebake.disabled = true;
      el.err.hidden = true;
      el.fill.style.width = "0%";
      say("Projection des textures…", 0);
      onBusy?.(true);

      const dirs = await tauri.core.invoke("retopo_workdir");
      stop = await tauri.event.listen("retopo://progress", (e) => {
        const f = e.payload || 0;
        say(`Projection des textures… ${Math.round(f * 100)} %`, f);
      });

      const r = await tauri.core.invoke("retopo_bake", {
        high: lastRun.high,
        low: lastRun.low,
        output: dirs.rebake,
        request: bakeRequest(),
      });

      say("Chargement du résultat…", 1);
      await importPart(dirs.rebake);
      lastRun = { high: lastRun.high, low: dirs.rebake };
      last = { ...last, ...r, outputTriangles: r.outputTriangles || last.outputTriangles };
      reportOn(r, true);
      toast?.(`Cartes refaites en ${(r.millis / 1000).toFixed(1)} s`);
      say("");
    } catch (e) {
      fail(e);
    } finally {
      stop?.();
      running = false;
      el.run.textContent = runLabel();
      onBusy?.(false);
      el.bar.classList.remove("busy");
      refresh();
    }
  }

  /**
   * The run button is also the cancel button.
   *
   * A second button that is inert for all but the twenty seconds a run lasts is
   * worse than a label that changes: the control you need is always the one
   * under the cursor, and there is nothing to hunt for while a long decimation
   * is grinding.
   */
  el.run.addEventListener("click", () => {
    if (running) tauri?.core.invoke("retopo_cancel").catch(() => {});
    else run();
  });
  el.rebake.addEventListener("click", rebake);
  el.close.addEventListener("click", () => api.hide());
  setMethod("decimate");

  const api = {
    get open() {
      return open;
    },
    show() {
      open = true;
      host.classList.add("open");
      onOpenChange?.(true);
      refresh();
    },
    hide() {
      open = false;
      host.classList.remove("open");
      onOpenChange?.(false);
    },
    toggle() {
      open ? api.hide() : api.show();
    },
    refresh,
  };
  return api;
}
