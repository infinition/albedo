//! Boundary loop detection and hole filling.
//!
//! Holes are not a cosmetic problem here. A cage ray fired through one escapes
//! the surface entirely and either finds nothing or lands on the far inside
//! wall, which is one of the ways a bake ends up with black patches. Several
//! later stages also assume a closed surface and quietly misbehave without one.
//! Generated meshes and scans arrive with holes as a matter of course.
//!
//! Loops are traced on welded topology, filled with a centroid fan, and wound to
//! match the triangles they close against. Large loops are left alone: a hole
//! that big is usually meant to be there, and a fan across it would be worse
//! than the hole.

use std::collections::HashMap;

use glam::{Vec2, Vec3};
use retopo_core::{Adjacency, Mesh};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct FillOptions {
    /// Loops with more edges than this are reported and left open.
    pub max_loop_edges: usize,
}

impl Default for FillOptions {
    fn default() -> Self {
        Self {
            max_loop_edges: 512,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct FillStats {
    pub loops_found: usize,
    pub loops_filled: usize,
    pub triangles_added: usize,
    /// Edge count of the largest loop left open, zero when none was.
    pub largest_left_open: usize,
}

/// A traced boundary loop, in the direction a fill would wind.
#[derive(Clone, Debug)]
pub struct BoundaryLoop {
    pub vertices: Vec<u32>,
    pub length: f32,
}

/// Trace every boundary loop, without changing anything.
///
/// Exposed on its own because the interface wants to show where the holes are
/// before offering to close them.
pub fn boundary_loops(mesh: &Mesh) -> Vec<BoundaryLoop> {
    let adj = Adjacency::build(mesh);
    let mut next: HashMap<u32, u32> = HashMap::new();

    for e in adj.edges.iter().filter(|e| e.is_boundary()) {
        let Some(t) = e.tri[0] else { continue };
        let f = mesh.triangles[t as usize];
        let w = [
            mesh.weld[f[0] as usize],
            mesh.weld[f[1] as usize],
            mesh.weld[f[2] as usize],
        ];
        // Which way does this edge run inside its own triangle? The fill has to
        // run the other way, the way any two triangles sharing an edge do.
        for k in 0..3 {
            let (a, b) = (w[k], w[(k + 1) % 3]);
            if (a == e.v[0] && b == e.v[1]) || (a == e.v[1] && b == e.v[0]) {
                next.insert(b, a);
                break;
            }
        }
    }

    let mut loops = Vec::new();
    let mut seen: HashMap<u32, bool> = HashMap::new();
    let starts: Vec<u32> = next.keys().copied().collect();

    for start in starts {
        if seen.contains_key(&start) {
            continue;
        }
        let mut vertices = Vec::new();
        let mut v = start;
        // The bound is a safety net against a malformed boundary, not an
        // expected exit.
        for _ in 0..next.len() + 1 {
            if seen.contains_key(&v) {
                break;
            }
            seen.insert(v, true);
            vertices.push(v);
            match next.get(&v) {
                Some(&n) => v = n,
                None => break,
            }
        }
        if vertices.len() < 3 {
            continue;
        }
        loops.push(BoundaryLoop {
            length: perimeter(mesh, &vertices),
            vertices,
        });
    }
    loops
}

fn perimeter(mesh: &Mesh, loop_vertices: &[u32]) -> f32 {
    // Welded points have no position of their own; any render vertex on them
    // does, and they all agree.
    let rep = representatives(mesh);
    let mut total = 0.0;
    for i in 0..loop_vertices.len() {
        let a = rep[loop_vertices[i] as usize];
        let b = rep[loop_vertices[(i + 1) % loop_vertices.len()] as usize];
        if a == u32::MAX || b == u32::MAX {
            continue;
        }
        total += mesh.positions[a as usize].distance(mesh.positions[b as usize]);
    }
    total
}

/// One render vertex per welded point, so a loop can be turned into geometry.
fn representatives(mesh: &Mesh) -> Vec<u32> {
    let mut rep = vec![u32::MAX; mesh.weld_count];
    for (r, &w) in mesh.weld.iter().enumerate() {
        if rep[w as usize] == u32::MAX {
            rep[w as usize] = r as u32;
        }
    }
    rep
}

/// Close every hole small enough to be worth closing.
pub fn fill_holes(mesh: &mut Mesh, opts: &FillOptions) -> FillStats {
    let loops = boundary_loops(mesh);
    let mut stats = FillStats {
        loops_found: loops.len(),
        ..Default::default()
    };
    if loops.is_empty() {
        return stats;
    }

    let rep = representatives(mesh);
    let material = mesh.tri_material.first().copied().unwrap_or(0);
    let has_uvs = mesh.has_uvs();

    for hole in &loops {
        if hole.vertices.len() > opts.max_loop_edges {
            stats.largest_left_open = stats.largest_left_open.max(hole.vertices.len());
            continue;
        }
        let corners: Vec<u32> = hole
            .vertices
            .iter()
            .map(|&w| rep[w as usize])
            .filter(|&r| r != u32::MAX)
            .collect();
        if corners.len() < 3 {
            continue;
        }

        if corners.len() == 3 {
            mesh.triangles.push([corners[0], corners[1], corners[2]]);
            mesh.tri_material.push(material);
            stats.triangles_added += 1;
        } else {
            // A centroid fan rather than ear clipping: a boundary loop is rarely
            // planar, and a fan across the middle handles a wavy rim without the
            // self intersections a projected ear clip produces.
            let centre_pos = corners
                .iter()
                .map(|&c| mesh.positions[c as usize])
                .fold(Vec3::ZERO, |a, b| a + b)
                / corners.len() as f32;
            let centre_nrm = corners
                .iter()
                .filter_map(|&c| mesh.normals.get(c as usize))
                .fold(Vec3::ZERO, |a, b| a + *b)
                .normalize_or_zero();

            let centre = mesh.positions.len() as u32;
            mesh.positions.push(centre_pos);
            mesh.normals.push(if centre_nrm == Vec3::ZERO {
                Vec3::Y
            } else {
                centre_nrm
            });
            if has_uvs {
                let uv = corners
                    .iter()
                    .map(|&c| mesh.uvs[c as usize])
                    .fold(Vec2::ZERO, |a, b| a + b)
                    / corners.len() as f32;
                mesh.uvs.push(uv);
            }

            for i in 0..corners.len() {
                let a = corners[i];
                let b = corners[(i + 1) % corners.len()];
                mesh.triangles.push([centre, a, b]);
                mesh.tri_material.push(material);
                stats.triangles_added += 1;
            }
        }
        stats.loops_filled += 1;
    }

    if stats.triangles_added > 0 {
        mesh.rebuild_weld(0.0);
        mesh.remove_degenerate();
        mesh.compact();
        mesh.rebuild_weld(0.0);
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use retopo_core::mesh::Material;

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

    /// Punch a hole by deleting a patch of triangles.
    fn punch(mesh: &mut Mesh, count: usize) {
        mesh.triangles.drain(0..count);
        mesh.tri_material.drain(0..count);
        mesh.rebuild_weld(0.0);
        mesh.compact();
        mesh.rebuild_weld(0.0);
        mesh.compute_normals(40.0);
    }

    #[test]
    fn a_closed_sphere_has_no_boundary_loops() {
        let m = sphere(20, 14);
        assert!(boundary_loops(&m).is_empty());
    }

    #[test]
    fn a_punched_sphere_reports_one_loop() {
        let mut m = sphere(20, 14);
        punch(&mut m, 6);
        let loops = boundary_loops(&m);
        assert_eq!(loops.len(), 1, "expected a single hole, got {}", loops.len());
        assert!(loops[0].vertices.len() >= 3);
        assert!(loops[0].length > 0.0);
    }

    #[test]
    fn filling_closes_the_surface() {
        let mut m = sphere(20, 14);
        punch(&mut m, 8);
        assert!(Adjacency::build(&m).boundary_edge_count() > 0);

        let stats = fill_holes(&mut m, &FillOptions::default());
        assert_eq!(stats.loops_filled, 1);
        assert!(stats.triangles_added > 0);
        assert_eq!(
            Adjacency::build(&m).boundary_edge_count(),
            0,
            "the surface is still open after filling"
        );
    }

    #[test]
    fn the_patch_winds_the_same_way_as_its_neighbours() {
        // A fan wound backwards closes the hole geometrically and leaves the
        // surface inside out across the patch, which only shows up later as a
        // bake that samples the wrong side.
        let mut m = sphere(20, 14);
        punch(&mut m, 8);
        let added_from = m.triangle_count();
        fill_holes(&mut m, &FillOptions::default());
        m.compute_normals(40.0);

        for t in added_from..m.triangle_count() {
            let n = m.face_normal(t);
            let outward = m.face_centroid(t).normalize_or_zero();
            assert!(
                n.dot(outward) > 0.0,
                "patch triangle {t} faces inward: {n:?} against {outward:?}"
            );
        }
        assert_eq!(Adjacency::build(&m).non_manifold_edges, 0);
    }

    #[test]
    fn several_holes_are_all_closed() {
        let mut m = sphere(20, 14);
        // Two patches far apart in the triangle list, so two separate loops.
        let n = m.triangle_count();
        m.triangles.drain(n - 6..n);
        m.tri_material.drain(n - 6..n);
        m.triangles.drain(0..6);
        m.tri_material.drain(0..6);
        m.rebuild_weld(0.0);
        m.compact();
        m.rebuild_weld(0.0);
        m.compute_normals(40.0);

        let found = boundary_loops(&m).len();
        assert!(found >= 2, "expected at least two holes, got {found}");
        let stats = fill_holes(&mut m, &FillOptions::default());
        assert_eq!(stats.loops_filled, found);
        assert_eq!(Adjacency::build(&m).boundary_edge_count(), 0);
    }

    #[test]
    fn a_loop_over_the_limit_is_reported_and_left_alone() {
        let mut m = sphere(20, 14);
        punch(&mut m, 8);
        let before = m.triangle_count();
        let stats = fill_holes(&mut m, &FillOptions { max_loop_edges: 3 });
        assert_eq!(stats.loops_filled, 0);
        assert!(stats.largest_left_open >= 4);
        assert_eq!(m.triangle_count(), before, "nothing should have been added");
    }

    #[test]
    fn an_open_patch_keeps_its_border_when_the_limit_is_low() {
        // A flat sheet is one big boundary loop, and closing it would be wrong.
        let mut m = Mesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(1.0, 1.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            ],
            triangles: vec![[0, 1, 2], [0, 2, 3]],
            tri_material: vec![0, 0],
            materials: vec![Material::default()],
            ..Default::default()
        };
        m.rebuild_weld(0.0);
        m.compute_normals(40.0);

        let loops = boundary_loops(&m);
        assert_eq!(loops.len(), 1);
        assert_eq!(loops[0].vertices.len(), 4);

        let stats = fill_holes(&mut m, &FillOptions { max_loop_edges: 3 });
        assert_eq!(stats.loops_filled, 0);
        assert_eq!(stats.largest_left_open, 4);
    }
}
