//! Curvature sizing on the immutable source, with area-normalized density.
//! Sizes are interpolated from this source after remeshing; estimating them on
//! each coarser result would mistake its facets for new geometric features.

use retopo_core::{Adjacency, Bvh, Mesh};

pub(crate) fn source_sizes(mesh: &Mesh, target: f32, strength: f32) -> Vec<f32> {
    let mut area = vec![0.0f32; mesh.weld_count];
    let mut bend = vec![0.0f32; mesh.weld_count];
    let mut pos = vec![glam::Vec3::ZERO; mesh.weld_count];
    for (r, &w) in mesh.weld.iter().enumerate() {
        pos[w as usize] = mesh.positions[r];
    }
    for (t, f) in mesh.triangles.iter().enumerate() {
        for &v in f {
            area[mesh.weld[v as usize] as usize] += mesh.face_area(t) / 3.0;
        }
    }
    let adj = Adjacency::build(mesh);
    let normals: Vec<_> = (0..mesh.triangle_count())
        .map(|t| mesh.face_normal(t))
        .collect();
    for e in &adj.edges {
        if let [Some(a), Some(b)] = e.tri {
            let (na, nb) = (normals[a as usize], normals[b as usize]);
            // atan2 is stable near coplanarity; acos(dot) amplifies rounding
            // into artificial curvature on nearly flat triangulation edges.
            let angle = na.cross(nb).length().atan2(na.dot(nb));
            let contribution = angle * pos[e.v[0] as usize].distance(pos[e.v[1] as usize]) * 0.25;
            for &v in &e.v {
                bend[v as usize] += contribution;
            }
        }
    }
    let strength = if strength.is_finite() {
        strength.clamp(0.0, 2.0)
    } else {
        0.0
    };
    let density: Vec<_> = area
        .iter()
        .zip(&bend)
        .map(|(&a, &b)| {
            if a > 0.0 {
                1.0 + strength * 4.0 * target * b / a
            } else {
                1.0
            }
        })
        .collect();
    // N is proportional to integral(1/h²). Normalize with surface area rather
    // than vertex count so an oversampled region does not consume the budget.
    let total: f64 = area.iter().map(|&a| a as f64).sum();
    let mean = if total > 0.0 {
        (area
            .iter()
            .zip(&density)
            .map(|(&a, &d)| a as f64 * d as f64)
            .sum::<f64>()
            / total) as f32
    } else {
        1.0
    };
    let mut sizes: Vec<_> = density
        .iter()
        .map(|&d| (mean / d).sqrt().clamp(0.4, 2.0))
        .collect();
    // Limit abrupt size transitions. Bounded sweeps keep preprocessing linear.
    for _ in 0..8 {
        for e in &adj.edges {
            let (a, b) = (e.v[0] as usize, e.v[1] as usize);
            let step = 0.35 * pos[a].distance(pos[b]) / target;
            sizes[a] = sizes[a].min(sizes[b] + step);
            sizes[b] = sizes[b].min(sizes[a] + step);
        }
    }
    sizes
}

pub(crate) fn sample(mesh: &Mesh, bvh: &Bvh, sizes: &[f32], p: glam::Vec3) -> f32 {
    bvh.closest_point(p)
        .map(|hit| {
            let f = mesh.triangles[hit.tri as usize];
            (0..3)
                .map(|k| sizes[mesh.weld[f[k] as usize] as usize] * hit.bary[k])
                .sum()
        })
        .unwrap_or(1.0)
}
