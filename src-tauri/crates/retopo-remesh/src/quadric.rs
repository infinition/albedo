//! Symmetric 4x4 error quadrics, Garland and Heckbert 1997.
//!
//! A quadric accumulates, for one vertex, the squared distance to every plane
//! its incident faces lie in. Collapsing an edge just adds the two quadrics, so
//! the cost of a collapse and the best position for the merged vertex both fall
//! out of one small matrix. Stored in f64: the sums run over thousands of planes
//! and f32 loses the small differences that decide collapse order.

use glam::{DVec3, Vec3};

/// Upper triangle of a symmetric 4x4, row major:
/// `a2 ab ac ad b2 bc bd c2 cd d2`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Quadric {
    pub m: [f64; 10],
}

impl Quadric {
    pub const ZERO: Quadric = Quadric { m: [0.0; 10] };

    /// Quadric of the plane `n . x + d = 0`, weighted by `w` (use the triangle
    /// area, so large faces matter more than slivers).
    pub fn from_plane(n: Vec3, d: f32, w: f64) -> Self {
        let (a, b, c, d) = (n.x as f64, n.y as f64, n.z as f64, d as f64);
        Quadric {
            m: [
                w * a * a,
                w * a * b,
                w * a * c,
                w * a * d,
                w * b * b,
                w * b * c,
                w * b * d,
                w * c * c,
                w * c * d,
                w * d * d,
            ],
        }
    }

    /// Quadric of the plane through `p` with unit normal `n`.
    pub fn from_point_normal(p: Vec3, n: Vec3, w: f64) -> Self {
        Self::from_plane(n, -n.dot(p), w)
    }

    pub fn add(&mut self, o: &Quadric) {
        for i in 0..10 {
            self.m[i] += o.m[i];
        }
    }

    pub fn scaled(mut self, k: f64) -> Self {
        for v in &mut self.m {
            *v *= k;
        }
        self
    }

    /// `v^T Q v` for `v = (p, 1)`. Never negative in exact arithmetic; rounding
    /// can push it a hair below zero, so callers clamp.
    pub fn eval(&self, p: Vec3) -> f64 {
        let (x, y, z) = (p.x as f64, p.y as f64, p.z as f64);
        let m = &self.m;
        m[0] * x * x
            + 2.0 * m[1] * x * y
            + 2.0 * m[2] * x * z
            + 2.0 * m[3] * x
            + m[4] * y * y
            + 2.0 * m[5] * y * z
            + 2.0 * m[6] * y
            + m[7] * z * z
            + 2.0 * m[8] * z
            + m[9]
    }

    /// Position minimising `eval`, by solving the 3x3 upper block.
    ///
    /// Returns `None` when the block is singular, which happens on a flat or
    /// perfectly symmetric neighbourhood. The caller then falls back to the two
    /// endpoints and their midpoint, which is what Garland and Heckbert suggest.
    pub fn minimiser(&self) -> Option<Vec3> {
        let m = &self.m;
        let a = DVec3::new(m[0], m[1], m[2]);
        let b = DVec3::new(m[1], m[4], m[5]);
        let c = DVec3::new(m[2], m[5], m[7]);

        let cof0 = b.y * c.z - b.z * c.y;
        let cof1 = b.z * c.x - b.x * c.z;
        let cof2 = b.x * c.y - b.y * c.x;
        let det = a.x * cof0 + a.y * cof1 + a.z * cof2;

        // The scale of the matrix sets what "singular" means; comparing the
        // determinant against a fixed epsilon would accept garbage on large
        // meshes and reject good solves on small ones.
        let scale = a.length() + b.length() + c.length();
        if scale <= 0.0 || det.abs() < 1e-12 * scale * scale * scale {
            return None;
        }

        let rhs = DVec3::new(-m[3], -m[6], -m[8]);
        let inv_det = 1.0 / det;
        let x = inv_det
            * (rhs.x * cof0 + rhs.y * (a.z * c.y - a.y * c.z) + rhs.z * (a.y * b.z - a.z * b.y));
        let y = inv_det
            * (rhs.x * cof1 + rhs.y * (a.x * c.z - a.z * c.x) + rhs.z * (a.z * b.x - a.x * b.z));
        let z = inv_det
            * (rhs.x * cof2 + rhs.y * (a.y * c.x - a.x * c.y) + rhs.z * (a.x * b.y - a.y * b.x));

        let v = Vec3::new(x as f32, y as f32, z as f32);
        if v.is_finite() {
            Some(v)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_point_on_the_plane_costs_nothing() {
        let q = Quadric::from_point_normal(Vec3::new(0.0, 1.0, 0.0), Vec3::Y, 1.0);
        assert!(q.eval(Vec3::new(5.0, 1.0, -3.0)).abs() < 1e-9);
    }

    #[test]
    fn cost_is_the_squared_distance_to_the_plane() {
        let q = Quadric::from_point_normal(Vec3::ZERO, Vec3::Y, 1.0);
        assert!((q.eval(Vec3::new(0.0, 3.0, 0.0)) - 9.0).abs() < 1e-9);
    }

    #[test]
    fn three_orthogonal_planes_pin_down_their_corner() {
        let corner = Vec3::new(1.0, 2.0, 3.0);
        let mut q = Quadric::from_point_normal(corner, Vec3::X, 1.0);
        q.add(&Quadric::from_point_normal(corner, Vec3::Y, 1.0));
        q.add(&Quadric::from_point_normal(corner, Vec3::Z, 1.0));
        let v = q.minimiser().expect("three orthogonal planes are solvable");
        assert!(v.abs_diff_eq(corner, 1e-4), "got {v:?}");
    }

    #[test]
    fn a_single_plane_has_no_unique_minimiser() {
        let q = Quadric::from_point_normal(Vec3::ZERO, Vec3::Y, 1.0);
        assert!(q.minimiser().is_none(), "a plane leaves two free directions");
    }

    #[test]
    fn two_parallel_planes_are_still_singular() {
        let mut q = Quadric::from_point_normal(Vec3::ZERO, Vec3::Y, 1.0);
        q.add(&Quadric::from_point_normal(Vec3::new(0.0, 1.0, 0.0), Vec3::Y, 1.0));
        assert!(q.minimiser().is_none());
    }

    #[test]
    fn singularity_detection_holds_at_large_coordinates() {
        // Same configuration, moved far from the origin and scaled up. A fixed
        // epsilon on the determinant would call this singular and lose the exact
        // corner, which shows up as visible drift on real world scans.
        let corner = Vec3::splat(10_000.0);
        let mut q = Quadric::from_point_normal(corner, Vec3::X, 1.0);
        q.add(&Quadric::from_point_normal(corner, Vec3::Y, 1.0));
        q.add(&Quadric::from_point_normal(corner, Vec3::Z, 1.0));
        let v = q.minimiser().expect("still solvable far from the origin");
        assert!(v.abs_diff_eq(corner, 1.0), "got {v:?}");
    }
}
