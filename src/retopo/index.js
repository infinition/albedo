import * as THREE from "three";
import { buildCage } from "./cage.js";
import { ICONS } from "./icons.js";
/*
 * No import of the overlay here.
 *
 * It is `src/viewer/wire.js` now, because it is a capability of the viewer and
 * not of this mode: the wireframe switch in the Vue pane drives the same shader.
 * The host hands over the one live set of uniforms, so this mode and that switch
 * cannot end up driving two different copies of the same state.
 */
import { selection } from "../selection.js";
import "./retopo.css";

/**
 * The Retopo mode.
 *
 * It used to own a panel: seven tabs of its own on the right edge, two of which
 * were Albedo's panes borrowed for the duration and put back on close. That gave
 * one model three competing navigations — the inspector's icon strip, this tab
 * row, and the icon bar over the viewport — and a tab strip nested inside a tab
 * strip wherever the two met.
 *
 * The cause was that panel visibility was tied to *modes* rather than to what is
 * being looked at. "Which materials are in this model" does not change according
 * to whether you are inspecting or decimating, so it does not deserve two
 * answers. Now there is one panel and one tab row for the whole application, and
 * a mode decides only three things: which tab opens first, which action bar
 * shows underneath, and whether the comparison curtain is live.
 *
 * What is left here is the mode itself: the engine's parameters in one pane of
 * that shared panel, the icon bar of shortcuts over the viewport, and the action
 * bar. The scene tree moved to `src/ui/tree.js`, the material numbers to the
 * Matière pane, and the view controls were always Albedo's own.
 *
 * This module, its stylesheet and the exporter it reaches for are one lazy
 * chunk. Nothing here is parsed until the mode is opened for the first time,
 * which matters more than usual: this executable is also the Explorer thumbnail
 * provider, one process per file.
 */

/**
 * The chrome this mode owns outright: the curtain and the action bar.
 *
 * There is no shortcut bar here any more. This mode used to put up a second one
 * in the same corner as Albedo's, hiding the first, and carrying its own Couleur,
 * its own Calques and a Caméra group that had lost Libre and Rotation continue
 * somewhere along the way. Two bars for one question, and the one the mode showed
 * was the poorer of the two.
 *
 * What that mode genuinely adds now goes into the slots of the shared bar, and
 * comes back out on close. See `BAR_*` below.
 */
const SHELL = `
<div class="rt-split" data-el="splitLine" hidden><i></i></div>

<div class="rt-bar" data-el="bar">
  <label class="rt-switch" title="Reprojeter les textures de la source sur le résultat">
    <input type="checkbox" data-el="bake" /><i></i><span>Projeter</span>
  </label>
  <button class="tb-i" type="button" data-el="undo" data-icon="undo" title="Annuler le dernier résultat" disabled></button>
  <button class="tb-i" type="button" data-el="redo" data-icon="redo" title="Refaire" disabled></button>
  <span class="rt-note" data-el="history"></span>
  <button class="wide" type="button" data-el="run">Décimer</button>
  <button class="wide" type="button" data-el="rebake" disabled
          title="Refaire seulement les cartes, sans retoucher la géométrie">Cuire</button>
  <span class="rt-note" data-el="note"></span>
  <button class="wide" type="button" data-el="close">Fermer</button>
  <div class="rt-progress"><i data-el="fill"></i></div>
</div>
`;

/*
 * What this mode lends the shared bar, by slot.
 *
 * Each of these is a handful of buttons that only make sense while a retopology
 * is on screen, and every one of them is genuinely new: nothing here duplicates
 * a control the bar already has. The wireframe, its light-or-dark flip, the
 * frame button and the five colour channels used to be repeated in this file and
 * are not any more; the bar's own are the ones that work now, and they work
 * whether the mode is open or not.
 *
 * They are written as markup rather than built node by node for the same reason
 * the rest of this file is: a template you can read as a layout beats fifteen
 * `createElement` calls you have to run in your head.
 */

/** Two data views, painted over the shaded render rather than replacing it. */
const BAR_COLOUR = `
  <button class="tb-i" type="button" data-colour="charts" data-icon="charts" data-el="btnCharts" disabled
          title="Îlots de l'atlas : une couleur par îlot d'UV"></button>
  <button class="tb-i" type="button" data-colour="deviation" data-icon="deviation" data-el="btnDeviation" disabled
          title="Écart au modèle d'origine : du bleu au rouge"></button>
`;

/** Two ways of looking through or at a surface, while judging its topology. */
const BAR_LAYERS = `
  <button class="tb-i tb-t" type="button" data-el="opaque" data-icon="opaque" aria-pressed="false"
          title="Forcer la surface opaque, pour que le fil de fer cesse de la traverser"></button>
  <button class="tb-i tb-t" type="button" data-el="xray" data-icon="xray" aria-pressed="false"
          title="Rayons X : voir la face arrière au travers de la proche"></button>
`;

/** A group of its own: what the viewport holds, source or result or both. */
const BAR_SCENE = `
<div class="tb-group">
  <span class="tb-label">Scène</span>
  <div class="tb-row">
    <div class="tb-plate" role="radiogroup" aria-label="Ce qui est dans la scène">
      <button class="tb-i" type="button" data-ab="source" data-icon="cmpSource" title="La source seule"></button>
      <button class="tb-i" type="button" data-ab="result" data-icon="cmpResult" title="Le résultat seul"></button>
      <button class="tb-i active" type="button" data-ab="both" data-icon="cmpBoth" title="Les deux dans la scène"></button>
      <button class="tb-i" type="button" data-ab="split" data-icon="cmpSplit" title="Rideau déplaçable : source à gauche, résultat à droite"></button>
      <button class="tb-i" type="button" data-ab="ghost" data-icon="cmpGhost" title="Fantôme : source en transparence sur le résultat"></button>
    </div>
    <button class="tb-i tb-t" type="button" data-el="peek" data-icon="peek" aria-pressed="false"
            title="Maintenir pour voir la source, relâcher pour le résultat (X)"></button>
  </div>
</div>
`;

/** The four numbers you check between every run. */
const BAR_HUD = `
<dl class="tb-counts" data-el="hud">
  <div><dt>Source</dt><dd data-el="hudSource">—</dd></div>
  <div><dt>Résultat</dt><dd data-el="hudResult">—</dd></div>
  <div><dt>Réduction</dt><dd data-el="hudCut">—</dd></div>
  <div><dt>Quads</dt><dd data-el="hudQuads">—</dd></div>
</dl>
`;

/**
 * The mode's own pane, in the shared panel.
 *
 * Sections stacked in one column, the way every other pane in this application
 * is built, rather than a second tab row inside a tab row.
 *
 * **Bilan comes first, and that ordering is load bearing.** This was one long
 * column once and it was wrong twice over: you had to scroll past the whole bake
 * to reach the result, and an error written at the bottom of it was invisible,
 * so a run that failed looked exactly like a button that did nothing. The report
 * is what you look at the instant a run ends, so it sits where the eye already
 * is — and it is not there at all until there is something to say, so an
 * untouched model opens on Méthode, which is where you would start anyway.
 */
const PANEL = `
<section data-el="resultSection" hidden>
  <h2>Bilan</h2>
  <p class="rt-hint rt-err" data-el="err" hidden></p>
  <div data-el="report"></div>
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
</section>

<section>
  <h2>Méthode</h2>
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
    <button class="seg" type="button" data-scope="visible" title="Seulement ce qui n'est pas masqué dans l'onglet Scène">Visible</button>
    <button class="seg" type="button" data-scope="picked" title="Seulement ce qui est sélectionné dans l'onglet Scène">Sélection</button>
  </div>
  <p class="rt-hint" data-el="scopeHint"></p>

  <p class="rt-sub">Quads</p>
  <label class="rt-check"><input type="checkbox" data-el="quads" /><span>Apparier les triangles en quads</span></label>
  <p class="rt-hint">glTF n'a pas de quads, donc l'appairage voyage à côté du
    fichier comme un masque de diagonale, un entier par triangle.</p>
</section>

<section>
  <h2>Nettoyage</h2>
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

<section>
  <h2>Cartes</h2>
  <p class="rt-hint">Le maillage réduit porte encore la disposition d'UV de
    l'original, et passé un certain point cette disposition ne décrit plus la
    surface sur laquelle elle est posée. L'interrupteur est dans la barre du
    bas, à côté du bouton dont il change le coût.</p>

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

<section>
  <h2>Atlas</h2>
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
  <p class="rt-hint" data-el="sourceNote"></p>
</section>
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
  channels,
  showPane,
  wire,
  // No `setWireframe`, `setWireDark` or `wireframeOn` any more: the buttons that
  // needed them belonged to a bar of this mode's own, and that bar is gone.
}) {
  const host = document.createElement("div");
  host.id = "retopo";
  host.innerHTML = SHELL;
  document.getElementById("app").appendChild(host);

  /*
   * The parameters go into the shared panel, beside Vue, Matière and the rest,
   * rather than into a panel of this mode's own. The pane and its tab button are
   * already in the page as empty shells; filling them is the only thing that
   * ever needed to be lazy.
   */
  const pane = document.getElementById("pane-retopo");
  pane.innerHTML = PANEL;
  const tab = document.querySelector('.tab[data-pane="retopo"]');

  /*
   * The groups this mode lends the shared bar.
   *
   * Built once, here, and then moved in and out of the bar as the mode opens and
   * closes. Built rather than rebuilt because the buttons carry state -- which
   * data view is showing, whether the x-ray is on -- and a fresh set of nodes on
   * every open would be a fresh set of listeners on every open and a bar that
   * forgot what it was doing every time you left it for a second.
   *
   * `held` is where they wait while the mode is shut. It is never in the
   * document, so nothing in it is painted, measured or clickable, and the `el`
   * map below can still find every one of them.
   */
  const bar = document.getElementById("viewbar");
  const plate = document.getElementById("vb-colour");
  const held = document.createElement("div");
  /** @type {{parent: Element, node: Element, before: Element|null}[]} */
  const lent = [];

  const lend = (parent, html, before = null) => {
    if (!parent) return;
    const box = document.createElement("template");
    box.innerHTML = html.trim();
    for (const node of [...box.content.children]) {
      lent.push({ parent, node, before });
      held.appendChild(node);
    }
  };

  lend(plate, BAR_COLOUR);
  lend(document.getElementById("vb-layers"), BAR_LAYERS);
  // Before Caméra, so the two groups that say *what* is on screen stay together
  // and the two that say *how you are looking at it* stay together after them.
  lend(bar, BAR_SCENE, document.getElementById("vb-camera")?.closest(".tb-group"));
  lend(bar, BAR_HUD);

  // Three roots, one map. Nothing is named twice across them, and a lookup that
  // silently found nothing is what the static audit exists to catch.
  const el = {};
  for (const root of [host, pane, held]) {
    for (const node of root.querySelectorAll("[data-el]")) el[node.dataset.el] = node;
  }

  // The icons are set from the map rather than written inline in the template,
  // so the same glyph cannot end up drawn two slightly different ways in two
  // places, and so the template stays readable as a layout.
  for (const root of [host, held]) {
    for (const node of root.querySelectorAll("[data-icon]")) {
      node.innerHTML = ICONS[node.dataset.icon] || "";
    }
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

  /** The host's uniforms, shared by every patched material in the application. */
  const wireU = wire.uniforms;
  const { setSide } = wire;
  const applyWire = (object, _u, mask, charts, dev) => wire.apply(object, mask, charts, dev);
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
    // Also a loop, and for the same reason: deviation is one float per vertex,
    // so spreading it hands `Math.max` an argument per vertex of the result.
    devMax = 0;
    if (dev) {
      for (let i = 0; i < dev.length; i++) {
        if (dev[i] > devMax) devMax = dev[i];
      }
    }
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

  /**
   * Show one of this mode's two data views.
   *
   * Not a channel, and the difference matters to everything below: a data view is
   * painted by the shared shader *over* the render, so the channel underneath
   * stays on the plain shaded one rather than on a UV checker that would show
   * through nothing. Albedo's Couleur group has no way to express that, which is
   * why the plate is told, in `data-view`, which of the two is showing. It reads
   * that back when it repaints and lights the right button; clearing the
   * attribute is how a real channel takes the plate back.
   */
  function setColour(name) {
    plate.dataset.view = name;
    for (const o of plate.children) o.classList.toggle("active", o.dataset.colour === name);
    wireU.uView.value = COLOUR_VIEWS[name] || 0;
    applyChannel?.("shaded");
    viewer.invalidate?.();
    say2(LABELS[name] || name);
  }

  for (const b of held.querySelectorAll("[data-colour]")) {
    b.addEventListener("click", () => setColour(b.dataset.colour));
  }

  /*
   * A channel picked anywhere leaves the data view, wherever it was picked.
   *
   * Two places can pick one: the Vue pane's grid of eleven, and the Couleur
   * group of the shared bar. Both are Albedo's and neither knows this mode
   * exists, which is the right way round given that this module is fetched on
   * demand and they are not. So this listens to both rather than asking either to
   * call in, and the only state it has to put back is its own: the shader
   * uniform, and the attribute that tells the plate a data view is showing.
   *
   * Albedo repaints the plate itself, from `applyChannel`, on a microtask -- so
   * after this has run, whichever order the listeners happen to fire in.
   */
  const leaveDataView = (e) => {
    if (e.target.closest("[data-colour]")) return;
    delete plate.dataset.view;
    wireU.uView.value = 0;
    viewer.invalidate?.();
  };
  document.getElementById("channels")?.addEventListener("click", leaveDataView);
  plate.addEventListener("click", leaveDataView);

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

  /*
   * There is no wire button here, and no light-or-dark flip beside it.
   *
   * This mode used to carry a pair that forwarded to the application's one
   * wireframe and then read its own state back through `onWireframe`. All that
   * relaying existed only because the bar it sat in was a different bar. The
   * shared one has both buttons, driving the same `setWireframe`, and they work
   * whether this mode is open or not -- which is what the relay was pretending to
   * achieve.
   */
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

  /*
   * Flat shading had a second listener here, identical to the one above, and the
   * two cancelled each other out exactly.
   *
   * Both fired on one click: the first read `aria-pressed`, found false, turned
   * flat shading on and wrote true; the second read the attribute the first had
   * just written, concluded the button was being turned off, and put everything
   * back. Net effect of pressing it: nothing at all, with no error anywhere. The
   * one that remains is the one with the toast, above.
   *
   * There is no Recadrer button here either. The shared bar has it, in the Caméra
   * group beside Libre and Rotation continue, which is where someone looks for it
   * whether or not this mode happens to be open.
   */

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

  /**
   * Put the curtain line exactly over the cut the shader draws.
   *
   * The cut is a fraction across the canvas, while the line is positioned in
   * its own box, `#retopo`, which spans the whole app. The two diverge the
   * moment the library takes half the screen and the canvas stops at it, so the
   * line is placed in pixels, translated from the canvas box into its own.
   */
  function paintSplit() {
    const c = viewer.renderer?.domElement;
    const box = el.splitLine.offsetParent?.getBoundingClientRect();
    if (!c || !box) return;
    const r = c.getBoundingClientRect();
    const t = wireU.uSplit.value;
    el.splitLine.style.left = `${r.left - box.left + t * r.width}px`;
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
    if (mode === "split") paintSplit();

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

  // The comparison group lives in `held` until the mode opens, then moves to
  // the shared bar as the same nodes. Listeners go on while they are in `held`;
  // the active highlight re-finds them in `bar`, where they are at click time.
  // Querying `host` for either found nothing at all, which is how a row of
  // buttons that did nothing used to ship.
  for (const b of held.querySelectorAll("[data-ab]")) {
    b.addEventListener("click", () => {
      for (const o of bar.querySelectorAll("[data-ab]")) o.classList.toggle("active", o === b);
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
      const r = viewer.renderer?.domElement.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(r.width, 1)));
      wireU.uSplit.value = t;
      paintSplit();
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
   * Peek at the source: hold to see before, release to see the result.
   *
   * The gesture every retopology tool has, on a button and on a key (X): no
   * planning, hold, judge, release. It only means something when there is a
   * result to compare, and it hands the mode back exactly what it found.
   */
  let peekPrev = null;
  function peekAb() {
    const parts = viewer.parts || [];
    if (peekPrev !== null || parts.length < 2) return;
    peekPrev = compareMode;
    setAB("source");
    el.peek.setAttribute("aria-pressed", "true");
    el.peek.classList.add("active");
  }
  function unpeekAb() {
    if (peekPrev === null) return;
    setAB(peekPrev);
    peekPrev = null;
    el.peek.setAttribute("aria-pressed", "false");
    el.peek.classList.remove("active");
  }
  el.peek.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    peekAb();
  });
  window.addEventListener("pointerup", unpeekAb);
  window.addEventListener("pointercancel", unpeekAb);
  window.addEventListener("keydown", (e) => {
    if (open && e.code === "KeyX" && !e.repeat) peekAb();
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "KeyX") unpeekAb();
  });

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
    // On the document root rather than on the host, because the reader is now
    // `#inspector`, which is not a descendant of this mode's host: a custom
    // property set on the host would never reach it.
    if (h > 0) document.documentElement.style.setProperty("--rt-bar-h", `${h}px`);
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
  window.addEventListener("resize", () => {
    syncViewport();
    paintSplit();
  });

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
  /**
   * Mark what this mode put in the scene.
   *
   * A flag on the object rather than "the last part", which is what this used to
   * mean and what made it fragile: importing anything by hand between two runs
   * moved the target, and the run would drop the user's own object instead of
   * its own output.
   */
  function claimResult(object) {
    if (object) object.userData.retopoResult = true;
  }

  /** Every part this mode put in the scene, newest last. */
  const results = () => (viewer.parts || []).filter((p) => p.object?.userData?.retopoResult);

  /** Drop the result currently in the scene, if there is one. */
  function dropResult() {
    const mine = results();
    if (!mine.length) return;
    // All of them, not the last one. A stacked result is a bug this function is
    // also the repair for, so it must not leave one behind.
    for (const part of mine) viewer.removePart(part);
    cage?.dispose();
    cage = null;
    // The channels were holding the result's real materials on its behalf while
    // a stand-in was on it, and `removePart` frees only what is attached. Said
    // here rather than only at the next import, because undoing back past the
    // first run drops a result and imports nothing after it.
    channels?.absorb?.();
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
      claimResult(viewer.parts.at(-1)?.object);
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
    showReport();
  }

  /**
   * Bring the report forward.
   *
   * The section is absent until there is something in it, so an untouched model
   * opens the pane on Méthode, which is where anyone would start. Once a run has
   * happened it is the first thing in the column, because it is the first thing
   * you look at, and it takes the pane with it: a result written into a panel
   * showing another subject is a result nobody reads.
   */
  function showReport() {
    el.resultSection.hidden = false;
    showPane?.("retopo");
    el.resultSection.scrollIntoView({ block: "nearest" });
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
   * nothing. Now it goes to the bar, to a toast, to its own line at the top of
   * the Bilan block, to that block being brought forward, and to the console.
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
    showReport();
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
    /*
     * The mode's own output never goes back into the mode's own input.
     *
     * The export walks the whole scene, and a previous result is in that scene:
     * decimating twice fed the engine the source *and* the low poly made from
     * it, so the second run's "input triangles" counted a mesh the user never
     * put there. Invisible to the glTF fast path, which reads the file on disk,
     * and therefore invisible on exactly the formats that get tested most.
     *
     * Marked not-visible for the length of the export, like everything else the
     * scope leaves out, and put straight back after.
     */
    const mine = [];
    for (const part of results()) {
      part.object.traverse((o) => {
        if ((o.isMesh || o.isSkinnedMesh) && o.visible) {
          mine.push(o);
          o.visible = false;
        }
      });
    }
    const restore = () => {
      for (const o of mine) o.visible = true;
    };

    if (scope === "all") {
      try {
        return await fn();
      } finally {
        restore();
      }
    }

    /*
     * Which meshes the exporter is allowed to see.
     *
     * Two ways of saying it, and they answer different questions. **Visible**
     * means "leave alone what I have hidden", which is subtractive and suits a
     * model you have been pruning. **Selection** means "touch only this", which
     * is additive and suits a model where you know exactly which part you want.
     * Both end in the same place: a set of meshes marked not-visible for the
     * length of the export and put straight back after.
     */
    const keep = (o) => {
      const source = channels?.original?.get(o) ?? o.material;
      const mats = (Array.isArray(source) ? source : [source]).filter(Boolean);
      if (scope === "picked") {
        return selection.has(o.uuid) || mats.some((m) => selection.has(m.uuid));
      }
      const hidden = new Set(
        (channels?.materials?.() || []).filter((m) => m.hidden).map((m) => m.uuid)
      );
      // All or nothing per mesh: one carrying four materials with a single one
      // hidden cannot be half exported without splitting its geometry.
      return !mats.length || !mats.every((m) => hidden.has(m.uuid));
    };

    const touched = [];
    if (scope !== "picked" || selection.size) {
      viewer.root.traverse((o) => {
        if ((!o.isMesh && !o.isSkinnedMesh) || !o.visible) return;
        if (!keep(o)) {
          touched.push(o);
          o.visible = false;
        }
      });
    }
    try {
      // Awaited, not returned. `finally` around a returned promise runs before
      // the promise settles, so the meshes would come back visible while the
      // exporter was still walking the scene and the filter would do nothing.
      return await fn();
    } finally {
      for (const o of touched) o.visible = true;
      restore();
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
      // The previous result leaves before the new one arrives. Without this a
      // second run stacked a second low poly on the first, so the scene held
      // three meshes claiming to be two and every count above was a lie.
      dropResult();
      await importPart(dirs.output);
      claimResult(viewer.parts.at(-1)?.object);
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
      /*
       * A bake replaces the result; it does not add one.
       *
       * Baking does not touch the geometry — that is the whole reason it exists
       * as its own button — so a bake that left the previous mesh in the scene
       * put two identical low polys on top of each other, differing only in
       * their textures. Same reason the history entry is *rewritten* rather than
       * pushed: undo walks geometry, and a bake is not a step in that walk. It
       * would otherwise take two undos to get back one decimation.
       */
      dropResult();
      await importPart(dirs.rebake);
      claimResult(viewer.parts.at(-1)?.object);
      lastRun = { high: lastRun.high, low: dirs.rebake };
      if (cursor >= 0) history[cursor] = { ...history[cursor], path: dirs.rebake };
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
  /*
   * What the chosen scope currently amounts to, written down rather than
   * announced once and gone.
   *
   * It used to be a toast fired on the click, which is the wrong place for it:
   * the selection and the hiding both live in another tab now, so the number
   * this control depends on moves while you are not looking at this control. A
   * line under the segment that follows both is the only version that cannot be
   * out of date.
   */
  function paintScope() {
    const hidden = (channels?.materials?.() || []).filter((m) => m.hidden).length;
    const n = selection.size;
    el.scopeHint.textContent =
      scope === "picked"
        ? n
          ? `${n} élément${n > 1 ? "s" : ""} sélectionné${n > 1 ? "s" : ""} dans l'onglet Scène.`
          : "Rien de sélectionné dans l'onglet Scène : la portée ne change rien."
        : scope === "visible"
          ? hidden
            ? `${hidden} matière${hidden > 1 ? "s" : ""} masquée${hidden > 1 ? "s" : ""}, laissée${hidden > 1 ? "s" : ""} tranquille.`
            : "Aucune matière masquée : la portée ne change rien."
          : "Tout le modèle, sans exception.";
  }

  for (const b of pane.querySelectorAll("[data-scope]")) {
    b.addEventListener("click", () => {
      for (const o of pane.querySelectorAll("[data-scope]")) o.classList.toggle("active", o === b);
      scope = b.dataset.scope;
      paintScope();
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
  paintScope();

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
      // The tab exists only while the mode does. A tab that opens a pane full of
      // controls driving a mode that is shut is a tab that lies.
      if (tab) tab.hidden = false;
      // The bar gets its extra groups back, each in the slot it was written for.
      for (const { parent, node, before } of lent) {
        parent.insertBefore(node, before && before.parentNode === parent ? before : null);
      }
      dressScene();
      paintScope();
      /*
       * Put the comparison back after every channel switch.
       *
       * Which side of the curtain an object draws on is a uniform carried by
       * its material, and a channel replaces every material in the scene with a
       * stand-in that has never been told. The cut then reads zero on both
       * halves, so source and result each draw everywhere and the split looks
       * like one mesh laid over another. `setAB` is the whole answer and it is
       * idempotent, so re-running it is exactly the repair.
       *
       * Registered here and dropped in `hide`, so a viewer that never opens the
       * mode never pays for it.
       */
      if (channels) channels.afterApply = () => setAB(compareMode);
      // And once now, because reopening the mode has to find the comparison it
      // was left on rather than a bar claiming a curtain that is not cutting.
      setAB(compareMode);
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
      document.body.classList.remove("retopo-open");
      if (tab) tab.hidden = true;
      if (channels) channels.afterApply = null;
      /*
       * The cut outlives this mode's chrome, so it has to be lifted by hand.
       *
       * `uSide` is on the materials and the materials stay on the meshes when
       * the bar goes away. Closing on the curtain therefore left half the model
       * discarded in a viewer that has no line, no A/B buttons and nothing at
       * all to say why. `compareMode` is deliberately not touched: it is what
       * the mode reopens on.
       */
      for (const p of viewer.parts || []) {
        p.object.visible = true;
        setSide(p.object, 0);
      }
      unghost();
      el.splitLine.hidden = true;
      viewer.invalidate?.();
      /*
       * The lent groups come back out, and the data view goes with them.
       *
       * Leaving the attribute behind would leave the plate looking for a button
       * that is no longer in it, so it would light nothing at all and the channel
       * that is actually on would show as unselected.
       */
      if (plate.dataset.view) {
        delete plate.dataset.view;
        wireU.uView.value = 0;
        applyChannel?.("shaded");
      }
      for (const { node } of lent) held.appendChild(node);
      onOpenChange?.(false);
    },
    toggle() {
      open ? api.hide() : api.show();
    },
    refresh,
    /**
     * The history belongs to a document, not to the mode.
     *
     * It holds paths to files produced from one particular model, so carrying it
     * across a tab switch would offer an undo that swaps in a low poly of
     * something else entirely. Handed out when a tab is parked and handed back
     * when it returns, so each model keeps its own runs.
     */
    saveState() {
      return { history, cursor, last, lastRun, hasQuads, devMax };
    },
    loadState(state) {
      history = state?.history || [];
      cursor = state?.cursor ?? -1;
      last = state?.last || null;
      lastRun = state?.lastRun || null;
      hasQuads = state?.hasQuads || false;
      devMax = state?.devMax || 0;
      wireU.uQuads.value = hasQuads ? 1 : 0;
      cage?.dispose();
      cage = null;
      el.err.hidden = true;
      el.report.textContent = "";
      el.resultSection.hidden = true;
      paintHistory();
      refresh();
    },
    /** The shared selection moved: only the scope line depends on it. */
    onSelection: paintScope,
    /**
     * The one wireframe changed, from wherever.
     *
     * Nothing to do here any more: the buttons that show it belong to the shared
     * bar, and Albedo paints them from `paintViewbar` whether this mode is open
     * or not. Kept as a no-op because the host calls it on every wireframe
     * change and a missing method would be a throw on a hot path, and because
     * dropping it would make it look as though the mode had stopped caring.
     */
    onWireframe() {},
  };
  return api;
}
