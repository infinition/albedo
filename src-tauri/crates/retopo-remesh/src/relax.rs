//! Tangential relaxation with reprojection.
//!
//! Decimation optimises for error, not for shape quality, so it leaves slivers:
//! triangles that are technically in the right place and still terrible to bake
//! a normal map onto or to deform. This walks every free vertex toward the
//! average of its neighbours, throws away the part of that motion that would
//! change the silhouette, and puts the vertex back on the original surface.
//!
//! The two guards are what make it safe to run:
//!
//! - **Tangential only.** The move is projected onto the tangent plane, so the
//!   surface slides rather than shrinks. A plain Laplacian smooth deflates a
//!   sphere a little more on every pass.
//! - **Reprojection.** Every moved vertex is snapped back onto the source
//!   through the BVH, so the shape it converges to is the original one, not a
//!   blurred version of itself.
//!
//! Creases and open borders are pinned, which is the same reason Cozy Blanket
//! pins corners: relaxing across a feature is how you lose it.

use glam::Vec3;
use retopo_core::{Adjacency, Bvh, Mesh};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RelaxOptions {
    pub iterations: u32,
    /// How far toward the neighbour average to move each pass, in `0..1`.
    pub strength: f32,
    /// Hold sharp edges and open borders in place.
    pub preserve_features: bool,
    /// Angle above which an edge counts as a feature *for relaxation*.
    ///
    /// Deliberately looser than the decimator's. A mesh reduced from a million
    /// triangles to twenty thousand is faceted everywhere, so its dihedral
    /// angles are large by construction; reusing the decimation threshold here
    /// pinned eighty six percent of the vertices and relaxation did nothing at
    /// all. The angles worth protecting on a coarse mesh are the genuinely
    /// sharp ones.
    pub sharp_angle_deg: f32,
    /// Snap back onto the source surface after each pass. Turning this off is
    /// only useful when there is no source to snap to.
    pub reproject: bool,
}

impl Default for RelaxOptions {
    fn default() -> Self {
        Self {
            iterations: 8,
            strength: 0.5,
            preserve_features: true,
            sharp_angle_deg: 75.0,
            reproject: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct RelaxStats {
    pub moved: usize,
    pub pinned: usize,
    /// Vertices relaxation was actually allowed to touch.
    pub free: usize,
    /// Largest distance any vertex travelled, in model units.
    pub max_travel: f32,
    /// Worst triangle aspect ratio before and after. Lower is better.
    ///
    /// Read the mean, not the worst. The single worst triangle on a decimated
    /// model is nearly always sitting on a crease, which relaxation is pinning
    /// on purpose, so this pair often does not move at all even when the mesh
    /// as a whole improved a lot.
    pub aspect_before: f32,
    pub aspect_after: f32,
    /// Mean aspect ratio before and after. This is the number that says whether
    /// relaxation did anything.
    pub mean_before: f32,
    pub mean_after: f32,
}

/// Relax `mesh` in place, keeping it on `source`.
pub fn relax(
    mesh: &mut Mesh,
    source: Option<&Bvh>,
    opts: &RelaxOptions,
    progress: &mut dyn FnMut(f32),
) -> RelaxStats {
    let (worst, mean) = aspect_ratios(mesh);
    let mut stats = RelaxStats {
        aspect_before: worst,
        mean_before: mean,
        ..Default::default()
    };
    if mesh.triangles.is_empty() || opts.iterations == 0 {
        stats.aspect_after = stats.aspect_before;
        stats.mean_after = stats.mean_before;
        return stats;
    }

    let adj = Adjacency::build(mesh);
    let sharp = adj.sharp_edges(mesh, opts.sharp_angle_deg);

    // Welded domain: positions and the one-ring, both indexed by welded point.
    let nw = mesh.weld_count;
    let mut pos = vec![Vec3::ZERO; nw];
    for (r, &w) in mesh.weld.iter().enumerate() {
        pos[w as usize] = mesh.positions[r];
    }
    let start = pos.clone();

    let mut pinned = vec![false; nw];
    if opts.preserve_features {
        for (ei, e) in adj.edges.iter().enumerate() {
            if sharp[ei] || e.is_boundary() {
                pinned[e.v[0] as usize] = true;
                pinned[e.v[1] as usize] = true;
            }
        }
    }
    stats.pinned = pinned.iter().filter(|p| **p).count();
    stats.free = nw - stats.pinned;
    if nw > 0 && stats.pinned * 10 > nw * 9 {
        // Worth saying out loud: at this ratio relaxation cannot achieve
        // anything, and silently doing nothing looks like a broken feature.
        tracing::warn!(
            pinned = stats.pinned,
            total = nw,
            angle = opts.sharp_angle_deg,
            "almost every vertex is pinned; raise the relax feature angle"
        );
    }

    // One-ring in CSR form, built once.
    let mut ring_start = vec![0u32; nw + 1];
    for e in &adj.edges {
        ring_start[e.v[0] as usize + 1] += 1;
        ring_start[e.v[1] as usize + 1] += 1;
    }
    for i in 0..nw {
        ring_start[i + 1] += ring_start[i];
    }
    let mut cursor = ring_start.clone();
    let mut ring = vec![0u32; ring_start[nw] as usize];
    for e in &adj.edges {
        ring[cursor[e.v[0] as usize] as usize] = e.v[1];
        cursor[e.v[0] as usize] += 1;
        ring[cursor[e.v[1] as usize] as usize] = e.v[0];
        cursor[e.v[1] as usize] += 1;
    }

    // Vertex normals in the welded domain, recomputed each pass because the
    // tangent plane moves with the surface.
    let mut normals = vec![Vec3::ZERO; nw];
    let strength = opts.strength.clamp(0.0, 1.0);

    for it in 0..opts.iterations {
        normals.iter_mut().for_each(|n| *n = Vec3::ZERO);
        for t in 0..mesh.triangles.len() {
            let f = mesh.triangles[t];
            let w = [
                mesh.weld[f[0] as usize],
                mesh.weld[f[1] as usize],
                mesh.weld[f[2] as usize],
            ];
            let n = (pos[w[1] as usize] - pos[w[0] as usize])
                .cross(pos[w[2] as usize] - pos[w[0] as usize]);
            for &v in &w {
                normals[v as usize] += n;
            }
        }

        let mut next = pos.clone();
        for v in 0..nw {
            if pinned[v] {
                continue;
            }
            let a = ring_start[v] as usize;
            let b = ring_start[v + 1] as usize;
            if b <= a {
                continue;
            }
            let mut sum = Vec3::ZERO;
            for &n in &ring[a..b] {
                sum += pos[n as usize];
            }
            let average = sum / (b - a) as f32;
            let mut delta = (average - pos[v]) * strength;

            // Keep only the tangential part, or the surface deflates.
            let n = normals[v].normalize_or_zero();
            if n != Vec3::ZERO {
                delta -= n * n.dot(delta);
            }
            let moved = pos[v] + delta;

            next[v] = match source.filter(|_| opts.reproject) {
                Some(bvh) => bvh.closest_point(moved).map(|h| h.point).unwrap_or(moved),
                None => moved,
            };
        }
        pos = next;
        progress((it + 1) as f32 / opts.iterations as f32);
    }

    for v in 0..nw {
        let travel = start[v].distance(pos[v]);
        if travel > 0.0 {
            stats.moved += 1;
            stats.max_travel = stats.max_travel.max(travel);
        }
    }

    // Scatter back: every render vertex follows the welded point it belongs to,
    // which is what keeps a UV seam from splitting open.
    for (r, &w) in mesh.weld.iter().enumerate() {
        mesh.positions[r] = pos[w as usize];
    }
    mesh.compute_normals(opts.sharp_angle_deg);
    let (worst, mean) = aspect_ratios(mesh);
    stats.aspect_after = worst;
    stats.mean_after = mean;
    stats
}

/// Worst aspect ratio in the mesh. See [`aspect_ratios`].
pub fn worst_aspect(mesh: &Mesh) -> f32 {
    aspect_ratios(mesh).0
}

/// Worst and mean aspect ratio: longest edge over inradius, normalised so an
/// equilateral triangle scores 1.
pub fn aspect_ratios(mesh: &Mesh) -> (f32, f32) {
    let mut worst = 1.0f32;
    let mut sum = 0.0f64;
    let mut n = 0usize;
    for t in 0..mesh.triangle_count() {
        let [a, b, c] = mesh.tri_positions(t);
        let (ab, bc, ca) = (a.distance(b), b.distance(c), c.distance(a));
        let s = (ab + bc + ca) * 0.5;
        let area = mesh.face_area(t);
        if area <= 0.0 || s <= 0.0 {
            continue;
        }
        let inradius = area / s;
        let longest = ab.max(bc).max(ca);
        // 2*sqrt(3) is the ratio for an equilateral triangle.
        let ratio = longest / inradius / (2.0 * std::f32::consts::SQRT_2 * 1.2247449);
        if ratio.is_finite() {
            worst = worst.max(ratio);
            sum += ratio as f64;
            n += 1;
        }
    }
    let mean = if n == 0 { 1.0 } else { (sum / n as f64) as f32 };
    (worst, mean)
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec2;
    use retopo_core::mesh::Material;

    /// A grid whose interior vertices have been shoved sideways, so the
    /// triangles are badly shaped but the surface is still a flat square.
    fn jittered_grid(n: usize) -> Mesh {
        let mut m = Mesh::default();
        let step = 1.0 / n as f32;
        for j in 0..=n {
            for i in 0..=n {
                let (x, y) = (i as f32 * step, j as f32 * step);
                // A deterministic wobble, only on the inside.
                let inside = i > 0 && j > 0 && i < n && j < n;
                // Hard enough to make genuinely bad triangles, so the test has
                // something to measure.
                let k = if inside { 0.85 } else { 0.0 };
                let wx = ((i * 7 + j * 13) % 5) as f32 / 5.0 - 0.5;
                let wy = ((i * 11 + j * 3) % 5) as f32 / 5.0 - 0.5;
                m.positions
                    .push(Vec3::new(x + wx * step * k, y + wy * step * k, 0.0));
                m.uvs.push(Vec2::new(x, y));
            }
        }
        let idx = |i: usize, j: usize| (j * (n + 1) + i) as u32;
        for j in 0..n {
            for i in 0..n {
                m.triangles.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1)]);
                m.triangles.push([idx(i, j), idx(i + 1, j + 1), idx(i, j + 1)]);
                m.tri_material.push(0);
                m.tri_material.push(0);
            }
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

    #[test]
    fn relaxing_improves_the_worst_triangle() {
        let mut m = jittered_grid(12);
        let (worst_before, mean_before) = aspect_ratios(&m);
        let stats = relax(
            &mut m,
            None,
            &RelaxOptions { iterations: 16, ..Default::default() },
            &mut |_| {},
        );
        assert!(
            stats.mean_after < mean_before * 0.9,
            "mean aspect went from {mean_before} to {}, barely moved",
            stats.mean_after
        );
        assert!(stats.aspect_after <= worst_before * 1.01);
        assert!(stats.moved > 0);
        assert_eq!(stats.free + stats.pinned, m.weld_count);
    }

    #[test]
    fn the_border_does_not_move() {
        let mut m = jittered_grid(10);
        let before = m.bounds();
        relax(&mut m, None, &RelaxOptions::default(), &mut |_| {});
        let after = m.bounds();
        assert!(after.min.abs_diff_eq(before.min, 1e-5), "{:?}", after.min);
        assert!(after.max.abs_diff_eq(before.max, 1e-5), "{:?}", after.max);
    }

    /// The whole point of the tangential projection. A plain Laplacian smooth
    /// shrinks a sphere a little on every pass; after twenty passes that is a
    /// visibly smaller model.
    #[test]
    fn a_sphere_does_not_deflate() {
        let src = sphere(28, 20);
        let bvh = Bvh::build(&src);
        let mut m = src.clone();
        relax(
            &mut m,
            Some(&bvh),
            &RelaxOptions {
                iterations: 20,
                strength: 0.8,
                ..Default::default()
            },
            &mut |_| {},
        );
        for p in &m.positions {
            let r = p.length();
            assert!(
                (r - 1.0).abs() < 0.02,
                "a vertex ended up at radius {r}, the sphere deflated"
            );
        }
    }

    #[test]
    fn reprojection_keeps_vertices_on_the_source() {
        let src = sphere(24, 16);
        let bvh = Bvh::build(&src);
        let mut m = src.clone();
        relax(&mut m, Some(&bvh), &RelaxOptions::default(), &mut |_| {});
        for p in &m.positions {
            let d = bvh.closest_point(*p).unwrap().dist2.sqrt();
            assert!(d < 1e-3, "a vertex drifted {d} off the source");
        }
    }

    #[test]
    fn a_uv_seam_survives() {
        let mut m = jittered_grid(8);
        // Split one interior vertex into two render vertices, as a seam does.
        let v = m.positions[40];
        m.positions.push(v);
        m.uvs.push(glam::Vec2::new(0.9, 0.9));
        m.rebuild_weld(0.0);
        let welded_before = m.weld_count;
        let render_before = m.vertex_count();

        relax(&mut m, None, &RelaxOptions::default(), &mut |_| {});
        assert_eq!(m.weld_count, welded_before);
        assert_eq!(m.vertex_count(), render_before);
        // The duplicate must still sit exactly on its twin.
        assert_eq!(m.positions[40], m.positions[render_before - 1]);
    }

    #[test]
    fn zero_iterations_changes_nothing() {
        let m0 = jittered_grid(6);
        let mut m = m0.clone();
        let stats = relax(
            &mut m,
            None,
            &RelaxOptions { iterations: 0, ..Default::default() },
            &mut |_| {},
        );
        assert_eq!(stats.moved, 0);
        assert_eq!(m.positions, m0.positions);
    }

    #[test]
    fn progress_ends_at_one() {
        let mut m = jittered_grid(6);
        let mut seen = Vec::new();
        relax(&mut m, None, &RelaxOptions::default(), &mut |p| seen.push(p));
        assert_eq!(seen.last().copied(), Some(1.0));
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
    }
}
