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
    <h2>Dernier passage</h2>
    <p class="rt-hint" data-el="report">Rien encore.</p>
  </div>
</div>

<div class="rt-bar">
  <button class="wide" type="button" data-el="run">Décimer</button>
  <button class="wide" type="button" data-el="close">Fermer</button>
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

export function createRetopo({ tauri, viewer, importPart, onBusy, onOpenChange }) {
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
  }

  /** The budget in triangles, from the slider's percentage. */
  const budget = () => Math.max(4, Math.round((source * Number(el.target.value)) / 100));

  function paint() {
    el.targetValue.textContent = source ? `${fr(budget())} · ${el.target.value} %` : `${el.target.value} %`;
    el.angleValue.textContent = `${el.angle.value}°`;
    el.seamValue.textContent = el.seam.value;
    el.relaxValue.textContent = el.relax.value;
    el.relaxAngleValue.textContent = `${el.relaxAngle.value}°`;

    el.hudSource.textContent = source ? fr(source) : "—";
    el.hudResult.textContent = last ? fr(last.outputTriangles) : "—";
    el.hudCut.textContent = last
      ? `${(100 - (last.outputTriangles / last.inputTriangles) * 100).toFixed(1)} %`
      : "—";
    el.hudQuads.textContent = last?.quads ? `${(last.quadFraction * 100).toFixed(0)} %` : "—";
  }

  function refresh() {
    source = viewer.current ? countTriangles(viewer.root) : 0;
    el.run.disabled = source === 0 || running || !tauri;
    el.run.title = source === 0 ? "Ouvre un modèle d'abord" : "";
    paint();
  }

  for (const k of ["target", "angle", "seam", "relax", "relaxAngle"]) {
    el[k].addEventListener("input", paint);
  }
  el.mDecimate.addEventListener("click", () => setMethod("decimate"));
  el.mIsotropic.addEventListener("click", () => setMethod("isotropic"));

  async function decimate() {
    if (running || !tauri || !viewer.current) return;
    running = true;
    el.run.disabled = true;
    el.report.textContent = "Export de la scène…";
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

      el.report.textContent = "Décimation…";
      stop = await tauri.event.listen("retopo://progress", (e) => {
        el.report.textContent = `Décimation… ${Math.round((e.payload || 0) * 100)} %`;
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
        },
      });

      el.report.textContent = "Chargement du résultat…";
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
      el.report.textContent = lines.join(" ");
    } catch (e) {
      el.report.textContent = String(e);
    } finally {
      stop?.();
      running = false;
      onBusy?.(false);
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
