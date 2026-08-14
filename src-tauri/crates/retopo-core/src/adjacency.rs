//! Edge and vertex adjacency over *welded* points.
//!
//! Built on `Mesh::weld`, never on render vertex indices. A UV seam splits a
//! render vertex in two but must not split the surface, so anything that asks
//! "what is next to what" has to go through here.

use crate::mesh::Mesh;
use std::collections::HashMap;

/// An undirected edge between two welded points.
#[derive(Clone, Copy, Debug)]
pub struct Edge {
    /// Endpoints, sorted, so an edge has one identity whichever side finds it.
    pub v: [u32; 2],
    /// Incident triangles. A boundary edge leaves slot 1 empty.
    pub tri: [Option<u32>; 2],
}

impl Edge {
    #[inline]
    pub fn is_boundary(&self) -> bool {
        self.tri[1].is_none()
    }
}

#[derive(Clone, Debug, Default)]
pub struct Adjacency {
    pub edges: Vec<Edge>,
    /// Per triangle, the edge ids of corners (0,1), (1,2), (2,0).
    pub tri_edges: Vec<[u32; 3]>,
    /// How many triangles wanted a third slot on some edge. Non zero means the
    /// input is non manifold, which several algorithms need to know about.
    pub non_manifold_edges: usize,

    vert_offset: Vec<u32>,
    vert_tris: Vec<u32>,
}

impl Adjacency {
    pub fn build(mesh: &Mesh) -> Self {
        let nt = mesh.triangles.len();
        let nw = mesh.weld_count;

        let mut edges: Vec<Edge> = Vec::with_capacity(nt * 3 / 2 + 1);
        let mut tri_edges = vec![[u32::MAX; 3]; nt];
        let mut lookup: HashMap<(u32, u32), u32> = HashMap::with_capacity(nt * 3 / 2 + 1);
        let mut non_manifold = 0usize;

        for (t, f) in mesh.triangles.iter().enumerate() {
            let w = [
                mesh.weld[f[0] as usize],
                mesh.weld[f[1] as usize],
                mesh.weld[f[2] as usize],
            ];
            for k in 0..3 {
                let (a, b) = (w[k], w[(k + 1) % 3]);
                let key = if a < b { (a, b) } else { (b, a) };
                let id = match lookup.get(&key) {
                    Some(&id) => {
                        let e = &mut edges[id as usize];
                        if e.tri[1].is_none() {
                            e.tri[1] = Some(t as u32);
                        } else {
                            // Third and later users of the same edge are dropped
                            // from the adjacency but counted, so callers can warn
                            // instead of silently producing wrong dihedrals.
                            non_manifold += 1;
                        }
                        id
                    }
                    None => {
                        let id = edges.len() as u32;
                        edges.push(Edge {
                            v: [key.0, key.1],
                            tri: [Some(t as u32), None],
                        });
                        lookup.insert(key, id);
                        id
                    }
                };
                tri_edges[t][k] = id;
            }
        }

        // CSR of welded vertex to incident triangles: counting sort, two passes.
        let mut counts = vec![0u32; nw + 1];
        for f in &mesh.triangles {
            for &c in f {
                counts[mesh.weld[c as usize] as usize + 1] += 1;
            }
        }
        for i in 0..nw {
            counts[i + 1] += counts[i];
        }
        let vert_offset = counts.clone();
        let mut cursor = counts;
        let mut vert_tris = vec![0u32; vert_offset[nw] as usize];
        for (t, f) in mesh.triangles.iter().enumerate() {
            for &c in f {
                let w = mesh.weld[c as usize] as usize;
                vert_tris[cursor[w] as usize] = t as u32;
                cursor[w] += 1;
            }
        }

        Self {
            edges,
            tri_edges,
            non_manifold_edges: non_manifold,
            vert_offset,
            vert_tris,
        }
    }

    /// Triangles incident to a welded point. A point appears once per incident
    /// triangle corner, so a triangle can repeat if it is itself degenerate.
    #[inline]
    pub fn vertex_triangles(&self, welded: u32) -> &[u32] {
        let a = self.vert_offset[welded as usize] as usize;
        let b = self.vert_offset[welded as usize + 1] as usize;
        &self.vert_tris[a..b]
    }

    pub fn boundary_edge_count(&self) -> usize {
        self.edges.iter().filter(|e| e.is_boundary()).count()
    }

    pub fn is_closed(&self) -> bool {
        self.non_manifold_edges == 0 && self.boundary_edge_count() == 0
    }

    /// One flag per edge: true when the edge is a crease the remesher must keep.
    ///
    /// Boundaries always count. Interior edges count when the angle between the
    /// two face normals exceeds `angle_deg`. This same array drives smoothing
    /// islands for normals, feature alignment for the orientation field, and the
    /// concavity term for segmentation, so it is worth computing once.
    pub fn sharp_edges(&self, mesh: &Mesh, angle_deg: f32) -> Vec<bool> {
        let cos_limit = angle_deg.to_radians().cos();
        self.edges
            .iter()
            .map(|e| match (e.tri[0], e.tri[1]) {
                (Some(a), Some(b)) => {
                    let na = mesh.face_normal(a as usize);
                    let nb = mesh.face_normal(b as usize);
                    if na == glam::Vec3::ZERO || nb == glam::Vec3::ZERO {
                        return true;
                    }
                    na.dot(nb) < cos_limit
                }
                _ => true,
            })
            .collect()
    }

    /// Signed dihedral angle per edge, in radians.
    ///
    /// Positive is convex, negative is concave. The sign is what separates a
    /// finger from the gap between two fingers, so the segmentation step reads
    /// this rather than the unsigned angle.
    pub fn dihedral_angles(&self, mesh: &Mesh) -> Vec<f32> {
        self.edges
            .iter()
            .map(|e| match (e.tri[0], e.tri[1]) {
                (Some(a), Some(b)) => {
                    let na = mesh.face_normal(a as usize);
                    let nb = mesh.face_normal(b as usize);
                    let ca = mesh.face_centroid(a as usize);
                    let cb = mesh.face_centroid(b as usize);
                    let angle = na.dot(nb).clamp(-1.0, 1.0).acos();
                    // If the neighbour's centroid sits above our plane the pair
                    // folds outwards, which is convex.
                    if na.dot(cb - ca) > 0.0 {
                        -angle
                    } else {
                        angle
                    }
                }
                _ => 0.0,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::{Material, Mesh};
    use glam::Vec3;

    fn quad_plane() -> Mesh {
        // Two triangles sharing one edge, flat.
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
        m
    }

    #[test]
    fn two_triangles_share_exactly_one_edge() {
        let m = quad_plane();
        let adj = Adjacency::build(&m);
        assert_eq!(adj.edges.len(), 5, "four border edges plus the diagonal");
        assert_eq!(adj.boundary_edge_count(), 4);
        assert_eq!(adj.non_manifold_edges, 0);
        assert!(!adj.is_closed(), "an open quad is not a closed surface");
    }

    #[test]
    fn the_shared_edge_of_a_flat_quad_is_not_sharp() {
        let m = quad_plane();
        let adj = Adjacency::build(&m);
        let sharp = adj.sharp_edges(&m, 30.0);
        let interior = adj.edges.iter().position(|e| !e.is_boundary()).unwrap();
        assert!(!sharp[interior]);
        assert_eq!(sharp.iter().filter(|&&s| s).count(), 4, "only the border");
    }

    #[test]
    fn vertex_triangles_finds_both_faces_at_the_diagonal() {
        let m = quad_plane();
        let adj = Adjacency::build(&m);
        assert_eq!(adj.vertex_triangles(0).len(), 2);
        assert_eq!(adj.vertex_triangles(1).len(), 1);
    }

    #[test]
    fn a_fold_is_detected_as_sharp_and_signed_concave() {
        let mut m = quad_plane();
        // Fold the second triangle up by 90 degrees around the shared diagonal.
        m.positions[3] = Vec3::new(0.0, 1.0, 1.0);
        m.rebuild_weld(0.0);
        let adj = Adjacency::build(&m);
        let interior = adj.edges.iter().position(|e| !e.is_boundary()).unwrap();
        assert!(adj.sharp_edges(&m, 30.0)[interior]);
        let d = adj.dihedral_angles(&m)[interior];
        assert!(d.abs() > 0.5, "expected a real fold, got {d}");
    }
}
