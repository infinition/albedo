import "./retopo.css";

/**
 * The Retopo mode.
 *
 * A third mode beside the inspector and the library, and not a pane inside the
 * inspector: the tool has a triangle budget, three guards, a bake with six knobs
 * and a per material selection to come, and none of that fits a 324 pixel
 * column. It is chrome around the viewport rather than a screen in front of it,
 * because you cannot judge a retopology without looking at it.
 *
 * This module, its stylesheet and the exporter it reaches for are one lazy
 * chunk. Nothing here is parsed until the mode is opened for the first time,
 * which matters more than usual: this executable is also the Explorer thumbnail
 * provider, one process per file.
 *
 * Nothing large crosses the bridge. The exported GLB goes to a file the Rust
 * side chose, the engine runs in a child process, and the result comes back
 * through the loader the application already has.
 */

const SHELL = `
<dl class="rt-hud" data-el="hud">
  <div><dt>Source</dt><dd data-el="hudSource">—</dd></div>
  <div><dt>Résultat</dt><dd data-el="hudResult">—</dd></div>
  <div><dt>Réduction</dt><dd data-el="hudCut">—</dd></div>
  <div><dt>Quads</dt><dd data-el="hudQuads">—</dd></div>
</dl>

<div class="rt-panel" data-el="panel">
  <div class="rt-block">
    <h2>Méthode</h2>
    <div class="segment" role="group" aria-label="Méthode">
      <button class="seg active" type="button" data-el="mDecimate" title="Dépenser le budget là où la silhouette en a besoin">Décimer</button>
      <button class="seg" type="button" data-el="mIsotropic" title="Reconstruire vers des arêtes régulières et une valence de six">Reconstruire</button>
    </div>
    <label class="rt-field">
      <span>Triangles <span class="rt-num" data-el="targetValue">—</span></span>
      <input type="range" data-el="target" min="1" max="90" step="1" value="10" />
    </label>
    <p class="rt-hint" data-el="methodHint">L'erreur quadrique met les triangles là
      où la silhouette en a besoin, pas régulièrement. C'est ce que veut un
      accessoire figé.</p>
  </div>

  <div class="rt-block">
    <h2>Garde-fous</h2>
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
  </div>

  <div class="rt-block">
    <h2>Lissage</h2>
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
  </div>

  <div class="rt-block">
    <h2>Quads</h2>
    <label class="rt-check"><input type="checkbox" data-el="quads" /><span>Apparier les triangles en quads</span></label>
    <p class="rt-hint">glTF n'a pas de quads, donc l'appairage voyage à côté du
      fichier comme un masque de diagonale, un entier par triangle.</p>
  </div>

  <div class="rt-block">
    <h2>Textures</h2>
    <label class="rt-check"><input type="checkbox" data-el="bake" /><span>Projeter la source sur le résultat</span></label>
    <p class="rt-hint">Le maillage réduit porte encore la disposition d'UV de
      l'original, et passé un certain point cette disposition ne décrit plus la
      surface sur laquelle elle est posée. Le bake est ce qui rend une réduction
      agressive utilisable.</p>

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
        abandonné tout seul quand rien n'émet, donc le laisser coché ne coûte
        rien.</p>

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
          donc deux bakes du même modèle se ressemblent exactement et comparer
          deux réglages n'est pas une devinette.</p>
      </div>

      <p class="rt-sub">Cage</p>
      <label class="rt-field">
        <span>Vers l'extérieur <span class="rt-num" data-el="cageOutValue">0.02</span></span>
        <input type="range" data-el="cageOut" min="0.001" max="0.2" step="0.001" value="0.02" />
      </label>
      <label class="rt-field">
        <span>Vers l'intérieur <span class="rt-num" data-el="cageInValue">0.02</span></span>
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
  </div>

  <div class="rt-block">
    <h2>Dernier passage</h2>
    <p class="rt-hint" data-el="report">Rien encore.</p>
  </div>
</div>

<div class="rt-bar" data-el="bar">
  <button class="wide" type="button" data-el="run">Décimer</button>
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

export function createRetopo({ tauri, viewer, importPart, onBusy, onOpenChange, toast }) {
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

  const METHOD_HINT = {
    decimate:
      "L'erreur quadrique met les triangles là où la silhouette en a besoin, pas " +
      "régulièrement. C'est ce que veut un accessoire figé.",
    isotropic:
      "Des arêtes de longueur égale et une valence de six, ce qui donne des boucles " +
      "prévisibles autour d'une articulation. C'est ce que veut un modèle qui va se " +
      "déformer ou se subdiviser, et c'est aussi ce dont l'appairage en quads a besoin.",
  };

  function setMethod(next) {
    method = next;
    el.mDecimate.classList.toggle("active", next === "decimate");
    el.mIsotropic.classList.toggle("active", next === "isotropic");
    el.methodHint.textContent = METHOD_HINT[next];
    // The run button says what it will do, and the method is what decides that.
    paint();
  }

  /** The budget in triangles, from the slider's percentage. */
  const budget = () => Math.max(4, Math.round((source * Number(el.target.value)) / 100));

  /** The atlas side, from the slider's exponent. */
  const mapSize = () => 2 ** Number(el.mapSize.value);

  function paint() {
    el.targetValue.textContent = source ? `${fr(budget())} · ${el.target.value} %` : `${el.target.value} %`;
    el.angleValue.textContent = `${el.angle.value}°`;
    el.seamValue.textContent = el.seam.value;
    el.relaxValue.textContent = el.relax.value;
    el.relaxAngleValue.textContent = `${el.relaxAngle.value}°`;

    // The atlas slider is an exponent, because the useful sizes are powers of
    // two and a linear 256..8192 slider spends most of its travel on values
    // nobody picks.
    el.mapSizeValue.textContent = String(mapSize());
    el.cageOutValue.textContent = Number(el.cageOut.value).toFixed(3);
    el.cageInValue.textContent = Number(el.cageIn.value).toFixed(3);
    el.gutterValue.textContent = el.gutter.value;
    el.bleedValue.textContent = el.bleed.value;
    el.islandValue.textContent = `${el.island.value}°`;
    el.aoSamplesValue.textContent = el.aoSamples.value;
    el.aoDistanceValue.textContent = Number(el.aoDistance.value).toFixed(2);

    el.bakeTools.classList.toggle("rt-off", !el.bake.checked);
    el.aoTools.classList.toggle("rt-off", !el.mAo.checked);

    setStat(el.hudSource, source ? fr(source) : null);
    setStat(el.hudResult, last ? fr(last.outputTriangles) : null);
    setStat(
      el.hudCut,
      last ? `${(100 - (last.outputTriangles / last.inputTriangles) * 100).toFixed(1)} %` : null
    );
    setStat(el.hudQuads, last?.quads ? `${(last.quadFraction * 100).toFixed(0)} %` : null);

    // The button says what it will do, because the method segment is above the
    // fold and the button is at the bottom of the window.
    el.run.textContent = el.bake.checked
      ? method === "isotropic"
        ? "Reconstruire et projeter"
        : "Décimer et projeter"
      : method === "isotropic"
        ? "Reconstruire"
        : "Décimer";
  }

  /** A stat nobody has filled in yet should not read as loudly as a real one. */
  function setStat(node, text) {
    node.textContent = text ?? "—";
    node.classList.toggle("rt-void", text == null);
  }

  function refresh() {
    source = viewer.current ? countTriangles(viewer.root) : 0;
    el.run.disabled = source === 0 || running || !tauri;
    el.run.title = source === 0 ? "Ouvre un modèle d'abord" : "";
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

  /** The bar, the fill and the note, in one place so they cannot disagree. */
  function say(text, fraction) {
    el.note.textContent = text || "";
    el.bar.classList.toggle("busy", running);
    if (typeof fraction === "number") el.fill.style.width = `${Math.round(fraction * 100)}%`;
  }

  async function decimate() {
    if (running || !tauri || !viewer.current) return;
    running = true;
    el.run.disabled = true;
    el.fill.style.width = "0%";
    say("Export de la scène…", 0);
    onBusy?.(true);

    let stop = null;
    try {
      const dirs = await tauri.core.invoke("retopo_workdir");

      // The group, not the object inside it: the orientation buttons and the
      // edit handles both write to the group, so exporting the object alone
      // hands the engine a model still lying on its side.
      const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
      const glb = await new GLTFExporter().parseAsync(viewer.root, {
        binary: true,
        includeCustomExtensions: true,
      });

      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(dirs.input, new Uint8Array(glb));

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
        input: dirs.input,
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
          bake: el.bake.checked,
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
        },
      });

      say("Chargement du résultat…", 1);
      await importPart(dirs.output);
      last = r;

      // The refusals are shown rather than swallowed. A run with a large refusal
      // count and a barely moved triangle count is a guard firing on every
      // candidate, and it looks exactly like a run that simply had nothing left
      // to collapse unless the numbers are on screen.
      const lines = [
        `${fr(r.inputTriangles)} → ${fr(r.outputTriangles)} triangles en ` +
          `${(r.millis / 1000).toFixed(2)} s, déviation maximum ` +
          `${r.deviationMax.toPrecision(3)} unité.`,
      ];
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
      if (r.charts) {
        const total = r.hits + r.misses;
        const miss = total ? (r.misses / total) * 100 : 0;
        lines.push(
          `Atlas : ${fr(r.charts)} îlots, ${(r.utilisation * 100).toFixed(0)} % occupé, ` +
            `${miss.toFixed(1)} % de rayons manqués.`
        );
        lines.push(`Cartes : ${r.maps.join(", ")}.`);
        // A miss is a ray that fell back to the nearest surface point rather
        // than finding the high poly. A few are normal; a lot means the cage is
        // too tight for this pair of meshes, or a chart wrapped around something
        // thin. Worth saying out loud rather than leaving in a number.
        if (miss > 15) {
          lines.push("Beaucoup de manques : essaie une cage plus longue.");
        }
      }
      el.report.textContent = lines.join(" ");

      const cut = (100 - (r.outputTriangles / r.inputTriangles) * 100).toFixed(0);
      toast?.(`${fr(r.outputTriangles)} triangles, ${cut} % de moins`);
      say("");
    } catch (e) {
      el.report.textContent = String(e);
      say("");
      toast?.("La retopologie a échoué");
    } finally {
      stop?.();
      running = false;
      onBusy?.(false);
      el.bar.classList.remove("busy");
      refresh();
    }
  }

  el.run.addEventListener("click", decimate);
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
