//! From half a million triangles to a merge order somebody can scrub through.
//!
//! Two stages, and the split between them is the whole performance story.
//!
//! **Superfaces** collapse every edge nobody could argue about — same colour,
//! no crease, same material — before anything expensive looks at the mesh. A
//! typical generated asset goes from 500,000 triangles to something in the tens
//! of thousands, and every later stage is priced against that number instead.
//!
//! **The hierarchy** then merges superfaces cheapest-pair-first, and records
//! *every* merge it makes rather than stopping at some particular count. What
//! comes out is a dendrogram, and cutting a dendrogram after `n - k` merges is
//! how you get exactly `k` groups without recomputing anything. That is what
//! lets the interface offer a slider that responds inside a frame instead of a
//! text field that costs a second per guess.
//!
//! This is also, not by coincidence, the shape of PartField's final stage
//! (ICCV 2025), whose paper notes that agglomerating over face adjacency gives
//! crisper borders than clustering features independently. The difference is
//! that its per-face vector is learned and this one is measured; the machinery
//! that turns either into parts is the same machinery.
//!
//! ## The dendrogram is a forest
//!
//! Barriers mean some pairs never become candidates, so the merging stops with
//! several roots still standing. The fewest groups this mesh can be cut into is
//! therefore `super_count - merges.len()`, not one, and an interface that lets
//! its slider go below that has a third of its travel doing nothing.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use glam::Vec3;
use retopo_core::util::UnionFind;
use retopo_core::{Adjacency, Mesh};

use crate::features::{EdgeFeatures, FaceFeatures};
use crate::graph::{edge_terms, region_cost, SegmentOptions};

/// The full decomposition, at every level at once.
#[derive(Clone, Debug, Default)]
pub struct Dendrogram {
    /// Which superface each triangle landed in. Dense, `0..super_count`.
    pub super_of_face: Vec<u32>,
    pub super_count: usize,
    /// The superface across each of the three edges of each triangle, in corner
    /// order `(0,1)`, `(1,2)`, `(2,0)`. `u32::MAX` where the mesh has an open
    /// border. This is what lets a shader draw group outlines without anybody
    /// computing a border on the CPU every time the slider moves.
    pub nbr_of_face: Vec<[u32; 3]>,

    /// Merge order, as pairs of superface ids. Replaying the first `n` of these
    /// through any union-find reproduces the partition at that level exactly,
    /// whichever representative it happens to pick.
    pub merges: Vec<[u32; 2]>,
    /// What each merge cost, made non decreasing. See `monotone` below.
    pub costs: Vec<f32>,
    /// The fewest groups reachable. `super_count - merges.len()`.
    pub floor: usize,
}

impl Dendrogram {
    /// The partition into exactly `k` groups, as a dense label per superface.
    ///
    /// The engine's own copy of what the interface does per slider move, kept
    /// here so the command line and the tests can ask the same question.
    pub fn cut(&self, k: usize) -> Vec<u32> {
        let k = k.clamp(self.floor.max(1), self.super_count.max(1));
        let take = self.super_count.saturating_sub(k);

        let mut uf = UnionFind::new(self.super_count);
        for m in self.merges.iter().take(take) {
            uf.union(m[0], m[1]);
        }

        let mut dense = vec![u32::MAX; self.super_count];
        let mut label = vec![0u32; self.super_count];
        let mut next = 0u32;
        for s in 0..self.super_count {
            let root = uf.find(s as u32) as usize;
            if dense[root] == u32::MAX {
                dense[root] = next;
                next += 1;
            }
            label[s] = dense[root];
        }
        label
    }
}

/// A pair waiting to be merged.
///
/// Carries the version each side had when the cost was computed. A merge bumps
/// the surviving region's version, which is what makes every entry naming the
/// old one stale without anybody hunting through the heap to delete it. Same
/// trick, and for the same reason, as the collapse queue in `retopo-remesh`.
#[derive(Clone, Copy, Debug)]
struct Cand {
    cost: f32,
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
        // Reversed: BinaryHeap is a max heap and the cheapest merge goes first.
        other.cost.total_cmp(&self.cost)
    }
}
impl PartialOrd for Cand {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// How much border two regions share, and what it looks like along the way.
#[derive(Clone, Copy, Debug, Default)]
struct Border {
    /// Total length. The weight the crease average is taken against, so that a
    /// long smooth join outvotes a millimetre of noise at one corner.
    len: f32,
    /// Length-weighted sum of the per-edge crease term.
    crease: f32,
    /// Nothing may join these two.
    barrier: bool,
}

impl Border {
    fn absorb(&mut self, other: &Border) {
        self.len += other.len;
        self.crease += other.crease;
        self.barrier |= other.barrier;
    }

    #[inline]
    fn mean_crease(&self) -> f32 {
        if self.len > 0.0 {
            self.crease / self.len
        } else {
            0.0
        }
    }
}

/// A region under construction. Starts as one superface, ends as one group.
#[derive(Clone, Debug)]
struct Region {
    alive: bool,
    version: u32,
    area: f32,
    /// Area-weighted means. Kept as sums divided on write, so a merge is an add.
    colour: Vec3,
    normal: Vec3,
    sdf: f32,
    nbr: HashMap<u32, Border>,
}

/// Run both stages.
pub fn build(
    mesh: &Mesh,
    adj: &Adjacency,
    ff: &FaceFeatures,
    ef: &EdgeFeatures,
    opts: &SegmentOptions,
) -> Dendrogram {
    let nt = mesh.triangle_count();
    if nt == 0 {
        return Dendrogram::default();
    }

    let (super_of_face, super_count) = superfaces(nt, adj, ff, ef, opts);
    let nbr_of_face = neighbours(nt, adj, &super_of_face);
    let wpos = welded_positions(mesh);
    let (merges, costs) = agglomerate(adj, ff, ef, opts, &super_of_face, super_count, &wpos);

    Dendrogram {
        floor: super_count - merges.len(),
        super_of_face,
        super_count,
        nbr_of_face,
        merges,
        costs,
    }
}

/// The cost of joining two single triangles across one edge.
///
/// The same terms the region stage uses, read off faces instead of means. SDF
/// is deliberately absent: it is measured *per superface*, which is the stage
/// this function exists to produce, and asking for it here would be circular.
fn face_pair_cost(
    edge: usize,
    a: usize,
    b: usize,
    ff: &FaceFeatures,
    ef: &EdgeFeatures,
    opts: &SegmentOptions,
) -> Option<f32> {
    let terms = edge_terms(edge, a, b, ff, ef, opts);
    if terms.barrier {
        return None;
    }
    Some(region_cost(
        terms.crease,
        ff.colour[a],
        ff.colour[b],
        ff.normal[a],
        ff.normal[b],
        0.0,
        0.0,
        opts,
    ))
}

/// Stage one: collapse the edges nobody could argue about.
///
/// The test is a pair of *tolerances*, not a budget: below a just-noticeable
/// colour difference and below a few degrees of fold, two triangles are the same
/// surface, and no weighting anybody chooses later should change that. Ordered
/// cheapest first anyway, so that when the size ceiling bites it bites on the
/// weakest join available rather than on whichever edge the adjacency listed
/// first.
fn superfaces(
    nt: usize,
    adj: &Adjacency,
    ff: &FaceFeatures,
    ef: &EdgeFeatures,
    opts: &SegmentOptions,
) -> (Vec<u32>, usize) {
    let fold = opts.superface_angle_deg.to_radians();
    let tint = opts.superface_colour;

    let mut order: Vec<(f32, u32, u32)> = Vec::new();
    for (id, e) in adj.edges.iter().enumerate() {
        let (Some(a), Some(b)) = (e.tri[0], e.tri[1]) else {
            continue;
        };
        if edge_terms(id, a as usize, b as usize, ff, ef, opts).barrier {
            continue;
        }
        if ef.dihedral[id].abs() > fold {
            continue;
        }
        if ff.colour[a as usize].distance(ff.colour[b as usize]) > tint {
            continue;
        }
        // Only to order the ones that already qualify.
        let Some(cost) = face_pair_cost(id, a as usize, b as usize, ff, ef, opts) else {
            continue;
        };
        order.push((cost, a, b));
    }
    order.sort_by(|x, y| x.0.total_cmp(&y.0));

    let mut uf = UnionFind::new(nt);
    for (_, a, b) in order {
        let (ra, rb) = (uf.find(a), uf.find(b));
        if ra == rb {
            continue;
        }
        if uf.set_size(ra) + uf.set_size(rb) > opts.max_superface_faces {
            continue;
        }
        uf.union(a, b);
    }

    let mut dense = vec![u32::MAX; nt];
    let mut label = vec![0u32; nt];
    let mut next = 0u32;
    for t in 0..nt {
        let root = uf.find(t as u32) as usize;
        if dense[root] == u32::MAX {
            dense[root] = next;
            next += 1;
        }
        label[t] = dense[root];
    }
    (label, next as usize)
}

/// Which superface sits across each edge of each triangle.
fn neighbours(nt: usize, adj: &Adjacency, super_of_face: &[u32]) -> Vec<[u32; 3]> {
    (0..nt)
        .map(|t| {
            let mut out = [u32::MAX; 3];
            for k in 0..3 {
                let e = &adj.edges[adj.tri_edges[t][k] as usize];
                let other = match (e.tri[0], e.tri[1]) {
                    (Some(a), Some(b)) if a as usize == t => Some(b),
                    (Some(a), Some(b)) if b as usize == t => Some(a),
                    _ => None,
                };
                if let Some(o) = other {
                    out[k] = super_of_face[o as usize];
                }
            }
            out
        })
        .collect()
}

/// Stage two: merge regions cheapest pair first, recording everything.
fn agglomerate(
    adj: &Adjacency,
    ff: &FaceFeatures,
    ef: &EdgeFeatures,
    opts: &SegmentOptions,
    super_of_face: &[u32],
    super_count: usize,
    wpos: &[Vec3],
) -> (Vec<[u32; 2]>, Vec<f32>) {
    let sdf = ff.sdf.as_deref();

    // Region state, seeded from the faces each superface swallowed.
    let mut regions: Vec<Region> = vec![
        Region {
            alive: true,
            version: 0,
            area: 0.0,
            colour: Vec3::ZERO,
            normal: Vec3::ZERO,
            sdf: 0.0,
            nbr: HashMap::new(),
        };
        super_count
    ];
    for (t, &s) in super_of_face.iter().enumerate() {
        let r = &mut regions[s as usize];
        let a = ff.area[t];
        r.area += a;
        r.colour += ff.colour[t] * a;
        r.normal += ff.normal[t] * a;
        r.sdf += sdf.map_or(0.0, |v| v[t]) * a;
    }
    let total_area: f32 = regions.iter().map(|r| r.area).sum();
    // Below this, a region is absorbed before anybody looks at what it is.
    let small = (total_area * opts.min_area_ratio).max(f32::MIN_POSITIVE);

    // Borders, from every adjacency edge whose two sides fell in different
    // superfaces.
    for (id, e) in adj.edges.iter().enumerate() {
        let (Some(a), Some(b)) = (e.tri[0], e.tri[1]) else {
            continue;
        };
        let (sa, sb) = (super_of_face[a as usize], super_of_face[b as usize]);
        if sa == sb {
            continue;
        }
        let terms = edge_terms(id, a as usize, b as usize, ff, ef, opts);
        // Length weighted, so a long smooth join outvotes a millimetre of noise
        // at one corner. Guarded, because a degenerate edge would otherwise let
        // a whole border average over a total weight of zero.
        let len = wpos[e.v[0] as usize]
            .distance(wpos[e.v[1] as usize])
            .max(f32::MIN_POSITIVE);
        let piece = Border {
            len,
            crease: terms.crease * len,
            barrier: terms.barrier,
        };
        regions[sa as usize].nbr.entry(sb).or_default().absorb(&piece);
        regions[sb as usize].nbr.entry(sa).or_default().absorb(&piece);
    }

    let mean = |r: &Region| -> (Vec3, Vec3, f32) {
        let inv = if r.area > 0.0 { 1.0 / r.area } else { 0.0 };
        (
            r.colour * inv,
            (r.normal * inv).normalize_or_zero(),
            r.sdf * inv,
        )
    };

    let price = |regions: &[Region], a: u32, b: u32| -> f32 {
        let (ra, rb) = (&regions[a as usize], &regions[b as usize]);
        let border = ra.nbr.get(&b).copied().unwrap_or_default();
        let (ca, na, sa) = mean(ra);
        let (cb, nb, sb) = mean(rb);
        let base = region_cost(border.mean_crease(), ca, cb, na, nb, sa, sb, opts);
        // A region too small to be a part is pulled in first whatever it looks
        // like, which is why no position of the slider ever shows confetti.
        base * (ra.area.min(rb.area) / small).min(1.0)
    };

    let mut heap: BinaryHeap<Cand> = BinaryHeap::new();
    for a in 0..super_count as u32 {
        for (&b, border) in &regions[a as usize].nbr {
            // Once per pair, not twice.
            if b <= a || border.barrier {
                continue;
            }
            heap.push(Cand {
                cost: price(&regions, a, b),
                a,
                b,
                va: 0,
                vb: 0,
            });
        }
    }

    let mut merges: Vec<[u32; 2]> = Vec::with_capacity(super_count.saturating_sub(1));
    let mut costs: Vec<f32> = Vec::with_capacity(super_count.saturating_sub(1));
    let mut monotone = 0.0f32;

    while let Some(c) = heap.pop() {
        let (ra, rb) = (&regions[c.a as usize], &regions[c.b as usize]);
        if !ra.alive || !rb.alive || ra.version != c.va || rb.version != c.vb {
            continue;
        }

        // Splice the one with fewer neighbours into the one with more.
        let (keep, gone) = if ra.nbr.len() >= rb.nbr.len() {
            (c.a, c.b)
        } else {
            (c.b, c.a)
        };

        let taken = std::mem::take(&mut regions[gone as usize].nbr);
        let (area, colour, normal, sdf) = {
            let g = &mut regions[gone as usize];
            g.alive = false;
            (g.area, g.colour, g.normal, g.sdf)
        };
        {
            let k = &mut regions[keep as usize];
            // Sums, not means. The division happens on read, so a merge stays an
            // add and no precision is lost round-tripping through an average.
            k.area += area;
            k.colour += colour;
            k.normal += normal;
            k.sdf += sdf;
            k.version += 1;
            k.nbr.remove(&gone);
        }

        for (n, border) in taken {
            if n == keep {
                continue;
            }
            regions[keep as usize].nbr.entry(n).or_default().absorb(&border);
            let side = &mut regions[n as usize].nbr;
            if let Some(b) = side.remove(&gone) {
                side.entry(keep).or_default().absorb(&b);
            }
        }

        // The heap only ever grows, so the costs coming out of it are not
        // monotone: a pair repriced after this merge can be cheaper than one
        // already popped. The merge *order* is still exactly greedy and the
        // slider only ever reads that, but a threshold read off a jagged column
        // would cut in the wrong place, so the column is clamped on the way out.
        monotone = monotone.max(c.cost);
        merges.push([keep, gone]);
        costs.push(monotone);

        let fresh: Vec<u32> = regions[keep as usize]
            .nbr
            .iter()
            .filter(|(_, b)| !b.barrier)
            .map(|(&n, _)| n)
            .collect();
        for n in fresh {
            if !regions[n as usize].alive {
                continue;
            }
            heap.push(Cand {
                cost: price(&regions, keep, n),
                a: keep,
                b: n,
                va: regions[keep as usize].version,
                vb: regions[n as usize].version,
            });
        }
    }

    (merges, costs)
}

/// Where every welded point sits.
///
/// `Adjacency::Edge` names its endpoints by welded id, and a welded id has no
/// position of its own: it is the identity several render vertices share. Any
/// one of them answers, since agreeing on a position is what made them one
/// welded point in the first place.
fn welded_positions(mesh: &Mesh) -> Vec<Vec3> {
    let mut out = vec![Vec3::ZERO; mesh.weld_count];
    for (r, &w) in mesh.weld.iter().enumerate() {
        out[w as usize] = mesh.positions[r];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec2;
    use retopo_core::mesh::{Image, Material};

    /// A strip of `n` quads in the z=0 plane, running along x.
    fn strip(n: usize) -> Mesh {
        let mut m = Mesh {
            materials: vec![Material::default()],
            ..Default::default()
        };
        for i in 0..=n {
            let x = i as f32;
            m.positions.push(Vec3::new(x, 0.0, 0.0));
            m.positions.push(Vec3::new(x, 1.0, 0.0));
            m.normals.push(Vec3::Z);
            m.normals.push(Vec3::Z);
            let u = i as f32 / n as f32;
            m.uvs.push(Vec2::new(u, 0.0));
            m.uvs.push(Vec2::new(u, 1.0));
        }
        for i in 0..n {
            let a = (i * 2) as u32;
            m.triangles.push([a, a + 2, a + 3]);
            m.triangles.push([a, a + 3, a + 1]);
            m.tri_material.extend([0, 0]);
        }
        m.rebuild_weld(0.0);
        m
    }

    /// The same strip, painted in `bands` flat greys along its length.
    ///
    /// Flat *within* a band so the pre-merge can do its job, and stepped between
    /// them so there is something real left for the hierarchy to find.
    fn banded(quads: usize, bands: usize) -> Mesh {
        let mut m = strip(quads);
        let w = 16 * bands as u32;
        let mut img = Image::new(w, 1);
        for x in 0..w {
            let band = (x * bands as u32 / w).min(bands as u32 - 1);
            let v = (18 + band * (220 / bands.max(1) as u32)) as u8;
            let i = (x * 4) as usize;
            img.rgba[i] = v;
            img.rgba[i + 1] = v;
            img.rgba[i + 2] = v;
            img.rgba[i + 3] = 255;
        }
        m.images.push(img);
        m.materials[0].base_color_texture = Some(0);
        m
    }

    fn run(m: &Mesh, opts: &SegmentOptions) -> Dendrogram {
        let adj = Adjacency::build(m);
        let ef = EdgeFeatures::build(m, &adj);
        let ff = FaceFeatures::build(m, &adj, &ef);
        build(m, &adj, &ff, &ef, opts)
    }

    #[test]
    fn a_flat_untextured_strip_collapses_to_one_group() {
        let d = run(&strip(8), &SegmentOptions::default());
        assert_eq!(d.floor, 1, "nothing here is a boundary");
        assert_eq!(d.super_count, 1, "and the pre-merge alone should see that");
        assert_eq!(d.cut(1).iter().max(), Some(&0));
    }

    #[test]
    fn two_disconnected_quads_can_never_become_one_group() {
        let mut m = strip(1);
        let base = m.positions.len() as u32;
        for i in 0..4 {
            let p = m.positions[i] + Vec3::new(50.0, 0.0, 0.0);
            m.positions.push(p);
            m.normals.push(Vec3::Z);
            m.uvs.push(Vec2::ZERO);
        }
        m.triangles.push([base, base + 2, base + 3]);
        m.triangles.push([base, base + 3, base + 1]);
        m.tri_material.extend([0, 0]);
        m.rebuild_weld(0.0);

        let d = run(&m, &SegmentOptions::default());
        assert_eq!(d.floor, 2, "a shell barrier makes the dendrogram a forest");
        let cut = d.cut(1);
        assert_eq!(
            cut.iter().collect::<std::collections::HashSet<_>>().len(),
            2,
            "asking for one group cannot produce fewer than the floor"
        );
    }

    #[test]
    fn a_painted_half_separates_from_the_other() {
        let n = 8;
        let mut m = strip(n);
        // Left half black, right half white, with a hard step in the middle.
        let w = 16u32;
        let mut img = Image::new(w, 1);
        for x in 0..w {
            let v = if x < w / 2 { 8 } else { 247 };
            let i = (x * 4) as usize;
            img.rgba[i] = v;
            img.rgba[i + 1] = v;
            img.rgba[i + 2] = v;
            img.rgba[i + 3] = 255;
        }
        m.images.push(img);
        m.materials[0].base_color_texture = Some(0);

        let d = run(&m, &SegmentOptions::default());
        assert!(
            d.super_count >= 2,
            "the pre-merge must not eat the step: got {}",
            d.super_count
        );

        let cut = d.cut(2);
        let left = cut[d.super_of_face[0] as usize];
        let right = cut[d.super_of_face[m.triangle_count() - 1] as usize];
        assert_ne!(left, right, "black and white are not one part");
    }

    #[test]
    fn the_merge_costs_come_out_non_decreasing() {
        let d = run(&strip(24), &SegmentOptions::default());
        for w in d.costs.windows(2) {
            assert!(w[0] <= w[1], "costs must be monotone: {w:?}");
        }
    }

    #[test]
    fn cutting_at_k_gives_exactly_k_groups_between_the_floor_and_the_ceiling() {
        let d = run(&banded(12, 4), &SegmentOptions::default());
        assert!(d.super_count > 1, "the bands must survive the pre-merge");
        for k in d.floor..=d.super_count {
            let cut = d.cut(k);
            let seen: std::collections::HashSet<_> = cut.iter().collect();
            assert_eq!(seen.len(), k, "asked for {k} groups");
        }
    }

    #[test]
    fn replaying_the_merge_prefix_reproduces_the_cut() {
        // What the interface does per slider move, done here the long way, to
        // pin that any union-find replaying a prefix lands on the same partition
        // whichever representative it happens to choose.
        let d = run(&banded(16, 5), &SegmentOptions::default());
        assert!(!d.merges.is_empty(), "there must be something to replay");
        let k = d.floor.max(1);
        let mine = d.cut(k);

        let mut uf = UnionFind::new(d.super_count);
        for m in d.merges.iter().take(d.super_count - k) {
            uf.union(m[1], m[0]); // deliberately the other way round
        }
        for a in 0..d.super_count as u32 {
            for b in 0..d.super_count as u32 {
                assert_eq!(
                    mine[a as usize] == mine[b as usize],
                    uf.find(a) == uf.find(b),
                    "the partition must not depend on merge direction"
                );
            }
        }
    }
}
