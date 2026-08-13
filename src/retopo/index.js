/**
 * Retopology, the browser half.
 *
 * This module is a lazy chunk. Nothing in here is parsed until the Retopo tab is
 * opened for the first time, which matters more than usual: this executable is
 * also the Explorer thumbnail provider, one process per file, and a viewer used
 * only to look at a model should never pay for a decimator it does not call.
 *
 * Nothing large crosses the bridge. The exported GLB goes to a file the Rust
 * side chose, and the result comes back through the loader the application
 * already has, so a fifty megabyte model never becomes a JSON array of numbers.
 */

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

const groupFr = (n) => n.toLocaleString("fr-FR");

export function createRetopo({ tauri, viewer, importPart, onBusy }) {
  const $ = (id) => document.getElementById(id);

  const tools = $("retopo-tools");
  const empty = $("retopo-empty");
  const target = $("retopo-target");
  const targetValue = $("retopo-target-value");
  const angle = $("retopo-angle");
  const angleValue = $("retopo-angle-value");
  const seam = $("retopo-seam");
  const seamValue = $("retopo-seam-value");
  const boundary = $("retopo-boundary");
  const run = $("retopo-run");
  const note = $("retopo-note");
  const report = $("retopo-report");

  let source = 0;
  let running = false;

  /** The budget in triangles, from the slider's percentage. */
  const budget = () => Math.max(4, Math.round((source * Number(target.value)) / 100));

  function paint() {
    targetValue.textContent = source
      ? `${groupFr(budget())} · ${target.value} %`
      : `${target.value} %`;
    angleValue.textContent = `${angle.value}°`;
    seamValue.textContent = seam.value;
  }

  /**
   * Called whenever the scene changes, and on first open.
   *
   * The panel is inert rather than absent when there is nothing loaded: hiding
   * the controls entirely makes the tool look like it cannot do the thing at
   * all, which reads worse than a dimmed panel.
   */
  function refresh() {
    source = viewer.current ? countTriangles(viewer.root) : 0;
    tools.hidden = source === 0;
    empty.hidden = source > 0;
    run.disabled = source === 0 || running || !tauri;
    paint();
  }

  for (const input of [target, angle, seam]) {
    input.addEventListener("input", paint);
  }

  async function decimate() {
    if (running || !tauri || !viewer.current) return;
    running = true;
    run.disabled = true;
    report.hidden = true;
    note.textContent = "Export de la scène…";
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
      const bytes = new Uint8Array(glb);

      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(dirs.input, bytes);

      note.textContent = "Décimation…";
      stop = await tauri.event.listen("retopo://progress", (e) => {
        note.textContent = `Décimation… ${Math.round((e.payload || 0) * 100)} %`;
      });

      const r = await tauri.core.invoke("retopo_decimate", {
        input: dirs.input,
        output: dirs.output,
        request: {
          targetTriangles: budget(),
          preserveBoundary: boundary.checked,
          sharpAngleDeg: Number(angle.value),
          seamPenalty: Number(seam.value),
        },
      });

      note.textContent = "Chargement du résultat…";
      await importPart(dirs.output);

      // The refusals are shown rather than swallowed. A run with a large refusal
      // count and a barely moved triangle count is a guard firing on every
      // candidate, and it looks exactly like a run that simply had nothing left
      // to collapse unless the numbers are on screen.
      const kept = ((r.outputTriangles / r.inputTriangles) * 100).toFixed(1);
      report.textContent =
        `${groupFr(r.inputTriangles)} → ${groupFr(r.outputTriangles)} triangles ` +
        `(${kept} %) · ${groupFr(r.collapses)} fusions · ` +
        `refus ${groupFr(r.rejectedTopology)} topologie, ${groupFr(r.rejectedFlip)} retournement · ` +
        `écart max ${r.maxError.toPrecision(3)} · ${(r.millis / 1000).toFixed(2)} s`;
      report.hidden = false;
      note.textContent = "";
    } catch (e) {
      note.textContent = String(e);
    } finally {
      stop?.();
      running = false;
      onBusy?.(false);
      refresh();
    }
  }

  run.addEventListener("click", decimate);
  refresh();

  return { refresh };
}
