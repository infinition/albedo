//! Bounding volume hierarchy over triangles.
//!
//! Binned surface area heuristic build, iterative traversal. Two queries matter
//! downstream: ray casting (shape diameter function, cage projection for the
//! bake) and closest point (snapping a remeshed vertex back onto the original
//! surface). Both are hot enough that the triangle positions are copied into the
//! tree rather than chased through the mesh index arrays.

use glam::Vec3;

use crate::mesh::{Aabb, Mesh};

const BINS: usize = 12;
const MAX_LEAF: u32 = 4;

#[derive(Clone, Copy, Debug)]
struct Node {
    bounds: Aabb,
    /// Leaf: first index into `tri_index`. Interior: index of the left child,
    /// the right child always sits at `left_first + 1`.
    left_first: u32,
    /// Zero marks an interior node.
    count: u32,
}

/// A ray hit against the surface.
#[derive(Clone, Copy, Debug)]
pub struct RayHit {
    pub t: f32,
    /// Index into `Mesh::triangles`.
    pub tri: u32,
    /// Barycentric weights of the three corners, in order.
    pub bary: Vec3,
    pub point: Vec3,
    /// False when the ray hit the back of the triangle.
    pub front_face: bool,
}

/// The nearest point on the surface to a query point.
#[derive(Clone, Copy, Debug)]
pub struct ClosestHit {
    pub dist2: f32,
    pub tri: u32,
    pub bary: Vec3,
    pub point: Vec3,
}

pub struct Bvh {
    nodes: Vec<Node>,
    /// Original triangle ids, permuted into leaf order.
    tri_index: Vec<u32>,
    /// Corner positions, in the same permuted order.
    tri_pos: Vec<[Vec3; 3]>,
}

impl Bvh {
    pub fn build(mesh: &Mesh) -> Self {
        let n = mesh.triangle_count();
        let mut tri_index: Vec<u32> = (0..n as u32).collect();
        let mut tri_pos: Vec<[Vec3; 3]> = (0..n).map(|t| mesh.tri_positions(t)).collect();
        let centroids: Vec<Vec3> = tri_pos
            .iter()
            .map(|p| (p[0] + p[1] + p[2]) / 3.0)
            .collect();
        let mut centroids = centroids;

        let mut nodes: Vec<Node> = Vec::with_capacity(n.max(1) * 2);
        nodes.push(Node {
            bounds: Aabb::EMPTY,
            left_first: 0,
            count: n as u32,
        });

        if n == 0 {
            return Self {
                nodes,
                tri_index,
                tri_pos,
            };
        }

        let mut stack = vec![0usize];
        while let Some(ni) = stack.pop() {
            let (first, count) = {
                let node = &nodes[ni];
                (node.left_first as usize, node.count as usize)
            };

            let mut bounds = Aabb::EMPTY;
            let mut cbounds = Aabb::EMPTY;
            for i in first..first + count {
                for p in tri_pos[i] {
                    bounds.grow(p);
                }
                cbounds.grow(centroids[i]);
            }
            nodes[ni].bounds = bounds;

            if count as u32 <= MAX_LEAF {
                continue;
            }

            let extent = cbounds.extent();
            let axis = if extent.x > extent.y && extent.x > extent.z {
                0
            } else if extent.y > extent.z {
                1
            } else {
                2
            };
            let cmin = cbounds.min[axis];
            let cext = extent[axis];
            if cext < 1e-12 {
                continue; // every centroid coincides, splitting cannot help
            }
            let scale = BINS as f32 / cext;

            let mut bin_bounds = [Aabb::EMPTY; BINS];
            let mut bin_count = [0u32; BINS];
            for i in first..first + count {
                let b = (((centroids[i][axis] - cmin) * scale) as usize).min(BINS - 1);
                bin_count[b] += 1;
                for p in tri_pos[i] {
                    bin_bounds[b].grow(p);
                }
            }

            // Sweep from both ends so each candidate plane knows the cost of the
            // whole left side and the whole right side in one pass each.
            let mut left_area = [0.0f32; BINS - 1];
            let mut left_count = [0u32; BINS - 1];
            let mut acc = Aabb::EMPTY;
            let mut acc_n = 0u32;
            for i in 0..BINS - 1 {
                acc.union(&bin_bounds[i]);
                acc_n += bin_count[i];
                left_area[i] = if acc.is_empty() { 0.0 } else { acc.half_area() };
                left_count[i] = acc_n;
            }
            let mut right_area = [0.0f32; BINS - 1];
            let mut right_count = [0u32; BINS - 1];
            acc = Aabb::EMPTY;
            acc_n = 0;
            for i in (1..BINS).rev() {
                acc.union(&bin_bounds[i]);
                acc_n += bin_count[i];
                right_area[i - 1] = if acc.is_empty() { 0.0 } else { acc.half_area() };
                right_count[i - 1] = acc_n;
            }

            let mut best_cost = f32::INFINITY;
            let mut best_plane = usize::MAX;
            for i in 0..BINS - 1 {
                if left_count[i] == 0 || right_count[i] == 0 {
                    continue;
                }
                let cost = left_area[i] * left_count[i] as f32
                    + right_area[i] * right_count[i] as f32;
                if cost < best_cost {
                    best_cost = cost;
                    best_plane = i;
                }
            }

            // Traversing this node has to beat testing its triangles one by one.
            let leaf_cost = bounds.half_area() * count as f32;
            if best_plane == usize::MAX || best_cost >= leaf_cost {
                continue;
            }

            let mut i = first;
            let mut j = first + count;
            while i < j {
                let b = (((centroids[i][axis] - cmin) * scale) as usize).min(BINS - 1);
                if b <= best_plane {
                    i += 1;
                } else {
                    j -= 1;
                    tri_index.swap(i, j);
                    tri_pos.swap(i, j);
                    centroids.swap(i, j);
                }
            }
            let left_n = i - first;
            if left_n == 0 || left_n == count {
                continue;
            }

            let left = nodes.len() as u32;
            nodes.push(Node {
                bounds: Aabb::EMPTY,
                left_first: first as u32,
                count: left_n as u32,
            });
            nodes.push(Node {
                bounds: Aabb::EMPTY,
                left_first: i as u32,
                count: (count - left_n) as u32,
            });
            nodes[ni].left_first = left;
            nodes[ni].count = 0;
            stack.push(left as usize);
            stack.push(left as usize + 1);
        }

        Self {
            nodes,
            tri_index,
            tri_pos,
        }
    }

    pub fn bounds(&self) -> Aabb {
        self.nodes.first().map(|n| n.bounds).unwrap_or(Aabb::EMPTY)
    }

    pub fn is_empty(&self) -> bool {
        self.tri_index.is_empty()
    }

    /// Closest hit along `origin + t * dir` for `t` in `(t_min, t_max)`.
    ///
    /// `dir` need not be normalised, but `t` is then measured in units of `dir`.
    pub fn raycast(&self, origin: Vec3, dir: Vec3, t_min: f32, t_max: f32) -> Option<RayHit> {
        if self.is_empty() {
            return None;
        }
        let inv = Vec3::new(1.0 / dir.x, 1.0 / dir.y, 1.0 / dir.z);
        let mut best: Option<RayHit> = None;
        let mut t_far = t_max;

        let mut stack: [u32; 64] = [0; 64];
        let mut sp = 1usize;
        while sp > 0 {
            sp -= 1;
            let node = self.nodes[stack[sp] as usize];
            if slab(node.bounds, origin, inv, t_min, t_far).is_none() {
                continue;
            }
            if node.count > 0 {
                let first = node.left_first as usize;
                for i in first..first + node.count as usize {
                    if let Some((t, u, v, front)) =
                        moller_trumbore(self.tri_pos[i], origin, dir, t_min, t_far)
                    {
                        t_far = t;
                        best = Some(RayHit {
                            t,
                            tri: self.tri_index[i],
                            bary: Vec3::new(1.0 - u - v, u, v),
                            point: origin + dir * t,
                            front_face: front,
                        });
                    }
                }
                continue;
            }

            // Visit the nearer child first so t_far tightens as early as possible.
            let l = node.left_first;
            let r = l + 1;
            let dl = slab(self.nodes[l as usize].bounds, origin, inv, t_min, t_far);
            let dr = slab(self.nodes[r as usize].bounds, origin, inv, t_min, t_far);
            match (dl, dr) {
                (Some(a), Some(b)) => {
                    let (near, far) = if a <= b { (l, r) } else { (r, l) };
                    if sp + 2 <= stack.len() {
                        stack[sp] = far;
                        stack[sp + 1] = near;
                        sp += 2;
                    }
                }
                (Some(_), None) => {
                    stack[sp] = l;
                    sp += 1;
                }
                (None, Some(_)) => {
                    stack[sp] = r;
                    sp += 1;
                }
                (None, None) => {}
            }
        }
        best
    }

    /// True when any triangle blocks the segment. Cheaper than `raycast`: it
    /// stops at the first hit instead of keeping the nearest.
    pub fn occluded(&self, origin: Vec3, dir: Vec3, t_min: f32, t_max: f32) -> bool {
        if self.is_empty() {
            return false;
        }
        let inv = Vec3::new(1.0 / dir.x, 1.0 / dir.y, 1.0 / dir.z);
        let mut stack: [u32; 64] = [0; 64];
        let mut sp = 1usize;
        while sp > 0 {
            sp -= 1;
            let node = self.nodes[stack[sp] as usize];
            if slab(node.bounds, origin, inv, t_min, t_max).is_none() {
                continue;
            }
            if node.count > 0 {
                let first = node.left_first as usize;
                for i in first..first + node.count as usize {
                    if moller_trumbore(self.tri_pos[i], origin, dir, t_min, t_max).is_some() {
                        return true;
                    }
                }
            } else if sp + 2 <= stack.len() {
                stack[sp] = node.left_first;
                stack[sp + 1] = node.left_first + 1;
                sp += 2;
            }
        }
        false
    }

    /// Nearest point on the surface to `p`.
    pub fn closest_point(&self, p: Vec3) -> Option<ClosestHit> {
        if self.is_empty() {
            return None;
        }
        let mut best: Option<ClosestHit> = None;
        let mut best_d2 = f32::INFINITY;

        let mut stack: [u32; 64] = [0; 64];
        let mut sp = 1usize;
        while sp > 0 {
            sp -= 1;
            let node = self.nodes[stack[sp] as usize];
            if aabb_dist2(node.bounds, p) > best_d2 {
                continue;
            }
            if node.count > 0 {
                let first = node.left_first as usize;
                for i in first..first + node.count as usize {
                    let (q, bary) = closest_on_triangle(self.tri_pos[i], p);
                    let d2 = q.distance_squared(p);
                    if d2 < best_d2 {
                        best_d2 = d2;
                        best = Some(ClosestHit {
                            dist2: d2,
                            tri: self.tri_index[i],
                            bary,
                            point: q,
                        });
                    }
                }
                continue;
            }
            let l = node.left_first;
            let r = l + 1;
            let dl = aabb_dist2(self.nodes[l as usize].bounds, p);
            let dr = aabb_dist2(self.nodes[r as usize].bounds, p);
            let (near, far, dfar) = if dl <= dr { (l, r, dr) } else { (r, l, dl) };
            if sp + 2 <= stack.len() {
                if dfar <= best_d2 {
                    stack[sp] = far;
                    sp += 1;
                }
                stack[sp] = near;
                sp += 1;
            }
        }
        best
    }
}

#[inline]
fn slab(b: Aabb, origin: Vec3, inv_dir: Vec3, t_min: f32, t_max: f32) -> Option<f32> {
    if b.is_empty() {
        return None;
    }
    let t0 = (b.min - origin) * inv_dir;
    let t1 = (b.max - origin) * inv_dir;
    let lo = t0.min(t1);
    let hi = t0.max(t1);
    let near = lo.x.max(lo.y).max(lo.z).max(t_min);
    let far = hi.x.min(hi.y).min(hi.z).min(t_max);
    if near <= far {
        Some(near)
    } else {
        None
    }
}

#[inline]
fn aabb_dist2(b: Aabb, p: Vec3) -> f32 {
    if b.is_empty() {
        return f32::INFINITY;
    }
    let d = (b.min - p).max(Vec3::ZERO).max(p - b.max);
    d.length_squared()
}

/// Moller-Trumbore. Returns `(t, u, v, front_face)`.
#[inline]
fn moller_trumbore(
    tri: [Vec3; 3],
    origin: Vec3,
    dir: Vec3,
    t_min: f32,
    t_max: f32,
) -> Option<(f32, f32, f32, bool)> {
    const EPS: f32 = 1e-9;
    let e1 = tri[1] - tri[0];
    let e2 = tri[2] - tri[0];
    let pv = dir.cross(e2);
    let det = e1.dot(pv);
    if det.abs() < EPS {
        return None;
    }
    let inv_det = 1.0 / det;
    let tv = origin - tri[0];
    let u = tv.dot(pv) * inv_det;
    if !(-1e-6..=1.0 + 1e-6).contains(&u) {
        return None;
    }
    let qv = tv.cross(e1);
    let v = dir.dot(qv) * inv_det;
    if v < -1e-6 || u + v > 1.0 + 1e-6 {
        return None;
    }
    let t = e2.dot(qv) * inv_det;
    if t < t_min || t > t_max {
        return None;
    }
    Some((t, u, v, det > 0.0))
}

/// Closest point on a triangle to `p`, with its barycentric weights.
///
/// The seven region test from Ericson, Real-Time Collision Detection. Handles
/// the vertex and edge regions explicitly rather than projecting and hoping.
#[inline]
fn closest_on_triangle(tri: [Vec3; 3], p: Vec3) -> (Vec3, Vec3) {
    let (a, b, c) = (tri[0], tri[1], tri[2]);
    let ab = b - a;
    let ac = c - a;
    let ap = p - a;

    let d1 = ab.dot(ap);
    let d2 = ac.dot(ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return (a, Vec3::new(1.0, 0.0, 0.0));
    }

    let bp = p - b;
    let d3 = ab.dot(bp);
    let d4 = ac.dot(bp);
    if d3 >= 0.0 && d4 <= d3 {
        return (b, Vec3::new(0.0, 1.0, 0.0));
    }

    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return (a + ab * v, Vec3::new(1.0 - v, v, 0.0));
    }

    let cp = p - c;
    let d5 = ab.dot(cp);
    let d6 = ac.dot(cp);
    if d6 >= 0.0 && d5 <= d6 {
        return (c, Vec3::new(0.0, 0.0, 1.0));
    }

    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return (a + ac * w, Vec3::new(1.0 - w, 0.0, w));
    }

    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return (b + (c - b) * w, Vec3::new(0.0, 1.0 - w, w));
    }

    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    (a + ab * v + ac * w, Vec3::new(1.0 - v - w, v, w))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::{Material, Mesh};

    /// An axis aligned box from (-1,-1,-1) to (1,1,1), outward facing.
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
        m
    }

    #[test]
    fn ray_from_outside_hits_the_near_face_first() {
        let m = box_mesh();
        let bvh = Bvh::build(&m);
        let hit = bvh
            .raycast(Vec3::new(0.0, 0.0, -5.0), Vec3::Z, 0.0, 100.0)
            .expect("the box is right there");
        assert!((hit.t - 4.0).abs() < 1e-4, "t = {}", hit.t);
        assert!((hit.point.z + 1.0).abs() < 1e-4);
        let s: f32 = hit.bary.x + hit.bary.y + hit.bary.z;
        assert!((s - 1.0).abs() < 1e-4, "barycentrics must sum to one");
    }

    #[test]
    fn ray_that_misses_returns_nothing() {
        let m = box_mesh();
        let bvh = Bvh::build(&m);
        assert!(bvh
            .raycast(Vec3::new(5.0, 5.0, -5.0), Vec3::Z, 0.0, 100.0)
            .is_none());
    }

    #[test]
    fn t_max_is_respected() {
        let m = box_mesh();
        let bvh = Bvh::build(&m);
        assert!(bvh
            .raycast(Vec3::new(0.0, 0.0, -5.0), Vec3::Z, 0.0, 3.0)
            .is_none());
        assert!(bvh.occluded(Vec3::new(0.0, 0.0, -5.0), Vec3::Z, 0.0, 100.0));
    }

    #[test]
    fn closest_point_lands_on_the_nearest_face() {
        let m = box_mesh();
        let bvh = Bvh::build(&m);
        let hit = bvh.closest_point(Vec3::new(0.0, 0.0, 3.0)).unwrap();
        assert!((hit.point.z - 1.0).abs() < 1e-4, "{:?}", hit.point);
        assert!((hit.dist2 - 4.0).abs() < 1e-3);
    }

    #[test]
    fn closest_point_from_inside_is_the_wall() {
        let m = box_mesh();
        let bvh = Bvh::build(&m);
        let hit = bvh.closest_point(Vec3::new(0.0, 0.0, 0.5)).unwrap();
        assert!((hit.dist2 - 0.25).abs() < 1e-3, "dist2 = {}", hit.dist2);
    }

    #[test]
    fn closest_point_snaps_to_a_corner() {
        let m = box_mesh();
        let bvh = Bvh::build(&m);
        let hit = bvh.closest_point(Vec3::splat(4.0)).unwrap();
        assert!(hit.point.abs_diff_eq(Vec3::splat(1.0), 1e-4), "{:?}", hit.point);
    }

    #[test]
    fn every_triangle_is_reachable_after_the_sah_build() {
        // A regression guard on the partition step: losing a triangle in the
        // swap loop is silent and would only show up as holes much later.
        let m = box_mesh();
        let bvh = Bvh::build(&m);
        let mut seen: Vec<u32> = bvh.tri_index.clone();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), m.triangle_count());
    }

    #[test]
    fn empty_mesh_answers_without_panicking() {
        let bvh = Bvh::build(&Mesh::default());
        assert!(bvh.is_empty());
        assert!(bvh.raycast(Vec3::ZERO, Vec3::Z, 0.0, 1.0).is_none());
        assert!(bvh.closest_point(Vec3::ZERO).is_none());
    }
}
