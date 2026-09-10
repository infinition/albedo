//! Isotropic remeshing, Botsch and Kobbelt.
//!
//! Four operations run in sequence, several times over: split what is too long,
//! collapse what is too short, flip toward a valence of six, then relax and
//! reproject. The result is a mesh whose triangles are all roughly the same size
//! and roughly equilateral, which is what every later stage wants and what a
//! quadric decimation never produces.
//!
//! This is also the honest route to quads. Pairing adjacent triangles of a
//! regular isotropic mesh gives a quad-dominant result immediately, long before
//! a field-aligned remesher exists.
//!
//! Per corner attributes are not carried through. Splits and collapses would
//! have to invent texture coordinates at every step, and the answer would be
//! wrong; the stage that follows this one is a bake, which builds a fresh atlas
//! anyway. Losing the source UVs here is a decision, not an oversight.

use std::collections::{HashMap, HashSet};

use glam::Vec3;
use retopo_core::{Bvh, Mesh};

use crate::relax::{self, RelaxOptions};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct IsotropicOptions {
    /// Edge length to converge on. Zero picks one from the mesh so the triangle
    /// count lands near `target_triangles`.
    pub target_edge: f32,
    /// Used only when `target_edge` is zero.
    pub target_triangles: usize,
    pub iterations: u32,
    /// Edges sharper than this are never collapsed or flipped away.
    pub sharp_angle_deg: f32,
    /// Relax passes between each remeshing iteration.
    pub relax_passes: u32,
    /// Hold existing open-border vertices in place (splitting is still allowed).
    pub preserve_boundary: bool,
    /// Zero is uniform; one allocates smaller triangles to curved regions.
    pub adaptivity: f32,
}

impl Default for IsotropicOptions {
    fn default() -> Self {
        Self {
            target_edge: 0.0,
            target_triangles: 5000,
            iterations: 5,
            sharp_angle_deg: 45.0,
            relax_passes: 3,
            preserve_boundary: true,
            adaptivity: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct IsotropicStats {
    pub input_triangles: usize,
    pub output_triangles: usize,
    pub splits: usize,
    pub collapses: usize,
    pub flips: usize,
    pub target_edge: f32,
    /// Share of interior vertices with valence six, a triangle regularity metric.
    pub regular_fraction: f32,
}

/// Remesh to a uniform edge length, staying on the original surface.
pub fn isotropic(
    mesh: &Mesh,
    opts: &IsotropicOptions,
    progress: &mut dyn FnMut(f32),
) -> (Mesh, IsotropicStats) {
    let mut stats = IsotropicStats {
        input_triangles: mesh.triangle_count(),
        ..Default::default()
    };
    if mesh.triangles.is_empty() || opts.iterations == 0 {
        stats.output_triangles = mesh.triangle_count();
        progress(1.0);
        return (mesh.clone(), stats);
    }

    // A uniform mesh of N triangles over area A has edges of about
    // sqrt(4A / (N * sqrt(3))). Solving that backwards is a far better first
    // guess than any fixed number.
    let target = if opts.target_edge.is_finite() && opts.target_edge > 0.0 {
        opts.target_edge
    } else {
        let area = mesh.total_area().max(1e-12);
        let n = opts.target_triangles.max(4) as f32;
        (4.0 * area / (n * 3.0f32.sqrt())).sqrt()
    };
    stats.target_edge = target;

    let source = Bvh::build(mesh);
    let sizes =
        (opts.adaptivity > 0.0).then(|| crate::sizing::source_sizes(mesh, target, opts.adaptivity));
    let mut d = Dyn::from_mesh(mesh);
    d.lock_features(opts.sharp_angle_deg, opts.preserve_boundary);
    if let Some(sizes) = &sizes {
        d.size.clone_from(sizes);
    }
    let high = target * 4.0 / 3.0;
    let low = target * 4.0 / 5.0;

    for it in 0..opts.iterations.max(1) {
        // Each operation runs to a fixed point rather than once.
        //
        // A single split pass only halves each long edge, so on an anisotropic
        // input the long edges are still long and the collapse pass then refuses
        // nearly everything, because collapsing would create an edge over the
        // limit. The mesh comes out *less* uniform than it went in. Driving each
        // stage to a fixed point is what makes the sequence converge.
        stats.splits += d.run_to_fixpoint(8, |d| d.split_long(high, &source));
        stats.collapses += d.run_to_fixpoint(6, |d| d.collapse_short(low, high, &source));
        stats.flips += d.run_to_fixpoint(4, |d| d.flip_to_valence());

        let mut out = d.to_mesh(opts.sharp_angle_deg);
        let mut next = Dyn::from_mesh(&out);
        next.inherit_features(&d);
        relax::relax_with_pins(
            &mut out,
            Some(&source),
            &RelaxOptions {
                iterations: opts.relax_passes,
                strength: 0.6,
                sharp_angle_deg: opts.sharp_angle_deg,
                // Source constraints are carried explicitly; coarse facets
                // must not become additional creases on every iteration.
                preserve_features: false,
                preserve_boundary: false,
                ..RelaxOptions::default()
            },
            &next.locked,
            &mut |_| {},
        );
        d = Dyn::from_mesh(&out);
        d.locked = next.locked;
        d.features = next.features;
        if let Some(sizes) = &sizes {
            for (v, &p) in d.pos.iter().enumerate() {
                d.size[v] = crate::sizing::sample(mesh, &source, sizes, p);
            }
        }

        progress((it + 1) as f32 / opts.iterations.max(1) as f32);
    }

    // Relaxation changes the geometric admissibility of flips. Finish with
    // connectivity optimization at the final positions, without another move.
    stats.flips += d.run_to_fixpoint(4, |d| d.flip_to_valence());
    let out = d.to_mesh(opts.sharp_angle_deg);
    stats.output_triangles = out.triangle_count();
    stats.regular_fraction = regular_fraction(&out);
    (out, stats)
}

/// Share of interior vertices with exactly six neighbours.
pub fn regular_fraction(mesh: &Mesh) -> f32 {
    let adj = retopo_core::Adjacency::build(mesh);
    let mut valence = vec![0u32; mesh.weld_count];
    let mut boundary = vec![false; mesh.weld_count];
    for e in &adj.edges {
        valence[e.v[0] as usize] += 1;
        valence[e.v[1] as usize] += 1;
        if e.is_boundary() {
            boundary[e.v[0] as usize] = true;
            boundary[e.v[1] as usize] = true;
        }
    }
    let mut regular = 0usize;
    let mut total = 0usize;
    for v in 0..mesh.weld_count {
        if boundary[v] || valence[v] == 0 {
            continue;
        }
        total += 1;
        if valence[v] == 6 {
            regular += 1;
        }
    }
    if total == 0 {
        0.0
    } else {
        regular as f32 / total as f32
    }
}

/* ----------------------------------------------------------- dynamic mesh */

/// Positions and triangles with enough bookkeeping to split, collapse and flip.
///
/// Deliberately not the main `Mesh`: that one carries per corner attributes and
/// a weld layer, and every operation here would have to maintain both.
struct Dyn {
    pos: Vec<Vec3>,
    tri: Vec<[u32; 3]>,
    alive: Vec<bool>,
    vtri: Vec<Vec<u32>>,
    dead_verts: Vec<bool>,
    size: Vec<f32>,
    locked: Vec<bool>,
    features: HashSet<(u32, u32)>,
}

impl Dyn {
    fn from_mesh(mesh: &Mesh) -> Self {
        // Collapse to welded points: the operations below are topological.
        let nw = mesh.weld_count;
        let mut pos = vec![Vec3::ZERO; nw];
        for (r, &w) in mesh.weld.iter().enumerate() {
            pos[w as usize] = mesh.positions[r];
        }
        let tri: Vec<[u32; 3]> = mesh
            .triangles
            .iter()
            .map(|f| {
                [
                    mesh.weld[f[0] as usize],
                    mesh.weld[f[1] as usize],
                    mesh.weld[f[2] as usize],
                ]
            })
            .filter(|f| f[0] != f[1] && f[1] != f[2] && f[0] != f[2])
            .collect();

        let mut me = Self {
            alive: vec![true; tri.len()],
            vtri: vec![Vec::new(); nw],
            dead_verts: vec![false; nw],
            size: vec![1.0; nw],
            locked: vec![false; nw],
            features: HashSet::new(),
            pos,
            tri,
        };
        me.rebuild_vtri();
        me
    }

    /// Repeat an operation until it stops changing anything, or `limit` passes.
    fn run_to_fixpoint(&mut self, limit: u32, mut op: impl FnMut(&mut Self) -> usize) -> usize {
        let mut total = 0;
        for _ in 0..limit {
            let n = op(self);
            total += n;
            if n == 0 {
                break;
            }
        }
        total
    }

    fn rebuild_vtri(&mut self) {
        for v in &mut self.vtri {
            v.clear();
        }
        self.vtri.resize(self.pos.len(), Vec::new());
        for t in 0..self.tri.len() {
            if !self.alive[t] {
                continue;
            }
            for &v in &self.tri[t] {
                self.vtri[v as usize].push(t as u32);
            }
        }
    }

    /// Every live edge, with the triangles on each side.
    fn edges(&self) -> Vec<((u32, u32), [i32; 2])> {
        let mut map: HashMap<(u32, u32), [i32; 2]> = HashMap::new();
        for t in 0..self.tri.len() {
            if !self.alive[t] {
                continue;
            }
            let f = self.tri[t];
            for k in 0..3 {
                let (a, b) = (f[k], f[(k + 1) % 3]);
                let key = if a < b { (a, b) } else { (b, a) };
                let slot = map.entry(key).or_insert([-1, -1]);
                if slot[0] < 0 {
                    slot[0] = t as i32;
                } else if slot[1] == -1 {
                    slot[1] = t as i32;
                } else {
                    slot[1] = -2; // non-manifold: never edit just two of its faces
                }
            }
        }
        let mut edges: Vec<_> = map.into_iter().collect();
        edges.sort_unstable_by_key(|e| e.0);
        edges
    }

    fn lock_features(&mut self, angle: f32, preserve_boundary: bool) {
        self.locked.fill(false);
        self.features.clear();
        let cos = angle.to_radians().cos();
        for ((a, b), tris) in self.edges() {
            let protect = if tris[1] == -2 {
                true
            } else if tris[1] < 0 {
                preserve_boundary
            } else {
                let normal = |t: i32| {
                    let f = self.tri[t as usize];
                    (self.pos[f[1] as usize] - self.pos[f[0] as usize])
                        .cross(self.pos[f[2] as usize] - self.pos[f[0] as usize])
                        .normalize_or_zero()
                };
                normal(tris[0]).dot(normal(tris[1])) < cos
            };
            if protect {
                self.features.insert((a, b));
                self.locked[a as usize] = true;
                self.locked[b as usize] = true;
            }
        }
    }

    fn inherit_features(&mut self, from: &Self) {
        let key = |p: Vec3| p.to_array().map(|x| if x == 0.0 { 0 } else { x.to_bits() });
        let lookup: HashMap<_, _> = self
            .pos
            .iter()
            .enumerate()
            .map(|(v, &p)| (key(p), v as u32))
            .collect();
        for &(a, b) in &from.features {
            if let (Some(&a), Some(&b)) = (
                lookup.get(&key(from.pos[a as usize])),
                lookup.get(&key(from.pos[b as usize])),
            ) {
                self.features.insert(if a < b { (a, b) } else { (b, a) });
                self.locked[a as usize] = true;
                self.locked[b as usize] = true;
            }
        }
    }

    fn opposite(&self, t: usize, a: u32, b: u32) -> Option<u32> {
        self.tri[t].iter().copied().find(|&v| v != a && v != b)
    }

    fn neighbours(&self, v: u32) -> Vec<u32> {
        let mut out = Vec::with_capacity(8);
        for &t in &self.vtri[v as usize] {
            if !self.alive[t as usize] {
                continue;
            }
            for &w in &self.tri[t as usize] {
                if w != v && !out.contains(&w) {
                    out.push(w);
                }
            }
        }
        out
    }

    fn add_tri(&mut self, f: [u32; 3]) {
        if f[0] == f[1] || f[1] == f[2] || f[0] == f[2] {
            return;
        }
        let id = self.tri.len() as u32;
        self.tri.push(f);
        self.alive.push(true);
        for &v in &f {
            self.vtri[v as usize].push(id);
        }
    }

    /// Split every edge longer than `high` at its midpoint, snapped back on to
    /// the source so a curved surface gains detail rather than facets.
    fn split_long(&mut self, high: f32, source: &Bvh) -> usize {
        let mut done = 0;
        let high2 = high * high;
        for ((a, b), tris) in self.edges() {
            if self.dead_verts[a as usize] || self.dead_verts[b as usize] {
                continue;
            }
            if tris[0] < 0 || tris[1] == -2 {
                continue;
            }
            let (pa, pb) = (self.pos[a as usize], self.pos[b as usize]);
            let size = (self.size[a as usize] + self.size[b as usize]) * 0.5;
            if pa.distance_squared(pb) <= high2 * size * size {
                continue;
            }
            // Both sides must still be the triangles this edge remembers.
            if !self.alive[tris[0] as usize] || (tris[1] >= 0 && !self.alive[tris[1] as usize]) {
                continue;
            }

            let mid = (pa + pb) * 0.5;
            let mid = source.closest_point(mid).map(|h| h.point).unwrap_or(mid);
            let m = self.pos.len() as u32;
            self.pos.push(mid);
            self.vtri.push(Vec::new());
            self.dead_verts.push(false);
            self.size.push(size);
            let feature = self.features.remove(&(a, b));
            self.locked.push(feature);
            if feature {
                self.features.insert((a, m));
                self.features.insert((b, m));
            }

            for &t in &tris {
                if t < 0 {
                    continue;
                }
                let t = t as usize;
                let Some(c) = self.opposite(t, a, b) else {
                    continue;
                };
                // Keep the winding the old triangle had.
                let f = self.tri[t];
                let forward = (0..3).any(|k| f[k] == a && f[(k + 1) % 3] == b);
                self.alive[t] = false;
                if forward {
                    self.add_tri([a, m, c]);
                    self.add_tri([m, b, c]);
                } else {
                    self.add_tri([b, m, c]);
                    self.add_tri([m, a, c]);
                }
            }
            done += 1;
        }
        self.rebuild_vtri();
        done
    }

    /// Collapse every edge shorter than `low`, refusing anything that would
    /// pinch the surface, flip a face, or create an edge longer than `high`.
    fn collapse_short(&mut self, low: f32, high: f32, source: &Bvh) -> usize {
        let mut done = 0;
        let low2 = low * low;
        let high2 = high * high;

        for ((mut a, mut b), _) in self.edges() {
            if self.dead_verts[a as usize] || self.dead_verts[b as usize] {
                continue;
            }
            if self.locked[a as usize] && self.locked[b as usize] {
                continue;
            }
            // An interior vertex may collapse onto a protected endpoint. Keep
            // that endpoint exactly fixed, including when its index is larger.
            if self.locked[b as usize] {
                std::mem::swap(&mut a, &mut b);
            }
            let (pa, pb) = (self.pos[a as usize], self.pos[b as usize]);
            let size = (self.size[a as usize] + self.size[b as usize]) * 0.5;
            if pa.distance_squared(pb) > low2 * size * size {
                continue;
            }
            let target = if self.locked[a as usize] {
                pa
            } else {
                let mid = (pa + pb) * 0.5;
                source.closest_point(mid).map(|h| h.point).unwrap_or(mid)
            };

            // The link condition, same reason as in the decimator: without it a
            // closed surface quietly becomes non manifold.
            let na = self.neighbours(a);
            let nb = self.neighbours(b);
            let shared: Vec<u32> = na.iter().copied().filter(|v| nb.contains(v)).collect();
            let opposite: Vec<u32> = self.vtri[a as usize]
                .iter()
                .filter(|&&t| self.alive[t as usize] && self.tri[t as usize].contains(&b))
                .filter_map(|&t| self.opposite(t as usize, a, b))
                .collect();
            if opposite.is_empty()
                || opposite.len() > 2
                || shared.len() != opposite.len()
                || !shared.iter().all(|v| opposite.contains(v))
            {
                continue;
            }
            // The vertex-only link test misses a tetrahedron: collapsing it
            // produces two copies of the same face. Check the surviving faces.
            let mut faces = std::collections::HashSet::new();
            let duplicate = self.vtri[a as usize]
                .iter()
                .chain(&self.vtri[b as usize])
                .any(|&t| {
                    let mut f = self.tri[t as usize];
                    if !self.alive[t as usize] || (f.contains(&a) && f.contains(&b)) {
                        return false;
                    }
                    for v in &mut f {
                        if *v == b {
                            *v = a;
                        }
                    }
                    f.sort_unstable();
                    !faces.insert(f)
                });
            if duplicate {
                continue;
            }

            // No neighbour may end up further than the long edge limit, or the
            // collapse simply moves the problem.
            let too_long = nb
                .iter()
                .chain(na.iter())
                .filter(|&&v| v != a && v != b)
                .any(|&v| {
                    let local = (size + self.size[v as usize]) * 0.5;
                    self.pos[v as usize].distance_squared(target) > high2 * local * local
                });
            if too_long {
                continue;
            }
            if self.would_flip(a, b, target) {
                continue;
            }

            for &t in &self.vtri[b as usize].clone() {
                let t = t as usize;
                if !self.alive[t] {
                    continue;
                }
                if self.tri[t].contains(&a) {
                    self.alive[t] = false;
                    continue;
                }
                for k in 0..3 {
                    if self.tri[t][k] == b {
                        self.tri[t][k] = a;
                    }
                }
                self.vtri[a as usize].push(t as u32);
            }
            self.pos[a as usize] = target;
            self.size[a as usize] = size;
            self.dead_verts[b as usize] = true;
            self.vtri[b as usize].clear();
            done += 1;
        }
        self.rebuild_vtri();
        done
    }

    fn would_flip(&self, a: u32, b: u32, p: Vec3) -> bool {
        for &side in &[a, b] {
            for &t in &self.vtri[side as usize] {
                let t = t as usize;
                if !self.alive[t] {
                    continue;
                }
                let f = self.tri[t];
                if f.contains(&a) && f.contains(&b) {
                    continue;
                }
                let old = [
                    self.pos[f[0] as usize],
                    self.pos[f[1] as usize],
                    self.pos[f[2] as usize],
                ];
                let mut new = old;
                for k in 0..3 {
                    if f[k] == a || f[k] == b {
                        new[k] = p;
                    }
                }
                let n0 = (old[1] - old[0]).cross(old[2] - old[0]);
                let n1 = (new[1] - new[0]).cross(new[2] - new[0]);
                let reach = (new[1] - new[0])
                    .length_squared()
                    .max((new[2] - new[0]).length_squared());
                let area2 = n1.length_squared();
                if !area2.is_finite() || area2 <= reach * reach * 1e-12 {
                    return true;
                }
                if n0.normalize_or_zero().dot(n1.normalize_or_zero()) < 0.2 {
                    return true;
                }
            }
        }
        false
    }

    /// Flip interior edges when doing so brings the four valences closer to six.
    ///
    /// This is what turns a merely uniform mesh into a regular one, and
    /// regularity is exactly what a quad pairing needs.
    fn flip_to_valence(&mut self) -> usize {
        let mut done = 0;
        let mut valence: Vec<i32> = vec![0; self.pos.len()];
        for ((a, b), _) in self.edges() {
            valence[a as usize] += 1;
            valence[b as usize] += 1;
        }

        for ((a, b), tris) in self.edges() {
            if tris[0] < 0 || tris[1] < 0 {
                continue;
            }
            if self.locked[a as usize] || self.locked[b as usize] {
                continue;
            }
            let (t1, t2) = (tris[0] as usize, tris[1] as usize);
            if !self.alive[t1] || !self.alive[t2] {
                continue;
            }
            let (Some(c), Some(d)) = (self.opposite(t1, a, b), self.opposite(t2, a, b)) else {
                continue;
            };
            if c == d {
                continue;
            }
            // Refuse if the diagonal already exists: flipping onto it would fold
            // two triangles onto each other.
            if self.neighbours(c).contains(&d) {
                continue;
            }

            let before = deviation(valence[a as usize])
                + deviation(valence[b as usize])
                + deviation(valence[c as usize])
                + deviation(valence[d as usize]);
            let after = deviation(valence[a as usize] - 1)
                + deviation(valence[b as usize] - 1)
                + deviation(valence[c as usize] + 1)
                + deviation(valence[d as usize] + 1);
            if after >= before {
                continue;
            }

            // The flipped pair must not fold over.
            let (pa, pb, pc, pd) = (
                self.pos[a as usize],
                self.pos[b as usize],
                self.pos[c as usize],
                self.pos[d as usize],
            );
            let n_old = (pb - pa).cross(pc - pa).normalize_or_zero();
            let n1 = (pd - pa).cross(pc - pa).normalize_or_zero();
            let n2 = (pc - pb).cross(pd - pb).normalize_or_zero();
            if n_old.dot(n1) < 0.3 || n_old.dot(n2) < 0.3 {
                continue;
            }

            let forward = (0..3).any(|k| self.tri[t1][k] == a && self.tri[t1][(k + 1) % 3] == b);
            self.alive[t1] = false;
            self.alive[t2] = false;
            if forward {
                self.add_tri([a, d, c]);
                self.add_tri([d, b, c]);
            } else {
                self.add_tri([b, d, c]);
                self.add_tri([d, a, c]);
            }
            valence[a as usize] -= 1;
            valence[b as usize] -= 1;
            valence[c as usize] += 1;
            valence[d as usize] += 1;
            done += 1;
        }
        self.rebuild_vtri();
        done
    }

    fn to_mesh(&self, sharp_angle_deg: f32) -> Mesh {
        let mut remap = vec![u32::MAX; self.pos.len()];
        let mut out = Mesh::default();
        for t in 0..self.tri.len() {
            if !self.alive[t] {
                continue;
            }
            let f = self.tri[t];
            let mut nf = [0u32; 3];
            for k in 0..3 {
                let v = f[k] as usize;
                if remap[v] == u32::MAX {
                    remap[v] = out.positions.len() as u32;
                    out.positions.push(self.pos[v]);
                }
                nf[k] = remap[v];
            }
            if nf[0] == nf[1] || nf[1] == nf[2] || nf[0] == nf[2] {
                continue;
            }
            out.triangles.push(nf);
            out.tri_material.push(0);
        }
        out.materials.push(retopo_core::Material::default());
        out.rebuild_weld(0.0);
        out.remove_degenerate();
        out.compact();
        out.rebuild_weld(0.0);
        out.compute_normals(sharp_angle_deg);
        out
    }
}

#[inline]
fn deviation(valence: i32) -> i32 {
    (valence - 6).pow(2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use retopo_core::Adjacency;

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
                    Vec3::new(
                        theta.sin() * phi.cos(),
                        theta.cos(),
                        theta.sin() * phi.sin(),
                    )
                };
                m.positions.push(p);
            }
        }
        let idx = |s: usize, r: usize| (r * (segments + 1) + s) as u32;
        for r in 0..rings {
            for s in 0..segments {
                m.triangles
                    .push([idx(s, r), idx(s + 1, r), idx(s + 1, r + 1)]);
                m.triangles
                    .push([idx(s, r), idx(s + 1, r + 1), idx(s, r + 1)]);
                m.tri_material.push(0);
                m.tri_material.push(0);
            }
        }
        m.materials.push(retopo_core::Material::default());
        m.rebuild_weld(0.0);
        m.remove_degenerate();
        m.compact();
        m.rebuild_weld(0.0);
        m.compute_normals(40.0);
        m
    }

    /// Coefficient of variation of the edge lengths: standard deviation over
    /// mean. This is the honest measure of "are the edges all about the same
    /// length". A max over min ratio is hostage to a single outlier edge, which
    /// on a sphere fixture is always the pole fan.
    fn edge_spread(mesh: &Mesh) -> f32 {
        let (_, _, mean, cv) = edge_stats(mesh);
        let _ = mean;
        cv
    }

    fn edge_lengths(mesh: &Mesh) -> (f32, f32, f32) {
        let (a, b, c, _) = edge_stats(mesh);
        (a, b, c)
    }

    fn edge_stats(mesh: &Mesh) -> (f32, f32, f32, f32) {
        let adj = Adjacency::build(mesh);
        let rep: Vec<u32> = {
            let mut r = vec![u32::MAX; mesh.weld_count];
            for (i, &w) in mesh.weld.iter().enumerate() {
                if r[w as usize] == u32::MAX {
                    r[w as usize] = i as u32;
                }
            }
            r
        };
        let mut min = f32::INFINITY;
        let mut max: f32 = 0.0;
        let mut sum = 0.0f64;
        let mut sum2 = 0.0f64;
        for e in &adj.edges {
            let a = mesh.positions[rep[e.v[0] as usize] as usize];
            let b = mesh.positions[rep[e.v[1] as usize] as usize];
            let d = a.distance(b);
            min = min.min(d);
            max = max.max(d);
            sum += d as f64;
            sum2 += (d * d) as f64;
        }
        let n = adj.edges.len().max(1) as f64;
        let mean = sum / n;
        let variance = (sum2 / n - mean * mean).max(0.0);
        let cv = if mean > 0.0 {
            variance.sqrt() / mean
        } else {
            0.0
        };
        (min, max, mean as f32, cv as f32)
    }

    #[test]
    fn edges_converge_on_the_target_length() {
        // The point of the whole thing: a mesh whose edges are all about the
        // same length, whatever they started as.
        let src = sphere(40, 8); // deliberately anisotropic: wide, short rows
        let spread_before = edge_spread(&src);

        let (out, stats) = isotropic(
            &src,
            &IsotropicOptions {
                target_triangles: 2000,
                ..Default::default()
            },
            &mut |_| {},
        );
        let spread_after = edge_spread(&out);
        let (_, _, mean_after) = edge_lengths(&out);

        assert!(
            spread_after < spread_before * 0.6,
            "edge spread (cv) went from {spread_before} to {spread_after}"
        );
        assert!(
            (mean_after / stats.target_edge - 1.0).abs() < 0.45,
            "mean edge {mean_after} against a target of {}",
            stats.target_edge
        );
    }

    #[test]
    fn regularity_improves() {
        let src = sphere(40, 8);
        let before = regular_fraction(&src);
        let (_, stats) = isotropic(
            &src,
            &IsotropicOptions {
                target_triangles: 1500,
                ..Default::default()
            },
            &mut |_| {},
        );
        // Feature and inversion guards take precedence over valence. Assert a
        // net gain, not the old 6% margin from randomized edge iteration with
        // no feature constraints on collapses or flips.
        assert!(
            stats.regular_fraction > before,
            "valence six fraction went from {before} to {}",
            stats.regular_fraction
        );
    }

    #[test]
    fn a_closed_surface_stays_closed_and_manifold() {
        let src = sphere(24, 16);
        assert_eq!(Adjacency::build(&src).boundary_edge_count(), 0);
        let (out, _) = isotropic(
            &src,
            &IsotropicOptions {
                target_triangles: 800,
                ..Default::default()
            },
            &mut |_| {},
        );
        let adj = Adjacency::build(&out);
        assert_eq!(adj.boundary_edge_count(), 0, "the sphere was punctured");
        assert_eq!(adj.non_manifold_edges, 0);
    }

    #[test]
    fn the_shape_is_preserved() {
        let src = sphere(28, 20);
        let (out, _) = isotropic(
            &src,
            &IsotropicOptions {
                target_triangles: 1200,
                ..Default::default()
            },
            &mut |_| {},
        );
        for p in &out.positions {
            let r = p.length();
            assert!((r - 1.0).abs() < 0.05, "a vertex sits at radius {r}");
        }
    }

    #[test]
    fn the_triangle_count_lands_near_the_request() {
        let src = sphere(32, 24);
        for target in [500usize, 2000] {
            let (out, _) = isotropic(
                &src,
                &IsotropicOptions {
                    target_triangles: target,
                    ..Default::default()
                },
                &mut |_| {},
            );
            let ratio = out.triangle_count() as f32 / target as f32;
            assert!(
                (0.4..=2.5).contains(&ratio),
                "asked for {target}, got {} ({ratio:.2}x)",
                out.triangle_count()
            );
        }
    }

    #[test]
    fn an_explicit_edge_length_is_honoured() {
        let src = sphere(24, 16);
        let (out, stats) = isotropic(
            &src,
            &IsotropicOptions {
                target_edge: 0.25,
                ..Default::default()
            },
            &mut |_| {},
        );
        assert_eq!(stats.target_edge, 0.25);
        let (_, _, mean) = edge_lengths(&out);
        assert!((mean / 0.25 - 1.0).abs() < 0.45, "mean edge {mean}");
    }

    #[test]
    fn progress_ends_at_one() {
        let src = sphere(16, 12);
        let mut seen = Vec::new();
        isotropic(
            &src,
            &IsotropicOptions {
                target_triangles: 400,
                iterations: 3,
                ..Default::default()
            },
            &mut |p| seen.push(p),
        );
        assert_eq!(seen.last().copied(), Some(1.0));
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn an_empty_mesh_is_returned_untouched() {
        let (out, stats) = isotropic(&Mesh::default(), &IsotropicOptions::default(), &mut |_| {});
        assert_eq!(out.triangle_count(), 0);
        assert_eq!(stats.input_triangles, 0);
    }

    #[test]
    fn zero_iterations_is_a_noop() {
        let src = sphere(12, 8);
        let (out, s) = isotropic(
            &src,
            &IsotropicOptions {
                iterations: 0,
                ..Default::default()
            },
            &mut |_| {},
        );
        assert_eq!(src.triangles, out.triangles);
        assert_eq!(src.positions, out.positions);
        assert_eq!(s.output_triangles, src.triangle_count());
    }

    #[test]
    fn tetrahedron_collapse_cannot_create_duplicate_faces() {
        let mut src = Mesh {
            positions: vec![Vec3::ZERO, Vec3::X, Vec3::Y, Vec3::Z],
            triangles: vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
            ..Default::default()
        };
        src.rebuild_weld(0.0);
        let mut d = Dyn::from_mesh(&src);
        assert_eq!(d.collapse_short(10.0, 100.0, &Bvh::build(&src)), 0);
        assert_eq!(d.to_mesh(40.0).triangle_count(), 4);
    }

    #[test]
    fn open_borders_and_crease_vertices_survive_reconstruction() {
        let mut src = Mesh::default();
        let n = 6;
        for j in 0..=n {
            for i in 0..=2 * n {
                let x = i as f32 / n as f32 - 1.0;
                src.positions
                    .push(Vec3::new(x.min(0.0), j as f32 / n as f32, x.max(0.0)));
            }
        }
        let index = |i, j| (j * (2 * n + 1) + i) as u32;
        for j in 0..n {
            for i in 0..2 * n {
                src.triangles
                    .push([index(i, j), index(i + 1, j), index(i + 1, j + 1)]);
                src.triangles
                    .push([index(i, j), index(i + 1, j + 1), index(i, j + 1)]);
            }
        }
        src.rebuild_weld(0.0);
        let adj = Adjacency::build(&src);
        let sharp = adj.sharp_edges(&src, 40.0);
        let (out, _) = isotropic(
            &src,
            &IsotropicOptions {
                target_triangles: 60,
                sharp_angle_deg: 40.0,
                ..Default::default()
            },
            &mut |_| {},
        );
        for (e, &protected) in adj.edges.iter().zip(&sharp) {
            if protected {
                for &v in &e.v {
                    assert!(
                        out.positions.contains(&src.positions[v as usize]),
                        "a protected vertex moved"
                    );
                }
            }
        }
        assert_eq!(Adjacency::build(&out).non_manifold_edges, 0);
    }

    #[test]
    fn adaptive_remeshing_is_deterministic_closed_and_on_source() {
        let mut src = sphere(24, 16);
        for p in &mut src.positions {
            p.x *= 3.0;
        }
        let opts = IsotropicOptions {
            target_triangles: 700,
            adaptivity: 1.0,
            ..Default::default()
        };
        let (a, _) = isotropic(&src, &opts, &mut |_| {});
        let (b, _) = isotropic(&src, &opts, &mut |_| {});
        assert_eq!(a.triangles, b.triangles);
        assert_eq!(a.positions, b.positions);
        assert!(Adjacency::build(&a).is_closed());
        assert!((280..=1750).contains(&a.triangle_count()));
        let source = Bvh::build(&src);
        for p in &a.positions {
            assert!(p.is_finite());
            assert!(source.closest_point(*p).unwrap().dist2 < 1e-10);
        }
    }

    #[test]
    fn adaptive_sizes_follow_curvature_and_scale() {
        let mut src = sphere(32, 24);
        for p in &mut src.positions {
            p.x *= 4.0;
        }
        let sizes = crate::sizing::source_sizes(&src, 0.2, 1.0);
        let mut tips = Vec::new();
        let mut waist = Vec::new();
        for (r, &w) in src.weld.iter().enumerate() {
            if src.positions[r].x.abs() > 3.8 {
                tips.push(sizes[w as usize]);
            }
            if src.positions[r].x.abs() < 0.1 {
                waist.push(sizes[w as usize]);
            }
        }
        let mean = |x: &[f32]| x.iter().sum::<f32>() / x.len() as f32;
        assert!(mean(&tips) < mean(&waist) * 0.8);
        for p in &mut src.positions {
            *p *= 100.0;
        }
        let scaled = crate::sizing::source_sizes(&src, 20.0, 1.0);
        for (a, b) in sizes.iter().zip(scaled) {
            assert!((a - b).abs() < 1e-3);
        }
    }
}
