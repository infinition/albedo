import * as THREE from "three";
import { buildCage } from "./cage.js";
import { createPainting } from "./paint.js";
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
import {
  byUuid,
  highPolyOf,
  lowPolyOf,
  nameResult,
  restoreIdentity,
  snapshotIdentity,
  supersededBy,
} from "../naming.js";
import { applyStaticIn, num, register, t } from "../i18n/index.js";
import { isPressed, setPressed } from "../ui/toggle.js";
import rtFr from "./fr.json";
import rtEn from "./en.json";
import "./retopo.css";

/*
 * This mode's strings live with this mode.
 *
 * Static imports, so they are part of this chunk and not of the startup one:
 * the two dictionaries in `src/i18n` are loaded before the window exists, and
 * putting a hundred and thirty seven retopology keys in them was sixteen
 * kilobytes parsed by every Explorer thumbnail job. Registered at module scope
 * so the first `t()` below already has them.
 */
register({ fr: rtFr, en: rtEn });

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
 * bar. The scene tree moved to `src/ui/outliner.js`, where it grew to hold the
 * lights, the stand and the backdrops too; the material numbers went to the
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
  <button class="tb-i rt-menu-toggle" type="button" data-el="menuToggle" aria-pressed="false"
          data-i18n-title="rt.menuTitle" title="Réglages de décimation et de projection">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10l5-5 5 5"/></svg>
  </button>
  <label class="rt-switch" data-i18n-title="rt.projectTitle" title="Reprojeter les textures de la source sur le résultat">
    <input type="checkbox" data-el="bake" /><i></i><span data-i18n="rt.project">Projeter</span>
  </label>
  <button class="tb-i" type="button" data-el="undo" data-icon="undo" data-i18n-title="rt.undo" title="Annuler le dernier résultat" disabled></button>
  <button class="tb-i" type="button" data-el="redo" data-icon="redo" data-i18n-title="rt.redo" title="Refaire" disabled></button>
  <span class="rt-note" data-el="history"></span>
  <button class="wide" type="button" data-el="run">Décimer</button>
  <button class="wide" type="button" data-el="rebake" data-i18n="rt.bake" disabled>Bake</button>
  <span class="rt-note" data-el="note"></span>
  <button class="wide" type="button" data-el="close" data-i18n="rt.close">Fermer</button>
  <div class="rt-progress"><i data-el="fill"></i></div>

  <div class="rt-menu" data-el="menu" hidden>
    <div class="rt-menu-tabs">
      <button class="seg active" type="button" data-mtab="remesh" data-i18n="rt.menuRemesh">Remesh</button>
      <button class="seg" type="button" data-mtab="bake" data-i18n="rt.menuBake">Bake</button>
      <button class="seg" type="button" data-mtab="paint" data-i18n="rt.menuPaint">Peinture</button>
    </div>

    <div data-mtabpane="remesh">
      <!--
        The two methods, as one control with two positions rather than two
        buttons side by side. They are exclusive — a run either simplifies the
        mesh it has or builds a new one — and a plain row of buttons said
        nothing about that. The tab above them used to be called "Remesh", which
        is the name of one of the two things inside it: a heading that competes
        with its own contents.
      -->
      <p class="rt-sub" data-i18n="rt.method">Méthode — choisis l'une des deux</p>
      <div class="segment" role="group" data-i18n-aria="rt.method" aria-label="Méthode">
        <button class="seg" type="button" data-el="mmDecimate" data-i18n="rt.decimate">Décimer</button>
        <button class="seg" type="button" data-el="mmIsotropic" data-i18n="rt.rebuild">Reconstruire</button>
      </div>
      <label class="rt-field">
        <span><span data-i18n="rt.triangles">Triangles</span> <span class="rt-num" data-el="mTargetValue">—</span></span>
        <input type="range" data-el="mTarget" min="1" max="90" step="1" value="10" />
      </label>
      <label class="rt-field">
        <span><span data-i18n="rt.maxDeviation">Déviation max</span> <span class="rt-num" data-el="mMaxErrorValue">—</span></span>
        <input type="range" data-el="mMaxError" min="0" max="50" step="1" value="0" />
      </label>
      <div class="rt-menu-row">
        <button class="seg" type="button" data-mscope="all" data-i18n="rt.scopeAll">Tout</button>
        <button class="seg" type="button" data-mscope="visible" data-i18n="rt.scopeVisible">Visible</button>
        <button class="seg active" type="button" data-mscope="picked" data-i18n="rt.scopePicked">Sélection</button>
      </div>
      <label class="rt-check"><input type="checkbox" data-el="mQuads" /><span data-i18n="rt.pairQuads">Apparier en quads</span></label>
      <label class="rt-check"><input type="checkbox" data-el="mHoles" /><span data-i18n="rt.fillHoles">Combler les trous</span></label>
      <label class="rt-check"><input type="checkbox" data-el="mBoundary" /><span data-i18n="rt.pinBoundary">Épingler les bords</span></label>
      <label class="rt-field">
        <span><span data-i18n="rt.creaseAngle">Angle de pli</span> <span class="rt-num" data-el="mAngleValue">—</span></span>
        <input type="range" data-el="mAngle" min="5" max="90" step="1" value="40" />
      </label>
      <label class="rt-field">
        <span><span data-i18n="rt.seamCost">Coût d'une couture</span> <span class="rt-num" data-el="mSeamValue">—</span></span>
        <input type="range" data-el="mSeam" min="0" max="20" step="1" value="4" />
      </label>
      <label class="rt-field">
        <span><span data-i18n="rt.passes">Passes</span> <span class="rt-num" data-el="mRelaxValue">—</span></span>
        <input type="range" data-el="mRelax" min="0" max="10" step="1" value="0" />
      </label>
      <label class="rt-field">
        <span><span data-i18n="rt.strength">Force</span> <span class="rt-num" data-el="mRelaxStrengthValue">—</span></span>
        <input type="range" data-el="mRelaxStrength" min="0.05" max="1" step="0.05" value="0.5" />
      </label>
      <label class="rt-field">
        <span><span data-i18n="rt.smoothAngle">Angle du lissage</span> <span class="rt-num" data-el="mRelaxAngleValue">—</span></span>
        <input type="range" data-el="mRelaxAngle" min="20" max="150" step="5" value="75" />
      </label>
    </div>

    <div data-mtabpane="paint" hidden>
      <!--
        The brush lives here rather than in the panel, for the same reason every
        other setting does: a brush size only means something while you are
        watching the ring it draws on the model, and the panel is on the far side
        of the screen from the model.
      -->
      <p class="rt-sub" data-i18n="rt.brush">Pinceau</p>
      <label class="rt-field">
        <span><span data-i18n="rt.brushSize">Taille</span> <span class="rt-num" data-el="pSizeValue">—</span></span>
        <input type="range" data-el="pSize" min="0.5" max="35" step="0.5" value="6" />
      </label>
      <label class="rt-field">
        <span><span data-i18n="rt.brushStrength">Force</span> <span class="rt-num" data-el="pStrengthValue">—</span></span>
        <input type="range" data-el="pStrength" min="0.05" max="1" step="0.05" value="0.6" />
      </label>
      <label class="rt-field">
        <span><span data-i18n="rt.brushHardness">Dureté</span> <span class="rt-num" data-el="pHardnessValue">—</span></span>
        <input type="range" data-el="pHardness" min="0" max="1" step="0.05" value="0.25" />
      </label>
      <p class="rt-hint" data-i18n="rt.brushHint">Maj + molette change la taille sans quitter le modèle
        des yeux. Alt, le bouton du stylet ou la gomme inversent le trait.</p>

      <p class="rt-sub" data-i18n="rt.pen">Stylet</p>
      <label class="rt-check"><input type="checkbox" data-el="pPressureSize" checked /><span data-i18n="rt.pressureSize">La pression change la taille</span></label>
      <label class="rt-check"><input type="checkbox" data-el="pPressureStrength" checked /><span data-i18n="rt.pressureStrength">La pression change la force</span></label>

      <p class="rt-sub" data-i18n="rt.guideKind">Guide</p>
      <div class="segment" role="group" data-i18n-aria="rt.guideKind" aria-label="Guide">
        <button class="seg active" type="button" data-guide="crease" data-i18n="rt.guideCrease">Pli</button>
        <button class="seg" type="button" data-guide="flow" data-i18n="rt.guideFlow">Flux</button>
      </div>
      <p class="rt-hint" data-i18n="rt.guideHint">Un pli est une promesse : le résultat aura encore une
        arête là. Un flux dit dans quel sens les boucles doivent courir, donc
        les arêtes qui le suivent sont gardées et celles qui le traversent sont
        celles qu'on dépense.</p>

      <p class="rt-sub" data-i18n="rt.influence">Ce que le moteur en fait</p>
      <label class="rt-field">
        <span><span data-i18n="rt.densityInfluence">Poids de la densité</span> <span class="rt-num" data-el="pDensityValue">—</span></span>
        <input type="range" data-el="pDensity" min="0" max="1" step="0.05" value="0.75" />
      </label>
      <label class="rt-field">
        <span><span data-i18n="rt.flowInfluence">Poids du flux</span> <span class="rt-num" data-el="pFlowValue">—</span></span>
        <input type="range" data-el="pFlow" min="0" max="1" step="0.05" value="0.5" />
      </label>
      <label class="rt-check"><input type="checkbox" data-el="pUse" checked /><span data-i18n="rt.usePaint">Lire la peinture au prochain calcul</span></label>
      <p class="rt-hint" data-i18n="rt.usePaintHint">Décoché, le calcul ignore tout ce qui est peint sans
        l'effacer : c'est la seule façon de voir ce que la peinture a vraiment
        changé, en comparant deux résultats plutôt qu'un résultat et un souvenir.</p>

      <div class="rt-menu-row">
        <button class="seg" type="button" data-pclear="density" data-i18n="rt.clearDensity">Densité</button>
        <button class="seg" type="button" data-pclear="freeze" data-i18n="rt.clearFreeze">Gel</button>
        <button class="seg" type="button" data-pclear="region" data-i18n="rt.clearRegion">Zone</button>
        <button class="seg" type="button" data-pclear="guides" data-i18n="rt.clearGuides">Guides</button>
      </div>
    </div>

    <div data-mtabpane="bake" hidden>
      <label class="rt-field">
        <span><span data-i18n="rt.atlasSize">Taille de l'atlas</span> <span class="rt-num" data-el="mMapSizeValue">—</span></span>
        <input type="range" data-el="mMapSize" min="8" max="13" step="1" value="11" />
      </label>
      <label class="rt-check"><input type="checkbox" data-el="mmMR" /><span data-i18n="rt.metalRough">Métal et rugosité</span></label>
      <label class="rt-check"><input type="checkbox" data-el="mmNormal" /><span data-i18n="rt.normalMap">Normale</span></label>
      <label class="rt-check"><input type="checkbox" data-el="mmEmissive" /><span data-i18n="rt.emissive">Émissif</span></label>
      <label class="rt-check"><input type="checkbox" data-el="mmAo" /><span data-i18n="rt.ao">Occlusion ambiante</span></label>
      <label class="rt-field">
        <span><span data-i18n="rt.raysPerTexel">Rayons par texel</span> <span class="rt-num" data-el="mAoSamplesValue">—</span></span>
        <input type="range" data-el="mAoSamples" min="4" max="128" step="4" value="16" />
      </label>
      <label class="rt-field">
        <span><span data-i18n="rt.aoDistance">Portée de l'occlusion</span> <span class="rt-num" data-el="mAoDistanceValue">—</span></span>
        <input type="range" data-el="mAoDistance" min="0.01" max="1" step="0.01" value="0.15" />
      </label>
      <label class="rt-check"><input type="checkbox" data-el="mShowCage" /><span data-i18n="rt.drawCage">Dessiner la cage</span></label>
      <label class="rt-field">
        <span><span data-i18n="rt.cageOut">Vers l'extérieur</span> <span class="rt-num" data-el="mCageOutValue">—</span></span>
        <input type="range" data-el="mCageOut" min="0.001" max="0.2" step="0.001" value="0.02" />
      </label>
      <label class="rt-field">
        <span><span data-i18n="rt.cageIn">Vers l'intérieur</span> <span class="rt-num" data-el="mCageInValue">—</span></span>
        <input type="range" data-el="mCageIn" min="0.001" max="0.2" step="0.001" value="0.02" />
      </label>
      <label class="rt-field">
        <span><span data-i18n="rt.gutter">Écart entre îlots</span> <span class="rt-num" data-el="mGutterValue">—</span></span>
        <input type="range" data-el="mGutter" min="0" max="32" step="1" value="4" />
      </label>
      <label class="rt-field">
        <span><span data-i18n="rt.bleed">Bavure hors des îlots</span> <span class="rt-num" data-el="mBleedValue">—</span></span>
        <input type="range" data-el="mBleed" min="0" max="32" step="1" value="8" />
      </label>
      <label class="rt-field">
        <span><span data-i18n="rt.islandAngle">Angle de rupture d'îlot</span> <span class="rt-num" data-el="mIslandValue">—</span></span>
        <input type="range" data-el="mIsland" min="10" max="120" step="1" value="50" />
      </label>
    </div>
  </div>
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
          data-i18n-title="rt.chartsTitle" title="Îlots de l'atlas : une couleur par îlot d'UV"></button>
  <button class="tb-i" type="button" data-colour="deviation" data-icon="deviation" data-el="btnDeviation" disabled
          data-i18n-title="rt.deviationTitle" title="Écart au modèle d'origine : du bleu au rouge"></button>
`;

/** Two ways of looking through or at a surface, while judging its topology. */
const BAR_LAYERS = `
  <button class="tb-i tb-t" type="button" data-el="opaque" data-icon="opaque" aria-pressed="false"
          data-i18n-title="rt.opaqueTitle" title="Forcer la surface opaque, pour que le fil de fer cesse de la traverser"></button>
  <button class="tb-i tb-t" type="button" data-el="xray" data-icon="xray" aria-pressed="false"
          data-i18n-title="rt.xrayTitle" title="Rayons X : voir la face arrière au travers de la proche"></button>
`;

/** A group of its own: what the viewport holds, source or result or both. */
const BAR_SCENE = `
<div class="tb-group">
  <span class="tb-label" data-i18n="rt.scene">Scène</span>
  <div class="tb-row">
    <div class="tb-plate" role="radiogroup" data-i18n-aria="rt.sceneAria" aria-label="Ce qui est dans la scène">
      <button class="tb-i" type="button" data-ab="source" data-icon="cmpSource" data-i18n-title="rt.abSource" title="La source seule"></button>
      <button class="tb-i" type="button" data-ab="result" data-icon="cmpResult" data-i18n-title="rt.abResult" title="Le résultat seul"></button>
      <button class="tb-i active" type="button" data-ab="both" data-icon="cmpBoth" data-i18n-title="rt.abBoth" title="Les deux dans la scène"></button>
      <button class="tb-i" type="button" data-ab="split" data-icon="cmpSplit" data-i18n-title="rt.abSplit" title="Rideau déplaçable : source à gauche, résultat à droite"></button>
      <button class="tb-i" type="button" data-ab="ghost" data-icon="cmpGhost" data-i18n-title="rt.abGhost" title="Fantôme : source en transparence sur le résultat"></button>
      <button class="tb-i" type="button" data-ab="none" data-icon="cmpNone" data-i18n-title="rt.abNoneTitle" title="Rien : masquer la source et le résultat"></button>
    </div>
    <button class="tb-i tb-t" type="button" data-el="peek" data-icon="peek" aria-pressed="false"
            data-i18n-title="rt.peekTitle" title="Maintenir pour voir la source, relâcher pour le résultat (X)"></button>
  </div>
</div>
`;

/**
 * The brushes, and what they leave on the model.
 *
 * A group of its own beside Scène, because it answers a different question from
 * every other group in the bar: not "how am I looking at this" but "what am I
 * telling the engine about it". The tools are a radio plate for the same reason
 * the A/B modes are — only one hand is on the pen at a time — and the first
 * position is *no brush*, which is what makes the pointer the camera's again
 * without hunting for the tool you last used to switch it off.
 */
const BAR_PAINT = `
<div class="tb-group">
  <span class="tb-label" data-i18n="rt.paintGroup">Peindre</span>
  <div class="tb-row">
    <div class="tb-plate" role="radiogroup" data-i18n-aria="rt.paintAria" aria-label="Ce que le stylet peint">
      <button class="tb-i active" type="button" data-tool="" data-icon="brushOff"
              data-i18n-title="rt.toolOff" title="Aucun pinceau : le pointeur tourne la caméra"></button>
      <button class="tb-i" type="button" data-tool="density" data-icon="brushDensity"
              data-i18n-title="rt.toolDensity" title="Densité : où les triangles valent la peine (Alt inverse)"></button>
      <button class="tb-i" type="button" data-tool="freeze" data-icon="brushFreeze"
              data-i18n-title="rt.toolFreeze" title="Geler : ne jamais toucher à ça"></button>
      <button class="tb-i" type="button" data-tool="region" data-icon="brushRegion"
              data-i18n-title="rt.toolRegion" title="Zone : la seule partie que ce calcul a le droit de modifier"></button>
      <button class="tb-i" type="button" data-tool="guide" data-icon="brushGuide"
              data-i18n-title="rt.toolGuide" title="Guide : tracer un pli ou un sens de boucles sur la surface"></button>
    </div>
    <button class="tb-i tb-t" type="button" data-el="paintView" data-icon="paintView" aria-pressed="true"
            data-i18n-title="rt.paintViewTitle" title="Montrer ce qui est peint"></button>
    <button class="tb-i" type="button" data-el="paintUndo" data-icon="undo"
            data-i18n-title="rt.paintUndo" title="Annuler le dernier trait" disabled></button>
    <button class="tb-i" type="button" data-el="paintRedo" data-icon="redo"
            data-i18n-title="rt.paintRedo" title="Refaire le trait" disabled></button>
    <button class="tb-i" type="button" data-el="paintClear" data-icon="paintClear"
            data-i18n-title="rt.paintClear" title="Tout effacer" disabled></button>
  </div>
</div>
`;

/** The four numbers you check between every run. */
const BAR_HUD = `
<dl class="tb-counts" data-el="hud">
  <div><dt data-i18n="rt.hudSource">Source</dt><dd data-el="hudSource">—</dd></div>
  <div><dt data-i18n="rt.hudResult">Résultat</dt><dd data-el="hudResult">—</dd></div>
  <div><dt data-i18n="rt.hudCut">Réduction</dt><dd data-el="hudCut">—</dd></div>
  <div><dt data-i18n="rt.hudQuads">Quads</dt><dd data-el="hudQuads">—</dd></div>
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
<!--
  The panel keeps what needs room; the bar's menu keeps what needs the model.

  Every setting existed twice — once here and once in the drop-down over the
  viewport — mirrored by hand in both directions. Two surfaces for one state is
  two chances to drift, and the panel's copy was the one you could not see the
  model through while using it.

  So the menu is where the settings are. The sections below still exist because
  they *are* the state: every read in this module goes through those inputs and
  the menu writes into them. They are not drawn. Turning that around — making the
  menu's own inputs the model — is a rename of forty identifiers with nothing to
  show for it, and this way the two cannot disagree at all.

  What is left on screen is what a panel is for: a report too wide for a
  drop-down, and the deviation ramp that is read while looking at the picture.
-->
<section data-el="settingsNote">
  <h2 data-i18n="rt.settingsTitle">Réglages</h2>
  <p class="rt-hint" data-i18n="rt.settingsMoved">Les réglages sont dans le menu de la barre, au-dessus du modèle : on les change en le regardant.</p>
  <button class="seg" type="button" data-el="openMenu" data-i18n="rt.openSettings">Ouvrir les réglages</button>
</section>

<section data-el="resultSection" hidden>
  <h2 data-i18n="rt.reportTitle">Bilan</h2>
  <p class="rt-hint rt-err" data-el="err" hidden></p>
  <div data-el="report"></div>
  <div data-el="devTools" class="rt-off">
    <p class="rt-sub" data-i18n="rt.devScale">Échelle de l'écart</p>
    <label class="rt-field">
      <span><span data-i18n="rt.redAt">Rouge à</span> <span class="rt-num" data-el="devScaleValue">—</span></span>
      <input type="range" data-el="devScale" min="0.1" max="4" step="0.1" value="1" />
    </label>
    <p class="rt-hint" data-i18n="rt.devScaleHint">Multiplicateur sur le pire écart du calcul, pas une
      distance absolue : « de combien ça a bougé » ne veut dire quelque chose
      que rapporté à ce que ça pouvait bouger. À 1 la couleur la plus chaude
      tombe exactement sur le pire sommet ; en dessous la rampe sature et les
      zones seulement mauvaises rejoignent les pires, ce qui est la façon de
      les trouver.</p>
  </div>
</section>

<section data-el="paintSection">
  <h2 data-i18n="rt.paintTitle">Peinture</h2>
  <p class="rt-hint" data-i18n="rt.paintIntro">Quatre pinceaux, dans la barre au-dessus du modèle. Ce
    qu'ils laissent n'est pas un réglage de plus : c'est ce que tu sais du
    modèle et que le budget de triangles ne peut pas deviner.</p>
  <dl class="rt-paint-counts" data-el="paintCounts"></dl>
  <p class="rt-hint" data-el="paintHint"></p>
</section>

<div data-el="settings" class="rt-mirror">
<section>
  <h2 data-i18n="rt.method">Méthode</h2>
  <div class="segment" role="group" data-i18n-aria="rt.method" aria-label="Méthode">
    <button class="seg active" type="button" data-el="mDecimate" data-i18n-title="rt.decimateTitle" data-i18n="rt.decimate" title="Dépenser le budget là où la silhouette en a besoin">Décimer</button>
    <button class="seg" type="button" data-el="mIsotropic" data-i18n-title="rt.rebuildTitle" data-i18n="rt.rebuild" title="Reconstruire vers des arêtes régulières et une valence de six">Reconstruire</button>
  </div>
  <label class="rt-field">
    <span><span data-i18n="rt.triangles">Triangles</span> <span class="rt-num" data-el="targetValue">—</span></span>
    <input type="range" data-el="target" min="1" max="90" step="1" value="10" />
  </label>
  <p class="rt-hint" data-el="methodHint"></p>

  <p class="rt-sub" data-i18n="rt.maxDev">Déviation maximum</p>
  <label class="rt-field">
    <span><span data-i18n="rt.cap">Plafond</span> <span class="rt-num" data-el="maxErrorValue">aucun</span></span>
    <input type="range" data-el="maxError" min="0" max="50" step="1" value="0" />
  </label>
  <p class="rt-hint" data-i18n="rt.maxDevHint">La deuxième condition d'arrêt, et celle qui compte quand
    on cherche une qualité plutôt qu'un budget : la décimation s'arrête quand
    la prochaine fusion déplacerait la surface de plus que ça. C'est la
    différence entre « fais-en 5 000 triangles » et « fais-le aussi petit que
    possible sans que ça se voie ». À zéro, seul le budget décide.</p>

  <p class="rt-sub" data-i18n="rt.scope">Portée</p>
  <div class="segment" role="group" data-i18n-aria="rt.scope" aria-label="Portée">
    <button class="seg" type="button" data-scope="all" data-i18n-title="rt.scopeAllTitle" data-i18n="rt.scopeAll" title="Tout le modèle">Tout</button>
    <button class="seg" type="button" data-scope="visible" data-i18n-title="rt.scopeVisibleTitle" data-i18n="rt.scopeVisible" title="Seulement ce qui n'est pas masqué dans l'onglet Scène">Visible</button>
    <button class="seg active" type="button" data-scope="picked" data-i18n-title="rt.scopePickedTitle" data-i18n="rt.scopePicked" title="Seulement ce qui est sélectionné dans l'onglet Scène">Sélection</button>
  </div>
  <p class="rt-hint" data-el="scopeHint"></p>

  <p class="rt-sub" data-i18n="rt.quadsTitle">Quads</p>
  <label class="rt-check"><input type="checkbox" data-el="quads" /><span data-i18n="rt.pairQuads">Apparier les triangles en quads</span></label>
  <p class="rt-hint" data-i18n="rt.quadsHint">glTF n'a pas de quads, donc l'appairage voyage à côté du
    fichier comme un masque de diagonale, un entier par triangle.</p>
</section>

<section>
  <h2 data-i18n="rt.cleanup">Nettoyage</h2>
  <label class="rt-check"><input type="checkbox" data-el="holes" /><span data-i18n="rt.fillHoles">Combler les trous d'abord</span></label>
  <label class="rt-check"><input type="checkbox" data-el="boundary" checked /><span data-i18n="rt.pinBoundary">Épingler les bords ouverts</span></label>
  <label class="rt-field">
    <span><span data-i18n="rt.creaseAngle">Angle de pli</span> <span class="rt-num" data-el="angleValue">40°</span></span>
    <input type="range" data-el="angle" min="5" max="90" step="1" value="40" />
  </label>
  <label class="rt-field">
    <span><span data-i18n="rt.seamCost">Coût d'une couture</span> <span class="rt-num" data-el="seamValue">4</span></span>
    <input type="range" data-el="seam" min="0" max="20" step="1" value="4" />
  </label>
  <p class="rt-hint" data-i18n="rt.creaseHint">Une arête plus pliée que l'angle compte comme un pli et
    résiste. Le coût d'une couture protège les bords d'UV, dont la rupture se
    voit dans la texture bien avant de se voir dans la forme.</p>

  <p class="rt-sub" data-i18n="rt.smoothing">Lissage</p>
  <label class="rt-field">
    <span><span data-i18n="rt.passes">Passes</span> <span class="rt-num" data-el="relaxValue">0</span></span>
    <input type="range" data-el="relax" min="0" max="10" step="1" value="0" />
  </label>
  <label class="rt-field">
    <span><span data-i18n="rt.strength">Force</span> <span class="rt-num" data-el="relaxStrengthValue">0.50</span></span>
    <input type="range" data-el="relaxStrength" min="0.05" max="1" step="0.05" value="0.5" />
  </label>
  <label class="rt-field">
    <span><span data-i18n="rt.smoothAngle">Angle de pli du lissage</span> <span class="rt-num" data-el="relaxAngleValue">75°</span></span>
    <input type="range" data-el="relaxAngle" min="20" max="150" step="5" value="75" />
  </label>
  <p class="rt-hint" data-i18n="rt.smoothHint">Chaque passe est reprojetée sur la source, sinon une sphère
    dégonfle un peu à chaque fois. Cet angle n'est pas celui du dessus, et c'est
    voulu : un maillage réduit cinquante fois est facetté partout, donc l'angle
    qui veut dire « pli » pour un décimateur veut dire « tout le modèle » pour
    un lisseur.</p>
</section>

<section>
  <h2 data-i18n="rt.maps">Cartes</h2>
  <p class="rt-hint" data-i18n="rt.mapsHint">Le maillage réduit porte encore la disposition d'UV de
    l'original, et passé un certain point cette disposition ne décrit plus la
    surface sur laquelle elle est posée. L'interrupteur est dans la barre du
    bas, à côté du bouton dont il change le coût.</p>

  <div data-el="bakeTools">
    <label class="rt-field">
      <span><span data-i18n="rt.atlasSize">Taille de l'atlas</span> <span class="rt-num" data-el="mapSizeValue">2048</span></span>
      <input type="range" data-el="mapSize" min="8" max="13" step="1" value="11" />
    </label>

    <p class="rt-sub" data-i18n="rt.mapsMade">Cartes produites</p>
    <label class="rt-check"><input type="checkbox" checked disabled /><span data-i18n="rt.baseColor">Couleur de base</span></label>
    <label class="rt-check"><input type="checkbox" data-el="mMR" checked /><span data-i18n="rt.metalRough">Métal et rugosité</span></label>
    <label class="rt-check"><input type="checkbox" data-el="mNormal" checked /><span data-i18n="rt.normalMap">Normale</span></label>
    <label class="rt-check"><input type="checkbox" data-el="mEmissive" checked /><span data-i18n="rt.emissive">Émissif</span></label>
    <label class="rt-check"><input type="checkbox" data-el="mAo" /><span data-i18n="rt.ao">Occlusion ambiante</span></label>
    <p class="rt-hint" data-i18n="rt.mapsChoiceHint">La couleur de base seule ne suffit pas : sans métal ni
      rugosité, tout le résultat hérite d'une seule paire de scalaires, et une
      boucle en laiton sur un manche en bois revient en bois mat. L'émissif est
      abandonné tout seul quand rien n'émet.</p>

    <div data-el="aoTools">
      <label class="rt-field">
        <span><span data-i18n="rt.raysPerTexel">Rayons par texel</span> <span class="rt-num" data-el="aoSamplesValue">16</span></span>
        <input type="range" data-el="aoSamples" min="4" max="128" step="4" value="16" />
      </label>
      <label class="rt-field">
        <span><span data-i18n="rt.aoDistance">Portée de l'occlusion</span> <span class="rt-num" data-el="aoDistanceValue">0.15</span></span>
        <input type="range" data-el="aoDistance" min="0.01" max="1" step="0.01" value="0.15" />
      </label>
      <p class="rt-hint" data-i18n="rt.aoHint">Courte, seuls les creux s'assombrissent ; longue, toute
        la silhouette s'ombre elle-même. La séquence de tirage est déterministe,
        donc comparer deux réglages n'est pas une devinette.</p>
    </div>
  </div>
</section>

<section>
  <h2 data-i18n="rt.atlas">Atlas</h2>
  <div data-el="atlasTools">
    <p class="rt-sub" data-i18n="rt.cage">Cage</p>
    <label class="rt-check"><input type="checkbox" data-el="showCage" /><span data-i18n="rt.drawCage">Dessiner la cage</span></label>
    <p class="rt-hint" data-i18n="rt.cageHint">Une distance de cage ne veut rien dire tant qu'on n'a pas
      vu la coque qu'elle décrit : trop courte, les rayons manquent ce qui
      dépasse du maillage réduit ; trop longue, ils vont chercher la pièce d'à
      côté et cuisent un chambranle sur une porte.</p>
    <label class="rt-field">
      <span><span data-i18n="rt.cageOut">Vers l'extérieur</span> <span class="rt-num" data-el="cageOutValue">0.020</span></span>
      <input type="range" data-el="cageOut" min="0.001" max="0.2" step="0.001" value="0.02" />
    </label>
    <label class="rt-field">
      <span><span data-i18n="rt.cageIn">Vers l'intérieur</span> <span class="rt-num" data-el="cageInValue">0.020</span></span>
      <input type="range" data-el="cageIn" min="0.001" max="0.2" step="0.001" value="0.02" />
    </label>

    <p class="rt-sub" data-i18n="rt.atlas">Atlas</p>
    <label class="rt-field">
      <span><span data-i18n="rt.gutter">Écart entre îlots</span> <span class="rt-num" data-el="gutterValue">4</span></span>
      <input type="range" data-el="gutter" min="0" max="32" step="1" value="4" />
    </label>
    <label class="rt-field">
      <span><span data-i18n="rt.bleed">Bavure hors des îlots</span> <span class="rt-num" data-el="bleedValue">8</span></span>
      <input type="range" data-el="bleed" min="0" max="32" step="1" value="8" />
    </label>
    <label class="rt-field">
      <span><span data-i18n="rt.islandAngle">Angle de rupture d'îlot</span> <span class="rt-num" data-el="islandValue">50°</span></span>
      <input type="range" data-el="island" min="10" max="120" step="1" value="50" />
    </label>
    <p class="rt-hint" data-i18n="rt.atlasHint">Ce sont deux choses différentes et les deux comptent :
      l'écart est du vide entre les îlots pour qu'aucun niveau de mip ne les
      mélange, la bavure est de la couleur peinte au-delà de chaque bord pour
      que le filtrage n'aille jamais chercher le fond.</p>
  </div>
  <p class="rt-hint" data-el="sourceNote"></p>
</section>
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

/* Grouped by the language that is on, never by French alone. */
const fr = num;
/** Compact for the floating bar's counters: 1 500 000 reads as 1.5M there. */
const abbr = (n) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000 ? `${+(n / 1_000).toFixed(1)}K`
  : String(n);
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
  // After Scène and before the counters: what is on screen, then what you are
  // telling the engine about it, then the numbers it comes back with.
  lend(bar, BAR_PAINT, document.getElementById("vb-camera")?.closest(".tb-group"));
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

  /**
   * This mode's own three roots, translated.
   *
   * Not `applyStatic`, which walks the document: none of these markup blocks
   * were in the document when the language was chosen. The pane and the shell
   * arrive with the lazy chunk, long after startup, and `held` is a detached div
   * that keeps the lent bar groups whenever the mode is closed. Called once now
   * so a window already switched to English does not open a French panel, and
   * again on every toggle for as long as the module is loaded.
   */
  const translate = () => {
    for (const root of [host, pane, held]) applyStaticIn(root);
  };
  translate();
  /*
   * On a language change, the markup is only half the screen.
   *
   * The run button's label, the method explanation, the scope sentence, the
   * reason a dead button is dead and the whole report are written by this
   * module, so no attribute can carry them and `applyStaticIn` cannot reach
   * them. They are repainted from the functions that produce them, which is the
   * only way they cannot drift from what a fresh run would say.
   *
   * Only on the event, never at setup: everything named here is declared below
   * and would still be in its dead zone at this point in the file.
   */
  window.addEventListener("i18n", () => {
    translate();
    el.run.textContent = runLabel();
    el.methodHint.textContent = t(METHOD_HINT[method]);
    paintScope();
    syncPaint();
    refresh();
    if (lastReport) reportOn(lastReport.r, lastReport.bakeOnly);
  });

  let source = 0;
  let last = null;
  /** The arguments the report was last drawn from, so it can be redrawn. */
  let lastReport = null;
  let running = false;
  let open = false;
  let method = "decimate";
  /** `all` or `visible`: which materials the run is allowed to touch. */
  /*
   * "Sélection", and it is the right default rather than a cautious one.
   *
   * The position already means "what is chosen, and everything when nothing is",
   * which is exactly the rule a multi-mesh scene wants: point at the two meshes
   * that need work and only those are touched; point at nothing and the whole
   * scene goes through, one mesh at a time. "Tout" was the default while a run
   * meant one merged export, when the distinction cost nothing because there was
   * only ever one result either way.
   */
  let scope = "picked";
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

  const METHOD_HINT = { decimate: "rt.hintDecimate", isotropic: "rt.hintIsotropic" };

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
  /**
   * Wrap the low poly the person is actually looking at.
   *
   * The cage is the shell the baker fires its rays from, so it belongs on *a*
   * low poly — and until a run meant one mesh at a time there was only ever one
   * to choose. Now a scene holds several, `dressResult` runs once per result,
   * and the cage simply ended up on whichever finished last. Selecting a
   * different mesh moved nothing: the drawn shell went on describing a bake
   * somewhere else in the scene.
   *
   * The subject is the selection, resolved through the link: choosing a low poly
   * wraps it, and choosing the high poly it came from wraps the low poly made
   * from it, because "the cage of this mesh" is the question either click asks.
   */
  function cageSubject() {
    const mine = results().map((p) => p.object);
    if (!mine.length) return null;

    const holds = (root, uuid) => {
      let found = false;
      root.traverse((o) => {
        if (o.uuid === uuid) found = true;
      });
      return found;
    };

    for (const id of selection.ids) {
      // The selected node itself, when it is one of this mode's results.
      const direct = mine.find((o) => holds(o, id));
      if (direct) return direct;
      // Or the result made from it, when a high poly is what is selected.
      const node = byUuid(viewer.root, id);
      const low = node && lowPolyOf(viewer.root, node);
      if (low) {
        const owner = mine.find((o) => o === low || holds(o, low.uuid));
        if (owner) return owner;
      }
    }
    // Nothing chosen: the newest result, which is what a run has just produced
    // and what somebody is most likely looking at.
    return mine.at(-1);
  }

  /** Put the cage on one result, taking it off whatever held it before. */
  function retargetCage(preferred = null) {
    const subject = preferred || cageSubject();
    if (cage?.object?.parent === subject) {
      syncCage();
      return;
    }
    cage?.dispose();
    cage = subject ? buildCage(subject) : null;
    if (cage && subject) subject.add(cage.object);
    syncCage();
  }

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
      ? `${(devMax / f).toPrecision(3)} ${t("rt.unit")}`
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

    retargetCage(object);
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

  /**
   * Un nombre et sa phrase, au singulier ou au pluriel.
   *
   * Deux cles plutot qu'un accord calcule : le francais accorde trois mots dans
   * « 2 elements selectionnes » et l'anglais un seul, donc une regle qui marche
   * dans une langue produit une faute dans l'autre. Ecrire les deux phrases est
   * plus court que la regle qui les rate.
   */
  const plural = (key, n) => t(n > 1 ? key + "N" : key).replace("{n}", fr(n));

  /** Where the history cursor is, in words. */
  const resultOf = () =>
    t("rt.resultOf").replace("{n}", String(cursor + 1)).replace("{total}", String(history.length));

  const LABELS = { charts: "rt.chartsLabel", deviation: "rt.deviationLabel" };

  const AB_LABELS = {
    source: "rt.abSourceSay",
    result: "rt.abResultSay",
    both: "rt.abBothSay",
    split: "rt.abSplitSay",
    ghost: "rt.abGhostSay",
    none: "rt.abNoneSay",
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
    say2(LABELS[name] ? t(LABELS[name]) : name);
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
    const on = !isPressed(el.opaque);
    setPressed(el.opaque, on);
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
    say2(t(on ? "rt.opaqueOn" : "rt.opaqueOff"));
  });

  el.xray.addEventListener("click", () => {
    const on = !isPressed(el.xray);
    setPressed(el.xray, on);
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

  /** True when `root` is, or holds, `node`. */
  function holds(root, node) {
    let found = false;
    root?.traverse?.((o) => {
      if (o === node) found = true;
    });
    return found;
  }

  /**
   * The two meshes a comparison is between.
   *
   * "The first part and the last part" was the answer while a run meant the
   * whole scene: there was one source and one result and the order settled it.
   * On a scene of nine meshes with three of them retopologised, first and last
   * name two objects with no relationship at all — so "voir le résultat
   * uniquement" hid an arbitrary mesh and showed another.
   *
   * The pair comes from the selection, resolved through the high/low link, which
   * is the same question the cage asks: point at either half and the comparison
   * is about that couple. With nothing selected it falls back to the newest
   * result and the mesh it was made from, which is what a run has just produced.
   */
  function comparePair() {
    const mine = results().map((p) => p.object);
    if (!mine.length) return null;

    const pairFor = (low) => {
      const high = highPolyOf(viewer.root, low);
      return high ? { high, low } : null;
    };

    for (const id of selection.ids) {
      const node = byUuid(viewer.root, id);
      if (!node) continue;
      // A high poly was chosen: compare it with what came off it.
      const low = lowPolyOf(viewer.root, node);
      if (low) {
        const owner = mine.find((o) => holds(o, low)) || low;
        return { high: node, low: owner };
      }
      // Or a result was chosen, directly or through a mesh inside it.
      const owner = mine.find((o) => holds(o, node));
      if (owner) {
        const pair = pairFor(owner);
        if (pair) return pair;
      }
    }
    return pairFor(mine.at(-1));
  }

  /** Nodes whose visibility a comparison mode is holding down. */
  let abTouched = [];

  function setAB(mode) {
    compareMode = mode;
    const parts = viewer.parts || [];
    unghost();
    // Only what a comparison hid comes back. Forcing every part visible would
    // undo the outliner's own eyes, which is a different promise made by a
    // different control.
    for (const node of abTouched) node.visible = true;
    abTouched = [];
    for (const p of parts) setSide(p.object, 0);

    el.splitLine.hidden = mode !== "split";
    if (mode === "split") paintSplit();

    const pair = comparePair();
    if (pair) {
      const { high, low } = pair;
      const hide = (node) => {
        node.visible = false;
        abTouched.push(node);
      };
      if (mode === "source") hide(low);
      else if (mode === "result") hide(high);
      else if (mode === "none") {
        hide(high);
        hide(low);
      } else if (mode === "split") {
        setSide(high, -1);
        setSide(low, 1);
      } else if (mode === "ghost") ghost(high);
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
        ? t(AB_LABELS[b.dataset.ab])
        : t("rt.nothingToCompare"));
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
  /*
   * Hold X to see the other half of the pair.
   *
   * It reveals the high poly of whatever is selected, because `setAB` resolves
   * the pair from the selection — so on a scene with three retopologies, X shows
   * the source of the one being judged rather than of whichever ran last.
   */
  function peekAb() {
    if (peekPrev !== null || !comparePair()) return;
    peekPrev = compareMode;
    setAB("source");
    setPressed(el.peek, true);
  }
  function unpeekAb() {
    if (peekPrev === null) return;
    setAB(peekPrev);
    peekPrev = null;
    setPressed(el.peek, false);
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
    // The comparison is re-asserted, not just repainted: a resize re-runs the
    // patched shader and can leave `uSide` at zero, which shows both topologies
    // stacked with nothing discarded and only the line still cutting.
    setAB(compareMode);
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
    el.mmDecimate.classList.toggle("active", next === "decimate");
    el.mmIsotropic.classList.toggle("active", next === "isotropic");
    el.methodHint.textContent = t(METHOD_HINT[next]);
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
    el.maxErrorValue.textContent = cap === 0 ? t("rt.none") : `${(cap / 1000).toFixed(3)}`;
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

    /*
     * Each counter carries its own name, because the rail hides the words.
     *
     * Upright, the bar drops the `dt` labels — "RÉDUCTION" was the widest thing
     * in a column of sixteen-pixel glyphs — so the only place left to say what a
     * number is, is the tooltip. Read from the label rather than written twice,
     * so a language change carries it.
     */
    for (const row of el.hud.querySelectorAll("div")) {
      const name = row.querySelector("dt")?.textContent;
      if (name) row.title = name;
    }

    setStat(el.hudSource, source ? abbr(source) : null);
    setStat(el.hudResult, last ? abbr(last.outputTriangles) : null);
    setStat(
      el.hudCut,
      last ? `${(100 - (last.outputTriangles / last.inputTriangles) * 100).toFixed(1)} %` : null
    );
    setStat(el.hudQuads, last?.quads ? `${(last.quadFraction * 100).toFixed(0)} %` : null);

    // The button says what it will do, unless it is currently the cancel button,
    // in which case what it will do is stop.
    if (!running) el.run.textContent = runLabel();
    syncMenu();
  }

  /** Mirror the panel's controls into the unfolded menu. One direction only. */
  function syncMenu() {
    el.mTarget.value = el.target.value;
    el.mMaxError.value = el.maxError.value;
    el.mAngle.value = el.angle.value;
    el.mSeam.value = el.seam.value;
    el.mRelax.value = el.relax.value;
    el.mRelaxStrength.value = el.relaxStrength.value;
    el.mRelaxAngle.value = el.relaxAngle.value;
    el.mMapSize.value = el.mapSize.value;
    el.mAoSamples.value = el.aoSamples.value;
    el.mAoDistance.value = el.aoDistance.value;
    el.mCageOut.value = el.cageOut.value;
    el.mCageIn.value = el.cageIn.value;
    el.mGutter.value = el.gutter.value;
    el.mBleed.value = el.bleed.value;
    el.mIsland.value = el.island.value;

    el.mTargetValue.textContent = `${el.target.value} %`;
    el.mMaxErrorValue.textContent =
      Number(el.maxError.value) === 0 ? t("rt.none") : `${(Number(el.maxError.value) / 1000).toFixed(3)}`;
    el.mAngleValue.textContent = `${el.angle.value}°`;
    el.mSeamValue.textContent = el.seam.value;
    el.mRelaxValue.textContent = el.relax.value;
    el.mRelaxStrengthValue.textContent = Number(el.relaxStrength.value).toFixed(2);
    el.mRelaxAngleValue.textContent = `${el.relaxAngle.value}°`;
    el.mMapSizeValue.textContent = String(mapSize());
    el.mAoSamplesValue.textContent = el.aoSamples.value;
    el.mAoDistanceValue.textContent = Number(el.aoDistance.value).toFixed(2);
    el.mCageOutValue.textContent = Number(el.cageOut.value).toFixed(3);
    el.mCageInValue.textContent = Number(el.cageIn.value).toFixed(3);
    el.mGutterValue.textContent = el.gutter.value;
    el.mBleedValue.textContent = el.bleed.value;
    el.mIslandValue.textContent = `${el.island.value}°`;

    el.mQuads.checked = el.quads.checked;
    el.mHoles.checked = el.holes.checked;
    el.mBoundary.checked = el.boundary.checked;
    el.mmMR.checked = el.mMR.checked;
    el.mmNormal.checked = el.mNormal.checked;
    el.mmEmissive.checked = el.mEmissive.checked;
    el.mmAo.checked = el.mAo.checked;
    el.mShowCage.checked = el.showCage.checked;
  }

  function refresh() {
    source = viewer.current ? countTriangles(viewer.root) : 0;
    // Never disabled while running: it is the cancel button then.
    el.run.disabled = running ? false : source === 0 || !tauri;
    el.run.title = running
      ? t("rt.killRun")
      : source === 0
        ? t("rt.openFirst")
        : "";
    paintHistory();
    el.rebake.disabled = !lastRun || running || !tauri;
    el.rebake.title = lastRun
      ? t("rt.rebakeTitle")
      : t("rt.rebakeNeedsResult");

    // A dead button should say why it is dead, in the bar rather than in a
    // tooltip nobody hovers. "Nothing happens" is not a diagnosis anyone should
    // have to make from the outside.
    if (!running) {
      const why = !tauri
        ? t("rt.noBridge")
        : source === 0
          ? t("rt.noModel")
          : "";
      if (why || el.note.dataset.why === "1") {
        say(why);
        if (why) el.note.dataset.why = "1";
      }
    }

    // Say where the geometry will come from, because the two paths behave
    // differently and the difference is worth a sentence rather than a surprise.
    const p = sourcePath?.();
    el.sourceNote.textContent = !source
      ? ""
      : isGltf(p)
        ? t("rt.readsDirectly")
        : t("rt.willExport");
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

  // --- the unfolded menu --------------------------------------------------
  // A compact mirror of the panel's controls, reached by the arrow on the action
  // bar. Each writes back to the panel's own input, which stays the single source
  // of truth, then repaints. Two tabs: remesh and bake.
  /** Open or shut the unfolded menu, from wherever the request came. */
  function showMenu(on) {
    if (el.menu.hidden === !on) return;
    el.menu.hidden = !on;
    setPressed(el.menuToggle, on, { active: false });
  }
  el.menuToggle.addEventListener("click", () => showMenu(el.menu.hidden));

  /*
   * Reaching past it closes it, the way every other drawer in this application
   * behaves. It used to stay open until the arrow itself was found again, which
   * on a panel this size means a large plate of controls sitting over the model
   * while you are trying to look at the model.
   *
   * On `pointerdown` rather than `click`, so it shuts on the press that begins
   * an orbit instead of waiting for a release that a drag never delivers. The
   * toggle is excluded because its own handler is about to run and would read a
   * menu this listener had just closed, turning one click into open-and-shut.
   */
  document.addEventListener("pointerdown", (e) => {
    if (el.menu.hidden) return;
    if (el.menu.contains(e.target) || el.menuToggle.contains(e.target)) return;
    showMenu(false);
  });
  // Escape reaches it too: a drawer you can only dismiss with the mouse is one
  // more thing the keyboard cannot get out of.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.menu.hidden) showMenu(false);
  });
  for (const b of el.menu.querySelectorAll("[data-mtab]")) {
    b.addEventListener("click", () => {
      for (const o of el.menu.querySelectorAll("[data-mtab]")) o.classList.toggle("active", o === b);
      for (const o of el.menu.querySelectorAll("[data-mtabpane]")) o.hidden = o.dataset.mtabpane !== b.dataset.mtab;
    });
  }
  el.mmDecimate.addEventListener("click", () => setMethod("decimate"));
  el.mmIsotropic.addEventListener("click", () => setMethod("isotropic"));
  // Sliders mirror the panel input, then repaint.
  for (const [m, p] of [
    ["mTarget", "target"], ["mMaxError", "maxError"], ["mAngle", "angle"],
    ["mSeam", "seam"], ["mRelax", "relax"], ["mRelaxStrength", "relaxStrength"],
    ["mRelaxAngle", "relaxAngle"], ["mMapSize", "mapSize"], ["mAoSamples", "aoSamples"],
    ["mAoDistance", "aoDistance"], ["mCageOut", "cageOut"], ["mCageIn", "cageIn"],
    ["mGutter", "gutter"], ["mBleed", "bleed"], ["mIsland", "island"],
  ]) {
    el[m].addEventListener("input", () => { el[p].value = el[m].value; paint(); });
  }
  // Checkboxes mirror the panel input, then repaint.
  for (const [m, p] of [
    ["mQuads", "quads"], ["mHoles", "holes"], ["mBoundary", "boundary"],
    ["mmMR", "mMR"], ["mmNormal", "mNormal"], ["mmEmissive", "mEmissive"], ["mmAo", "mAo"],
    ["mShowCage", "showCage"],
  ]) {
    el[m].addEventListener("change", () => { el[p].checked = el[m].checked; paint(); });
  }
  for (const b of el.menu.querySelectorAll("[data-mscope]")) {
    b.addEventListener("click", () => {
      for (const o of el.menu.querySelectorAll("[data-mscope]")) o.classList.toggle("active", o === b);
      for (const o of pane.querySelectorAll("[data-scope]")) o.classList.toggle("active", o.dataset.scope === b.dataset.mscope);
      scope = b.dataset.mscope;
      paintScope();
    });
  }

  // --- what is painted on the model ---------------------------------------

  /**
   * The brushes.
   *
   * Built once with the mode, not once per open: a painting is work, and losing
   * it because the panel was closed for a second would make it work nobody does
   * twice. It is the mode's own state and travels with the document through
   * `saveState`, like the run history beside it.
   *
   * The uniforms are the shared ones, so the paint is drawn by the same patched
   * shader as the wireframe and the two data views. See `paint.js` for why that
   * matters rather than being tidy.
   */
  const painting = createPainting({ viewer, wireUniforms: wireU });

  /** The brush size slider is a percentage; the brush wants a fraction. */
  const brushPercent = () => Number(el.pSize.value);

  /*
   * The tool buttons, held as nodes rather than looked up.
   *
   * These five move between `held` and the bar every time the mode opens and
   * shuts, so neither root can answer for them at both ends of that: `held` is
   * empty while the mode is open and the bar is empty while it is shut. The
   * nodes themselves are the same objects throughout.
   */
  const toolButtons = [...held.querySelectorAll("[data-tool]")];

  /** The slider is a view of the brush size, which lives in `paint.js`. */
  const syncBrushSlider = () => {
    const pct = painting.brush.size * 100;
    el.pSize.value = pct.toFixed(1);
    el.pSizeValue.textContent = `${pct.toFixed(1)} %`;
  };

  function syncPaint() {
    const s = painting.stats();
    const tool = painting.tool;
    for (const b of toolButtons) {
      b.classList.toggle("active", (b.dataset.tool || null) === tool);
    }
    for (const b of el.menu.querySelectorAll("[data-guide]")) {
      b.classList.toggle("active", b.dataset.guide === painting.guideKind);
    }
    setPressed(el.paintView, painting.view);
    el.paintUndo.disabled = !painting.canUndo;
    el.paintRedo.disabled = !painting.canRedo;
    el.paintClear.disabled = painting.empty;

    syncBrushSlider();
    el.pStrengthValue.textContent = Number(el.pStrength.value).toFixed(2);
    el.pHardnessValue.textContent = Number(el.pHardness.value).toFixed(2);
    el.pDensityValue.textContent = Number(el.pDensity.value).toFixed(2);
    el.pFlowValue.textContent = Number(el.pFlow.value).toFixed(2);

    /*
     * The counts, as a list rather than a sentence.
     *
     * Painting is the one part of this mode with no preview button: the only way
     * to know a brush reached the model is to see the number it moved. An empty
     * list is the honest answer when nothing has been painted, and it is why the
     * section is written even when it is empty.
     */
    const rows = [
      [t("rt.countDensity"), s.density],
      [t("rt.countFreeze"), s.freeze],
      [t("rt.countRegion"), s.region],
      [t("rt.countGuides"), s.guides],
    ].filter(([, n]) => n > 0);
    el.paintCounts.innerHTML = rows.length
      ? rows.map(([k, n]) => `<div><dt>${k}</dt><dd>${fr(n)}</dd></div>`).join("")
      : "";
    el.paintHint.textContent = !rows.length
      ? t("rt.paintNothing")
      : !el.pUse.checked
        ? t("rt.paintIgnored")
        : s.region
          ? t("rt.paintRegionOn")
          : t("rt.paintReady");
  }
  painting.onChange = syncPaint;

  for (const b of toolButtons) {
    b.addEventListener("click", () => {
      const next = b.dataset.tool || null;
      // Clicking the live tool puts the pen down, which is one click rather than
      // two to get the camera back.
      painting.setTool(painting.tool === next ? null : next);
      if (painting.tool) showPane?.("retopo");
      syncPaint();
    });
  }
  for (const b of el.menu.querySelectorAll("[data-guide]")) {
    b.addEventListener("click", () => {
      painting.setGuideKind(b.dataset.guide);
      // Choosing a kind of guide is choosing to draw one.
      painting.setTool("guide");
      syncPaint();
    });
  }
  el.paintView.addEventListener("click", () => {
    painting.setView(!painting.view);
    syncPaint();
  });
  el.paintUndo.addEventListener("click", () => {
    painting.undo();
    syncPaint();
  });
  el.paintRedo.addEventListener("click", () => {
    painting.redo();
    syncPaint();
  });
  el.paintClear.addEventListener("click", () => {
    painting.clear("all");
    say2(t("rt.paintCleared"));
    syncPaint();
  });
  for (const b of el.menu.querySelectorAll("[data-pclear]")) {
    b.addEventListener("click", () => {
      painting.clear(b.dataset.pclear);
      syncPaint();
    });
  }
  for (const k of ["pSize", "pStrength", "pHardness"]) {
    el[k].addEventListener("input", () => {
      painting.setBrush({
        size: brushPercent() / 100,
        strength: Number(el.pStrength.value),
        hardness: Number(el.pHardness.value),
      });
      syncPaint();
    });
  }
  for (const k of ["pPressureSize", "pPressureStrength"]) {
    el[k].addEventListener("change", () => {
      painting.setBrush({
        pressureSize: el.pPressureSize.checked,
        pressureStrength: el.pPressureStrength.checked,
      });
    });
  }
  for (const k of ["pDensity", "pFlow"]) el[k].addEventListener("input", syncPaint);
  el.pUse.addEventListener("change", syncPaint);

  /*
   * Escape puts the pen down.
   *
   * A brush is a mode, and every mode in this application has one key that gets
   * out of it. Registered on the document because the canvas does not take focus
   * — clicking it paints — so a key listener on it would never fire.
   */
  document.addEventListener("keydown", (e) => {
    if (!open || e.key !== "Escape" || !painting.tool) return;
    painting.setTool(null);
    syncPaint();
  });

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

  /**
   * Drop results, and be precise about which.
   *
   * With no argument this clears everything the mode put in the scene, which is
   * what stepping through the history wants: it is about to import the state at
   * another cursor position and nothing of the current one should survive.
   *
   * A run passes the meshes it covers, and then only the low polys made *from
   * those meshes* go. This used to be unconditional, and on a scene of three
   * meshes retopologising the second one silently threw away the first one's
   * low poly: "my output" was a boolean on the object, so every result answered
   * to it. Ownership is not the question a re-run asks; descent is.
   *
   * @param {any[]} [sources] meshes whose derived results are being replaced
   */
  function dropResult(sources) {
    const mine = sources
      ? supersededBy(results(), new Set(sources.map((o) => o.uuid)), viewer.root)
      : results();
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
      // Every low poly of that step comes back, not just one: a step is a whole
      // run now, and a run is as many results as it had source meshes.
      for (const item of entry.items) {
        await importPart(item.path);
        const back = viewer.parts.at(-1);
        claimResult(back?.object);
        if (back?.object && item.identity) {
          back.name = restoreIdentity(viewer.root, back.object, item.identity);
        }
        await dressResult(back?.object, item.path);
      }
      last = entry.report;
      lastRun = entry.items.map((i) => ({ high: i.high, low: i.path, identity: i.identity }));
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
    const verb = t(method === "isotropic" ? "rt.rebuild" : "rt.decimate");
    return el.bake.checked ? `${verb} ${t("rt.andProject")}` : verb;
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
    // Kept so a language change can rewrite the same report rather than an
    // approximation of it: a bake and a decimation do not have the same rows,
    // and replaying one as the other would put invented geometry numbers on a
    // run that never touched the geometry.
    lastReport = { r, bakeOnly };
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
      add(t("rt.triangles"), `${fr(r.inputTriangles)} → ${fr(r.outputTriangles)}`);
      add(t("rt.hudCut"), `${(100 - (r.outputTriangles / r.inputTriangles) * 100).toFixed(1)} %`, "good");
      add(t("rt.duration"), `${(r.millis / 1000).toFixed(2)} s`);
      add(t("rt.maxDeviation"), `${r.deviationMax.toPrecision(3)} ${t("rt.unit")}`);
      if (r.holesFilled || r.holesLeft) {
        add(t("rt.holesFilled"), fr(r.holesFilled));
        // A hole left open is one the bake will project straight through.
        if (r.holesLeft) add(t("rt.holesLeft"), fr(r.holesLeft), "warn");
      }
      if (r.collapses) add(t("rt.collapses"), fr(r.collapses));
      // A large refusal count next to a barely moved triangle count is a guard
      // firing on every candidate, and it looks exactly like a mesh that had
      // nothing left to collapse unless the numbers are side by side.
      if (r.rejectedTopology) add(t("rt.rejectedTopology"), fr(r.rejectedTopology), r.rejectedTopology > r.collapses ? "warn" : "");
      if (r.rejectedFlip) add(t("rt.rejectedFlip"), fr(r.rejectedFlip), r.rejectedFlip > r.collapses ? "warn" : "");
      // The mean, never the worst: the worst triangle sits on a crease, which
      // relaxation pins on purpose, so it barely moves even when the mesh
      // improved everywhere else.
      if (r.aspectAfter > 0) {
        add(t("rt.aspect"), `${r.aspectBefore.toFixed(2)} → ${r.aspectAfter.toFixed(2)}`,
            r.aspectAfter < r.aspectBefore ? "good" : "");
      }
      if (r.quads) add(t("rt.hudQuads"), `${fr(r.quads)} · ${(r.quadFraction * 100).toFixed(0)} %`, "good");

      /*
       * What the painting did, and whether it arrived at all.
       *
       * The failure that matters here has no symptom of its own: a sidecar whose
       * points do not land on the mesh produces an ordinary looking run that
       * ignored everything you drew. `paintMatched` against `paintSamples` is
       * the one place that shows, so it is reported as a ratio and flagged when
       * it goes wrong rather than left to be noticed.
       */
      if (r.paintSamples || r.paintGuides) {
        const share = r.paintSamples ? r.paintMatched / r.paintSamples : 1;
        if (r.paintSamples) {
          add(t("rt.paintRead"), `${fr(r.paintMatched)} / ${fr(r.paintSamples)}`,
              share > 0.9 ? "good" : share > 0.5 ? "warn" : "bad");
        }
        if (r.paintGuides) add(t("rt.countGuides"), fr(r.paintGuides));
        if (r.paintLocked) add(t("rt.paintHeld"), fr(r.paintLocked));
      }
    } else {
      add(t("rt.bakeTime"), `${(r.millis / 1000).toFixed(2)} s`);
      add(t("rt.geometry"), t("rt.unchanged"));
    }

    let atlas = [];
    if (r.charts) {
      const total = r.hits + r.misses;
      const miss = total ? (r.misses / total) * 100 : 0;
      atlas = [
        { label: t("rt.islands"), value: fr(r.charts), tone: "" },
        { label: t("rt.utilisation"), value: `${(r.utilisation * 100).toFixed(0)} %`,
          tone: r.utilisation > 0.6 ? "good" : "warn" },
        // A miss is a ray that fell back to the nearest surface point instead of
        // finding the high poly. A few are normal; a lot means the cage is too
        // tight for this pair of meshes.
        { label: t("rt.missedRays"), value: `${miss.toFixed(1)} %`,
          tone: miss > 15 ? "bad" : miss > 6 ? "warn" : "good" },
        { label: t("rt.maps"), value: r.maps.join(", "), tone: "" },
      ];
    }

    const paint = (list) => list.map((x) =>
      `<div class="rt-stat ${x.tone}"><span>${x.label}</span><b>${x.value}</b></div>`).join("");

    el.report.innerHTML =
      `<div class="rt-stats">${paint(rows)}</div>` +
      (atlas.length
        ? `<p class="rt-stats-head">${t("rt.atlas")}</p><div class="rt-stats">${paint(atlas)}</div>`
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
    // Whoever writes the note owns it. `refresh` re-marks it straight after
    // when the text is its own, so "may I clear this" stays a question about
    // who wrote the line. It used to be answered by matching the first word of
    // it, which stopped working the moment the line could be in two languages.
    delete el.note.dataset.why;
    el.bar.classList.toggle("busy", running);
    if (typeof fraction === "number") {
      el.fill.style.width = `${Math.round(fraction * 100)}%`;
    } else if (!text) {
      // A finished run clears the bar rather than leaving it full.
      el.fill.style.width = "0%";
    }
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
      say(t("rt.cancelled"));
      return;
    }
    console.error("[retopo]", e);
    el.err.textContent = text;
    el.err.hidden = false;
    showReport();
    say("");
    toast?.(t("rt.failed"), 2600);
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
   * The export path no longer needs a scope filter of its own.
   *
   * `withScope` used to hide whatever the scope excluded, once, around a single
   * export of the whole scene. A run is per mesh now, so the question at export
   * time is not "what does the scope leave out" but "which one mesh is this",
   * and `withOnly` below answers that. It also subsumes the rule that kept this
   * mode's own output out of its own input: a result is not the mesh being
   * exported, so it is hidden along with everything else.
   */

  /**
   * Exactly which meshes the current scope covers.
   *
   * Two ways of saying it, and they answer different questions. **Visible**
   * means "leave alone what I have hidden", which is subtractive and suits a
   * model you have been pruning. **Selection** means "touch only this", which
   * is additive and suits a model where you know exactly which part you want.
   *
   * It used to be a predicate buried inside the export, used once, to decide
   * what to hide. It is a list now because two other things need the same
   * answer and must not compute it a second way: the result takes its *name*
   * from these meshes, and a re-run replaces the low polys made from these
   * meshes and no others. Three readers, one definition of "what this run is
   * about".
   *
   * This mode's own output is never in it. Feeding a low poly back in as a
   * source is how a second run came to count meshes the user never put there.
   */
  function sourceMeshes() {
    const hidden = new Set(
      (channels?.materials?.() || []).filter((m) => m.hidden).map((m) => m.uuid)
    );
    const mine = new Set();
    for (const part of results()) part.object.traverse((o) => mine.add(o));

    const list = [];
    viewer.root.traverse((o) => {
      if ((!o.isMesh && !o.isSkinnedMesh) || mine.has(o)) return;
      // Whatever the scope says, the exporter is called with `onlyVisible`, so a
      // hidden mesh reaches the engine under no setting at all. Tested here for
      // every scope rather than only for "visible", or a hidden mesh that
      // happened to be selected would be named as a source of a run it took no
      // part in.
      if (!o.visible) return;

      const source = channels?.original?.get(o) ?? o.material;
      const mats = (Array.isArray(source) ? source : [source]).filter(Boolean);

      if (scope === "picked") {
        // An empty selection is not an empty scope: the export leaves the scene
        // alone in that case, so the run really does cover everything.
        if (selection.size && !(selection.has(o.uuid) || mats.some((m) => selection.has(m.uuid))))
          return;
      } else if (scope === "visible") {
        // All or nothing per mesh: one carrying four materials with a single one
        // hidden cannot be half exported without splitting its geometry.
        if (mats.length && mats.every((m) => hidden.has(m.uuid))) return;
      }
      list.push(o);
    });
    return list;
  }

  /** The document's own name, for a result that covers more than one mesh. */
  const documentLabel = () => {
    const file = (sourcePath?.() || "").split(/[\\/]/).pop() || "modele";
    return file.replace(/\.[^.]+$/, "");
  };

  /**
   * Give the freshly imported result its name and its link back to the source.
   *
   * The part *entry* is renamed alongside the object, because the two are read
   * by different lists — the outliner walks the objects, the parts list shows
   * the entry — and a result called `Head_LP` in one and `output.glb` in the
   * other is the same confusion this whole change is about.
   */
  function nameResultPart(sources) {
    const entry = viewer.parts.at(-1);
    if (!entry?.object) return;
    entry.name = nameResult(viewer.root, entry.object, sources, documentLabel());
  }

  /** `…/result-17.glb` and an index into `…/result-17.2.glb`. */
  const numbered = (path, i) =>
    i === 0 ? path : path.replace(/(\.[^.\\/]+)$/, `.${i + 1}$1`);

  /**
   * Hide everything except these meshes, run something, put it all back.
   *
   * `withScope` hid what the scope *excluded*. This hides everything the current
   * step is not about, which is the same operation asked the other way round and
   * is what a per-mesh run needs: nine meshes means nine exports, each of one
   * mesh, and eight of them are hidden every time.
   */
  async function withOnly(keep, fn) {
    const wanted = new Set(keep);
    const touched = [];
    viewer.root.traverse((o) => {
      if ((!o.isMesh && !o.isSkinnedMesh) || !o.visible || wanted.has(o)) return;
      touched.push(o);
      o.visible = false;
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

  /**
   * Write one mesh out as the engine's input.
   *
   * The fast path — handing over the file on disk untouched — survives only for
   * a scene that is a single mesh in a glTF, because that is the only case where
   * "the file" and "this mesh" are the same thing. It used to apply whenever the
   * scope was "all", which was true while a run meant the whole scene at once
   * and is false now that a run means one mesh at a time.
   */
  async function inputForMesh(dirs, mesh, index, total) {
    const p = sourcePath?.();
    /*
     * The fast path hands the engine the file already on disk, and it cannot
     * survive a painting.
     *
     * Two reasons, either one enough. The sidecar goes *beside the input*, so
     * taking this path would write a `.paint` file into the person's own asset
     * folder next to their model. And the painted points are in the coordinates
     * of the scene as it stands — turned by the orientation buttons, moved by
     * the handles — which is what an export writes and is not what the file on
     * disk contains.
     */
    const paintBytes = usePaint() ? painting.sidecarFor(mesh) : null;
    if (!paintBytes && total === 1 && isGltf(p) && scope === "all" && countMeshes() === 1) {
      return p;
    }

    say(t("rt.exporting"), 0);
    // The group, not the object inside it: the orientation buttons and the edit
    // handles both write to the group.
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const { withoutWireAttributes } = await import("../viewer/wire.js");
    /*
     * The wireframe overlay's attributes never reach the engine.
     *
     * They are shader scaffolding — barycentric coordinates, an edge mask, a
     * chart index, a deviation — and three's exporter writes them as custom
     * glTF semantics, `_ABARY` and friends. The engine's reader refuses the
     * whole file over them: "invalid semantic name", nothing decimated, no clue
     * which of four attributes it meant.
     *
     * This was invisible until a run stopped going through the fast path. A glTF
     * file opened whole used to be handed to the engine as a path on disk, so
     * nothing was ever exported and the attributes never travelled; per mesh,
     * every run exports. The fault was always there, waiting for the first
     * non-glTF model or the first restricted run.
     */
    const glb = await withOnly([mesh], () =>
      withoutWireAttributes(viewer.root, () =>
        new GLTFExporter().parseAsync(viewer.root, {
          binary: true,
          includeCustomExtensions: true,
          // The default, said out loud because the whole scope control rests on
          // it: anything marked not-visible does not reach the file.
          onlyVisible: true,
        })
      )
    );
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = numbered(dirs.input, index);
    await writeFile(path, new Uint8Array(glb));
    /*
     * The painting travels beside the model, never inside it.
     *
     * Same arrangement the results already use for the quad mask, the deviation
     * and the chart ids: glTF has nowhere to put any of them, and inventing a
     * custom vertex semantic is what made the engine refuse whole files once
     * already — see the note above about `_ABARY`.
     */
    if (paintBytes) await writeFile(`${path}.paint`, paintBytes);
    return path;
  }

  /** How many meshes the scene holds, this mode's own output aside. */
  function countMeshes() {
    const mine = new Set();
    for (const part of results()) part.object.traverse((o) => mine.add(o));
    let n = 0;
    viewer.root.traverse((o) => {
      if ((o.isMesh || o.isSkinnedMesh) && !mine.has(o)) n++;
    });
    return n;
  }

  /** The engine's settings, which are the same for every mesh in a run. */
  function request(target) {
    return {
      method,
      targetTriangles: target,
      fillHoles: el.holes.checked,
      preserveBoundary: el.boundary.checked,
      sharpAngleDeg: Number(el.angle.value),
      seamPenalty: Number(el.seam.value),
      relaxIterations: Number(el.relax.value),
      relaxAngleDeg: Number(el.relaxAngle.value),
      maxError: Number(el.maxError.value) / 1000,
      relaxStrength: Number(el.relaxStrength.value),
      pairQuads: el.quads.checked,
      densityInfluence: Number(el.pDensity.value),
      flowStrength: Number(el.pFlow.value),
      usePainting: usePaint(),
      ...bakeRequest(),
      bake: el.bake.checked,
    };
  }

  /** Whether this run reads what is painted. */
  const usePaint = () => el.pUse.checked && !painting.empty;

  /**
   * The budget, per mesh.
   *
   * The slider is a percentage, and a percentage is the one form of budget that
   * survives being applied mesh by mesh: each keeps the same share of its own
   * detail, so a bolt and a hull both come out at forty percent rather than the
   * hull eating a whole scene-wide allowance and the bolt vanishing.
   */
  const budgetFor = (mesh) => {
    const total = countTriangles(mesh);
    const pct = Number(el.target.value) / 100;
    /*
     * A percentage of *what*, once a run is confined to part of a model.
     *
     * The slider means "keep this share of the detail", and with a region
     * painted the only detail on the table is the region's own: everything else
     * is locked and cannot be spent. Asking the engine for ten percent of a
     * whole head while only the face may be touched is a target it cannot reach
     * — it grinds through every remaining candidate and gives up — and the
     * result then looks like a slider that stopped working.
     *
     * So the percentage is spent inside the region and the rest is counted as
     * it stands.
     */
    const share = usePaint() ? painting.regionShare(mesh) : 1;
    const inside = total * share;
    const outside = total - inside;
    return Math.max(4, Math.round(outside + inside * pct));
  };

  /** Add up N per-mesh reports into the one the panel shows. */
  function totalReport(reports) {
    if (reports.length === 1) return reports[0];
    const sum = (k) => reports.reduce((a, r) => a + (r?.[k] || 0), 0);
    const worst = (k) => reports.reduce((a, r) => Math.max(a, r?.[k] || 0), 0);
    return {
      ...reports[reports.length - 1],
      inputTriangles: sum("inputTriangles"),
      outputTriangles: sum("outputTriangles"),
      millis: sum("millis"),
      // A deviation is a distance, and distances do not add up: the number that
      // means anything across N meshes is the worst one.
      maxDeviation: worst("maxDeviation"),
      meshes: reports.length,
    };
  }

  async function run() {
    if (running || !tauri || !viewer.current) return;
    running = true;

    let stop = null;
    try {
      // Everything that touches state lives inside the try, so a throw on the
      // way in cannot leave `running` stuck true and the button disabled for the
      // rest of the session.
      el.run.textContent = t("rt.cancel");
      el.rebake.disabled = true;
      el.err.hidden = true;
      el.fill.style.width = "0%";
      say(t("rt.preparing"), 0);
      onBusy?.(true);

      const dirs = await tauri.core.invoke("retopo_workdir");
      // Read before the export, while the scene is still as the user left it:
      // the export hides half of it and puts it back, and a list taken during
      // that window would describe the scene the exporter saw rather than the
      // one the run is about.
      const sources = sourceMeshes();
      if (!sources.length) throw new Error(t("rt.nothingToRun"));

      const verb = t(method === "isotropic" ? "rt.rebuilding" : "rt.decimating");
      /*
       * One mesh at a time, and one low poly per mesh.
       *
       * A run used to export the whole scene into a single file, decimate that,
       * and bring back one object. On a scene of one mesh those are the same
       * thing; on a scene of nine they are not, and the difference is
       * everything: the result was a single merged blob with no relationship to
       * any of the nine, so it could not be named after its source, could not be
       * replaced without replacing all of them, and could not be baked against
       * the mesh it actually came from.
       *
       * The engine still sees one mesh per call, which is what it is good at.
       * The loop is here.
       */
      const done = [];
      const reports = [];
      let cancelled = false;

      // The bar belongs to the whole run rather than to whichever call is
      // talking: nine meshes each sweeping 0 to 100 is nine bars, and a person
      // watching cannot tell the second from the last.
      stop = await tauri.event.listen("retopo://progress", (e) => {
        const f = e.payload || 0;
        const at = (done.length + f) / sources.length;
        // The engine apportions its own bar by what each stage costs, so the
        // wording follows the fraction rather than being timed here.
        const what = !el.bake.checked || f < 0.5 ? verb : t("rt.projecting");
        const of = sources.length > 1 ? ` ${done.length + 1}/${sources.length}` : "";
        say(`${what}${of}…`, at);
      });

      // Everything this run supersedes goes before anything is written, not
      // between the meshes: dropping as we go would renumber `viewer.parts`
      // under the imports that follow it.
      dropResult(sources);

      for (const [i, mesh] of sources.entries()) {
        const name = mesh.name || `#${i + 1}`;
        say(`${verb} ${name}…`, done.length / sources.length);

        const input = await inputForMesh(dirs, mesh, i, sources.length);
        const output = numbered(dirs.output, i);
        let r;
        try {
          r = await tauri.core.invoke("retopo_decimate", {
            input,
            output,
            request: request(budgetFor(mesh)),
          });
        } catch (e) {
          /*
           * Cancelling stops the run; it does not undo it.
           *
           * The cancel button reaches the engine, so the call in flight rejects
           * with "annulé" — and with one mesh per call that rejection is about
           * *this* mesh, not about the five already finished. Throwing on would
           * carry them all into `fail` and lose work the person watching has
           * already seen appear.
           */
          if (String(e?.message || e).trim() === "annulé") {
            cancelled = true;
            break;
          }
          throw e;
        }

        await importPart(output);
        const part = viewer.parts.at(-1);
        claimResult(part?.object);
        if (part?.object) {
          // One source, so the result is that mesh low poly and says so. This is
          // what the whole loop is for.
          part.name = nameResult(viewer.root, part.object, [mesh], documentLabel());
        }
        await dressResult(part?.object, output);
        reports.push(r);
        done.push({ path: output, high: input, identity: snapshotIdentity(part?.object) });
      }

      // Cancelled before the first mesh finished: nothing was made, and that is
      // the person's own decision rather than a failure to report at them.
      if (!done.length) {
        say(cancelled ? t("rt.cancelled") : "");
        return;
      }

      say(t("rt.loadingResult"), 1);
      const r = totalReport(reports);
      last = r;
      // Every pair stays named, so each bake can be redone on its own without
      // touching the geometry again.
      lastRun = done.map((d) => ({ high: d.high, low: d.path, identity: d.identity }));
      // Anything ahead of the cursor is a branch nobody took; a new run replaces
      // it rather than leaving a redo that would jump to an unrelated result.
      history = history.slice(0, cursor + 1);
      // The identities travel with the entry. Walking back to this step has to
      // bring the names and the links back with it, or an undo would quietly
      // turn `Casque_LP` into an unnamed import that no longer follows its
      // source.
      history.push({ items: done, report: r });
      cursor = history.length - 1;
      reportOn(r);

      const cut = (100 - (r.outputTriangles / r.inputTriangles) * 100).toFixed(0);
      toast?.(
        (cancelled ? "⏹ " : "") +
          t("rt.ranTriangles").replace("{n}", fr(r.outputTriangles)).replace("{cut}", cut) +
          (sources.length > 1 ? ` · ${done.length}/${sources.length}` : "")
      );
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
      el.run.textContent = t("rt.cancel");
      el.rebake.disabled = true;
      el.err.hidden = true;
      el.fill.style.width = "0%";
      say(`${t("rt.projecting")}…`, 0);
      onBusy?.(true);

      const dirs = await tauri.core.invoke("retopo_workdir");
      const pairs = lastRun;
      const baked = [];
      const reports = [];
      stop = await tauri.event.listen("retopo://progress", (e) => {
        const f = e.payload || 0;
        say(`${t("rt.projecting")} ${baked.length + 1}/${pairs.length}…`, (baked.length + f) / pairs.length);
      });

      /*
       * A bake replaces the results; it does not add any.
       *
       * Baking does not touch the geometry — that is the whole reason it exists
       * as its own button — so a bake that left the previous meshes in the scene
       * would put identical low polys on top of each other, differing only in
       * their textures. Same reason the history entry is *rewritten* rather than
       * pushed: undo walks geometry, and a bake is not a step in that walk. It
       * would otherwise take two undos to get back one decimation.
       *
       * The identities are taken before anything is dropped: a bake changes the
       * pixels on meshes the person has possibly renamed, and coming back as
       * fresh imports would rename them after their sources and drop their links
       * on the way.
       */
      for (const [i, pair] of pairs.entries()) {
        const output = numbered(dirs.rebake, i);
        try {
          reports.push(
            await tauri.core.invoke("retopo_bake", {
              high: pair.high,
              low: pair.low,
              output,
              request: bakeRequest(),
            })
          );
        } catch (e) {
          if (String(e?.message || e).trim() === "annulé") break;
          throw e;
        }
        baked.push({ high: pair.high, low: output, identity: pair.identity });
      }
      if (!baked.length) {
        say(t("rt.cancelled"));
        return;
      }

      say(t("rt.loadingResult"), 1);
      dropResult();
      for (const item of baked) {
        await importPart(item.low);
        const part = viewer.parts.at(-1);
        claimResult(part?.object);
        if (part?.object && item.identity) {
          part.name = restoreIdentity(viewer.root, part.object, item.identity);
        }
        await dressResult(part?.object, item.low);
      }

      const r = totalReport(reports);
      lastRun = baked;
      if (cursor >= 0) {
        history[cursor] = {
          ...history[cursor],
          items: baked.map((b) => ({ path: b.low, high: b.high, identity: b.identity })),
        };
      }
      last = { ...last, ...r, outputTriangles: r.outputTriangles || last.outputTriangles };
      reportOn(r, true);
      toast?.(t("rt.rebaked").replace("{s}", (r.millis / 1000).toFixed(1)));
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
          ? plural("rt.scopeHintPicked", n)
          : t("rt.scopeHintPickedNone")
        : scope === "visible"
          ? hidden
            ? plural("rt.scopeHintVisible", hidden)
            : t("rt.scopeHintVisibleNone")
          : t("rt.scopeHintAll");
    for (const o of el.menu.querySelectorAll("[data-mscope]")) {
      o.classList.toggle("active", o.dataset.mscope === scope);
    }
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
    say2(cursor < 0 ? t("rt.backToSource") : resultOf());
  });
  el.redo.addEventListener("click", async () => {
    await step(1);
    say2(resultOf());
  });

  el.devScale.addEventListener("input", syncDevScale);

  el.showCage.addEventListener("change", () => {
    syncCage();
    say2(el.showCage.checked
      ? cage ? t("rt.cageOn") : t("rt.cageNeedsResult")
      : t("rt.cageOff"));
  });
  el.cageOut.addEventListener("input", syncCage);

  el.run.addEventListener("click", () => {
    if (running) tauri?.core.invoke("retopo_cancel").catch(() => {});
    else run();
  });
  el.rebake.addEventListener("click", rebake);
  // The panel points at the menu rather than holding a second copy of it.
  el.openMenu?.addEventListener("click", () => {
    showMenu(true);
    el.menu.scrollIntoView?.({ block: "nearest" });
  });
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
      // Only after `dressScene`: it is what patches the materials the paint is
      // drawn by, and on a model nobody has run yet nothing has been patched.
      syncPaint();
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
      /*
       * The pen goes down with the mode.
       *
       * The brush holds the canvas's pointer events in the capture phase and
       * turns the orbit controls off while a stroke is live. Leaving it on would
       * leave a viewer whose camera does not respond and whose bar has no brush
       * in it to explain why.
       */
      painting.setTool(null);
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
      return { history, cursor, last, lastRun, hasQuads, devMax, painting: painting.snapshot() };
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
      painting.restore(state?.painting);
      paintHistory();
      syncPaint();
      refresh();
    },
    /** The shared selection moved: only the scope line depends on it. */
    onSelection() {
      paintScope();
      // The cage follows what is chosen, so a scene of several low polys shows
      // the shell of the one being judged rather than the one made last.
      retargetCage();
    },
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
