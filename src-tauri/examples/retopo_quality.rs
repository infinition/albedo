//! Reproducible local comparison; no files are changed.
//! cargo run --manifest-path src-tauri/Cargo.toml --example retopo_quality -- input.glb 5000
use retopo_core::{Adjacency, Bvh};
use retopo_remesh::{isotropic, pair_into_quads, IsotropicOptions, QuadOptions};

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let path = args
        .get(1)
        .expect("usage: quality input.glb [target triangles]");
    let target = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(5000);
    let source = retopo_core::glb::load_path(std::path::Path::new(path)).expect("load GLB");
    let source_bvh = Bvh::build(&source);
    println!("source_triangles={}", source.triangle_count());
    let source_adj = Adjacency::build(&source);
    println!(
        "source_boundary_edges={},source_nonmanifold_incidents={}",
        source_adj.boundary_edge_count(),
        source_adj.non_manifold_edges
    );
    println!("mode,triangles,remesh_ms,greedy_quads,guided_quads,recovered_quads,pair_ms,boundary_edges,nonmanifold_incidents,sampled_deviation");
    for (mode, adaptivity) in [("uniform", 0.0), ("adaptive", 1.0)] {
        let start = std::time::Instant::now();
        let (mesh, _) = isotropic(
            &source,
            &IsotropicOptions {
                target_triangles: target,
                adaptivity,
                ..Default::default()
            },
            &mut |_| {},
        );
        let elapsed = start.elapsed().as_millis();
        let greedy = pair_into_quads(
            &mesh,
            &QuadOptions {
                direction_weight: 0.0,
                field_iterations: 0,
                repair_passes: 0,
                ..Default::default()
            },
        );
        let start = std::time::Instant::now();
        let paired = pair_into_quads(&mesh, &QuadOptions::default());
        let pairing_ms = start.elapsed().as_millis();
        let adj = Adjacency::build(&mesh);
        let output_bvh = Bvh::build(&mesh);
        // Bidirectional vertex AND centroid samples, capped at ~10k per side.
        // This is an error estimate, not a Hausdorff bound.
        let mut deviation = 0.0f32;
        for (from, to) in [(&mesh, &source_bvh), (&source, &output_bvh)] {
            let stride = (from.triangle_count() / 2500).max(1);
            for t in (0..from.triangle_count()).step_by(stride) {
                for p in from
                    .tri_positions(t)
                    .into_iter()
                    .chain([from.face_centroid(t)])
                {
                    if let Some(hit) = to.closest_point(p) {
                        deviation = deviation.max(hit.dist2.sqrt());
                    }
                }
            }
        }
        println!(
            "{mode},{},{elapsed},{},{},{},{pairing_ms},{},{},{deviation:.6}",
            mesh.triangle_count(),
            greedy.stats.quads,
            paired.stats.quads,
            paired.stats.recovered_quads,
            adj.boundary_edge_count(),
            adj.non_manifold_edges
        );
    }
}
