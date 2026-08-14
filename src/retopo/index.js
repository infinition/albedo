import * as THREE from "three";
import { buildCage } from "./cage.js";
import { ICONS } from "./icons.js";
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
<div class="rt-top" data-el="top">

  <dl class="rt-counts" data-el="hud">
    <div><dt>Source</dt><dd data-el="hudSource">—</dd></div>
    <div><dt>Résultat</dt><dd data-el="hudResult">—</dd></div>
    <div><dt>Réduction</dt><dd data-el="hudCut">—</dd></div>
    <div><dt>Quads</dt><dd data-el="hudQuads">—</dd></div>
  </dl>

  <div class="rt-tgroup">
    <span class="rt-tlabel">Couleur</span>
    <div class="rt-plate" role="radiogroup" aria-label="Couleur de la surface">
      <button class="rt-i active" type="button" data-colour="shaded" data-icon="shaded" title="Rendu physique"></button>
      <button class="rt-i" type="button" data-colour="unlit" data-icon="unlit" title="Peint : la texture telle qu'elle a été faite, sans éclairage"></button>
      <button class="rt-i" type="button" data-colour="albedo" data-icon="albedo" title="Couleur de base seule"></button>
      <button class="rt-i" type="button" data-colour="normalGeom" data-icon="normalGeom" title="Normales de géométrie"></button>
      <button class="rt-i" type="button" data-colour="uv" data-icon="uv" title="Damier d'UV"></button>
      <button class="rt-i" type="button" data-colour="charts" data-icon="charts" data-el="btnCharts" title="Îlots de l'atlas, une couleur par îlot" disabled></button>
      <button class="rt-i" type="button" data-colour="deviation" data-icon="deviation" data-el="btnDeviation" title="Écart au modèle d'origine" disabled></button>
    </div>
  </div>

  <div class="rt-tgroup">
    <span class="rt-tlabel">Calques</span>
    <div class="rt-toggles">
      <button class="rt-i rt-t" type="button" data-el="wire" data-icon="wireLight" aria-pressed="false" title="Fil de fer par-dessus la surface"></button>
      <button class="rt-i rt-t rt-sub-i" type="button" data-el="wireFlip" data-icon="wireDark" aria-pressed="false" title="Traits sombres plutôt que clairs" hidden></button>
      <button class="rt-i rt-t" type="button" data-el="flat" data-icon="flat" aria-pressed="false" title="Ombrage plat : chaque triangle sa normale"></button>
      <button class="rt-i rt-t" type="button" data-el="opaque" data-icon="opaque" aria-pressed="false" title="Opaque : forcer la surface pleine, pour que le fil de fer ne traverse plus"></button>
      <button class="rt-i rt-t" type="button" data-el="xray" data-icon="xray" aria-pressed="false" title="Rayons X : voir à travers la surface"></button>
    </div>
  </div>

  <div class="rt-tgroup">
    <span class="rt-tlabel">Scène</span>
    <div class="rt-plate" role="radiogroup" aria-label="Ce qui est dans la scène">
      <button class="rt-i" type="button" data-ab="source" data-icon="cmpSource" title="La source seule"></button>
      <button class="rt-i" type="button" data-ab="result" data-icon="cmpResult" title="Le résultat seul"></button>
      <button class="rt-i active" type="button" data-ab="both" data-icon="cmpBoth" title="Les deux dans la scène"></button>
      <button class="rt-i" type="button" data-ab="split" data-icon="cmpSplit" title="Rideau déplaçable : source à gauche, résultat à droite"></button>
      <button class="rt-i" type="button" data-ab="ghost" data-icon="cmpGhost" title="Fantôme : source en transparence sur le résultat"></button>
    </div>
  </div>

  <div class="rt-tgroup">
    <span class="rt-tlabel">Caméra</span>
    <div class="rt-toggles">
      <button class="rt-i rt-t" type="button" data-el="frame" data-icon="frame" title="Recadrer"></button>
    </div>
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
    <button class="rt-tab" type="button" data-tab="matter" role="tab">Matières</button>
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

    <p class="rt-sub">Déviation maximum</p>
    <label class="rt-field">
      <span>Plafond <span class="rt-num" data-el="maxErrorValue">aucun</span></span>
      <input type="range" data-el="maxError" min="0" max="50" step="1" value="0" />
    </label>
    <p class="rt-hint">La deuxième condition d'arrêt, et celle qui compte quand
      on cherche une qualité plutôt qu'un budget : la décimation s'arrête quand
      la prochaine fusion déplacerait la surface de plus que ça. C'est la
      différence entre « fais-en 5 000 triangles » et « fais-le aussi petit que
      possible sans que ça se voie ». À zéro, seul le budget décide.</p>

    <p class="rt-sub">Portée</p>
    <div class="segment" role="group" aria-label="Portée">
      <button class="seg active" type="button" data-scope="all" title="Tout le modèle">Tout</button>
      <button class="seg" type="button" data-scope="visible" title="Seulement ce qui n'est pas masqué dans l'onglet Matières">Matières visibles</button>
    </div>
    <p class="rt-hint" data-el="scopeHint">Masque une matière dans l'onglet
      Matières et choisis « Matières visibles » pour la laisser tranquille. Le
      masquage qui existe déjà sert de sélection, plutôt qu'une seconde
      sélection qui dirait la même chose ailleurs.</p>

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
      <span>Force <span class="rt-num" data-el="relaxStrengthValue">0.50</span></span>
      <input type="range" data-el="relaxStrength" min="0.05" max="1" step="0.05" value="0.5" />
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
      <label class="rt-check"><input type="checkbox" data-el="showCage" /><span>Dessiner la cage</span></label>
      <p class="rt-hint">Une distance de cage ne veut rien dire tant qu'on n'a pas
        vu la coque qu'elle décrit : trop courte, les rayons manquent ce qui
        dépasse du maillage réduit ; trop longue, ils vont chercher la pièce d'à
        côté et cuisent un chambranle sur une porte.</p>
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

  <section class="rt-page" data-tab="matter">
    <p class="rt-hint">La liste des matières d'Albedo, telle quelle. Chaque
      emplacement de texture peut être remplacé ou restauré ici, ce qui est la
      façon de préparer une source avant de la cuire : une carte de normale
      corrigée avant projection vaut mieux qu'une projection corrigée après.</p>
    <div data-el="matterHost"></div>
  </section>

  <section class="rt-page" data-tab="result">
    <div data-el="devTools" class="rt-off">
      <p class="rt-sub">Échelle de l'écart</p>
      <label class="rt-field">
        <span>Rouge à <span class="rt-num" data-el="devScaleValue">—</span></span>
        <input type="range" data-el="devScale" min="0.1" max="4" step="0.1" value="1" />
      </label>
      <p class="rt-hint">Multiplicateur sur le pire écart du calcul, pas une
        distance absolue : « de combien ça a bougé » ne veut dire quelque chose
        que rapporté à ce que ça pouvait bouger. À 1 la couleur la plus chaude
        tombe exactement sur le pire sommet ; en dessous la rampe sature et les
        zones seulement mauvaises rejoignent les pires, ce qui est la façon de
        les trouver.</p>
    </div>

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
  <button class="rt-i" type="button" data-el="undo" data-icon="undo" title="Annuler le dernier résultat" disabled></button>
  <button class="rt-i" type="button" data-el="redo" data-icon="redo" title="Refaire" disabled></button>
  <span class="rt-note" data-el="history"></span>
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
  channels,
}) {
  const host = document.createElement("div");
  host.id = "retopo";
  host.innerHTML = SHELL;
  document.getElementById("app").appendChild(host);

  const el = {};
  for (const node of host.querySelectorAll("[data-el]")) el[node.dataset.el] = node;

  // The icons are set from the map rather than written inline in the template,
  // so the same glyph cannot end up drawn two slightly different ways in two
  // places, and so the template stays readable as a layout.
  for (const node of host.querySelectorAll("[data-icon]")) {
    node.innerHTML = ICONS[node.dataset.icon] || "";
  }

  let source = 0;
  let last = null;
  let running = false;
  let open = false;
  let method = "decimate";
  /** `all` or `visible`: which materials the run is allowed to touch. */
  let scope = "all";
  /** The two files the last run left behind, so a bake can be redone alone. */
  let lastRun = null;

  /**
   * Results, in order, so a run can be taken back.
   *
   * A twenty second computation you cannot undo is a computation you stop
   * experimenting with, which is the opposite of what a tool full of sliders is
   * for. The history holds paths rather than meshes because `removePart`
   * disposes the geometry and textures it took out, and it is right to: keeping
   * every result resident to make redo cheap would mean holding a dozen copies
   * of a model in memory to save re-reading a file that is still sitting in the
   * work directory.
   */
  let history = [];
  /** Index of the result currently in the scene, or -1 for the bare source. */
  let cursor = -1;

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

  /**
   * Borrow Albedo's materials list rather than build a second one.
   *
   * The inspector already has a row per material, every texture slot listed one
   * at a time, replacement and restore, and `replaceMap` already does the part
   * that costs an afternoon: the incoming texture inherits flipY, wrapping,
   * repeat, offset, centre and rotation from the one it replaces, because those
   * belong to the model's UVs and not to the image.
   *
   * So the section is *moved* here while the mode is open and handed straight
   * back on close. Not copied: a second list would need its own handlers, its
   * own repaint on model change, and would drift from the first one within a
   * week. Moving a node keeps its listeners, and the repaint that targets it by
   * id keeps finding it because the id came along.
   *
   * The two can never both want it, since opening either mode closes the other.
   */
  let matterHome = null;

  function borrowMatter() {
    const section = document.getElementById("materials-section");
    if (!section || matterHome) return;
    matterHome = { parent: section.parentNode, next: section.nextSibling };
    el.matterHost.appendChild(section);
  }

  function returnMatter() {
    const section = document.getElementById("materials-section");
    if (!section || !matterHome) return;
    matterHome.parent.insertBefore(section, matterHome.next);
    matterHome = null;
  }

  /** The drawn bake cage, rebuilt with each result. */
  let cage = null;

  /**
   * Teach whatever is already in the scene to draw its own edges.
   *
   * Without this the wireframe, the flat toggle and the x-ray do nothing until
   * the first run, because only a *patched* material can draw them and nothing
   * has been patched yet. Opening the mode on a model you have not decimated is
   * the normal way to start — you look at it first — so the controls have to
   * work from the moment the bar appears.
   *
   * Idempotent: `patchWire` skips a material it has already seen, so calling
   * this every time the mode opens costs a traverse and nothing else.
   */
  function dressScene() {
    for (const part of viewer.parts || []) applyWire(part.object, wireU, null);
    syncViewport();
    viewer.invalidate?.();
  }

  /**
   * Point the shell at the current result and the current slider.
   *
   * Called after a run and whenever the distance changes, which is the whole
   * interaction: the number only means something while you are watching the
   * shell move.
   */
  function syncCage() {
    if (!cage) {
      el.showCage.checked = false;
      return;
    }
    cage.setDistance(Number(el.cageOut.value));
    cage.setVisible(el.showCage.checked);
    viewer.invalidate?.();
  }

  /** Shared by every patched material, so a toggle is an assignment. */
  const wireU = makeWireUniforms();
  /** True once a result carrying a pairing has been prepared. */
  let hasQuads = false;
  /** The worst deviation of the current result, in model units. */
  let devMax = 0;

  /**
   * The heat ramp's top end.
   *
   * The slider is a multiplier on the run's own worst value rather than an
   * absolute distance, because "how far did it move" only means something
   * against how far it could have. At 1 the hottest colour sits exactly on the
   * worst vertex; below 1 the ramp saturates and the merely-bad areas join the
   * worst ones, which is how you find them.
   */
  function syncDevScale() {
    const f = Number(el.devScale.value);
    wireU.uDevScale.value = devMax > 0 ? f / devMax : 0;
    el.devScaleValue.textContent = devMax > 0
      ? `${(devMax / f).toPrecision(3)} unité`
      : "—";
    viewer.invalidate?.();
  }

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
    const read = async (kind) => {
      if (!tauri) return null;
      try {
        return await tauri.core.invoke("retopo_sidecar", { output: path, kind });
      } catch {
        return null;
      }
    };
    // Three files, read together, because the three views they feed are all
    // switched on from the same row of icons and a missing one has to disable
    // its icon rather than paint zeros.
    const [mask, charts, dev] = await Promise.all([read("quads"), read("charts"), read("dev")]);

    hasQuads = !!mask?.length;
    wireU.uQuads.value = hasQuads ? 1 : 0;
    el.btnCharts.disabled = !charts?.length;
    el.btnDeviation.disabled = !dev?.length;
    el.devTools.classList.toggle("rt-off", !dev?.length);
    // The scale is set from the run's own worst deviation, so the ramp spans the
    // data instead of an arbitrary range: a model that barely moved should still
    // show where it moved most.
    devMax = dev?.length ? Math.max(...dev) : 0;
    syncDevScale();
    applyWire(object, wireU, mask, charts, dev);
    // The source gets the same treatment, with no mask: without it the curtain
    // has nothing to cut on its own side and the left half stays empty.
    const src = viewer.parts?.[0]?.object;
    if (src && src !== object) applyWire(src, wireU, null);

    // The cage wraps the low poly, because that is the surface the baker fires
    // its rays from.
    cage?.dispose();
    cage = buildCage(object);
    if (cage) object.add(cage.object);
    syncCage();
    syncViewport();
    // A new result has to join whatever comparison was already on screen.
    setAB(compareMode);
    viewer.invalidate?.();
  }

  // --- the top bar --------------------------------------------------------

  /*
   * One choice of surface colour, seven options, one mechanism.
   *
   * Five of them are Albedo's own channels and two are overrides this module
   * draws in the shader, and *that difference is not the user's problem*. They
   * were two groups with two behaviours that looked identical in the bar, which
   * is what made the row unreadable: some buttons stayed lit together and some
   * replaced each other, with nothing on screen saying which was which. One
   * radio group, exactly one active, whatever it takes underneath.
   */
  const COLOUR_VIEWS = { charts: 1, deviation: 2 };

  /**
   * Say what just happened, in the words the buttons use.
   *
   * Every control in this mode changes something you have to *look* at the model
   * to notice, and several of them do nothing visible at all on a model that has
   * not been decimated yet. Without a line of text the honest reading of a click
   * is "nothing happened", which is how a working tool gets reported as broken.
   *
   * Never with an empty string: the toast element prints whatever it is handed,
   * so a null would flash a blank bubble, which says less than silence.
   */
  const say2 = (text) => text && toast?.(text);

  const LABELS = {
    shaded: "Rendu physique",
    unlit: "Peint, sans éclairage",
    albedo: "Couleur de base",
    normalGeom: "Normales de géométrie",
    uv: "Damier d'UV",
    charts: "Îlots de l'atlas",
    deviation: "Écart au modèle d'origine",
  };

  const AB_LABELS = {
    source: "Source seule",
    result: "Résultat seul",
    both: "Source et résultat",
    split: "Rideau : glisse la ligne",
    ghost: "Fantôme : source en transparence",
  };

  function setColour(name) {
    for (const o of host.querySelectorAll("[data-colour]")) {
      o.classList.toggle("active", o.dataset.colour === name);
    }
    const view = COLOUR_VIEWS[name] || 0;
    wireU.uView.value = view;
    // A data view is painted over whatever channel is underneath, so the
    // underlying one stays on the plain shaded render rather than on a UV
    // checker that would show through nothing.
    applyChannel?.(view ? "shaded" : name);
    viewer.invalidate?.();
    say2(LABELS[name] || name);
  }

  for (const b of host.querySelectorAll("[data-colour]")) {
    b.addEventListener("click", () => setColour(b.dataset.colour));
  }

  /*
   * Layers are toggles, and they look like toggles.
   *
   * The colour above is a choice; these are things you add on top of it, and any
   * number of them can be on at once. Giving them a different shape in the bar
   * is the only thing that says so without a manual.
   */
  const toggle = (node, on) => {
    node.setAttribute("aria-pressed", String(on));
    node.classList.toggle("active", on);
  };

  el.wire.addEventListener("click", () => {
    const on = el.wire.getAttribute("aria-pressed") !== "true";
    toggle(el.wire, on);
    wireU.uWire.value = on ? 1 : 0;
    // The light-or-dark choice only exists while there are lines to colour, so
    // it appears with them instead of sitting there inert two thirds of the time.
    el.wireFlip.hidden = !on;
    viewer.invalidate?.();
    say2(on ? (hasQuads ? "Fil de fer, quads compris" : "Fil de fer") : "Fil de fer coupé");
  });

  el.wireFlip.addEventListener("click", () => {
    const dark = el.wireFlip.getAttribute("aria-pressed") !== "true";
    toggle(el.wireFlip, dark);
    setWireColor(wireU, !dark);
    viewer.invalidate?.();
  });

  el.flat.addEventListener("click", () => {
    const on = el.flat.getAttribute("aria-pressed") !== "true";
    toggle(el.flat, on);
    viewer.root.traverse((n) => {
      if (!n.isMesh && !n.isSkinnedMesh) return;
      for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
        if (!m || !("flatShading" in m)) continue;
        m.flatShading = on;
        m.needsUpdate = true;
      }
    });
    viewer.invalidate?.();
    say2(on ? "Ombrage plat" : "Ombrage lisse");
  });

  /*
   * Force the surface solid.
   *
   * A model whose materials are alpha blended draws its own far side through its
   * near one, and a wireframe over that is every edge of the whole mesh at once:
   * unreadable, and the exact opposite of what a wireframe is for. Nothing is
   * wrong with the model — leaves and glass are supposed to be transparent — but
   * judging topology is not the moment for it.
   *
   * The originals are kept and handed back, because this is a way of looking at
   * the model and not an edit to it.
   */
  el.opaque.addEventListener("click", () => {
    const on = el.opaque.getAttribute("aria-pressed") !== "true";
    toggle(el.opaque, on);
    viewer.root.traverse((n) => {
      if (!n.isMesh && !n.isSkinnedMesh) return;
      for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
        if (!m) continue;
        if (on) {
          m.userData.solidWas ??= {
            transparent: m.transparent,
            opacity: m.opacity,
            depthWrite: m.depthWrite,
            side: m.side,
          };
          m.transparent = false;
          m.opacity = 1;
          m.depthWrite = true;
          // Front faces only: a double sided leaf drawn solid still shows its own
          // underside through itself wherever it folds.
          m.side = THREE.FrontSide;
        } else if (m.userData.solidWas) {
          Object.assign(m, m.userData.solidWas);
          delete m.userData.solidWas;
        }
        m.needsUpdate = true;
      }
    });
    viewer.invalidate?.();
    say2(on ? "Surface forcée opaque" : "Transparence du modèle rendue");
  });

  el.xray.addEventListener("click", () => {
    const on = el.xray.getAttribute("aria-pressed") !== "true";
    toggle(el.xray, on);
    wireU.uXray.value = on ? 1 : 0;
    // Transparency has to be turned on at the material for the alpha the shader
    // writes to mean anything at all.
    viewer.root.traverse((n) => {
      if (!n.isMesh && !n.isSkinnedMesh) return;
      for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
        if (!m || !m.userData?.wirePatched) continue;
        if (on) {
          m.userData.xrayWas ??= { transparent: m.transparent, depthWrite: m.depthWrite };
          m.transparent = true;
          m.depthWrite = false;
        } else if (m.userData.xrayWas) {
          m.transparent = m.userData.xrayWas.transparent;
          m.depthWrite = m.userData.xrayWas.depthWrite;
          delete m.userData.xrayWas;
        }
        m.needsUpdate = true;
      }
    });
    viewer.invalidate?.();
  });

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

  el.frame.addEventListener("click", () => {
    viewer.frameCurrent?.();
    say2("Recadré");
  });

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
      const parts = viewer.parts || [];
      // On a model with no result yet, four of the five modes are the same
      // picture. Saying so beats letting someone click all five and conclude the
      // buttons are dead.
      say2(parts.length > 1
        ? AB_LABELS[b.dataset.ab]
        : "Rien à comparer tant qu'il n'y a pas de résultat");
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
  /*
   * The action bar's real height, published to the stylesheet.
   *
   * The panel used to reserve a fixed number of pixels above it, which was right
   * until the bar wrapped onto three rows in a narrow window and the panel sat
   * on top of its own buttons. Reserving a guess is how that happens; measuring
   * cannot drift.
   *
   * Measured on the events that change it *and* watched by an observer. The
   * observer alone would be neater, but it only delivers while the page is being
   * rendered, so the first layout can land before it has said anything. The
   * explicit calls are what make the very first paint right.
   */
  function measureBar() {
    const h = Math.ceil(el.bar.getBoundingClientRect().height);
    if (h > 0) host.style.setProperty("--rt-bar-h", `${h}px`);
  }
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(measureBar).observe(el.bar);
  }
  window.addEventListener("resize", measureBar);


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
    // Zéro veut dire « pas de plafond », ce qui est un mot et pas un nombre.
    const cap = Number(el.maxError.value);
    el.maxErrorValue.textContent = cap === 0 ? "aucun" : `${(cap / 1000).toFixed(3)}`;
    el.relaxStrengthValue.textContent = Number(el.relaxStrength.value).toFixed(2);
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
    paintHistory();
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
    "maxError", "relaxStrength",
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
  /** Drop the result currently in the scene, if there is one. */
  function dropResult() {
    const parts = viewer.parts || [];
    if (parts.length < 2) return;
    viewer.removePart(parts.at(-1));
    cage?.dispose();
    cage = null;
  }

  function paintHistory() {
    el.undo.disabled = running || cursor < 0;
    el.redo.disabled = running || cursor >= history.length - 1;
    el.history.textContent = history.length ? `${cursor + 1} / ${history.length}` : "";
  }

  /** Walk the history by one, in either direction. */
  async function step(delta) {
    if (running) return;
    const next = cursor + delta;
    if (next < -1 || next >= history.length) return;
    dropResult();
    cursor = next;
    if (cursor >= 0) {
      const entry = history[cursor];
      await importPart(entry.path);
      await dressResult(viewer.parts.at(-1)?.object, entry.path);
      last = entry.report;
      lastRun = { high: entry.high, low: entry.path };
      reportOn(entry.report);
    } else {
      last = null;
      lastRun = null;
      el.report.textContent = "";
      setAB(compareMode);
    }
    paintHistory();
    refresh();
  }

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
    /*
     * Rows, not a paragraph.
     *
     * It was one grey block holding eleven numbers, which is the same as holding
     * none: nothing to compare against, nothing to scan for, and nothing that
     * stands out when it goes wrong. A label and a value per line, and the two
     * figures that mean "this went badly" are allowed to say so in colour.
     */
    const rows = [];
    const add = (label, value, tone = "") => rows.push({ label, value, tone });

    if (!bakeOnly) {
      add("Triangles", `${fr(r.inputTriangles)} → ${fr(r.outputTriangles)}`);
      add("Réduction", `${(100 - (r.outputTriangles / r.inputTriangles) * 100).toFixed(1)} %`, "good");
      add("Durée", `${(r.millis / 1000).toFixed(2)} s`);
      add("Déviation max", `${r.deviationMax.toPrecision(3)} unité`);
      if (r.holesFilled || r.holesLeft) {
        add("Trous comblés", fr(r.holesFilled));
        // A hole left open is one the bake will project straight through.
        if (r.holesLeft) add("Trous laissés", fr(r.holesLeft), "warn");
      }
      if (r.collapses) add("Fusions", fr(r.collapses));
      // A large refusal count next to a barely moved triangle count is a guard
      // firing on every candidate, and it looks exactly like a mesh that had
      // nothing left to collapse unless the numbers are side by side.
      if (r.rejectedTopology) add("Refus topologie", fr(r.rejectedTopology), r.rejectedTopology > r.collapses ? "warn" : "");
      if (r.rejectedFlip) add("Refus retournement", fr(r.rejectedFlip), r.rejectedFlip > r.collapses ? "warn" : "");
      // The mean, never the worst: the worst triangle sits on a crease, which
      // relaxation pins on purpose, so it barely moves even when the mesh
      // improved everywhere else.
      if (r.aspectAfter > 0) {
        add("Rapport d'aspect moyen", `${r.aspectBefore.toFixed(2)} → ${r.aspectAfter.toFixed(2)}`,
            r.aspectAfter < r.aspectBefore ? "good" : "");
      }
      if (r.quads) add("Quads", `${fr(r.quads)} · ${(r.quadFraction * 100).toFixed(0)} %`, "good");
    } else {
      add("Cuisson", `${(r.millis / 1000).toFixed(2)} s`);
      add("Géométrie", "inchangée");
    }

    let atlas = [];
    if (r.charts) {
      const total = r.hits + r.misses;
      const miss = total ? (r.misses / total) * 100 : 0;
      atlas = [
        { label: "Îlots", value: fr(r.charts), tone: "" },
        { label: "Occupation", value: `${(r.utilisation * 100).toFixed(0)} %`,
          tone: r.utilisation > 0.6 ? "good" : "warn" },
        // A miss is a ray that fell back to the nearest surface point instead of
        // finding the high poly. A few are normal; a lot means the cage is too
        // tight for this pair of meshes.
        { label: "Rayons manqués", value: `${miss.toFixed(1)} %`,
          tone: miss > 15 ? "bad" : miss > 6 ? "warn" : "good" },
        { label: "Cartes", value: r.maps.join(", "), tone: "" },
      ];
    }

    const paint = (list) => list.map((x) =>
      `<div class="rt-stat ${x.tone}"><span>${x.label}</span><b>${x.value}</b></div>`).join("");

    el.report.innerHTML =
      `<div class="rt-stats">${paint(rows)}</div>` +
      (atlas.length
        ? `<p class="rt-stats-head">Atlas</p><div class="rt-stats">${paint(atlas)}</div>`
        : "");
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
  /**
   * Meshes every one of whose materials is hidden, so the export can leave them
   * out.
   *
   * Hiding swaps a material for one that writes neither colour nor depth, which
   * is right for looking but invisible to an exporter: the geometry is still
   * there and still gets written. So the meshes are marked not-visible for the
   * duration of the export and put back straight after.
   *
   * All or nothing per mesh. A mesh carrying four materials with one hidden
   * cannot be half exported without splitting its geometry, and splitting
   * geometry to honour a display toggle is a much bigger promise than this
   * control makes.
   */
  async function withScope(fn) {
    if (scope !== "visible") return fn();
    const hidden = new Set(
      (channels?.materials?.() || []).filter((m) => m.hidden).map((m) => m.uuid)
    );
    if (!hidden.size) return fn();

    const touched = [];
    viewer.root.traverse((o) => {
      if ((!o.isMesh && !o.isSkinnedMesh) || !o.visible) return;
      // The *original* materials, because the ones on the mesh right now may be
      // the channel view's stand-ins and carry different uuids.
      const source = channels?.original?.get(o) ?? o.material;
      const uuids = (Array.isArray(source) ? source : [source]).map((m) => m?.uuid);
      if (uuids.length && uuids.every((u) => u && hidden.has(u))) {
        touched.push(o);
        o.visible = false;
      }
    });
    try {
      // Awaited, not returned. `finally` around a returned promise runs before
      // the promise settles, so the meshes would come back visible while the
      // exporter was still walking the scene and the filter would do nothing.
      return await fn();
    } finally {
      for (const o of touched) o.visible = true;
    }
  }

  async function inputFor(dirs) {
    const p = sourcePath?.();
    // The fast path hands the engine the file on disk, which by definition
    // carries the whole model: a restricted run has to go through the exporter.
    if (isGltf(p) && scope === "all") return p;

    say("Export de la scène…", 0);
    // The group, not the object inside it: the orientation buttons and the edit
    // handles both write to the group.
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const glb = await withScope(() =>
      new GLTFExporter().parseAsync(viewer.root, {
        binary: true,
        includeCustomExtensions: true,
        // The default, said out loud because the whole scope control rests on
        // it: anything marked not-visible does not reach the file.
        onlyVisible: true,
      })
    );
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
          maxError: Number(el.maxError.value) / 1000,
          relaxStrength: Number(el.relaxStrength.value),
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
      // Anything ahead of the cursor is a branch nobody took; a new run replaces
      // it rather than leaving a redo that would jump to an unrelated result.
      history = history.slice(0, cursor + 1);
      history.push({ path: dirs.output, high: input, report: r });
      cursor = history.length - 1;
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
  for (const b of host.querySelectorAll("[data-scope]")) {
    b.addEventListener("click", () => {
      for (const o of host.querySelectorAll("[data-scope]")) o.classList.toggle("active", o === b);
      scope = b.dataset.scope;
      const hidden = (channels?.materials?.() || []).filter((m) => m.hidden).length;
      say2(scope === "visible"
        ? hidden
          ? `${hidden} matière${hidden > 1 ? "s" : ""} laissée${hidden > 1 ? "s" : ""} tranquille${hidden > 1 ? "s" : ""}`
          : "Aucune matière masquée : la portée ne change rien"
        : "Tout le modèle");
    });
  }

  el.undo.addEventListener("click", async () => {
    await step(-1);
    say2(cursor < 0 ? "Retour au modèle d'origine" : `Résultat ${cursor + 1} sur ${history.length}`);
  });
  el.redo.addEventListener("click", async () => {
    await step(1);
    say2(`Résultat ${cursor + 1} sur ${history.length}`);
  });

  el.devScale.addEventListener("input", syncDevScale);
  el.showCage.addEventListener("change", () => {
    syncCage();
    say2(el.showCage.checked
      ? cage ? "Cage affichée" : "La cage a besoin d'un résultat"
      : "Cage masquée");
  });
  el.cageOut.addEventListener("input", syncCage);

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
      // The layout outside this module has to know, because the library sizes
      // the viewport and a retopology cannot be judged in a preview strip.
      document.body.classList.add("retopo-open");
      borrowMatter();
      dressScene();
      onOpenChange?.(true);
      syncViewport();
      refresh();
      // After refresh, because the label on the run button changes its width and
      // therefore whether the bar wraps at all.
      requestAnimationFrame(measureBar);
    },
    hide() {
      open = false;
      host.classList.remove("open");
      returnMatter();
      document.body.classList.remove("retopo-open");
      onOpenChange?.(false);
    },
    toggle() {
      open ? api.hide() : api.show();
    },
    refresh,
  };
  return api;
}
