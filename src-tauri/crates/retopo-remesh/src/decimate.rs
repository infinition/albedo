//! Quadric error decimation.
//!
//! Garland and Heckbert's edge collapse, with the three guards that separate a
//! toy implementation from one you can point at a real asset:
//!
//! - **Link condition.** A collapse that would fuse two parts of the surface
//!   that only touch at that edge is rejected. Without it, closed meshes quietly
//!   become non manifold and every later stage inherits the damage.
//! - **Flip test.** A collapse that turns a triangle inside out is rejected,
//!   even when its quadric cost looks small.
//! - **Seam and crease constraints.** Boundaries, sharp edges and UV seams get a
//!   virtual plane perpendicular to the surface, so the optimiser pays to move
//!   along them. This is what keeps a texture from sliding during decimation.
//!
//! Everything runs on welded points. Render vertices follow along through a
//! forwarding table, so a UV seam stays a seam instead of being welded shut.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::sync::Arc;

use glam::{Vec2, Vec3};
use retopo_core::{Adjacency, Mesh, VertexField};

use crate::quadric::Quadric;

/// Weight of a boundary or crease constraint plane, relative to `edge_len^2`.
///
/// Face quadrics are weighted by area, so using `edge_len^2` keeps the two terms
/// in the same units and makes the whole thing invariant to mesh scale.
const CONSTRAINT_WEIGHT: f64 = 100.0;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct DecimateOptions {
    /// Stop once this many triangles remain.
    pub target_triangles: usize,
    /// Also stop when the next collapse would move the surface further than
    /// this, as a fraction of the bounding box diagonal. Infinity disables it.
    pub max_error: f32,
    /// Pin open borders in place.
    pub preserve_boundary: bool,
    /// Dihedral angle, in degrees, above which an edge counts as a crease.
    pub sharp_angle_deg: f32,
    /// Extra cost multiplier for collapsing a UV seam or normal split.
    pub seam_penalty: f32,
    /// Minimum dot product between a face normal before and after a collapse.
    pub flip_threshold: f32,

    /// What the artist painted, resolved onto this mesh's welded vertices.
    ///
    /// `None` is the identity: every number below is ignored and the decimator
    /// behaves exactly as it did before there was a brush. That property is
    /// worth stating, because it is what makes the painting an *addition* to
    /// this algorithm rather than a second algorithm sharing its name.
    ///
    /// Skipped by serde: it is derived from a sidecar beside the input file, and
    /// a copy of it inside the request would be the same data twice, able to
    /// disagree with itself.
    #[serde(skip)]
    pub field: Option<Arc<VertexField>>,

    /// How hard painted density pulls, `0..1`.
    ///
    /// It scales a *cost*, never an error. That separation is the whole reason
    /// this is safe to expose: `max_error` still measures real displacement, so
    /// painting "keep this" reorders which collapses happen first without ever
    /// letting one through that the quality ceiling would have refused.
    pub density_influence: f32,

    /// How hard a flow guide biases which edges are spent, `0..1`.
    pub flow_strength: f32,
}

impl Default for DecimateOptions {
    fn default() -> Self {
        Self {
            target_triangles: 0,
            max_error: f32::INFINITY,
            preserve_boundary: true,
            sharp_angle_deg: 40.0,
            seam_penalty: 4.0,
            flip_threshold: 0.2,
            field: None,
            density_influence: 0.75,
            flow_strength: 0.5,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct DecimateStats {
    pub input_triangles: usize,
    pub output_triangles: usize,
    pub collapses: usize,
    pub rejected_topology: usize,
    pub rejected_flip: usize,
    /// Largest approximate surface displacement accepted, in model units.
    pub max_error: f32,
    /// Welded points held still by the painting: frozen, on a crease guide, or
    /// outside the region the run was restricted to.
    ///
    /// Reported rather than inferred, because "the budget was not met" and "you
    /// froze most of the model" are the same picture from the outside and very
    /// different problems.
    pub locked_by_paint: usize,
}

/// Simplify to roughly `options.target_triangles`.
///
/// `progress` is called with a value in `0..=1`, often enough to drive a bar and
/// rarely enough not to matter.
pub fn decimate(
    mesh: &Mesh,
    options: &DecimateOptions,
    progress: &mut dyn FnMut(f32),
) -> (Mesh, DecimateStats) {
    let mut d = Decimator::new(mesh, options);
    d.run(progress);
    d.finish(mesh)
}

#[derive(Clone, Copy)]
struct Cand {
    cost: f32,
    /// Approximate surface displacement this collapse would cause.
    error: f32,
    a: u32,
    b: u32,
    va: u32,
    vb: u32,
}

impl PartialEq for Cand {
    fn eq(&self, other: &Self) -> bool {
        self.cost == other.cost
    }
}
impl Eq for Cand {}
impl Ord for Cand {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reversed: BinaryHeap is a max heap and we want the cheapest collapse.
        other.cost.total_cmp(&self.cost)
    }
}
impl PartialOrd for Cand {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

struct Decimator<'a> {
    opts: &'a DecimateOptions,

    vpos: Vec<Vec3>,
    vquad: Vec<Quadric>,
    /// Total plane weight folded into each quadric, used to turn a raw quadric
    /// cost back into an approximate distance.
    vweight: Vec<f64>,
    vdead: Vec<bool>,
    vseam: Vec<bool>,
    vlocked: Vec<bool>,
    vversion: Vec<u32>,
    vtri: Vec<Vec<u32>>,
    vrend: Vec<Vec<u32>>,

    tri_w: Vec<[u32; 3]>,
    tri_r: Vec<[u32; 3]>,
    tri_alive: Vec<bool>,

    /// Render vertex forwarding, resolved with path compression at the end.
    rmap: Vec<u32>,

    /// Source attributes, read only. Used to decide which render vertex of the
    /// surviving point a disappearing one should adopt.
    attr_uvs: Option<Vec<Vec2>>,
    attr_normals: Vec<Vec3>,

    heap: BinaryHeap<Cand>,
    live_tris: usize,
    error_limit: f32,
    stats: DecimateStats,
}

impl<'a> Decimator<'a> {
    fn new(mesh: &Mesh, opts: &'a DecimateOptions) -> Self {
        let nw = mesh.weld_count;
        let nt = mesh.triangle_count();

        let mut vpos = vec![Vec3::ZERO; nw];
        let mut vrend: Vec<Vec<u32>> = vec![Vec::new(); nw];
        for (r, &w) in mesh.weld.iter().enumerate() {
            vpos[w as usize] = mesh.positions[r];
            vrend[w as usize].push(r as u32);
        }
        let vseam: Vec<bool> = vrend.iter().map(|v| v.len() > 1).collect();

        let tri_w: Vec<[u32; 3]> = mesh
            .triangles
            .iter()
            .map(|f| {
                [
                    mesh.weld[f[0] as usize],
                    mesh.weld[f[1] as usize],
                    mesh.weld[f[2] as usize],
                ]
            })
            .collect();

        let mut vtri: Vec<Vec<u32>> = vec![Vec::new(); nw];
        for (t, f) in tri_w.iter().enumerate() {
            for &w in f {
                let v = &mut vtri[w as usize];
                if v.last() != Some(&(t as u32)) {
                    v.push(t as u32);
                }
            }
        }

        let mut vquad = vec![Quadric::ZERO; nw];
        let mut vweight = vec![0.0f64; nw];
        for (t, corners) in tri_w.iter().enumerate() {
            let n = mesh.face_normal(t);
            if n == Vec3::ZERO {
                continue;
            }
            let area = mesh.face_area(t) as f64;
            let q = Quadric::from_point_normal(mesh.tri_positions(t)[0], n, area);
            for &w in corners {
                vquad[w as usize].add(&q);
                vweight[w as usize] += area;
            }
        }

        // Constraint planes on boundaries and creases: a plane through the edge,
        // perpendicular to the face. Moving along the surface is free, moving
        // off the crease is not.
        let adj = Adjacency::build(mesh);
        let sharp = adj.sharp_edges(mesh, opts.sharp_angle_deg);
        let mut vlocked = vec![false; nw];
        for (ei, e) in adj.edges.iter().enumerate() {
            let is_boundary = e.is_boundary();
            if !is_boundary && !sharp[ei] {
                continue;
            }
            let (u, v) = (e.v[0], e.v[1]);
            if is_boundary && opts.preserve_boundary {
                vlocked[u as usize] = true;
                vlocked[v as usize] = true;
            }
            let Some(t) = e.tri[0] else { continue };
            let fn_ = mesh.face_normal(t as usize);
            let dir = vpos[v as usize] - vpos[u as usize];
            let len2 = dir.length_squared();
            if len2 <= 0.0 || fn_ == Vec3::ZERO {
                continue;
            }
            let plane_n = dir.cross(fn_).normalize_or_zero();
            if plane_n == Vec3::ZERO {
                continue;
            }
            let w = CONSTRAINT_WEIGHT * len2 as f64;
            let q = Quadric::from_point_normal(vpos[u as usize], plane_n, w);
            vquad[u as usize].add(&q);
            vquad[v as usize].add(&q);
            vweight[u as usize] += w;
            vweight[v as usize] += w;
        }

        /*
         * What the artist painted, folded into the same `vlocked` the boundary
         * and crease rules already use.
         *
         * Three different intentions land on one mechanism, and they land there
         * because in an edge-collapse decimator "do not move this point" is the
         * only primitive strong enough to express any of them:
         *
         * - **Frozen** paint: the person said keep this exactly.
         * - **Crease guides**: a line drawn along a fold, with the promise that
         *   the result still has an edge there. Points that carry the line have
         *   to stay put, or the line is what gets averaged away.
         * - **Outside the region**: when a region was painted, everything else
         *   is somebody else's work and this run must not touch it. Locking is
         *   what makes "retopologise only the face" mean it.
         *
         * The one thing this deliberately does not lock is *density*. Density
         * says where triangles are worth spending, which is a matter of order
         * rather than permission, and it is applied to the cost in `evaluate`.
         */
        let mut locked_by_paint = 0usize;
        if let Some(field) = opts.field.as_deref() {
            let n = nw.min(field.frozen.len());
            for w in 0..n {
                let outside = field.has_region && !field.region[w];
                if field.frozen[w] || field.creased[w] || outside {
                    if !vlocked[w] {
                        locked_by_paint += 1;
                    }
                    vlocked[w] = true;
                }
            }
        }

        let diag = mesh.bounds().diagonal().max(1e-6);
        let error_limit = if opts.max_error.is_finite() {
            opts.max_error * diag
        } else {
            f32::INFINITY
        };

        let mut me = Self {
            opts,
            vpos,
            vquad,
            vweight,
            vdead: vec![false; nw],
            vseam,
            vlocked,
            vversion: vec![0; nw],
            vtri,
            vrend,
            tri_w,
            tri_r: mesh.triangles.clone(),
            tri_alive: vec![true; nt],
            rmap: (0..mesh.positions.len() as u32).collect(),
            attr_uvs: mesh.has_uvs().then(|| mesh.uvs.clone()),
            attr_normals: if mesh.normals.len() == mesh.positions.len() {
                mesh.normals.clone()
            } else {
                vec![Vec3::Y; mesh.positions.len()]
            },
            heap: BinaryHeap::with_capacity(nt * 3 / 2 + 1),
            live_tris: nt,
            error_limit,
            stats: DecimateStats {
                input_triangles: nt,
                locked_by_paint,
                ..Default::default()
            },
        };

        for e in &adj.edges {
            me.push_candidate(e.v[0], e.v[1]);
        }
        me
    }

    fn push_candidate(&mut self, a: u32, b: u32) {
        if a == b || self.vdead[a as usize] || self.vdead[b as usize] {
            return;
        }
        if self.vlocked[a as usize] && self.vlocked[b as usize] {
            // Two pinned border points: collapsing the edge between them would
            // eat the border itself.
            return;
        }
        let Some((cost, error, _)) = self.evaluate(a, b) else {
            return;
        };
        self.heap.push(Cand {
            cost,
            error,
            a,
            b,
            va: self.vversion[a as usize],
            vb: self.vversion[b as usize],
        });
    }

    /// Cost, approximate displacement, and the position the merged point takes.
    fn evaluate(&self, a: u32, b: u32) -> Option<(f32, f32, Vec3)> {
        let mut q = self.vquad[a as usize];
        q.add(&self.vquad[b as usize]);
        let (pa, pb) = (self.vpos[a as usize], self.vpos[b as usize]);

        // A locked endpoint has to stay where it is, whatever the quadric wants.
        let (la, lb) = (self.vlocked[a as usize], self.vlocked[b as usize]);
        let candidates: Vec<Vec3> = if la && !lb {
            vec![pa]
        } else if lb && !la {
            vec![pb]
        } else {
            let mut c = vec![pa, pb, (pa + pb) * 0.5];
            if let Some(v) = q.minimiser() {
                // The minimiser is unconstrained, and on a nearly flat or nearly
                // symmetric neighbourhood it can shoot far off the surface. A
                // vertex further from the edge than the edge is long is never
                // what we want, whatever its quadric cost says.
                let mid = (pa + pb) * 0.5;
                let reach = pa.distance(pb).max(1e-9) * 2.0;
                if v.distance(mid) <= reach {
                    c.push(v);
                }
            }
            c
        };

        let mut best = f64::INFINITY;
        let mut best_p = pa;
        for p in candidates {
            let v = q.eval(p).max(0.0);
            if v < best {
                best = v;
                best_p = p;
            }
        }
        if !best.is_finite() {
            return None;
        }

        let weight = self.vweight[a as usize] + self.vweight[b as usize];
        let error = if weight > 0.0 {
            (best / weight).sqrt() as f32
        } else {
            0.0
        };

        let mut cost = best as f32;
        if self.vseam[a as usize] || self.vseam[b as usize] {
            cost *= 1.0 + self.opts.seam_penalty;
        }
        cost *= self.painted_cost(a, b, pa, pb);
        Some((cost, error, best_p))
    }

    /// The multiplier the painting puts on one collapse.
    ///
    /// One when nothing was painted, and one on unpainted ground even when the
    /// rest of the model is covered, so the brush adds a bias where it was used
    /// and changes nothing where it was not.
    fn painted_cost(&self, a: u32, b: u32, pa: Vec3, pb: Vec3) -> f32 {
        let Some(field) = self.opts.field.as_deref() else {
            return 1.0;
        };
        let (a, b) = (a as usize, b as usize);
        if a >= field.density.len() || b >= field.density.len() {
            return 1.0;
        }

        let mut k = 1.0f32;

        /*
         * Density, as a reciprocal pair around neutral.
         *
         * `4^(d * influence)`: paint +1 and this edge costs four times what it
         * did, so it is collapsed four times later; paint -1 and it costs a
         * quarter and goes first. Exponential rather than linear because the two
         * halves have to be symmetric, a brush that makes things twice as dear
         * and only half as cheap is a brush whose eraser does not undo it, and
         * because a multiplier of zero, which a linear map reaches, would mean
         * "free" rather than "cheap" and pull the whole heap out of order.
         */
        let d = 0.5 * (field.density[a] + field.density[b]);
        let influence = self.opts.density_influence.clamp(0.0, 1.0);
        if d != 0.0 && influence > 0.0 {
            k *= 4.0f32.powf(d.clamp(-1.0, 1.0) * influence);
        }

        /*
         * Flow: keep the edges that run along the drawn direction, spend the
         * ones that cross it.
         *
         * This is the cheap half of what a field-aligned remesher does properly,
         * and it is worth having on its own: an edge parallel to the stroke is
         * part of the loop the person is asking for, and an edge perpendicular to
         * it is the one to remove to get there. The weight lives in the length of
         * the flow vector, which is how far into the guide's band the point sits.
         */
        let flow = field.flow[a] + field.flow[b];
        let strength = self.opts.flow_strength.clamp(0.0, 1.0);
        let w = flow.length() * 0.5;
        if w > 1e-4 && strength > 0.0 {
            let edge = (pb - pa).normalize_or_zero();
            let dir = flow.normalize_or_zero();
            if edge != Vec3::ZERO && dir != Vec3::ZERO {
                let along = edge.dot(dir).abs().clamp(0.0, 1.0);
                // Along the flow: dearer. Across it: cheaper. Same reciprocal
                // shape as density, so a guide neither adds nor removes cost on
                // average over the edges it touches.
                k *= 3.0f32.powf((along * 2.0 - 1.0) * w * strength);
            }
        }

        k
    }

    fn neighbours(&self, v: u32) -> Vec<u32> {
        let mut out = Vec::with_capacity(8);
        for &t in &self.vtri[v as usize] {
            if !self.tri_alive[t as usize] {
                continue;
            }
            for &w in &self.tri_w[t as usize] {
                if w != v && !out.contains(&w) {
                    out.push(w);
                }
            }
        }
        out
    }

    /// The link condition: the shared one-ring of the two endpoints must be
    /// exactly the vertices opposite the edge. Anything else means the collapse
    /// would pinch the surface.
    fn link_condition(&self, a: u32, b: u32) -> bool {
        let mut opposite = Vec::with_capacity(2);
        for &t in &self.vtri[a as usize] {
            if !self.tri_alive[t as usize] {
                continue;
            }
            let f = self.tri_w[t as usize];
            if !f.contains(&b) {
                continue;
            }
            if opposite.len() == 2 {
                return false; // three or more faces on one edge
            }
            for &w in &f {
                if w != a && w != b {
                    opposite.push(w);
                }
            }
        }

        let na = self.neighbours(a);
        let nb = self.neighbours(b);
        let shared: Vec<u32> = na.iter().copied().filter(|w| nb.contains(w)).collect();
        shared.len() == opposite.len() && shared.iter().all(|w| opposite.contains(w))
    }

    fn would_flip(&self, a: u32, b: u32, p: Vec3) -> bool {
        for &side in &[a, b] {
            for &t in &self.vtri[side as usize] {
                if !self.tri_alive[t as usize] {
                    continue;
                }
                let f = self.tri_w[t as usize];
                if f.contains(&a) && f.contains(&b) {
                    continue; // this face disappears with the collapse
                }
                let old = [
                    self.vpos[f[0] as usize],
                    self.vpos[f[1] as usize],
                    self.vpos[f[2] as usize],
                ];
                let mut new = old;
                for k in 0..3 {
                    if f[k] == a || f[k] == b {
                        new[k] = p;
                    }
                }
                let n0 = (old[1] - old[0]).cross(old[2] - old[0]);
                let n1 = (new[1] - new[0]).cross(new[2] - new[0]);
                // Degeneracy has to be judged against the triangle's own size.
                // An absolute epsilon here reads every face of a dense mesh as
                // already collapsed, and refuses the entire run.
                let reach = (new[1] - new[0])
                    .length_squared()
                    .max((new[2] - new[0]).length_squared())
                    .max((new[2] - new[1]).length_squared());
                let area2 = n1.length_squared();
                // NaN counts as a flip: a face we cannot measure is one we
                // must not collapse.
                if !area2.is_finite() || area2 <= reach * reach * 1e-12 {
                    return true; // the face would collapse to a line
                }
                if n0.normalize_or_zero().dot(n1.normalize_or_zero()) < self.opts.flip_threshold {
                    return true;
                }
            }
        }
        false
    }

    fn run(&mut self, progress: &mut dyn FnMut(f32)) {
        let target = self.opts.target_triangles.max(4);
        let start = self.live_tris;
        if start <= target {
            return;
        }
        let span = (start - target) as f32;
        let mut since_report = 0usize;

        while self.live_tris > target {
            let Some(c) = self.heap.pop() else { break };
            let (a, b) = (c.a, c.b);
            if self.vdead[a as usize] || self.vdead[b as usize] {
                continue;
            }
            if self.vversion[a as usize] != c.va || self.vversion[b as usize] != c.vb {
                continue; // stale entry, a newer one is in the heap
            }
            if c.error > self.error_limit {
                // The heap is ordered by cost, so everything left is at least
                // this expensive. Nothing cheaper is coming.
                break;
            }
            if !self.link_condition(a, b) {
                self.stats.rejected_topology += 1;
                continue;
            }
            let Some((_, error, p)) = self.evaluate(a, b) else {
                continue;
            };
            if self.would_flip(a, b, p) {
                self.stats.rejected_flip += 1;
                continue;
            }

            self.collapse(a, b, p);
            self.stats.collapses += 1;
            self.stats.max_error = self.stats.max_error.max(error);

            since_report += 1;
            if since_report >= 2048 {
                since_report = 0;
                progress(((start - self.live_tris) as f32 / span).clamp(0.0, 1.0));
            }
        }
        progress(1.0);
    }

    /// Merge `b` into `a`, which moves to `p`.
    fn collapse(&mut self, a: u32, b: u32, p: Vec3) {
        // Faces on the collapsed edge disappear.
        let doomed: Vec<u32> = self.vtri[b as usize]
            .iter()
            .copied()
            .filter(|&t| self.tri_alive[t as usize] && self.tri_w[t as usize].contains(&a))
            .collect();
        for t in doomed {
            if self.tri_alive[t as usize] {
                self.tri_alive[t as usize] = false;
                self.live_tris -= 1;
            }
        }

        // Every render vertex of b adopts the closest matching one of a, so a
        // point split across a UV seam keeps two distinct texture coordinates.
        let targets = self.vrend[a as usize].clone();
        for &rb in &self.vrend[b as usize].clone() {
            let best = self.best_render_match(rb, &targets).unwrap_or(targets[0]);
            self.rmap[rb as usize] = best;
        }

        for &t in &self.vtri[b as usize].clone() {
            if !self.tri_alive[t as usize] {
                continue;
            }
            for k in 0..3 {
                if self.tri_w[t as usize][k] == b {
                    self.tri_w[t as usize][k] = a;
                }
            }
            if !self.vtri[a as usize].contains(&t) {
                self.vtri[a as usize].push(t);
            }
        }

        self.vpos[a as usize] = p;
        let qb = self.vquad[b as usize];
        self.vquad[a as usize].add(&qb);
        self.vweight[a as usize] += self.vweight[b as usize];
        self.vseam[a as usize] |= self.vseam[b as usize];
        self.vlocked[a as usize] |= self.vlocked[b as usize];
        self.vdead[b as usize] = true;
        self.vtri[b as usize] = Vec::new();
        self.vrend[b as usize] = Vec::new();

        self.vtri[a as usize].retain(|&t| self.tri_alive[t as usize]);
        // Only `a` changed, so only entries mentioning `a` go stale. Bumping the
        // neighbours too would invalidate the edges *between* them, which are
        // never re-pushed, and simplification would stall well short of target.
        self.vversion[a as usize] = self.vversion[a as usize].wrapping_add(1);
        for n in self.neighbours(a) {
            self.push_candidate(a, n);
        }
    }

    /// Pick the render vertex of the surviving point whose attributes are
    /// closest to the one being absorbed.
    fn best_render_match(&self, rb: u32, targets: &[u32]) -> Option<u32> {
        if targets.len() == 1 {
            return Some(targets[0]);
        }
        let uv_b = self.attr_uv(rb);
        let n_b = self.attr_normal(rb);
        let mut best = None;
        let mut best_d = f32::INFINITY;
        for &ra in targets {
            let d = uv_b.distance_squared(self.attr_uv(ra))
                + (1.0 - n_b.dot(self.attr_normal(ra))) * 0.1;
            if d < best_d {
                best_d = d;
                best = Some(ra);
            }
        }
        best
    }

    /// Zero when the source had no texture coordinates, which makes the match
    /// fall back to comparing normals alone.
    fn attr_uv(&self, r: u32) -> Vec2 {
        self.attr_uvs
            .as_ref()
            .map(|u| u[r as usize])
            .unwrap_or(Vec2::ZERO)
    }

    fn attr_normal(&self, r: u32) -> Vec3 {
        self.attr_normals[r as usize]
    }

    fn finish(mut self, src: &Mesh) -> (Mesh, DecimateStats) {
        let mut resolved = vec![0u32; self.rmap.len()];
        for r in 0..resolved.len() as u32 {
            let target = self.resolve(r);
            resolved[r as usize] = target;
        }

        let mut positions = src.positions.clone();
        for w in 0..self.vpos.len() {
            if self.vdead[w] {
                continue;
            }
            for &r in &self.vrend[w] {
                positions[r as usize] = self.vpos[w];
            }
        }

        let mut out = Mesh {
            positions,
            normals: Vec::new(),
            uvs: src.uvs.clone(),
            triangles: Vec::new(),
            tri_material: Vec::new(),
            weld: Vec::new(),
            weld_count: 0,
            materials: src.materials.clone(),
            images: src.images.clone(),
        };

        for t in 0..self.tri_alive.len() {
            if !self.tri_alive[t] {
                continue;
            }
            let f = self.tri_r[t];
            let f = [
                resolved[f[0] as usize],
                resolved[f[1] as usize],
                resolved[f[2] as usize],
            ];
            if f[0] == f[1] || f[1] == f[2] || f[0] == f[2] {
                continue;
            }
            out.triangles.push(f);
            out.tri_material.push(src.tri_material[t]);
        }

        out.rebuild_weld(0.0);
        out.remove_degenerate();
        out.compact();
        out.rebuild_weld(0.0);
        out.compute_normals(self.opts.sharp_angle_deg);

        self.stats.output_triangles = out.triangle_count();
        (out, self.stats)
    }

    fn resolve(&mut self, mut x: u32) -> u32 {
        while self.rmap[x as usize] != x {
            let g = self.rmap[self.rmap[x as usize] as usize];
            self.rmap[x as usize] = g;
            x = g;
        }
        x
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use retopo_core::mesh::Material;
    use retopo_core::paint::{Painting, Sample};

    /// A painting over the welded points of `mesh`, decided per position.
    ///
    /// Built from the mesh itself rather than from hand written coordinates,
    /// which is also how the interface builds one: it paints the vertices it can
    /// see, and the sidecar is those vertices with a value attached.
    fn painting_of(mesh: &Mesh, f: impl Fn(Vec3) -> (f32, bool, bool)) -> Painting {
        let mut seen = std::collections::HashSet::new();
        let mut samples = Vec::new();
        let mut region_used = false;
        for (r, &w) in mesh.weld.iter().enumerate() {
            if !seen.insert(w) {
                continue;
            }
            let p = mesh.positions[r];
            let (density, freeze, region) = f(p);
            if region {
                region_used = true;
            }
            samples.push(Sample { p, density, freeze, region });
        }
        Painting {
            // A tenth of a cell of the grids below: close enough that a vertex
            // only ever matches its own sample.
            match_radius: 1e-3,
            has_region: region_used,
            samples,
            guides: vec![],
        }
    }

    fn field_of(mesh: &Mesh, painting: Painting) -> Arc<VertexField> {
        Arc::new(retopo_core::PaintField::new(painting).resolve(mesh))
    }

    /// Does a point of the input survive into the output, to within a hair?
    fn survives(out: &Mesh, p: Vec3) -> bool {
        out.positions.iter().any(|q| q.distance_squared(p) < 1e-8)
    }

    /// Flat grid in the XY plane, `n` cells a side, with UVs.
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

    /// The same grid pushed into a smooth bump, so decimation actually has to
    /// choose which detail to keep instead of every collapse costing zero.
    fn bumpy_grid(n: usize) -> Mesh {
        let mut m = grid(n);
        for p in &mut m.positions {
            p.z = (p.x * std::f32::consts::PI * 2.0).sin()
                * (p.y * std::f32::consts::PI * 2.0).sin()
                * 0.15;
        }
        m.rebuild_weld(0.0);
        m.compute_normals(40.0);
        m
    }

    /// Closed sphere carrying a real UV seam at the wrap, the way an exporter
    /// writes one: duplicated positions with different texture coordinates.
    fn uv_sphere(segments: usize, rings: usize) -> Mesh {
        use std::f32::consts::PI;
        let mut m = Mesh::default();
        for r in 0..=rings {
            let theta = r as f32 / rings as f32 * PI;
            for s in 0..=segments {
                // Positions use `s % segments` so the wrap column lands on the
                // exact bits of column zero, and the poles are written literally.
                // Otherwise sin(2*PI) leaves a hairline gap and the "sphere" is
                // an open cylinder with two frayed ends, which would make the
                // closed-surface assertions below meaningless.
                let p = if r == 0 {
                    Vec3::Y
                } else if r == rings {
                    -Vec3::Y
                } else {
                    let phi = (s % segments) as f32 / segments as f32 * 2.0 * PI;
                    Vec3::new(theta.sin() * phi.cos(), theta.cos(), theta.sin() * phi.sin())
                };
                m.positions.push(p);
                m.uvs
                    .push(Vec2::new(s as f32 / segments as f32, r as f32 / rings as f32));
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
        m.materials.push(Material::default());
        m.rebuild_weld(0.0);
        m.remove_degenerate();
        m.compact();
        m.rebuild_weld(0.0);
        m.compute_normals(40.0);
        m
    }

    fn run(mesh: &Mesh, target: usize) -> (Mesh, DecimateStats) {
        decimate(
            mesh,
            &DecimateOptions {
                target_triangles: target,
                ..Default::default()
            },
            &mut |_| {},
        )
    }

    #[test]
    fn a_sphere_reaches_its_triangle_target() {
        let src = uv_sphere(24, 16);
        assert!(src.triangle_count() > 600, "{}", src.triangle_count());
        let (out, stats) = run(&src, 200);
        assert!(
            out.triangle_count() <= 260,
            "wanted about 200, got {}",
            out.triangle_count()
        );
        assert!(stats.collapses > 0);
        assert_eq!(stats.output_triangles, out.triangle_count());
    }

    #[test]
    fn decimation_does_not_create_non_manifold_edges() {
        // The link condition exists for exactly this. Without it a sphere ends
        // up pinched and every later stage inherits a broken surface.
        let src = uv_sphere(20, 14);
        let (out, _) = run(&src, 120);
        let adj = Adjacency::build(&out);
        assert_eq!(adj.non_manifold_edges, 0);
    }

    #[test]
    fn a_closed_sphere_stays_closed() {
        let src = uv_sphere(20, 14);
        assert_eq!(Adjacency::build(&src).boundary_edge_count(), 0);
        let (out, _) = run(&src, 150);
        assert_eq!(
            Adjacency::build(&out).boundary_edge_count(),
            0,
            "decimation punched a hole in a closed surface"
        );
    }

    #[test]
    fn the_border_of_an_open_patch_is_untouched() {
        let src = bumpy_grid(10);
        let before = Adjacency::build(&src).boundary_edge_count();
        let (out, _) = run(&src, 20);
        assert_eq!(
            Adjacency::build(&out).boundary_edge_count(),
            before,
            "the border moved even though preserve_boundary was on"
        );
    }

    #[test]
    fn a_flat_plane_collapses_almost_completely() {
        // Every interior collapse on a flat sheet is free, so only the pinned
        // border should survive.
        let src = grid(12);
        let (out, _) = run(&src, 2);
        assert!(
            out.triangle_count() < src.triangle_count() / 4,
            "flat interior was not simplified: {} of {}",
            out.triangle_count(),
            src.triangle_count()
        );
        let b = out.bounds();
        assert!(b.min.abs_diff_eq(Vec3::ZERO, 1e-4), "{:?}", b.min);
        assert!(b.max.abs_diff_eq(Vec3::new(1.0, 1.0, 0.0), 1e-4), "{:?}", b.max);
    }

    #[test]
    fn the_uv_seam_is_still_a_seam_afterwards() {
        let src = uv_sphere(24, 16);
        assert!(src.vertex_count() > src.weld_count, "the fixture has a seam");
        let (out, _) = run(&src, 200);
        assert!(out.has_uvs());
        assert!(
            out.vertex_count() > out.weld_count,
            "the seam was welded shut: {} render vertices for {} points",
            out.vertex_count(),
            out.weld_count
        );
    }

    #[test]
    fn the_result_never_leaves_the_original_bounding_box() {
        let src = uv_sphere(20, 14);
        let b = src.bounds();
        let (out, _) = run(&src, 100);
        let ob = out.bounds();
        // A small margin: the quadric minimiser is allowed to sit slightly off
        // the hull on a curved surface, but never far.
        let slack = b.diagonal() * 0.05;
        assert!(ob.min.cmpge(b.min - slack).all(), "{:?} vs {:?}", ob.min, b.min);
        assert!(ob.max.cmple(b.max + slack).all(), "{:?} vs {:?}", ob.max, b.max);
    }

    #[test]
    fn max_error_stops_before_the_triangle_target() {
        let src = bumpy_grid(14);
        let (out, stats) = decimate(
            &src,
            &DecimateOptions {
                target_triangles: 2,
                max_error: 0.001,
                ..Default::default()
            },
            &mut |_| {},
        );
        assert!(
            out.triangle_count() > 2,
            "a tight error budget should have stopped the run early"
        );
        assert!(stats.max_error <= 0.001 * src.bounds().diagonal() + 1e-6);
    }

    #[test]
    fn progress_is_monotonic_and_ends_at_one() {
        let src = uv_sphere(20, 14);
        let mut seen: Vec<f32> = Vec::new();
        decimate(
            &src,
            &DecimateOptions {
                target_triangles: 60,
                ..Default::default()
            },
            &mut |p| seen.push(p),
        );
        assert_eq!(seen.last().copied(), Some(1.0));
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "{seen:?}");
    }

    #[test]
    fn asking_for_more_triangles_than_there_are_changes_nothing() {
        let src = uv_sphere(8, 6);
        let n = src.triangle_count();
        let (out, stats) = run(&src, n * 10);
        assert_eq!(out.triangle_count(), n);
        assert_eq!(stats.collapses, 0);
    }

    /// Decimation must not care how big the model is.
    ///
    /// This is the regression guard for a real failure: the flip test compared
    /// a triangle area against a fixed epsilon, so on a dense mesh with small
    /// triangles every single collapse was refused and a 406k triangle asset
    /// came out untouched. Every fixture above happens to be about one unit
    /// across, which is exactly why none of them caught it.
    #[test]
    fn scale_does_not_change_the_outcome() {
        for scale in [0.001f32, 1.0, 1000.0] {
            let mut src = uv_sphere(20, 14);
            for p in &mut src.positions {
                *p *= scale;
            }
            src.rebuild_weld(0.0);
            src.compute_normals(40.0);

            let (out, stats) = run(&src, 100);
            assert!(
                stats.collapses > 0,
                "scale {scale}: every collapse was refused ({} on topology, {} on flip)",
                stats.rejected_topology,
                stats.rejected_flip
            );
            assert!(
                out.triangle_count() < src.triangle_count() / 2,
                "scale {scale}: {} of {} triangles left",
                out.triangle_count(),
                src.triangle_count()
            );
        }
    }

    /// Dense meshes have small triangles even at unit scale, which is the other
    /// half of the same trap.
    #[test]
    fn a_dense_mesh_at_unit_scale_still_simplifies() {
        let src = bumpy_grid(60);
        assert!(src.triangle_count() > 6000);
        let (out, stats) = run(&src, 400);
        assert!(stats.collapses > 1000, "only {} collapses", stats.collapses);
        assert!(out.triangle_count() < 900, "got {}", out.triangle_count());
    }

    #[test]
    fn every_output_triangle_indexes_live_vertices() {
        let src = uv_sphere(16, 12);
        let (out, _) = run(&src, 80);
        for f in &out.triangles {
            for &c in f {
                assert!((c as usize) < out.positions.len());
            }
            assert!(f[0] != f[1] && f[1] != f[2] && f[0] != f[2]);
        }
        assert_eq!(out.normals.len(), out.positions.len());
        assert_eq!(out.uvs.len(), out.positions.len());
        assert_eq!(out.tri_material.len(), out.triangles.len());
    }

    #[test]
    fn frozen_paint_is_still_there_afterwards() {
        let mesh = bumpy_grid(24);
        // Freeze the left half, and give the decimator a budget it can only
        // meet by eating something.
        let painting = painting_of(&mesh, |p| (0.0, p.x < 0.5, false));
        let frozen: Vec<Vec3> = mesh
            .positions
            .iter()
            .copied()
            .filter(|p| p.x < 0.5)
            .collect();

        let (out, stats) = decimate(
            &mesh,
            &DecimateOptions {
                target_triangles: 120,
                field: Some(field_of(&mesh, painting)),
                ..Default::default()
            },
            &mut |_| {},
        );

        assert!(stats.locked_by_paint > 0, "the painting locked nothing");
        for p in &frozen {
            assert!(survives(&out, *p), "a frozen point at {p} was collapsed away");
        }
        // And the run still did its job on the half it was allowed to touch,
        // while stopping short of the budget, which is the honest outcome when
        // half the model has been declared off limits.
        let free = decimate(
            &mesh,
            &DecimateOptions { target_triangles: 120, ..Default::default() },
            &mut |_| {},
        )
        .0;
        assert!(out.triangle_count() < mesh.triangle_count());
        assert!(
            out.triangle_count() > free.triangle_count(),
            "freezing half the model left {} triangles, no more than the {} an              unrestricted run leaves: the paint did nothing",
            out.triangle_count(),
            free.triangle_count()
        );
    }

    #[test]
    fn a_region_confines_the_run_to_what_was_painted() {
        let mesh = bumpy_grid(24);
        let painting = painting_of(&mesh, |p| (0.0, false, p.x > 0.5));
        let outside: Vec<Vec3> = mesh
            .positions
            .iter()
            .copied()
            .filter(|p| p.x < 0.45)
            .collect();

        let (out, _) = decimate(
            &mesh,
            &DecimateOptions {
                target_triangles: 200,
                field: Some(field_of(&mesh, painting)),
                ..Default::default()
            },
            &mut |_| {},
        );

        for p in &outside {
            assert!(survives(&out, *p), "a point outside the region moved: {p}");
        }
    }

    #[test]
    fn density_spends_the_budget_where_it_was_not_painted() {
        let mesh = bumpy_grid(28);
        let target = 400;

        let plain = decimate(
            &mesh,
            &DecimateOptions { target_triangles: target, ..Default::default() },
            &mut |_| {},
        )
        .0;

        // "Keep this half" on the left, and nothing said about the right.
        let painting = painting_of(&mesh, |p| (if p.x < 0.5 { 1.0 } else { 0.0 }, false, false));
        let painted = decimate(
            &mesh,
            &DecimateOptions {
                target_triangles: target,
                density_influence: 1.0,
                field: Some(field_of(&mesh, painting)),
                ..Default::default()
            },
            &mut |_| {},
        )
        .0;

        // Same budget on both sides of the comparison, so the only thing that
        // can differ is where it went.
        assert!((painted.triangle_count() as i64 - plain.triangle_count() as i64).abs() < 40);

        let left = |m: &Mesh| {
            m.triangles
                .iter()
                .filter(|f| f.iter().all(|&v| m.positions[v as usize].x < 0.5))
                .count()
        };
        assert!(
            left(&painted) > left(&plain),
            "painted {} triangles on the kept half against {} unpainted",
            left(&painted),
            left(&plain)
        );
    }

    #[test]
    fn an_absent_painting_changes_nothing_at_all() {
        // The identity claimed in `DecimateOptions::field`, checked rather than
        // asserted in a comment: with no field, every number the brush adds is
        // inert and the result is the one this engine always gave.
        let mesh = bumpy_grid(20);
        let opts = DecimateOptions { target_triangles: 300, ..Default::default() };
        let (a, _) = decimate(&mesh, &opts, &mut |_| {});
        let (b, _) = decimate(
            &mesh,
            &DecimateOptions { density_influence: 0.0, flow_strength: 0.0, ..opts.clone() },
            &mut |_| {},
        );
        assert_eq!(a.triangle_count(), b.triangle_count());
        assert_eq!(a.positions.len(), b.positions.len());
    }
}
