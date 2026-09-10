//! Four-fold tangent directions, transported across shared edges.
//! exp(4 i theta) makes the two axes and their signs equivalent. This is a
//! bounded diffusion heuristic, not a seamless integer-grid parametrization.

use glam::{Vec2, Vec3};
use rayon::prelude::*;
use retopo_core::{Adjacency, Mesh};

pub(crate) struct CrossField {
    axes: Vec<(Vec3, Vec3)>,
    values: Vec<Vec2>,
}

fn product(a: Vec2, b: Vec2) -> Vec2 {
    Vec2::new(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x)
}

fn encode(axes: (Vec3, Vec3), edge: Vec3) -> Vec2 {
    let z = Vec2::new(edge.dot(axes.0), edge.dot(axes.1)).normalize_or_zero();
    let z2 = product(z, z);
    product(z2, z2)
}

impl CrossField {
    pub(crate) fn solve(mesh: &Mesh, adj: &Adjacency, fold: f32, iterations: u32) -> Self {
        let n = mesh.triangle_count();
        let normals: Vec<_> = (0..n).map(|t| mesh.face_normal(t)).collect();
        let axes: Vec<_> = (0..n)
            .map(|t| {
                let p = mesh.tri_positions(t);
                let edges = [p[1] - p[0], p[2] - p[1], p[0] - p[2]];
                let x = edges
                    .into_iter()
                    .max_by(|a, b| a.length_squared().total_cmp(&b.length_squared()))
                    .unwrap()
                    .normalize_or_zero();
                (x, normals[t].cross(x).normalize_or_zero())
            })
            .collect();
        let mut incidence = vec![0u32; adj.edges.len()];
        for edges in &adj.tri_edges {
            for &e in edges {
                incidence[e as usize] += 1;
            }
        }
        let mut links = vec![Vec::with_capacity(3); n];
        let mut seeds = vec![Vec2::ZERO; n];
        let mut weights = vec![0.0f32; n];
        let cos = fold.to_radians().cos();
        for (ei, e) in adj.edges.iter().enumerate() {
            let Some(a) = e.tri[0].map(|t| t as usize) else {
                continue;
            };
            let f = mesh.triangles[a];
            let p = |w| {
                mesh.positions[*f.iter().find(|&&r| mesh.weld[r as usize] == w).unwrap() as usize]
            };
            let edge = p(e.v[1]) - p(e.v[0]);
            let qa = encode(axes[a], edge);
            let b = e.tri[1].map(|t| t as usize);
            let sharp = b.map(|b| normals[a].dot(normals[b]) < cos).unwrap_or(true);
            if incidence[ei] != 2 || sharp {
                for t in [Some(a), b].into_iter().flatten() {
                    seeds[t] += encode(axes[t], edge) * 4.0;
                    weights[t] += 4.0;
                }
            } else if let Some(b) = b {
                let qb = encode(axes[b], edge);
                let transport = product(qa, Vec2::new(qb.x, -qb.y));
                links[a].push((b, transport));
                links[b].push((a, Vec2::new(transport.x, -transport.y)));
                // Curvature provides a weak seed; sharp features dominate it.
                let bend = (1.0 - normals[a].dot(normals[b])).max(0.0);
                seeds[a] += qa * bend;
                seeds[b] += qb * bend;
                weights[a] += bend;
                weights[b] += bend;
            }
        }
        let mut values: Vec<_> = seeds
            .iter()
            .map(|s| {
                if s.length_squared() > 1e-12 {
                    s.normalize()
                } else {
                    Vec2::X
                }
            })
            .collect();
        for _ in 0..iterations.min(64) {
            let step = |t: usize| {
                let mut sum = seeds[t] + values[t] * 0.25;
                let mut weight = weights[t] + 0.25;
                for &(other, rotation) in &links[t] {
                    sum += product(rotation, values[other]);
                    weight += 1.0;
                }
                sum / weight
            };
            values = if n >= 4096 {
                (0..n).into_par_iter().map(step).collect()
            } else {
                (0..n).map(step).collect()
            };
        }
        Self { axes, values }
    }

    /// Zero means aligned. Conflicting directions reduce confidence instead
    /// of forcing an arbitrary axis near a singularity.
    pub(crate) fn penalty(&self, t: usize, edge: Vec3) -> f32 {
        let q = self.values[t];
        (q.length() - q.dot(encode(self.axes[t], edge))).max(0.0) * 0.5
    }
}
