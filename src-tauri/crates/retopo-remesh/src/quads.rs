//! Pairing triangles into quads.
//!
//! Candidates respect winding, convexity, material boundaries and manifold
//! incidence. A transported cross field guides their alignment; bounded
//! augmenting paths recover pairs missed by greedy matching. This produces a
//! quad-dominant mesh, without promising animation-ready global edge loops.
//!
//! Nothing is merged in the geometry. glTF has no quads, so the mesh stays
//! triangles and the pairing travels alongside as an edge mask: which of a
//! triangle's three edges are real edges of the quad, and which one is the
//! diagonal the viewer should not draw. That way the wireframe shows the quad
//! topology while the file stays a file every tool can read.

use glam::Vec3;
use retopo_core::{Adjacency, Mesh};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(default)]
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
    pub direction_weight: f32,
    pub field_iterations: u32,
    pub repair_passes: u32,
}

impl Default for QuadOptions {
    fn default() -> Self {
        Self {
            max_fold_deg: 40.0,
            max_angle_error_deg: 55.0,
            max_aspect: 6.0,
            direction_weight: 0.35,
            field_iterations: 24,
            repair_passes: 4,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct QuadStats {
    pub quads: usize,
    pub triangles_left: usize,
    /// Fraction of input triangles belonging to quads (not surface area).
    pub quad_fraction: f32,
    pub recovered_quads: usize,
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
    let mut incidence = vec![0u32; adj.edges.len()];
    for edges in &adj.tri_edges {
        for &e in edges {
            incidence[e as usize] += 1;
        }
    }
    let field = (opts.direction_weight > 0.0 && opts.field_iterations > 0).then(|| {
        crate::field::CrossField::solve(mesh, &adj, opts.max_fold_deg, opts.field_iterations)
    });

    // Every interior edge is a candidate diagonal, scored by how square the quad
    // it would produce is.
    let mut candidates: Vec<(f32, u32, usize, usize)> = Vec::new();
    for (ei, e) in adj.edges.iter().enumerate() {
        if incidence[ei] != 2 {
            continue;
        }
        let (Some(t1), Some(t2)) = (e.tri[0], e.tri[1]) else {
            continue;
        };
        let (t1, t2) = (t1 as usize, t2 as usize);
        if t1 == t2 || mesh.tri_material.get(t1) != mesh.tri_material.get(t2) {
            continue;
        }
        let forward = |t: usize| {
            let f = mesh.triangles[t].map(|r| mesh.weld[r as usize]);
            (0..3).any(|k| f[k] == e.v[0] && f[(k + 1) % 3] == e.v[1])
        };
        if forward(t1) == forward(t2) {
            continue;
        }
        let n1 = mesh.face_normal(t1);
        let n2 = mesh.face_normal(t2);
        if n1 == Vec3::ZERO || n2 == Vec3::ZERO || n1.dot(n2) < cos_fold {
            continue;
        }
        let Some(quad) = quad_corners(mesh, t1, t2, e.v) else {
            continue;
        };
        if !convex(&quad) {
            continue;
        }
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
        let alignment = field
            .as_ref()
            .map(|f| {
                (0..4)
                    .map(|k| {
                        let side = quad[(k + 1) % 4] - quad[k];
                        f.penalty(t1, side) + f.penalty(t2, side)
                    })
                    .sum::<f32>()
                    / 8.0
            })
            .unwrap_or(0.0);
        let score = error + aspect + 90.0 * opts.direction_weight.clamp(0.0, 2.0) * alignment;
        if score.is_finite() {
            candidates.push((score, ei as u32, t1, t2));
        }
    }

    candidates.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut graph = vec![Vec::with_capacity(3); nt];
    for &(_, _, a, b) in &candidates {
        graph[a].push(b);
        graph[b].push(a);
    }

    for &(_, _, t1, t2) in &candidates {
        if pairing.partner[t1] >= 0 || pairing.partner[t2] >= 0 {
            continue;
        }
        pairing.partner[t1] = t2 as i32;
        pairing.partner[t2] = t1 as i32;
    }
    let greedy = pairing.partner.iter().filter(|&&p| p >= 0).count() / 2;
    repair_matching(&graph, &mut pairing.partner, opts.repair_passes.min(8));
    for &(_, ei, t1, t2) in &candidates {
        if pairing.partner[t1] != t2 as i32 {
            continue;
        }
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
    pairing.stats.recovered_quads = pairing.stats.quads - greedy;

    pairing.stats.triangles_left = pairing.partner.iter().filter(|p| **p < 0).count();
    pairing.stats.quad_fraction = (pairing.stats.quads * 2) as f32 / nt as f32;
    pairing
}

/// Alternating paths of at most five edges. On the triangle dual every node
/// has at most three neighbours, so each pass is O(triangles), with bounded
/// stack/memory use. This is deliberately not an exact blossom solver.
fn repair_matching(graph: &[Vec<usize>], partner: &mut [i32], passes: u32) {
    fn find(graph: &[Vec<usize>], partner: &[i32], path: &mut Vec<usize>, left: u32) -> bool {
        let a = *path.last().unwrap();
        for &b in &graph[a] {
            if path.contains(&b) {
                continue;
            }
            path.push(b);
            if partner[b] < 0 {
                return true;
            }
            let c = partner[b] as usize;
            if left > 1 && !path.contains(&c) {
                path.push(c);
                if find(graph, partner, path, left - 1) {
                    return true;
                }
                path.pop();
            }
            path.pop();
        }
        false
    }
    let mut path = Vec::with_capacity(6);
    for _ in 0..passes {
        let mut changed = false;
        for root in 0..partner.len() {
            if partner[root] >= 0 {
                continue;
            }
            path.clear();
            path.push(root);
            if find(graph, partner, &mut path, 3) {
                for pair in path.chunks_exact(2) {
                    partner[pair[0]] = pair[1] as i32;
                    partner[pair[1]] = pair[0] as i32;
                }
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
}

fn convex(q: &[Vec3; 4]) -> bool {
    if q.iter().any(|p| !p.is_finite()) {
        return false;
    }
    let n = (q[1] - q[0]).cross(q[2] - q[0]) + (q[2] - q[0]).cross(q[3] - q[0]);
    let scale = (0..4)
        .map(|k| q[k].distance_squared(q[(k + 1) % 4]))
        .fold(0.0f32, f32::max);
    if n.length_squared() <= scale * scale * 1e-12 {
        return false;
    }
    let n = n.normalize_or_zero();
    (0..4).all(|k| {
        (q[(k + 1) % 4] - q[k])
            .cross(q[(k + 2) % 4] - q[(k + 1) % 4])
            .dot(n)
            > scale * 1e-7
    })
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
    if min <= 0.0 {
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
                m.triangles
                    .push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1)]);
                m.triangles
                    .push([idx(i, j), idx(i + 1, j + 1), idx(i, j + 1)]);
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
        assert_eq!(
            p.stats.quads, 0,
            "a ninety degree fold was paired into a quad"
        );
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
            &QuadOptions {
                max_aspect: 100.0,
                ..Default::default()
            },
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
            &QuadOptions {
                max_angle_error_deg: 89.0,
                max_aspect: 100.0,
                ..Default::default()
            },
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

    #[test]
    fn alternating_paths_recover_the_greedy_trap() {
        let graph = vec![vec![1], vec![2, 0], vec![1, 3], vec![2]];
        let mut partner = vec![-1, 2, 1, -1];
        repair_matching(&graph, &mut partner, 4);
        assert_eq!(partner, vec![1, 0, 3, 2]);
    }

    #[test]
    fn five_edge_paths_and_odd_cycles_keep_matching_valid() {
        let graph = vec![
            vec![1],
            vec![2, 0],
            vec![1, 3, 4],
            vec![4, 2],
            vec![3, 2, 5],
            vec![4],
        ];
        let mut partner = vec![-1, 2, 1, 4, 3, -1];
        repair_matching(&graph, &mut partner, 4);
        for (a, &b) in partner.iter().enumerate() {
            assert!(b >= 0);
            assert!(graph[a].contains(&(b as usize)));
            assert_eq!(partner[b as usize], a as i32);
        }
    }

    #[test]
    fn material_boundaries_are_real_edges() {
        let mut m = grid(1);
        m.materials.push(Material::default());
        m.tri_material[1] = 1;
        assert_eq!(pair_into_quads(&m, &QuadOptions::default()).stats.quads, 0);
    }

    #[test]
    fn non_manifold_edges_are_not_hidden() {
        let mut m = grid(1);
        m.positions.push(Vec3::new(0.0, 0.0, 1.0));
        m.triangles.push([0, 4, 3]);
        m.tri_material.push(0);
        m.rebuild_weld(0.0);
        assert_eq!(Adjacency::build(&m).non_manifold_edges, 1);
        assert_eq!(pair_into_quads(&m, &QuadOptions::default()).stats.quads, 0);
    }

    #[test]
    fn concavity_is_rejected_even_with_loose_angle_limits() {
        let m = two_triangle_quad([
            Vec3::ZERO,
            Vec3::X * 2.0,
            Vec3::new(0.4, 0.4, 0.0),
            Vec3::Y * 2.0,
        ]);
        let p = pair_into_quads(
            &m,
            &QuadOptions {
                max_angle_error_deg: 180.0,
                max_aspect: 100.0,
                ..Default::default()
            },
        );
        assert_eq!(p.stats.quads, 0);
    }

    #[test]
    fn field_transports_across_rotated_face_frames() {
        let mut m = grid(5);
        let rotation = glam::Quat::from_rotation_x(0.7) * glam::Quat::from_rotation_z(0.31);
        for p in &mut m.positions {
            *p = rotation * *p;
        }
        let adj = Adjacency::build(&m);
        let f = crate::field::CrossField::solve(&m, &adj, 40.0, 48);
        let x = rotation * Vec3::X;
        let diagonal = rotation * (Vec3::X + Vec3::Y);
        for t in 0..m.triangle_count() {
            assert!(f.penalty(t, x) < 0.01);
            assert!(f.penalty(t, diagonal) > 0.5);
        }
        assert_eq!(pair_into_quads(&m, &QuadOptions::default()).stats.quads, 25);
    }

    #[test]
    fn pairing_is_scale_invariant_and_repeatable() {
        let m = grid(5);
        let baseline = pair_into_quads(&m, &QuadOptions::default());
        for scale in [1e-5, 1.0, 1e5] {
            let mut scaled = m.clone();
            for p in &mut scaled.positions {
                *p *= scale;
            }
            let paired = pair_into_quads(&scaled, &QuadOptions::default());
            assert_eq!(baseline.partner, paired.partner);
            assert_eq!(baseline.edge_mask, paired.edge_mask);
        }
    }
}
