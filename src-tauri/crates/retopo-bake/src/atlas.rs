//! UV atlas generation, in pure Rust.
//!
//! The obvious move here is xatlas, and xatlas is better than this. It also
//! needs bindgen, which needs libclang, on every machine and every CI runner,
//! for a tool whose whole pitch is one binary with nothing to install. So this
//! does the job the honest cheap way:
//!
//! 1. **Charts** grow from a seed triangle across edge neighbours, accepting a
//!    face while it stays within an angle of the chart's running mean normal and
//!    does not fold over when projected. Creases stop growth.
//! 2. **Parameterisation** is a plane projection per chart. Not conformal, but
//!    the angle bound caps the stretch: at 50 degrees the worst case is about
//!    1.6x, which a bake target absorbs without visible artefacts.
//! 3. **Packing** is skyline bottom-left over chart bounding boxes, at a single
//!    world-to-texel scale so texel density is uniform across the model.
//!
//! Vertices are duplicated at chart borders, which is what a seam is.
//!
//! The interface is deliberately the same shape xatlas exposes, so swapping in a
//! vendored copy later changes this file and nothing else.

use std::collections::HashMap;

use glam::{Vec2, Vec3};
use retopo_core::util::UnionFind;
use retopo_core::{Adjacency, Mesh};

#[derive(Clone, Debug)]
pub struct AtlasOptions {
    /// Atlas edge, in texels. Charts are scaled to fill it.
    pub resolution: u32,
    /// Empty texels kept between charts, so bilinear sampling and mip levels
    /// never bleed one chart into its neighbour.
    pub padding: u32,
    /// A face joins a chart while its normal stays within this of the chart's
    /// mean. Lower means more charts, more seams, less stretch.
    pub max_chart_angle_deg: f32,
    /// Edges sharper than this always start a new chart.
    pub crease_angle_deg: f32,
    /// Charts smaller than this are absorbed by a neighbour.
    ///
    /// Growth alone leaves a long tail of tiny charts, and each one costs two
    /// seams and a full padding gutter. Swallowing them is worth a little extra
    /// stretch.
    pub min_chart_triangles: usize,
    /// How far a small chart may bend to be absorbed.
    pub merge_angle_deg: f32,
}

impl Default for AtlasOptions {
    fn default() -> Self {
        Self {
            resolution: 2048,
            padding: 4,
            max_chart_angle_deg: 50.0,
            crease_angle_deg: 60.0,
            min_chart_triangles: 24,
            merge_angle_deg: 85.0,
        }
    }
}

/// A mesh re-indexed with fresh texture coordinates.
#[derive(Clone, Debug, Default)]
pub struct Atlas {
    pub positions: Vec<Vec3>,
    pub normals: Vec<Vec3>,
    pub uvs: Vec<Vec2>,
    pub triangles: Vec<[u32; 3]>,
    /// Source vertex each output vertex came from.
    pub xref: Vec<u32>,
    /// Chart index per triangle, in the order of [`Atlas::triangles`].
    ///
    /// Note that order is *not* the input order: triangles are grouped by chart,
    /// which keeps a chart's texels contiguous and lets a consumer draw or
    /// rasterise one chart at a time.
    pub chart_of_tri: Vec<u32>,
    pub chart_count: usize,
    /// Share of the atlas actually covered by charts, before padding.
    pub utilisation: f32,
    /// Texels per world unit. Useful to report, and to compare two bakes.
    pub texel_density: f32,
}

/// Take the atlas the mesh already carries, instead of making a new one.
///
/// **A bake regenerates the UV layout every time, and that is the thing that
/// makes a second bake useless as a correction.** Change a cage distance and
/// re-run, and what comes back is not a fixed version of the texture you had —
/// it is a different texture, with the islands somewhere else. Nothing can be
/// compared against the previous result, nothing can be patched into it, and any
/// work done downstream of the first bake is thrown away.
///
/// So: when a mesh already has coordinates worth keeping, keep them. The bake
/// then answers a question it could not answer before — "shoot these rays again,
/// into the picture I already have" — and that is what makes a partial re-bake
/// possible at all.
///
/// # Charts, for free
///
/// The one thing an atlas holds that a bare mesh does not is which chart each
/// triangle belongs to, and it does not have to be guessed: **unwrapping is
/// exactly the act of splitting vertices at chart borders.** Two triangles in a
/// laid-out mesh share a render vertex if and only if they are in the same
/// island — the seam is the duplication. So the charts fall out of a union-find
/// over the triangles' own corners, with no geometry and no angle threshold
/// involved.
///
/// Returns `None` when the mesh has no usable coordinates, so a caller that
/// asked for this on a mesh that has never been unwrapped is told rather than
/// handed a single chart covering a fold.
pub fn from_uvs(mesh: &Mesh) -> Option<Atlas> {
    let nt = mesh.triangle_count();
    if nt == 0 || mesh.uvs.len() != mesh.positions.len() {
        return None;
    }

    // Coordinates that are all zero are the absence of an unwrap written down,
    // which several exporters do. Rasterising that puts the whole model on one
    // texel and reports a healthy looking utilisation.
    let spread = mesh.uvs.iter().fold((f32::MAX, f32::MIN), |(lo, hi), uv| {
        (lo.min(uv.x).min(uv.y), hi.max(uv.x).max(uv.y))
    });
    if !(spread.1 - spread.0).is_finite() || spread.1 - spread.0 < 1e-6 {
        return None;
    }

    let mut find = UnionFind::new(mesh.positions.len());
    for f in &mesh.triangles {
        find.union(f[0], f[1]);
        find.union(f[1], f[2]);
    }

    let mut label: HashMap<u32, u32> = HashMap::new();
    let mut chart_of_tri = Vec::with_capacity(nt);
    for f in &mesh.triangles {
        let root = find.find(f[0]);
        let next = label.len() as u32;
        chart_of_tri.push(*label.entry(root).or_insert(next));
    }

    // Utilisation is reported the same way `unwrap` reports it — the share of
    // the square the charts actually cover — so the two paths can be compared in
    // the same column of the same report.
    let mut uv_area = 0.0f32;
    let mut world_area = 0.0f32;
    for (t, f) in mesh.triangles.iter().enumerate() {
        let (a, b, c) = (f[0] as usize, f[1] as usize, f[2] as usize);
        let (ua, ub, uc) = (mesh.uvs[a], mesh.uvs[b], mesh.uvs[c]);
        uv_area += ((ub - ua).perp_dot(uc - ua)).abs() * 0.5;
        world_area += mesh.face_area(t);
    }

    Some(Atlas {
        positions: mesh.positions.clone(),
        normals: if mesh.normals.len() == mesh.positions.len() {
            mesh.normals.clone()
        } else {
            vec![Vec3::Y; mesh.positions.len()]
        },
        uvs: mesh.uvs.clone(),
        triangles: mesh.triangles.clone(),
        // Identity: nothing was re-indexed, which is the whole point. It is also
        // what lets a caller map an atlas triangle back to the mesh triangle it
        // came from, and therefore what makes a painted region addressable here.
        xref: (0..mesh.positions.len() as u32).collect(),
        chart_of_tri,
        chart_count: label.len(),
        utilisation: uv_area.clamp(0.0, 1.0),
        texel_density: if world_area > 1e-12 {
            (uv_area / world_area).sqrt()
        } else {
            0.0
        },
    })
}

pub fn unwrap(mesh: &Mesh, opts: &AtlasOptions) -> Atlas {
    let nt = mesh.triangle_count();
    if nt == 0 {
        return Atlas::default();
    }

    let adj = Adjacency::build(mesh);
    let creases = adj.sharp_edges(mesh, opts.crease_angle_deg);
    let mut charts = grow_charts(mesh, &adj, &creases, opts);
    merge_small(mesh, &adj, &mut charts, opts);

    // Project every chart into its own plane and measure it.
    let mut flats: Vec<FlatChart> = charts
        .iter()
        .map(|c| project(mesh, c))
        .collect();

    // One scale for the whole atlas keeps texel density uniform: a bake where
    // the head is four times denser than the body is worse than a coarser bake.
    let inner = opts.resolution.saturating_sub(opts.padding * 2).max(1) as f32;
    let mut scale = choose_scale(&flats, opts, inner);

    // The area estimate is only an estimate: bounding boxes waste more room than
    // it predicts, and how much depends on the shape mix. So shrink until the
    // packer actually succeeds rather than trusting the first guess.
    let placements = loop {
        for f in &mut flats {
            f.texels = (f.size * scale).ceil().max(Vec2::ONE);
        }
        if let Some(p) = pack(&flats, opts) {
            break p;
        }
        scale *= 0.85;
        if scale < 1e-6 {
            // Cannot happen with a sane resolution, but a silent infinite loop
            // would be far worse than a coarse atlas.
            tracing::warn!("atlas packing gave up; charts will overlap");
            break vec![Placement { x: 0.0, y: 0.0 }; flats.len()];
        }
    };

    build(mesh, &charts, &flats, &placements, opts, scale)
}

/* ------------------------------------------------------------------ charts */

struct Chart {
    tris: Vec<u32>,
    normal: Vec3,
}

fn grow_charts(mesh: &Mesh, adj: &Adjacency, creases: &[bool], opts: &AtlasOptions) -> Vec<Chart> {
    let nt = mesh.triangle_count();
    let mut chart_of = vec![u32::MAX; nt];
    let mut charts: Vec<Chart> = Vec::new();

    // Seed from the largest remaining face: big faces set a chart's plane more
    // reliably than slivers, which drift the mean normal around.
    let mut order: Vec<u32> = (0..nt as u32).collect();
    order.sort_unstable_by(|&a, &b| {
        mesh.face_area(b as usize)
            .total_cmp(&mesh.face_area(a as usize))
    });

    let cos_limit = opts.max_chart_angle_deg.to_radians().cos();
    let mut queue: Vec<u32> = Vec::new();

    for &seed in &order {
        if chart_of[seed as usize] != u32::MAX {
            continue;
        }
        let seed_normal = mesh.face_normal(seed as usize);
        if seed_normal == Vec3::ZERO {
            continue;
        }

        let id = charts.len() as u32;
        charts.push(Chart {
            tris: vec![seed],
            normal: seed_normal,
        });
        chart_of[seed as usize] = id;
        // Area weighted running mean: normalising only at the end would let a
        // thousand slivers outvote the face the chart is actually made of.
        let mut sum = seed_normal * mesh.face_area(seed as usize);

        queue.clear();
        queue.push(seed);
        while let Some(t) = queue.pop() {
            for k in 0..3 {
                let edge = adj.tri_edges[t as usize][k] as usize;
                if creases[edge] {
                    continue;
                }
                let e = &adj.edges[edge];
                let Some(next) = (match (e.tri[0], e.tri[1]) {
                    (Some(a), Some(b)) if a == t => Some(b),
                    (Some(a), Some(b)) if b == t => Some(a),
                    _ => None,
                }) else {
                    continue;
                };
                if chart_of[next as usize] != u32::MAX {
                    continue;
                }
                let n = mesh.face_normal(next as usize);
                if n == Vec3::ZERO {
                    continue;
                }
                let mean = sum.normalize_or_zero();
                if mean.dot(n) < cos_limit {
                    continue;
                }
                chart_of[next as usize] = id;
                charts[id as usize].tris.push(next);
                sum += n * mesh.face_area(next as usize);
                queue.push(next);
            }
        }
        charts[id as usize].normal = sum.normalize_or_zero();
        if charts[id as usize].normal == Vec3::ZERO {
            charts[id as usize].normal = seed_normal;
        }
    }

    // Any face the growth could not reach, typically a degenerate one, becomes
    // its own chart rather than vanishing from the atlas.
    for (t, slot) in chart_of.iter_mut().enumerate() {
        if *slot == u32::MAX {
            *slot = charts.len() as u32;
            charts.push(Chart {
                tris: vec![t as u32],
                normal: {
                    let n = mesh.face_normal(t);
                    if n == Vec3::ZERO {
                        Vec3::Y
                    } else {
                        n
                    }
                },
            });
        }
    }
    charts
}


/// Absorb charts too small to be worth their own gutters.
///
/// Growth stops at the first neighbour that fails the angle test and never
/// reconsiders it, which leaves a long tail of chart fragments: on a decimated
/// organic model that was eight hundred charts for twelve thousand triangles,
/// roughly fifteen faces each. Every one of those borders is a seam the bake has
/// to pad and the renderer has to filter across, so a fragment is merged into
/// whichever neighbour it agrees with most, repeatedly, until none are left.
fn merge_small(mesh: &Mesh, adj: &Adjacency, charts: &mut Vec<Chart>, opts: &AtlasOptions) {
    if opts.min_chart_triangles <= 1 {
        return;
    }
    let cos_limit = opts.merge_angle_deg.to_radians().cos();
    let nt = mesh.triangle_count();

    // Merging changes who is small, so this runs to a fixed point. The bound is
    // a safety net, not an expected exit.
    for _ in 0..32 {
        let mut chart_of = vec![u32::MAX; nt];
        for (ci, c) in charts.iter().enumerate() {
            for &t in &c.tris {
                chart_of[t as usize] = ci as u32;
            }
        }

        // Shared border length per pair of charts: a fragment belongs with the
        // neighbour it actually touches, not merely the one it points at.
        let mut border: HashMap<(u32, u32), f32> = HashMap::new();
        for e in &adj.edges {
            let (Some(a), Some(b)) = (e.tri[0], e.tri[1]) else {
                continue;
            };
            let (ca, cb) = (chart_of[a as usize], chart_of[b as usize]);
            if ca == cb || ca == u32::MAX || cb == u32::MAX {
                continue;
            }
            let length = mesh.positions[e.v[0] as usize]
                .distance(mesh.positions[e.v[1] as usize]);
            *border.entry((ca.min(cb), ca.max(cb))).or_insert(0.0) += length;
        }

        let mut best_target: Vec<Option<(u32, f32)>> = vec![None; charts.len()];
        for (&(a, b), &length) in &border {
            for (small, big) in [(a, b), (b, a)] {
                if charts[small as usize].tris.len() >= opts.min_chart_triangles {
                    continue;
                }
                if charts[small as usize]
                    .normal
                    .dot(charts[big as usize].normal)
                    < cos_limit
                {
                    continue;
                }
                let slot = &mut best_target[small as usize];
                if slot.map(|(_, l)| length > l).unwrap_or(true) {
                    *slot = Some((big, length));
                }
            }
        }

        // Only merge into charts that are not themselves being merged away, so
        // one pass cannot build a chain that loses triangles.
        let mut merged_any = false;
        let mut absorb: Vec<(u32, u32)> = Vec::new();
        for (small, target) in best_target.iter().enumerate() {
            let Some((big, _)) = *target else { continue };
            if best_target[big as usize].is_some() {
                continue;
            }
            absorb.push((small as u32, big));
            merged_any = true;
        }
        if !merged_any {
            break;
        }

        for &(small, big) in &absorb {
            let taken = std::mem::take(&mut charts[small as usize].tris);
            let area: f32 = taken.iter().map(|&t| mesh.face_area(t as usize)).sum();
            let small_normal = charts[small as usize].normal;
            let big_area: f32 = charts[big as usize]
                .tris
                .iter()
                .map(|&t| mesh.face_area(t as usize))
                .sum();
            let target = &mut charts[big as usize];
            target.normal = (target.normal * big_area + small_normal * area)
                .normalize_or_zero();
            if target.normal == Vec3::ZERO {
                target.normal = small_normal;
            }
            target.tris.extend(taken);
        }
        charts.retain(|c| !c.tris.is_empty());
    }
}

/* --------------------------------------------------------- parameterisation */

struct FlatChart {
    /// Chart plane basis.
    tangent: Vec3,
    bitangent: Vec3,
    /// Projected coordinates, per source vertex touched by the chart.
    uv: HashMap<u32, Vec2>,
    min: Vec2,
    size: Vec2,
    /// World area, used to pick a scale that fills the atlas.
    area: f32,
    texels: Vec2,
}

/// An orthonormal pair spanning the plane with this normal.
fn basis(n: Vec3) -> (Vec3, Vec3) {
    // Cross with whichever axis the normal leans on least, so the result never
    // degenerates.
    let a = n.abs();
    let axis = if a.x <= a.y && a.x <= a.z {
        Vec3::X
    } else if a.y <= a.z {
        Vec3::Y
    } else {
        Vec3::Z
    };
    let t = n.cross(axis).normalize_or_zero();
    let t = if t == Vec3::ZERO { Vec3::X } else { t };
    (t, n.cross(t).normalize_or_zero())
}

fn project(mesh: &Mesh, chart: &Chart) -> FlatChart {
    let (tangent, bitangent) = basis(chart.normal);
    let mut uv: HashMap<u32, Vec2> = HashMap::new();
    let mut min = Vec2::splat(f32::INFINITY);
    let mut max = Vec2::splat(f32::NEG_INFINITY);
    let mut area = 0.0f32;

    for &t in &chart.tris {
        area += mesh.face_area(t as usize);
        for &c in &mesh.triangles[t as usize] {
            let p = mesh.positions[c as usize];
            let q = Vec2::new(p.dot(tangent), p.dot(bitangent));
            uv.insert(c, q);
            min = min.min(q);
            max = max.max(q);
        }
    }
    let size = (max - min).max(Vec2::splat(1e-6));
    FlatChart {
        tangent,
        bitangent,
        uv,
        min,
        size,
        area,
        texels: Vec2::ONE,
    }
}

/// Texels per world unit, chosen so the charts roughly fill the atlas.
///
/// Solved analytically from the total projected area, then walked down until the
/// packer actually succeeds, because bounding boxes waste more space than area
/// alone predicts.
fn choose_scale(flats: &[FlatChart], opts: &AtlasOptions, inner: f32) -> f32 {
    let boxed: f32 = flats.iter().map(|f| f.size.x * f.size.y).sum();
    if boxed <= 0.0 {
        return 1.0;
    }
    // Assume the packer wastes about a third, and reserve the padding gutters.
    let usable = inner * inner * 0.66;
    let mut scale = (usable / boxed).sqrt();

    // Padding is a fixed texel cost per chart, so a scale that makes charts
    // smaller than their own gutters is never worth taking.
    let pad = opts.padding.max(1) as f32;
    let smallest = flats
        .iter()
        .map(|f| f.size.x.min(f.size.y))
        .fold(f32::INFINITY, f32::min);
    if smallest.is_finite() && smallest > 0.0 {
        scale = scale.max(pad / smallest);
    }
    scale.max(1e-6)
}

/* ----------------------------------------------------------------- packing */

#[derive(Clone, Copy, Debug)]
struct Placement {
    x: f32,
    y: f32,
}

/// Skyline bottom-left, bounded by the atlas on both axes.
///
/// Charts go in tallest first onto a running height profile, which fills far
/// better than shelves for the mix of sizes a chart decomposition produces.
/// Returns `None` when something does not fit, so the caller can rescale.
fn pack(flats: &[FlatChart], opts: &AtlasOptions) -> Option<Vec<Placement>> {
    let pad = opts.padding as f32;
    let limit = opts.resolution as f32;

    let mut order: Vec<usize> = (0..flats.len()).collect();
    order.sort_unstable_by(|&a, &b| flats[b].texels.y.total_cmp(&flats[a].texels.y));

    let mut placements = vec![Placement { x: 0.0, y: 0.0 }; flats.len()];
    // Steps across the atlas: from `x` onward the profile is `y`, until the next.
    let mut skyline: Vec<(f32, f32)> = vec![(0.0, 0.0)];

    for &i in &order {
        let w = flats[i].texels.x + pad * 2.0;
        let h = flats[i].texels.y + pad * 2.0;
        if w > limit || h > limit {
            return None;
        }
        let (x, y) = fit(&skyline, w, h, limit)?;
        placements[i] = Placement { x: x + pad, y: y + pad };
        raise(&mut skyline, x, w, y + h, limit);
    }
    Some(placements)
}

/// Lowest, then leftmost, spot where a `w` by `h` box fits inside the atlas.
fn fit(skyline: &[(f32, f32)], w: f32, h: f32, limit: f32) -> Option<(f32, f32)> {
    let mut best: Option<(f32, f32)> = None;
    for i in 0..skyline.len() {
        let x = skyline[i].0;
        if x + w > limit {
            break;
        }
        // A box rests on the highest step it spans.
        let mut y = 0.0f32;
        let mut j = i;
        while j < skyline.len() && skyline[j].0 < x + w {
            y = y.max(skyline[j].1);
            j += 1;
        }
        if y + h > limit {
            continue;
        }
        let better = match best {
            None => true,
            Some((bx, by)) => y < by || (y == by && x < bx),
        };
        if better {
            best = Some((x, y));
        }
    }
    best
}

/// Lift the profile to `top` across `[x, x + w)`, preserving it either side.
fn raise(skyline: &mut Vec<(f32, f32)>, x: f32, w: f32, top: f32, limit: f32) {
    let right = x + w;
    // Height that applies immediately past the box, taken from the last step
    // that starts at or before it.
    let mut after = 0.0f32;
    for &(sx, sy) in skyline.iter() {
        if sx > right {
            break;
        }
        after = sy;
    }

    skyline.retain(|&(sx, _)| sx < x || sx > right);
    skyline.push((x, top));
    if right < limit {
        skyline.push((right, after));
    }
    skyline.sort_by(|a, b| a.0.total_cmp(&b.0));
    // Merge steps that ended up at the same height; keeping them costs a linear
    // scan on every later fit for no information.
    skyline.dedup_by(|a, b| a.1 == b.1);
}

/* ------------------------------------------------------------------ output */

fn build(
    mesh: &Mesh,
    charts: &[Chart],
    flats: &[FlatChart],
    placements: &[Placement],
    opts: &AtlasOptions,
    scale: f32,
) -> Atlas {
    let res = opts.resolution as f32;
    let mut out = Atlas {
        chart_count: charts.len(),
        texel_density: scale,
        ..Default::default()
    };

    let mut covered = 0.0f32;
    for (ci, chart) in charts.iter().enumerate() {
        let flat = &flats[ci];
        let place = placements[ci];
        covered += flat.texels.x * flat.texels.y;

        // One vertex map per chart: a point shared with another chart is
        // duplicated here, and that duplication is the seam.
        let mut local: HashMap<u32, u32> = HashMap::new();
        for &t in &chart.tris {
            let f = mesh.triangles[t as usize];
            let mut tri = [0u32; 3];
            for (k, &c) in f.iter().enumerate() {
                tri[k] = *local.entry(c).or_insert_with(|| {
                    let flat_uv = flat.uv.get(&c).copied().unwrap_or(Vec2::ZERO);
                    let texel = (flat_uv - flat.min) * scale + Vec2::new(place.x, place.y);
                    let id = out.positions.len() as u32;
                    out.positions.push(mesh.positions[c as usize]);
                    out.normals.push(
                        mesh.normals
                            .get(c as usize)
                            .copied()
                            .unwrap_or(chart.normal),
                    );
                    out.uvs.push(texel / res);
                    out.xref.push(c);
                    id
                });
            }
            out.triangles.push(tri);
            out.chart_of_tri.push(ci as u32);
        }
        let _ = (flat.tangent, flat.bitangent, flat.area);
    }

    out.utilisation = covered / (res * res);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use retopo_core::mesh::Material;

    /// Axis aligned box: six flat faces, so a correct chart pass finds exactly
    /// six charts and every one of them is undistorted.
    fn box_mesh() -> Mesh {
        let c = [
            Vec3::new(-1.0, -1.0, -1.0),
            Vec3::new(1.0, -1.0, -1.0),
            Vec3::new(1.0, 1.0, -1.0),
            Vec3::new(-1.0, 1.0, -1.0),
            Vec3::new(-1.0, -1.0, 1.0),
            Vec3::new(1.0, -1.0, 1.0),
            Vec3::new(1.0, 1.0, 1.0),
            Vec3::new(-1.0, 1.0, 1.0),
        ];
        let faces = [
            [0, 3, 2, 1],
            [4, 5, 6, 7],
            [0, 4, 7, 3],
            [1, 2, 6, 5],
            [0, 1, 5, 4],
            [3, 7, 6, 2],
        ];
        let mut m = Mesh::default();
        for f in faces {
            let base = m.positions.len() as u32;
            for &k in &f {
                m.positions.push(c[k]);
            }
            m.triangles.push([base, base + 1, base + 2]);
            m.triangles.push([base, base + 2, base + 3]);
            m.tri_material.push(0);
            m.tri_material.push(0);
        }
        m.materials.push(Material::default());
        m.rebuild_weld(0.0);
        m.compute_normals(40.0);
        m
    }

    fn sphere(segments: usize, rings: usize) -> Mesh {
        use std::f32::consts::PI;
        let mut m = Mesh::default();
        for r in 0..=rings {
            let theta = r as f32 / rings as f32 * PI;
            for s in 0..=segments {
                let p = if r == 0 {
                    Vec3::Y
                } else if r == rings {
                    -Vec3::Y
                } else {
                    let phi = (s % segments) as f32 / segments as f32 * 2.0 * PI;
                    Vec3::new(theta.sin() * phi.cos(), theta.cos(), theta.sin() * phi.sin())
                };
                m.positions.push(p);
            }
        }
        let idx = |s: usize, r: usize| (r * (segments + 1) + s) as u32;
        for r in 0..rings {
            for s in 0..segments {
                m.triangles.push([idx(s, r), idx(s + 1, r), idx(s + 1, r + 1)]);
                m.triangles.push([idx(s, r), idx(s + 1, r + 1), idx(s, r + 1)]);
                m.tri_material.push(0);
                m.tri_material.push(0);
            }
        }
        m.materials.push(Material::default());
        m.rebuild_weld(0.0);
        m.remove_degenerate();
        m.compact();
        m.rebuild_weld(0.0);
        m.compute_normals(40.0);
        m
    }

    fn every_uv_in_unit_square(a: &Atlas) {
        for uv in &a.uvs {
            assert!(
                uv.x >= -1e-4 && uv.x <= 1.0 + 1e-4 && uv.y >= -1e-4 && uv.y <= 1.0 + 1e-4,
                "uv {uv:?} escaped the atlas"
            );
        }
    }

    #[test]
    fn a_box_splits_into_its_six_faces() {
        let m = box_mesh();
        let a = unwrap(&m, &AtlasOptions::default());
        assert_eq!(a.chart_count, 6, "a cube has six developable sides");
        assert_eq!(a.triangles.len(), 12);
        every_uv_in_unit_square(&a);
    }

    #[test]
    fn a_box_chart_keeps_its_shape_exactly() {
        // Each side is already planar, so its projection must be a rigid motion:
        // the ratio of UV area to world area is the same for every triangle.
        let m = box_mesh();
        let a = unwrap(&m, &AtlasOptions::default());
        let mut ratios = Vec::new();
        for (t, f) in a.triangles.iter().enumerate() {
            let uv: Vec<Vec2> = f.iter().map(|&i| a.uvs[i as usize]).collect();
            let uv_area = ((uv[1] - uv[0]).perp_dot(uv[2] - uv[0])).abs() * 0.5;
            let p: Vec<Vec3> = f.iter().map(|&i| a.positions[i as usize]).collect();
            let world = (p[1] - p[0]).cross(p[2] - p[0]).length() * 0.5;
            assert!(uv_area > 0.0, "triangle {t} has no area in the atlas");
            ratios.push(uv_area / world);
        }
        let first = ratios[0];
        for r in &ratios {
            assert!(
                (r / first - 1.0).abs() < 1e-3,
                "texel density drifts across a planar chart: {ratios:?}"
            );
        }
    }

    #[test]
    fn every_triangle_survives_and_has_area() {
        let m = sphere(24, 16);
        let a = unwrap(&m, &AtlasOptions::default());
        assert_eq!(a.triangles.len(), m.triangle_count());
        assert_eq!(a.chart_of_tri.len(), m.triangle_count());
        every_uv_in_unit_square(&a);

        let degenerate = a
            .triangles
            .iter()
            .filter(|f| {
                let uv: Vec<Vec2> = f.iter().map(|&i| a.uvs[i as usize]).collect();
                (uv[1] - uv[0]).perp_dot(uv[2] - uv[0]).abs() < 1e-12
            })
            .count();
        assert_eq!(degenerate, 0, "{degenerate} triangles collapsed in UV space");
    }

    #[test]
    fn seams_duplicate_vertices_rather_than_sharing_them() {
        let m = box_mesh();
        let a = unwrap(&m, &AtlasOptions::default());
        // A cube corner belongs to three charts, so it must appear three times.
        assert_eq!(a.positions.len(), 24, "six charts of four corners");
        assert_eq!(a.xref.len(), a.positions.len());
        for &x in &a.xref {
            assert!((x as usize) < m.vertex_count());
        }
    }

    #[test]
    fn a_tighter_angle_makes_more_charts() {
        let m = sphere(24, 16);
        let loose = unwrap(&m, &AtlasOptions { max_chart_angle_deg: 70.0, ..Default::default() });
        let tight = unwrap(&m, &AtlasOptions { max_chart_angle_deg: 20.0, ..Default::default() });
        assert!(
            tight.chart_count > loose.chart_count,
            "{} charts at 20 degrees against {} at 70",
            tight.chart_count,
            loose.chart_count
        );
    }

    #[test]
    fn charts_do_not_overlap_in_the_atlas() {
        // The packer is the part most likely to be subtly wrong, and an overlap
        // shows up as one part of the model wearing another part's texture.
        let m = sphere(16, 12);
        let opts = AtlasOptions { resolution: 512, ..Default::default() };
        let a = unwrap(&m, &opts);

        let mut boxes: Vec<(u32, Vec2, Vec2)> = Vec::new();
        for c in 0..a.chart_count as u32 {
            let mut lo = Vec2::splat(f32::INFINITY);
            let mut hi = Vec2::splat(f32::NEG_INFINITY);
            let mut any = false;
            for (t, &ct) in a.chart_of_tri.iter().enumerate() {
                if ct != c {
                    continue;
                }
                any = true;
                for &i in &a.triangles[t] {
                    lo = lo.min(a.uvs[i as usize]);
                    hi = hi.max(a.uvs[i as usize]);
                }
            }
            if any {
                boxes.push((c, lo, hi));
            }
        }
        for i in 0..boxes.len() {
            for j in i + 1..boxes.len() {
                let (_, alo, ahi) = boxes[i];
                let (_, blo, bhi) = boxes[j];
                let overlap = alo.x < bhi.x - 1e-6
                    && blo.x < ahi.x - 1e-6
                    && alo.y < bhi.y - 1e-6
                    && blo.y < ahi.y - 1e-6;
                assert!(!overlap, "charts {} and {} overlap", boxes[i].0, boxes[j].0);
            }
        }
    }

    #[test]
    fn an_empty_mesh_produces_an_empty_atlas() {
        let a = unwrap(&Mesh::default(), &AtlasOptions::default());
        assert_eq!(a.chart_count, 0);
        assert!(a.triangles.is_empty());
    }

    /// A mesh carrying an atlas, the way one comes back from a bake.
    fn laid_out(atlas: &Atlas) -> Mesh {
        let mut m = Mesh::default();
        m.positions = atlas.positions.clone();
        m.normals = atlas.normals.clone();
        m.uvs = atlas.uvs.clone();
        m.triangles = atlas.triangles.clone();
        m.tri_material = vec![0; m.triangles.len()];
        m.materials.push(Material::default());
        m.rebuild_weld(0.0);
        m
    }

    #[test]
    fn an_existing_layout_is_taken_as_it_stands() {
        // Unwrap once, then read the result back: the second atlas has to be the
        // first one, because that is the whole promise — a re-bake that does not
        // move anything.
        let mesh = box_mesh();
        let made = unwrap(&mesh, &AtlasOptions::default());
        let baked = laid_out(&made);

        let again = from_uvs(&baked).expect("a laid out mesh has an atlas");
        assert_eq!(again.triangles.len(), made.triangles.len());
        assert_eq!(again.chart_count, made.chart_count, "the islands moved");
        for (a, b) in again.uvs.iter().zip(baked.uvs.iter()) {
            assert!((*a - *b).length() < 1e-9, "the coordinates were not kept");
        }
    }

    #[test]
    fn a_mesh_that_was_never_unwrapped_is_refused() {
        // No coordinates at all, and coordinates that are all zero — which is how
        // several exporters write "there is no unwrap here". Both have to be told
        // apart from a real layout rather than rasterised onto one texel.
        let mut bare = box_mesh();
        bare.uvs.clear();
        assert!(from_uvs(&bare).is_none());

        let mut flat = box_mesh();
        flat.uvs = vec![Vec2::ZERO; flat.positions.len()];
        assert!(from_uvs(&flat).is_none());
    }

    #[test]
    fn charts_come_from_the_seams_the_unwrap_left() {
        // Six faces of a box, split into six charts by `unwrap`, which duplicates
        // the corners. Reading that back has to find six islands from the vertex
        // sharing alone, with no angle threshold in sight.
        let mesh = box_mesh();
        let made = unwrap(&mesh, &AtlasOptions::default());
        let baked = laid_out(&made);
        let again = from_uvs(&baked).unwrap();

        let mut seen = std::collections::HashSet::new();
        for c in &again.chart_of_tri {
            seen.insert(*c);
        }
        assert_eq!(seen.len(), again.chart_count);
        assert!(again.chart_count >= 6, "a box has at least six islands, got {}", again.chart_count);
        // Two triangles of one quad face share corners, so they are one island.
        for pair in again.chart_of_tri.chunks(2) {
            if pair.len() == 2 {
                assert_eq!(pair[0], pair[1], "one face came out split across islands");
            }
        }
    }
}
