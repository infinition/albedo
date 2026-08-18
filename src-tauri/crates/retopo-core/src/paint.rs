//! What the artist drew on the model, and how the engine reads it back.
//!
//! Three sliders and a triangle budget describe a *whole* mesh, and a whole mesh
//! is almost never what a retopology is about. The face needs its detail and the
//! back of the skull does not; the bolt heads have to survive and the plate they
//! sit on can lose ninety percent; that seam across the shoulder is a real edge
//! and no cost function can know it. All of that is knowledge the person looking
//! at the model already has, and until now there was nowhere to put it.
//!
//! This module is the place. The interface paints it — density, freeze, the
//! region to work in, and guide curves along the edges that matter — and writes
//! it beside the GLB as one sidecar file. Everything downstream reads it through
//! [`PaintField`].
//!
//! # Why positions and not vertex indices
//!
//! The obvious encoding is one value per vertex, in file order. It is also
//! wrong, and quietly: the interface hands the engine a GLB it exported from
//! three.js, and between the two there is an exporter that may split a primitive
//! per material, a reader that concatenates primitives, a weld pass, and a
//! degenerate-triangle cull. Any one of those shifts the numbering, and a
//! shifted paint mask is not an error — it is a *plausible* mask, applied to the
//! wrong places, which is the worst shape a bug can take in a tool whose output
//! you judge by eye.
//!
//! So the sidecar carries points in space, and the engine matches them to its
//! own vertices by proximity. Both sides describe the same surface, so the match
//! is exact in practice and merely close in theory, and [`PaintField::matched`]
//! reports how many landed so a mismatch shows up as a number rather than as a
//! strange result.
//!
//! It also buys something the index encoding could never give: the field is
//! *spatial*, so it can be asked about a point that is not a vertex at all. That
//! is what lets the isotropic remesher — which creates vertices as it runs —
//! honour a density painted on the original.

use std::collections::HashMap;

use glam::Vec3;

use crate::mesh::Mesh;

/// Magic at the head of the sidecar. Version is the last byte, so a reader can
/// refuse a file from a newer interface instead of misreading it.
const MAGIC: &[u8; 8] = b"ALBPNT01";

/// A guide the person drew along the surface.
#[derive(Clone, Debug)]
pub struct Guide {
    /// 0 — a crease: hold this line, the result must still have an edge here.
    /// 1 — a flow: edges along this direction are worth keeping, edges across it
    ///     are the ones to spend.
    pub kind: u32,
    /// How far from the curve the guide reaches, in model units.
    pub radius: f32,
    /// 0..1, how hard it pulls.
    pub strength: f32,
    /// The curve itself, already resampled by the interface.
    pub points: Vec<Vec3>,
}

impl Guide {
    pub const CREASE: u32 = 0;
    pub const FLOW: u32 = 1;
}

/// One painted point: a vertex of the mesh the interface was looking at.
#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub p: Vec3,
    /// -1 coarser, 0 untouched, +1 finer.
    pub density: f32,
    /// Never move this point.
    pub freeze: bool,
    /// Inside the area the run is allowed to touch.
    pub region: bool,
}

/// The sidecar, parsed.
#[derive(Clone, Debug, Default)]
pub struct Painting {
    /// How far a mesh vertex may be from a sample and still be that sample.
    /// Written by the interface from the mesh's own edge lengths.
    pub match_radius: f32,
    /// Whether a region was painted at all. Without one, everything is inside.
    pub has_region: bool,
    pub samples: Vec<Sample>,
    pub guides: Vec<Guide>,
}

/// A little reader that cannot run off the end of the buffer.
struct Cursor<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn u32(&mut self) -> Result<u32, String> {
        let end = self.at + 4;
        if end > self.b.len() {
            return Err("sidecar de peinture tronqué".into());
        }
        let v = u32::from_le_bytes(self.b[self.at..end].try_into().unwrap());
        self.at = end;
        Ok(v)
    }
    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_bits(self.u32()?))
    }
    fn vec3(&mut self) -> Result<Vec3, String> {
        Ok(Vec3::new(self.f32()?, self.f32()?, self.f32()?))
    }
}

impl Painting {
    /// Parse the sidecar. See the module header for the layout.
    ///
    /// ```text
    /// "ALBPNT01"        magic and version
    /// u32  flags        bit 0: a region was painted
    /// f32  match_radius
    /// u32  sample_count
    /// u32  guide_count
    /// samples[]         f32 x, y, z, density; u32 flags (bit 0 freeze, bit 1 region)
    /// guides[]          u32 kind; f32 radius, strength; u32 point_count; f32 xyz * count
    /// ```
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 8 || &bytes[..8] != MAGIC {
            return Err("ce fichier n'est pas une peinture Albedo".into());
        }
        let mut c = Cursor { b: bytes, at: 8 };
        let flags = c.u32()?;
        let match_radius = c.f32()?;
        let n_samples = c.u32()? as usize;
        let n_guides = c.u32()? as usize;

        let mut samples = Vec::with_capacity(n_samples.min(1 << 22));
        for _ in 0..n_samples {
            let p = c.vec3()?;
            let density = c.f32()?;
            let f = c.u32()?;
            samples.push(Sample {
                p,
                density,
                freeze: f & 1 != 0,
                region: f & 2 != 0,
            });
        }

        let mut guides = Vec::with_capacity(n_guides.min(1 << 16));
        for _ in 0..n_guides {
            let kind = c.u32()?;
            let radius = c.f32()?;
            let strength = c.f32()?;
            let n = c.u32()? as usize;
            let mut points = Vec::with_capacity(n.min(1 << 20));
            for _ in 0..n {
                points.push(c.vec3()?);
            }
            guides.push(Guide {
                kind,
                radius,
                strength,
                points,
            });
        }

        Ok(Self {
            match_radius: if match_radius.is_finite() && match_radius > 0.0 {
                match_radius
            } else {
                1e-4
            },
            has_region: flags & 1 != 0,
            samples,
            guides,
        })
    }

    /// Read one from disk, or nothing at all when there is none.
    ///
    /// A missing file is not an error: most runs have no painting, and the
    /// caller should not have to tell "nobody painted" from "the disk failed".
    /// A *malformed* file is an error, because silently ignoring it would look
    /// exactly like a brush that does nothing.
    pub fn load(path: &std::path::Path) -> Result<Option<Self>, String> {
        match std::fs::read(path) {
            Ok(bytes) => Self::parse(&bytes).map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("peinture illisible: {e}")),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty() && self.guides.is_empty()
    }
}

/// A uniform grid over points in space, cell sized to the query radius.
///
/// Not a BVH and not a kd-tree on purpose. Every query here has the same, known
/// radius, and the points are spread over a surface rather than clustered, which
/// is precisely the case a hash grid answers in constant time and a tree answers
/// in log n with worse constants.
struct Grid {
    cell: f32,
    map: HashMap<(i32, i32, i32), Vec<u32>>,
}

impl Grid {
    fn key(&self, p: Vec3) -> (i32, i32, i32) {
        (
            (p.x / self.cell).floor() as i32,
            (p.y / self.cell).floor() as i32,
            (p.z / self.cell).floor() as i32,
        )
    }

    fn build(points: impl Iterator<Item = Vec3>, cell: f32) -> Self {
        let mut g = Self {
            cell: cell.max(1e-9),
            map: HashMap::new(),
        };
        for (i, p) in points.enumerate() {
            let k = g.key(p);
            g.map.entry(k).or_default().push(i as u32);
        }
        g
    }

    /// Everything within one cell of `p`, which covers any radius up to `cell`.
    fn near(&self, p: Vec3, out: &mut Vec<u32>) {
        out.clear();
        let (x, y, z) = self.key(p);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(v) = self.map.get(&(x + dx, y + dy, z + dz)) {
                        out.extend_from_slice(v);
                    }
                }
            }
        }
    }
}

/// The painting, indexed so it can be asked questions.
///
/// Two faces, and both are needed:
///
/// - **Spatial.** [`density_at`](Self::density_at) and friends answer for any
///   point, including one that did not exist when the painting was made. The
///   isotropic remesher splits and collapses its way to a new mesh entirely, so
///   a per-vertex table would be stale by its second iteration.
/// - **Per welded vertex.** [`resolve`](Self::resolve) precomputes the same
///   answers for one mesh, because the decimator asks about the same few
///   thousand points a million times and a hash lookup per question is a
///   measurable share of a run.
///
/// `Debug` prints what it is rather than what is in it: the grids hold a bucket
/// per cell over hundreds of thousands of points, and an options struct printed
/// in a log has no use for any of it.
pub struct PaintField {
    painting: Painting,
    samples: Grid,
    /// Guides, densely resampled, with the local tangent carried alongside so a
    /// flow query does not have to walk back to the segment it came from.
    guide_pts: Vec<(Vec3, Vec3, u32, f32)>,
    guide_grid: Grid,
    guide_reach: f32,
}

/// The same answers, precomputed for one mesh, one entry per welded vertex.
#[derive(Clone, Debug, Default)]
pub struct VertexField {
    /// -1..1. Positive keeps triangles here, negative spends them elsewhere.
    pub density: Vec<f32>,
    /// Never moves.
    pub frozen: Vec<bool>,
    /// Allowed to be touched at all. All true when no region was painted.
    pub region: Vec<bool>,
    /// On a crease guide: hold the line here.
    pub creased: Vec<bool>,
    /// On a flow guide: the direction the artist drew, normalised.
    pub flow: Vec<Vec3>,
    /// How many painted samples found a vertex to land on. A count far below
    /// the sample count means the sidecar and the mesh do not describe the same
    /// thing, which is worth saying out loud rather than acting on.
    pub matched: usize,
    /// Vertices inside the region, when one was painted.
    pub inside: usize,
    pub has_region: bool,
}

impl std::fmt::Debug for PaintField {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PaintField")
            .field("samples", &self.painting.samples.len())
            .field("guides", &self.painting.guides.len())
            .field("has_region", &self.painting.has_region)
            .field("match_radius", &self.painting.match_radius)
            .finish()
    }
}

impl PaintField {
    pub fn new(painting: Painting) -> Self {
        let cell = painting.match_radius.max(1e-6);
        let samples = Grid::build(painting.samples.iter().map(|s| s.p), cell);

        // Guides arrive as polylines, and a polyline is answered by walking its
        // segments. Resampling them into points on the same kind of grid as the
        // samples turns "how far is this vertex from the curve" into the same
        // constant-time question, and the step is half the reach so no vertex
        // inside the band can slip between two samples.
        let mut guide_pts = Vec::new();
        let mut reach: f32 = cell;
        for g in &painting.guides {
            let r = g.radius.max(1e-6);
            reach = reach.max(r);
            let step = (r * 0.5).max(1e-6);
            for w in g.points.windows(2) {
                let (a, b) = (w[0], w[1]);
                let d = b - a;
                let len = d.length();
                if len <= 1e-9 {
                    continue;
                }
                let dir = d / len;
                let n = (len / step).ceil().max(1.0) as usize;
                for i in 0..=n {
                    let t = i as f32 / n as f32;
                    guide_pts.push((a + d * t, dir, g.kind, g.strength.clamp(0.0, 1.0)));
                }
            }
            // A guide of a single point still means something: a pin.
            if g.points.len() == 1 {
                guide_pts.push((g.points[0], Vec3::ZERO, g.kind, g.strength.clamp(0.0, 1.0)));
            }
        }
        let guide_grid = Grid::build(guide_pts.iter().map(|(p, ..)| *p), reach);

        Self {
            painting,
            samples,
            guide_pts,
            guide_grid,
            guide_reach: reach,
        }
    }

    pub fn from_painting(painting: Painting) -> Option<Self> {
        if painting.is_empty() {
            return None;
        }
        Some(Self::new(painting))
    }

    pub fn has_region(&self) -> bool {
        self.painting.has_region
    }

    pub fn guide_count(&self) -> usize {
        self.painting.guides.len()
    }

    pub fn sample_count(&self) -> usize {
        self.painting.samples.len()
    }

    /// The nearest painted sample to `p`, if one is close enough to be about the
    /// same point.
    fn nearest(&self, p: Vec3) -> Option<&Sample> {
        let mut scratch = Vec::new();
        self.samples.near(p, &mut scratch);
        let limit = self.painting.match_radius * self.painting.match_radius;
        let mut best = None;
        let mut best_d = limit;
        for i in scratch {
            let s = &self.painting.samples[i as usize];
            let d = s.p.distance_squared(p);
            if d <= best_d {
                best_d = d;
                best = Some(s);
            }
        }
        best
    }

    /// -1..1 at any point. Zero where nothing was painted, which is the
    /// identity: the engine behaves exactly as it did before the brush existed.
    pub fn density_at(&self, p: Vec3) -> f32 {
        self.nearest(p).map(|s| s.density).unwrap_or(0.0)
    }

    /// Whether this point was painted as untouchable.
    pub fn frozen_at(&self, p: Vec3) -> bool {
        self.nearest(p).map(|s| s.freeze).unwrap_or(false)
    }

    /// Whether a run may touch this point at all.
    pub fn in_region(&self, p: Vec3) -> bool {
        if !self.painting.has_region {
            return true;
        }
        self.nearest(p).map(|s| s.region).unwrap_or(false)
    }

    /// A multiplier on the target edge length: dense paint asks for shorter
    /// edges, sparse paint for longer ones.
    ///
    /// The range is deliberately narrow. An edge length is a *length*, so a
    /// factor of four between two neighbouring regions is a factor of sixteen in
    /// triangle count across a seam the remesher then has to make continuous, and
    /// what comes out is a scar rather than a gradient. Two and a half either way
    /// is as far as this can go and still look like one mesh.
    pub fn edge_scale_at(&self, p: Vec3, influence: f32) -> f32 {
        let d = self.density_at(p).clamp(-1.0, 1.0) * influence.clamp(0.0, 1.0);
        // 2.5^-d: positive density shortens, negative lengthens, and the two are
        // exact reciprocals so painting + then - returns to where it started.
        2.5f32.powf(-d)
    }

    /// The strongest guide acting at `p`: its kind, its tangent and its weight,
    /// the weight falling off to nothing at the edge of the band.
    pub fn guide_at(&self, p: Vec3) -> Option<(u32, Vec3, f32)> {
        if self.guide_pts.is_empty() {
            return None;
        }
        let mut scratch = Vec::new();
        self.guide_grid.near(p, &mut scratch);
        let mut best: Option<(u32, Vec3, f32)> = None;
        let mut best_w = 0.0f32;
        for i in scratch {
            let (gp, dir, kind, strength) = self.guide_pts[i as usize];
            let d = gp.distance(p);
            if d > self.guide_reach {
                continue;
            }
            // Smooth, not linear: a linear falloff puts a visible ring at the
            // edge of every guide, where the constraint switches off in one step.
            let t = 1.0 - (d / self.guide_reach).clamp(0.0, 1.0);
            let w = t * t * (3.0 - 2.0 * t) * strength;
            if w > best_w {
                best_w = w;
                best = Some((kind, dir, w));
            }
        }
        best
    }

    /// Precompute every answer for one mesh, per welded vertex.
    pub fn resolve(&self, mesh: &Mesh) -> VertexField {
        let nw = mesh.weld_count;
        let mut f = VertexField {
            density: vec![0.0; nw],
            frozen: vec![false; nw],
            region: vec![!self.painting.has_region; nw],
            creased: vec![false; nw],
            flow: vec![Vec3::ZERO; nw],
            matched: 0,
            inside: 0,
            has_region: self.painting.has_region,
        };

        // Welded positions, taken from the render vertices that map onto them.
        let mut pos = vec![Vec3::ZERO; nw];
        for (r, &w) in mesh.weld.iter().enumerate() {
            pos[w as usize] = mesh.positions[r];
        }

        for (w, &p) in pos.iter().enumerate() {
            if let Some(s) = self.nearest(p) {
                f.matched += 1;
                f.density[w] = s.density;
                f.frozen[w] = s.freeze;
                if self.painting.has_region {
                    f.region[w] = s.region;
                }
            }
            if let Some((kind, dir, weight)) = self.guide_at(p) {
                if kind == Guide::CREASE {
                    // A crease guide is a promise that an edge survives here, and
                    // the only way to keep that promise in an edge-collapse
                    // decimator is to refuse to move the points that carry it.
                    f.creased[w] = true;
                } else if dir != Vec3::ZERO {
                    f.flow[w] = dir * weight;
                }
            }
        }
        f.inside = f.region.iter().filter(|&&r| r).count();
        f
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(samples: &[Sample], guides: &[Guide], has_region: bool, radius: f32) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(MAGIC);
        b.extend_from_slice(&(has_region as u32).to_le_bytes());
        b.extend_from_slice(&radius.to_le_bytes());
        b.extend_from_slice(&(samples.len() as u32).to_le_bytes());
        b.extend_from_slice(&(guides.len() as u32).to_le_bytes());
        for s in samples {
            for v in [s.p.x, s.p.y, s.p.z, s.density] {
                b.extend_from_slice(&v.to_le_bytes());
            }
            let f = (s.freeze as u32) | ((s.region as u32) << 1);
            b.extend_from_slice(&f.to_le_bytes());
        }
        for g in guides {
            b.extend_from_slice(&g.kind.to_le_bytes());
            b.extend_from_slice(&g.radius.to_le_bytes());
            b.extend_from_slice(&g.strength.to_le_bytes());
            b.extend_from_slice(&(g.points.len() as u32).to_le_bytes());
            for p in &g.points {
                for v in [p.x, p.y, p.z] {
                    b.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
        b
    }

    /*
     * A sidecar the *interface* wrote, byte for byte.
     *
     * Everything else in this file checks that this module agrees with itself.
     * This one checks the only thing that can actually break in the field: that
     * the two halves of the feature, written in two languages against one
     * paragraph of documentation, still agree. It was produced by driving
     * `src/retopo/paint.js` with real pointer events over a 2x2 plane placed at
     * x = 0.5 — a region dab and one crease guide — and captured as it came out.
     *
     * If a future change to either side breaks the layout, this fails here
     * rather than in a run that silently ignores everything the artist drew.
     */
    const FROM_THE_BRUSH: &str = "QUxCUE5UMDEBAAAAAACAPQoAAAABAAAAAAAAPwAAAD8AAAAAAAAAAAIAAAAAAIA+AACAPgAAAAAAAAAAAgAAAAAAAD8AAIA+AAAAAAAAAAACAAAAAABAPwAAgD4AAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAgD4AAAAAAAAAAAAAAAACAAAAAAAAPwAAAAAAAAAAAAAAAAIAAAAAAEA/AAAAAAAAAAAAAAAAAgAAAAAAgD4AAIC+AAAAAAAAAAACAAAAAAAAPwAAgL4AAAAAAAAAAAIAAAAAAAAAAADAPgAAgD8CAAAA7T8PPu0/j74AAAAA5N/WPu0/j74AAAAA";

    /// Just enough base64 to read one test fixture, so the crate does not gain a
    /// dependency for the sake of a string constant.
    fn unbase64(text: &str) -> Vec<u8> {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let (mut acc, mut bits) = (0u32, 0u32);
        for c in text.bytes() {
            if c == b'=' || c.is_ascii_whitespace() {
                continue;
            }
            let Some(v) = ALPHABET.iter().position(|&a| a == c) else {
                continue;
            };
            acc = (acc << 6) | v as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
            }
        }
        out
    }

    #[test]
    fn the_interfaces_own_bytes_are_read_the_way_it_wrote_them() {
        let raw = unbase64(FROM_THE_BRUSH);
        let p = Painting::parse(&raw).expect("the interface's sidecar parses");

        assert!(p.has_region, "a region was painted and the flag says so");
        assert_eq!(p.samples.len(), 10);
        assert_eq!(p.guides.len(), 1);
        assert_eq!(p.guides[0].kind, Guide::CREASE);
        assert_eq!(p.guides[0].points.len(), 2);

        // The plane sits at x = 0.5, so a painted point at the mesh's own origin
        // has to arrive here at x = 0.5: the interface writes world coordinates,
        // which is the space the exported GLB is in. Local ones would put every
        // stroke wherever the model happened to be before it was placed.
        assert!(
            p.samples.iter().any(|s| (s.p.x - 0.5).abs() < 1e-5 && s.region),
            "no sample landed where the mesh was placed: {:?}",
            p.samples.iter().map(|s| s.p.x).collect::<Vec<_>>()
        );
        assert!(p.samples.iter().all(|s| !s.freeze));

        // And the whole thing answers questions once indexed.
        let field = PaintField::from_painting(p).expect("not empty");
        assert!(field.has_region());
        assert_eq!(field.guide_count(), 1);
    }

    #[test]
    fn round_trips_through_the_sidecar() {
        let samples = vec![
            Sample { p: Vec3::ZERO, density: 1.0, freeze: true, region: true },
            Sample { p: Vec3::X, density: -0.5, freeze: false, region: false },
        ];
        let guides = vec![Guide {
            kind: Guide::FLOW,
            radius: 0.1,
            strength: 0.8,
            points: vec![Vec3::ZERO, Vec3::Y],
        }];
        let raw = write(&samples, &guides, true, 0.01);
        let p = Painting::parse(&raw).expect("parses");
        assert_eq!(p.samples.len(), 2);
        assert!(p.has_region);
        assert_eq!(p.guides.len(), 1);
        assert_eq!(p.guides[0].points.len(), 2);
        assert!((p.match_radius - 0.01).abs() < 1e-9);
        assert!(p.samples[0].freeze && !p.samples[1].freeze);
    }

    #[test]
    fn a_truncated_file_is_refused_rather_than_half_read() {
        let raw = write(
            &[Sample { p: Vec3::ZERO, density: 1.0, freeze: false, region: true }],
            &[],
            true,
            0.01,
        );
        assert!(Painting::parse(&raw[..raw.len() - 4]).is_err());
        assert!(Painting::parse(b"not a painting").is_err());
    }

    #[test]
    fn density_is_answered_by_proximity_and_falls_back_to_neutral() {
        let samples = vec![Sample { p: Vec3::new(1.0, 2.0, 3.0), density: 0.75, freeze: false, region: true }];
        let field = PaintField::new(Painting {
            match_radius: 0.05,
            has_region: true,
            samples,
            guides: vec![],
        });
        // Near enough to be the same point, even after a float round trip.
        assert!((field.density_at(Vec3::new(1.0, 2.0, 3.0001)) - 0.75).abs() < 1e-6);
        // Far away: untouched, which is what an unpainted model has to read as.
        assert_eq!(field.density_at(Vec3::new(9.0, 9.0, 9.0)), 0.0);
        // And a region that was painted excludes what it does not cover.
        assert!(field.in_region(Vec3::new(1.0, 2.0, 3.0)));
        assert!(!field.in_region(Vec3::new(9.0, 9.0, 9.0)));
    }

    #[test]
    fn edge_scale_is_a_reciprocal_pair_around_neutral() {
        let field = PaintField::new(Painting {
            match_radius: 0.05,
            has_region: false,
            samples: vec![
                Sample { p: Vec3::ZERO, density: 1.0, freeze: false, region: true },
                Sample { p: Vec3::X, density: -1.0, freeze: false, region: true },
            ],
            guides: vec![],
        });
        let fine = field.edge_scale_at(Vec3::ZERO, 1.0);
        let coarse = field.edge_scale_at(Vec3::X, 1.0);
        assert!(fine < 1.0 && coarse > 1.0);
        assert!((fine * coarse - 1.0).abs() < 1e-5, "{fine} * {coarse}");
        // Untouched ground stays exactly as it was: influence has no effect
        // where nothing was painted.
        assert!((field.edge_scale_at(Vec3::new(5.0, 5.0, 5.0), 1.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn a_guide_reaches_its_band_and_stops() {
        let field = PaintField::new(Painting {
            match_radius: 0.01,
            has_region: false,
            samples: vec![],
            guides: vec![Guide {
                kind: Guide::CREASE,
                radius: 0.2,
                strength: 1.0,
                points: vec![Vec3::ZERO, Vec3::new(1.0, 0.0, 0.0)],
            }],
        });
        let on = field.guide_at(Vec3::new(0.5, 0.0, 0.0));
        assert!(on.is_some());
        let (kind, dir, w) = on.unwrap();
        assert_eq!(kind, Guide::CREASE);
        assert!((dir - Vec3::X).length() < 1e-5);
        assert!(w > 0.9, "on the curve the guide is at full weight, got {w}");
        // Just outside the band it is gone, rather than fading forever.
        assert!(field.guide_at(Vec3::new(0.5, 1.0, 0.0)).is_none());
    }
}
