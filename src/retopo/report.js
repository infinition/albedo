/** Combine per-mesh measurements without losing all but the last mesh. */
export function totalReport(reports) {
  const sum = (key) => reports.reduce((n, r) => n + (r?.[key] || 0), 0);
  const worst = (key) => reports.reduce((n, r) => Math.max(n, r?.[key] || 0), 0);
  const weighted = (key) => {
    const measured = reports.filter((r) => Number.isFinite(r?.[key]) && r[key] > 0);
    const weight = measured.reduce((n, r) => n + (r.outputTriangles || 0), 0);
    return weight ? measured.reduce((n, r) => n + r[key] * (r.outputTriangles || 0), 0) / weight : 0;
  };
  const outputTriangles = sum("outputTriangles");
  const quads = sum("quads");
  return {
    ...reports.at(-1),
    inputTriangles: sum("inputTriangles"), outputTriangles, targetTriangles: sum("targetTriangles"),
    millis: sum("millis"), deviationMax: worst("deviationMax"), maxError: worst("maxError"),
    quads, quadFraction: outputTriangles ? 2 * quads / outputTriangles : 0,
    recoveredQuads: sum("recoveredQuads"), collapses: sum("collapses"),
    rejectedTopology: sum("rejectedTopology"), rejectedFlip: sum("rejectedFlip"),
    holesFilled: sum("holesFilled"), holesLeft: sum("holesLeft"),
    hits: sum("hits"), misses: sum("misses"), charts: sum("charts"),
    aspectBefore: weighted("aspectBefore"), aspectAfter: weighted("aspectAfter"),
    // Each run uses the same atlas resolution, so texture utilization is a mean
    // over atlases, not a triangle-weighted mean.
    utilisation: reports.filter((r) => r.charts > 0).reduce((n, r, _, a) => n + (r.utilisation || 0) / a.length, 0),
    maps: [...new Set(reports.flatMap((r) => r.maps || []))],
    meshes: reports.length,
  };
}
