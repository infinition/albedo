//! Pairing triangles into quads.
//!
//! On a regular isotropic mesh, most triangles have a neighbour they form a
//! decent quad with. Finding those pairs greedily gives a quad-dominant result
//! without any of the machinery a field-aligned remesher needs, and it is good
//! enough for the thing quads are actually wanted for: predictable edge loops
//! when the model deforms, and clean subdivision.
//!
//! Nothing is merged in the geometry. glTF has no quads, so the mesh stays
//! triangles and the pairing travels alongside as an edge mask: which of a
//! triangle's three edges are real edges of the quad, and which one is the
//! diagonal the viewer should not draw. That way the wireframe shows the quad
//! topology while the file stays a file every tool can read.

use glam::Vec3;
use retopo_core::{Adjacency, Mesh};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct QuadOptions {
    /// Two triangles will not pair if their normals differ by more than this.
    pub max_fold_deg: f32,
    /// Reject a quad whose worst interior angle strays further than this from
    /// ninety degrees.
    pub max_angle_error_deg: f32,
    /// Reject a quad whose longest side is more than this times its shortest.
    ///
    /// Angles alone do not catch elongation: a rectangle fifty units long and
    /// one wide has four perfect right angles and is still a terrible quad.
    /// Generous by default, because a strap or a cylinder is legitimately made
    /// of long thin quads.
    pub max_aspect: f32,
}

impl Default for QuadOptions {
    fn default() -> Self {
        Self {
            max_fold_deg: 40.0,
            max_angle_error_deg: 55.0,
            max_aspect: 6.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct QuadStats {
    pub quads: usize,
    pub triangles_left: usize,
    /// Share of the surface covered by quads rather than lone triangles.
    pub quad_fraction: f32,
}

/// The pairing, plus the per triangle edge mask the viewer draws.
pub struct Pairing {
    /// Partner triangle for each triangle, or `-1` when it stayed a triangle.
    pub partner: Vec<i32>,
    /// Bit `k` set means "edge from corner `k` to corner `k+1` is a real edge".
    /// The cleared bit on a paired triangle is the quad's diagonal.
    pub edge_mask: Vec<u32>,
    pub stats: QuadStats,
}

pub fn pair_into_quads(mesh: &Mesh, opts: &QuadOptions) -> Pairing {
    let nt = mesh.triangle_count();
    let mut pairing = Pairing {
        partner: vec![-1; nt],
        edge_mask: vec![0b111; nt],
        stats: QuadStats::default(),
    };
    if nt == 0 {
        return pairing;
    }

    let adj = Adjacency::build(mesh);
    let cos_fold = opts.max_fold_deg.to_radians().cos();

    // Every interior edge is a candidate diagonal, scored by how square the quad
    // it would produce is.
    let mut candidates: Vec<(f32, u32, usize, usize)> = Vec::new();
    for (ei, e) in adj.edges.iter().enumerate() {
        let (Some(t1), Some(t2)) = (e.tri[0], e.tri[1]) else {
            continue;
        };
        let (t1, t2) = (t1 as usize, t2 as usize);
        let n1 = mesh.face_normal(t1);
        let n2 = mesh.face_normal(t2);
        if n1 == Vec3::ZERO || n2 == Vec3::ZERO || n1.dot(n2) < cos_fold {
            continue;
        }
        let Some(quad) = quad_corners(mesh, t1, t2, e.v) else {
            continue;
        };
        let error = worst_angle_error(&quad);
        if error > opts.max_angle_error_deg {
            continue;
        }
        let aspect = side_aspect(&quad);
        if aspect > opts.max_aspect {
            continue;
        }
        // Rank by angle error first, with elongation as a gentle tiebreak: a
        // square beats a rectangle, but a rectangle still beats a rhombus.
        candidates.push((error + aspect, ei as u32, t1, t2));
    }

    // Greedy, best first. A proper maximum weight matching would pair a few more
    // triangles; on a regular mesh the difference is small and greedy is
    // predictable, which matters more when a slider is driving it.
    candidates.sort_by(|a, b| a.0.total_cmp(&b.0));

    for (_, ei, t1, t2) in candidates {
        if pairing.partner[t1] >= 0 || pairing.partner[t2] >= 0 {
            continue;
        }
        pairing.partner[t1] = t2 as i32;
        pairing.partner[t2] = t1 as i32;
        // Hide the diagonal on both sides.
        for &t in &[t1, t2] {
            for k in 0..3 {
                if adj.tri_edges[t][k] == ei {
                    pairing.edge_mask[t] &= !(1 << k);
                }
            }
        }
        pairing.stats.quads += 1;
    }

    pairing.stats.triangles_left = pairing.partner.iter().filter(|p| **p < 0).count();
    pairing.stats.quad_fraction = (pairing.stats.quads * 2) as f32 / nt as f32;
    pairing
}

/// The four corners of the quad two triangles would make, in order around it.
fn quad_corners(mesh: &Mesh, t1: usize, t2: usize, shared: [u32; 2]) -> Option<[Vec3; 4]> {
    let opposite = |t: usize| -> Option<u32> {
        mesh.triangles[t]
            .iter()
            .copied()
            .find(|&c| mesh.weld[c as usize] != shared[0] && mesh.weld[c as usize] != shared[1])
    };
    let c1 = opposite(t1)?;
    let c2 = opposite(t2)?;

    // Any render vertex on a welded point will do for a position.
    let on = |w: u32| -> Option<Vec3> {
        mesh.triangles[t1]
            .iter()
            .chain(mesh.triangles[t2].iter())
            .find(|&&c| mesh.weld[c as usize] == w)
            .map(|&c| mesh.positions[c as usize])
    };
    // Around the quad: one opposite, an end of the diagonal, the other
    // opposite, the other end.
    Some([
        mesh.positions[c1 as usize],
        on(shared[0])?,
        mesh.positions[c2 as usize],
        on(shared[1])?,
    ])
}

/// Longest side over shortest side.
fn side_aspect(quad: &[Vec3; 4]) -> f32 {
    let mut min = f32::INFINITY;
    let mut max = 0.0f32;
    for i in 0..4 {
        let d = quad[i].distance(quad[(i + 1) % 4]);
        min = min.min(d);
        max = max.max(d);
    }
    if min <= 1e-9 {
        f32::INFINITY
    } else {
        max / min
    }
}

/// Largest departure from ninety degrees among the quad's interior angles.
fn worst_angle_error(quad: &[Vec3; 4]) -> f32 {
    let mut worst = 0.0f32;
    for i in 0..4 {
        let prev = quad[(i + 3) % 4];
        let here = quad[i];
        let next = quad[(i + 1) % 4];
        let a = (prev - here).normalize_or_zero();
        let b = (next - here).normalize_or_zero();
        if a == Vec3::ZERO || b == Vec3::ZERO {
            return f32::INFINITY;
        }
        let angle = a.dot(b).clamp(-1.0, 1.0).acos().to_degrees();
        worst = worst.max((angle - 90.0).abs());
    }
    worst
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec2;
    use retopo_core::Material;

    /// A flat grid triangulated the obvious way: every pair of triangles in a
    /// cell is already a perfect square, so a correct pairing finds all of them.
    fn grid(n: usize) -> Mesh {
        let mut m = Mesh::default();
        let step = 1.0 / n as f32;
        for j in 0..=n {
            for i in 0..=n {
                m.positions
                    .push(Vec3::new(i as f32 * step, j as f32 * step, 0.0));
                m.uvs.push(Vec2::new(i as f32 * step, j as f32 * step));
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

    #[test]
    fn a_grid_pairs_completely() {
        let m = grid(8);
        let p = pair_into_quads(&m, &QuadOptions::default());
        assert_eq!(p.stats.quads, 64, "every cell should become one quad");
        assert_eq!(p.stats.triangles_left, 0);
        assert!((p.stats.quad_fraction - 1.0).abs() < 1e-6);
    }

    #[test]
    fn every_paired_triangle_hides_exactly_one_edge() {
        let m = grid(6);
        let p = pair_into_quads(&m, &QuadOptions::default());
        for t in 0..m.triangle_count() {
            let drawn = p.edge_mask[t].count_ones();
            if p.partner[t] >= 0 {
                assert_eq!(drawn, 2, "triangle {t} should hide its diagonal only");
            } else {
                assert_eq!(drawn, 3);
            }
        }
    }

    #[test]
    fn the_pairing_is_symmetric_and_never_self_paired() {
        let m = grid(7);
        let p = pair_into_quads(&m, &QuadOptions::default());
        for t in 0..m.triangle_count() {
            let q = p.partner[t];
            if q < 0 {
                continue;
            }
            assert_ne!(q as usize, t, "triangle {t} paired with itself");
            assert_eq!(p.partner[q as usize], t as i32, "pairing is one sided");
        }
    }

    #[test]
    fn a_sharp_fold_is_not_paired_across() {
        // Two triangles at ninety degrees are a corner, not a quad. Pairing them
        // would put a quad's diagonal exactly on the feature line.
        let mut m = Mesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(1.0, 1.0, 0.0),
                Vec3::new(0.0, 0.0, 1.0),
            ],
            triangles: vec![[0, 1, 2], [1, 0, 3]],
            tri_material: vec![0, 0],
            materials: vec![Material::default()],
            ..Default::default()
        };
        m.rebuild_weld(0.0);
        m.compute_normals(40.0);

        let p = pair_into_quads(&m, &QuadOptions::default());
        assert_eq!(p.stats.quads, 0, "a ninety degree fold was paired into a quad");
    }

    fn two_triangle_quad(corners: [Vec3; 4]) -> Mesh {
        let mut m = Mesh {
            positions: corners.to_vec(),
            triangles: vec![[0, 1, 2], [0, 2, 3]],
            tri_material: vec![0, 0],
            materials: vec![Material::default()],
            ..Default::default()
        };
        m.rebuild_weld(0.0);
        m.compute_normals(40.0);
        m
    }

    /// The case that caught a hole in the scoring: this rectangle has four
    /// perfect right angles, so an angle-only rule accepts it happily even
    /// though it is fifty times longer than it is wide.
    #[test]
    fn an_elongated_quad_is_refused_despite_perfect_angles() {
        let m = two_triangle_quad([
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(10.0, 0.0, 0.0),
            Vec3::new(10.0, 0.2, 0.0),
            Vec3::new(0.0, 0.2, 0.0),
        ]);
        assert_eq!(pair_into_quads(&m, &QuadOptions::default()).stats.quads, 0);

        // Opening the aspect rule alone lets it through, which shows that rule
        // is what refused it.
        let loose = pair_into_quads(
            &m,
            &QuadOptions { max_aspect: 100.0, ..Default::default() },
        );
        assert_eq!(loose.stats.quads, 1);
    }

    #[test]
    fn a_quad_with_an_acute_corner_is_refused() {
        // A dart: two sides nearly collinear, so one corner is very sharp.
        let m = two_triangle_quad([
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(1.6, 0.15, 0.0),
            Vec3::new(0.6, 0.9, 0.0),
        ]);
        assert_eq!(pair_into_quads(&m, &QuadOptions::default()).stats.quads, 0);
        let loose = pair_into_quads(
            &m,
            &QuadOptions { max_angle_error_deg: 89.0, max_aspect: 100.0, ..Default::default() },
        );
        assert_eq!(loose.stats.quads, 1);
    }

    #[test]
    fn an_odd_mesh_leaves_a_triangle_over() {
        // Three triangles in a strip: at most one pair, so one is left alone.
        let mut m = grid(1); // two triangles
        let base = m.positions.len() as u32;
        m.positions.push(Vec3::new(2.0, 0.0, 0.0));
        m.uvs.push(Vec2::new(2.0, 0.0));
        m.triangles.push([1, base, 2]);
        m.tri_material.push(0);
        m.rebuild_weld(0.0);
        m.compute_normals(40.0);

        let p = pair_into_quads(&m, &QuadOptions::default());
        assert_eq!(p.stats.quads, 1);
        assert_eq!(p.stats.triangles_left, 1);
    }

    #[test]
    fn an_empty_mesh_pairs_nothing() {
        let p = pair_into_quads(&Mesh::default(), &QuadOptions::default());
        assert_eq!(p.stats.quads, 0);
        assert!(p.partner.is_empty());
    }
}
