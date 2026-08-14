//! Mesh representation.
//!
//! Two levels on purpose.
//!
//! `positions` / `normals` / `uvs` are *render* vertices: the array a GPU eats
//! directly. A UV seam or a hard edge duplicates a point there, because one
//! point needs two texture coordinates or two normals.
//!
//! `weld` maps every render vertex back to a single *spatial* point. Topology
//! (adjacency, sharp edges, decimation, ray casting) runs on welded ids and
//! therefore never sees those duplicates. Skipping this indirection is exactly
//! how retopology tools tear a mesh open along its UV seams.

use glam::{Vec2, Vec3};
use std::collections::HashMap;

use crate::adjacency::Adjacency;
use crate::util::UnionFind;

/// Axis aligned bounding box.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Aabb {
    pub min: Vec3,
    pub max: Vec3,
}

impl Default for Aabb {
    fn default() -> Self {
        Self::EMPTY
    }
}

impl Aabb {
    pub const EMPTY: Aabb = Aabb {
        min: Vec3::splat(f32::INFINITY),
        max: Vec3::splat(f32::NEG_INFINITY),
    };

    #[inline]
    pub fn grow(&mut self, p: Vec3) {
        self.min = self.min.min(p);
        self.max = self.max.max(p);
    }

    #[inline]
    pub fn union(&mut self, other: &Aabb) {
        self.min = self.min.min(other.min);
        self.max = self.max.max(other.max);
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.min.x > self.max.x
    }

    #[inline]
    pub fn center(&self) -> Vec3 {
        (self.min + self.max) * 0.5
    }

    #[inline]
    pub fn extent(&self) -> Vec3 {
        (self.max - self.min).max(Vec3::ZERO)
    }

    #[inline]
    pub fn diagonal(&self) -> f32 {
        self.extent().length()
    }

    /// Half the surface area, which is all the SAH comparison needs.
    #[inline]
    pub fn half_area(&self) -> f32 {
        let e = self.extent();
        e.x * e.y + e.y * e.z + e.z * e.x
    }
}

/// A decoded texture. Always RGBA8, so sampling never branches on the format.
#[derive(Clone, Debug)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Image {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            rgba: vec![0; (width as usize) * (height as usize) * 4],
        }
    }

    #[inline]
    pub fn texel(&self, x: i64, y: i64) -> [f32; 4] {
        // Wrap, matching the glTF default sampler.
        let w = self.width as i64;
        let h = self.height as i64;
        if w == 0 || h == 0 {
            return [0.0; 4];
        }
        let x = x.rem_euclid(w) as usize;
        let y = y.rem_euclid(h) as usize;
        let i = (y * self.width as usize + x) * 4;
        [
            self.rgba[i] as f32 / 255.0,
            self.rgba[i + 1] as f32 / 255.0,
            self.rgba[i + 2] as f32 / 255.0,
            self.rgba[i + 3] as f32 / 255.0,
        ]
    }

    /// Bilinear sample in glTF UV space (origin top left, v grows downwards).
    pub fn sample(&self, uv: Vec2) -> [f32; 4] {
        if self.width == 0 || self.height == 0 {
            return [0.0; 4];
        }
        let x = uv.x * self.width as f32 - 0.5;
        let y = uv.y * self.height as f32 - 0.5;
        let x0 = x.floor();
        let y0 = y.floor();
        let fx = x - x0;
        let fy = y - y0;
        let (x0, y0) = (x0 as i64, y0 as i64);

        let c00 = self.texel(x0, y0);
        let c10 = self.texel(x0 + 1, y0);
        let c01 = self.texel(x0, y0 + 1);
        let c11 = self.texel(x0 + 1, y0 + 1);

        let mut out = [0.0f32; 4];
        for k in 0..4 {
            let top = c00[k] * (1.0 - fx) + c10[k] * fx;
            let bot = c01[k] * (1.0 - fx) + c11[k] * fx;
            out[k] = top * (1.0 - fy) + bot * fy;
        }
        out
    }
}

/// A `KHR_texture_transform`: how a texture slot rewrites the mesh UVs.
///
/// Ignoring this is not a cosmetic loss. Quantising exporters routinely store
/// texture coordinates as normalised integers in `0..1` and put the real range
/// in the scale here, so a file with `scale: [16, 16]` sampled without it shows
/// one sixteenth of the texture smeared over the whole model.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UvTransform {
    pub offset: Vec2,
    pub scale: Vec2,
    /// Counter-clockwise, in radians.
    pub rotation: f32,
}

impl Default for UvTransform {
    fn default() -> Self {
        Self {
            offset: Vec2::ZERO,
            scale: Vec2::ONE,
            rotation: 0.0,
        }
    }
}

impl UvTransform {
    pub fn is_identity(&self) -> bool {
        *self == Self::default()
    }

    /// Scale, then rotate, then translate, as the extension specifies.
    #[inline]
    pub fn apply(&self, uv: Vec2) -> Vec2 {
        let s = uv * self.scale;
        let r = if self.rotation == 0.0 {
            s
        } else {
            let (sin, cos) = self.rotation.sin_cos();
            Vec2::new(cos * s.x - sin * s.y, sin * s.x + cos * s.y)
        };
        r + self.offset
    }
}

/// How a material's alpha channel is meant to be read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AlphaMode {
    /// Alpha is ignored entirely.
    #[default]
    Opaque,
    /// Alpha is a yes or no test against `alpha_cutoff`. This is what foliage,
    /// chains and rope cutouts use, and rendering it as opaque fills every hole.
    Mask,
    /// Alpha blends.
    Blend,
}

/// A metallic-roughness material, the glTF 2.0 core model.
#[derive(Clone, Debug)]
pub struct Material {
    pub name: String,
    pub base_color: [f32; 4],
    pub base_color_texture: Option<usize>,
    /// UV transform of the base colour slot.
    pub base_color_uv: UvTransform,
    pub metallic: f32,
    pub roughness: f32,
    /// glTF packs roughness in green and metallic in blue of one image.
    pub metallic_roughness_texture: Option<usize>,
    pub metallic_roughness_uv: UvTransform,
    pub normal_texture: Option<usize>,
    pub normal_uv: UvTransform,
    pub normal_scale: f32,
    /// Ambient occlusion, read from the red channel.
    pub occlusion_texture: Option<usize>,
    pub occlusion_uv: UvTransform,
    pub occlusion_strength: f32,
    pub emissive: [f32; 3],
    pub emissive_texture: Option<usize>,
    pub emissive_uv: UvTransform,
    pub alpha_mode: AlphaMode,
    pub alpha_cutoff: f32,
    pub double_sided: bool,
}

impl Default for Material {
    fn default() -> Self {
        Self {
            name: String::new(),
            base_color: [0.8, 0.8, 0.8, 1.0],
            base_color_texture: None,
            base_color_uv: UvTransform::default(),
            metallic: 0.0,
            roughness: 0.8,
            metallic_roughness_texture: None,
            metallic_roughness_uv: UvTransform::default(),
            normal_texture: None,
            normal_uv: UvTransform::default(),
            normal_scale: 1.0,
            occlusion_texture: None,
            occlusion_uv: UvTransform::default(),
            occlusion_strength: 1.0,
            emissive: [0.0, 0.0, 0.0],
            emissive_texture: None,
            emissive_uv: UvTransform::default(),
            alpha_mode: AlphaMode::Opaque,
            alpha_cutoff: 0.5,
            double_sided: false,
        }
    }
}

/// A triangle mesh with per corner attributes.
///
/// Invariants, relied on everywhere downstream:
/// - `normals.len() == positions.len()` and `weld.len() == positions.len()`.
/// - `uvs` is either empty or the same length as `positions`.
/// - `tri_material.len() == triangles.len()`.
/// - every index in `triangles` is `< positions.len()`.
/// - every value in `weld` is `< weld_count`.
#[derive(Clone, Debug, Default)]
pub struct Mesh {
    pub positions: Vec<Vec3>,
    pub normals: Vec<Vec3>,
    pub uvs: Vec<Vec2>,
    pub triangles: Vec<[u32; 3]>,
    pub tri_material: Vec<u32>,

    /// Render vertex to welded spatial point. See the module docs.
    pub weld: Vec<u32>,
    pub weld_count: usize,

    pub materials: Vec<Material>,
    pub images: Vec<Image>,
}

impl Mesh {
    pub fn vertex_count(&self) -> usize {
        self.positions.len()
    }

    pub fn triangle_count(&self) -> usize {
        self.triangles.len()
    }

    pub fn has_uvs(&self) -> bool {
        self.uvs.len() == self.positions.len() && !self.uvs.is_empty()
    }

    #[inline]
    pub fn tri_positions(&self, t: usize) -> [Vec3; 3] {
        let f = self.triangles[t];
        [
            self.positions[f[0] as usize],
            self.positions[f[1] as usize],
            self.positions[f[2] as usize],
        ]
    }

    /// Unnormalised face normal. Its length is twice the triangle area, which is
    /// the weight we want when accumulating vertex normals.
    #[inline]
    pub fn face_normal_weighted(&self, t: usize) -> Vec3 {
        let [a, b, c] = self.tri_positions(t);
        (b - a).cross(c - a)
    }

    #[inline]
    pub fn face_normal(&self, t: usize) -> Vec3 {
        self.face_normal_weighted(t).normalize_or_zero()
    }

    #[inline]
    pub fn face_area(&self, t: usize) -> f32 {
        self.face_normal_weighted(t).length() * 0.5
    }

    #[inline]
    pub fn face_centroid(&self, t: usize) -> Vec3 {
        let [a, b, c] = self.tri_positions(t);
        (a + b + c) / 3.0
    }

    pub fn bounds(&self) -> Aabb {
        let mut b = Aabb::EMPTY;
        for &p in &self.positions {
            b.grow(p);
        }
        b
    }

    pub fn total_area(&self) -> f32 {
        (0..self.triangle_count()).map(|t| self.face_area(t)).sum()
    }

    /// Mean triangle edge length, the natural default target for remeshing.
    pub fn mean_edge_length(&self) -> f32 {
        if self.triangles.is_empty() {
            return 0.0;
        }
        let mut sum = 0.0f64;
        for t in 0..self.triangle_count() {
            let [a, b, c] = self.tri_positions(t);
            sum += ((b - a).length() + (c - b).length() + (a - c).length()) as f64;
        }
        (sum / (self.triangles.len() as f64 * 3.0)) as f32
    }

    /// Rebuild `weld` and `weld_count`.
    ///
    /// `eps <= 0` welds only bit-identical positions, which is what glTF
    /// exporters actually produce when they split a seam. A positive `eps` snaps
    /// to a grid instead and also checks the 26 neighbouring cells, so points
    /// that straddle a cell boundary still merge. Use it for scans and for OBJ.
    pub fn rebuild_weld(&mut self, eps: f32) {
        let n = self.positions.len();
        self.weld = vec![u32::MAX; n];

        if eps <= 0.0 {
            let mut map: HashMap<[u32; 3], u32> = HashMap::with_capacity(n);
            let mut next = 0u32;
            for (i, p) in self.positions.iter().enumerate() {
                // Canonicalise -0.0 to 0.0 so the two spellings of zero collide.
                let key = [
                    (p.x + 0.0).to_bits(),
                    (p.y + 0.0).to_bits(),
                    (p.z + 0.0).to_bits(),
                ];
                let id = *map.entry(key).or_insert_with(|| {
                    let v = next;
                    next += 1;
                    v
                });
                self.weld[i] = id;
            }
            self.weld_count = next as usize;
            return;
        }

        let inv = 1.0 / eps;
        let cell = |p: Vec3| -> [i64; 3] {
            [
                (p.x * inv).floor() as i64,
                (p.y * inv).floor() as i64,
                (p.z * inv).floor() as i64,
            ]
        };

        // Cell to the representative render vertices living in it.
        let mut grid: HashMap<[i64; 3], Vec<u32>> = HashMap::with_capacity(n);
        let mut reps: Vec<Vec3> = Vec::new();
        let eps2 = eps * eps;

        for i in 0..n {
            let p = self.positions[i];
            let c = cell(p);
            let mut found = u32::MAX;

            'outer: for dz in -1..=1i64 {
                for dy in -1..=1i64 {
                    for dx in -1..=1i64 {
                        let key = [c[0] + dx, c[1] + dy, c[2] + dz];
                        if let Some(bucket) = grid.get(&key) {
                            for &r in bucket {
                                if reps[r as usize].distance_squared(p) <= eps2 {
                                    found = r;
                                    break 'outer;
                                }
                            }
                        }
                    }
                }
            }

            if found == u32::MAX {
                found = reps.len() as u32;
                reps.push(p);
                grid.entry(c).or_default().push(found);
            }
            self.weld[i] = found;
        }
        self.weld_count = reps.len();
    }

    /// Recompute vertex normals, respecting hard edges.
    ///
    /// Triangles are grouped into smoothing islands by flood filling across
    /// edges whose dihedral angle stays under `sharp_angle_deg`, then normals
    /// are accumulated per (welded point, island). Without the island split a
    /// cube comes out looking like a ball; without the weld step a seam shows up
    /// as a visible lighting crack.
    pub fn compute_normals(&mut self, sharp_angle_deg: f32) {
        let n = self.positions.len();
        if self.weld.len() != n {
            self.rebuild_weld(0.0);
        }
        self.normals = vec![Vec3::ZERO; n];
        if self.triangles.is_empty() {
            return;
        }

        let adj = Adjacency::build(self);
        let sharp = adj.sharp_edges(self, sharp_angle_deg);

        let mut islands = UnionFind::new(self.triangles.len());
        for (ei, e) in adj.edges.iter().enumerate() {
            if sharp[ei] {
                continue;
            }
            if let (Some(a), Some(b)) = (e.tri[0], e.tri[1]) {
                islands.union(a, b);
            }
        }

        let mut acc: HashMap<(u32, u32), Vec3> = HashMap::new();
        let mut tri_island = vec![0u32; self.triangles.len()];
        for (t, slot) in tri_island.iter_mut().enumerate() {
            let island = islands.find(t as u32);
            *slot = island;
            let nw = self.face_normal_weighted(t);
            for &c in &self.triangles[t] {
                let w = self.weld[c as usize];
                *acc.entry((w, island)).or_insert(Vec3::ZERO) += nw;
            }
        }

        for (t, &island) in tri_island.iter().enumerate() {
            let fallback = self.face_normal(t);
            for &c in &self.triangles[t] {
                let w = self.weld[c as usize];
                let v = acc
                    .get(&(w, island))
                    .copied()
                    .unwrap_or(fallback)
                    .normalize_or_zero();
                self.normals[c as usize] = if v == Vec3::ZERO { fallback } else { v };
            }
        }
    }

    /// Drop triangles that are degenerate or index the same point twice.
    ///
    /// Degenerate faces have no usable normal, break the BVH surface area
    /// heuristic and make quadric error metrics produce NaN, so they are removed
    /// on import rather than defended against everywhere else.
    pub fn remove_degenerate(&mut self) -> usize {
        let before = self.triangles.len();
        let weld = &self.weld;
        let positions = &self.positions;
        let mut keep = Vec::with_capacity(before);
        for (t, f) in self.triangles.iter().enumerate() {
            let (a, b, c) = (
                weld[f[0] as usize],
                weld[f[1] as usize],
                weld[f[2] as usize],
            );
            if a == b || b == c || a == c {
                continue;
            }
            let (pa, pb, pc) = (
                positions[f[0] as usize],
                positions[f[1] as usize],
                positions[f[2] as usize],
            );
            // Relative, not absolute: a fine mesh has genuinely tiny triangles,
            // and a fixed epsilon would delete perfectly good geometry.
            let cross = (pb - pa).cross(pc - pa);
            let reach = (pb - pa)
                .length_squared()
                .max((pc - pa).length_squared())
                .max((pc - pb).length_squared());
            let area2 = cross.length_squared();
            // NaN counts as degenerate, hence the explicit finiteness check
            // rather than a single negated comparison.
            if !area2.is_finite() || area2 <= reach * reach * 1e-12 {
                continue;
            }
            keep.push(t);
        }
        if keep.len() == before {
            return 0;
        }
        self.triangles = keep.iter().map(|&t| self.triangles[t]).collect();
        self.tri_material = keep.iter().map(|&t| self.tri_material[t]).collect();
        before - self.triangles.len()
    }

    /// Drop render vertices no triangle references, remapping indices.
    pub fn compact(&mut self) {
        let n = self.positions.len();
        let mut used = vec![false; n];
        for f in &self.triangles {
            for &c in f {
                used[c as usize] = true;
            }
        }
        let mut remap = vec![u32::MAX; n];
        let mut next = 0u32;
        for i in 0..n {
            if used[i] {
                remap[i] = next;
                next += 1;
            }
        }
        if next as usize == n {
            return;
        }

        let pick = |src: &Vec<Vec3>| -> Vec<Vec3> {
            let mut out = vec![Vec3::ZERO; next as usize];
            for i in 0..n {
                if remap[i] != u32::MAX {
                    out[remap[i] as usize] = src[i];
                }
            }
            out
        };
        self.positions = pick(&self.positions);
        if self.normals.len() == n {
            self.normals = pick(&self.normals);
        }
        if self.uvs.len() == n {
            let mut out = vec![Vec2::ZERO; next as usize];
            for i in 0..n {
                if remap[i] != u32::MAX {
                    out[remap[i] as usize] = self.uvs[i];
                }
            }
            self.uvs = out;
        }
        if self.weld.len() == n {
            let mut out = vec![0u32; next as usize];
            for i in 0..n {
                if remap[i] != u32::MAX {
                    out[remap[i] as usize] = self.weld[i];
                }
            }
            self.weld = out;
        }
        for f in &mut self.triangles {
            for c in f.iter_mut() {
                *c = remap[*c as usize];
            }
        }
    }

    /// Append another mesh, offsetting indices and material references.
    pub fn append(&mut self, other: &Mesh) {
        let vbase = self.positions.len() as u32;
        let mbase = self.materials.len() as u32;
        let ibase = self.images.len();

        self.positions.extend_from_slice(&other.positions);
        self.normals.extend_from_slice(&other.normals);
        if self.uvs.len() == vbase as usize && other.has_uvs() {
            self.uvs.extend_from_slice(&other.uvs);
        } else if !other.uvs.is_empty() || !self.uvs.is_empty() {
            // Mixed UV coverage: pad both sides so the invariant holds.
            self.uvs.resize(vbase as usize, Vec2::ZERO);
            self.uvs
                .extend(other.uvs.iter().copied().chain(std::iter::repeat(Vec2::ZERO)).take(other.positions.len()));
        }
        self.triangles
            .extend(other.triangles.iter().map(|f| [f[0] + vbase, f[1] + vbase, f[2] + vbase]));
        self.tri_material
            .extend(other.tri_material.iter().map(|m| m + mbase));

        self.images.extend(other.images.iter().cloned());
        self.materials.extend(other.materials.iter().map(|m| {
            let mut m = m.clone();
            m.base_color_texture = m.base_color_texture.map(|i| i + ibase);
            m.normal_texture = m.normal_texture.map(|i| i + ibase);
            m
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unit cube, 12 triangles, corners duplicated per face the way an exporter
    /// would write them. Exercises weld, sharp edges and normals at once.
    fn cube() -> Mesh {
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
            [0, 1, 2, 3],
            [5, 4, 7, 6],
            [4, 0, 3, 7],
            [1, 5, 6, 2],
            [4, 5, 1, 0],
            [3, 2, 6, 7],
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
    fn weld_collapses_duplicated_corners() {
        let m = cube();
        assert_eq!(m.positions.len(), 24, "six faces of four corners");
        assert_eq!(m.weld_count, 8, "a cube has eight distinct points");
    }

    #[test]
    fn hard_edges_survive_normal_computation() {
        let mut m = cube();
        m.compute_normals(30.0);
        // Every normal must point straight along an axis. A cube whose corners
        // were smoothed across the 90 degree edges would give diagonal normals.
        for n in &m.normals {
            let a = n.abs();
            let max = a.x.max(a.y).max(a.z);
            assert!((max - 1.0).abs() < 1e-4, "normal {n:?} is not axis aligned");
        }
    }

    #[test]
    fn smooth_angle_above_ninety_degrees_rounds_the_cube() {
        let mut m = cube();
        m.compute_normals(120.0);
        // With every edge treated as smooth, corner normals become diagonals.
        let n = m.normals[0].abs();
        assert!(n.x > 0.4 && n.y > 0.4 && n.z > 0.4, "expected a corner normal, got {n:?}");
    }

    #[test]
    fn bounds_and_area_are_exact_for_a_unit_cube() {
        let m = cube();
        let b = m.bounds();
        assert_eq!(b.min, Vec3::splat(-1.0));
        assert_eq!(b.max, Vec3::splat(1.0));
        // Six faces of a 2x2 square.
        assert!((m.total_area() - 24.0).abs() < 1e-4);
    }

    #[test]
    fn degenerate_triangles_are_removed() {
        let mut m = cube();
        let v = m.positions.len() as u32;
        m.positions.push(Vec3::ZERO);
        m.positions.push(Vec3::ZERO);
        m.positions.push(Vec3::ZERO);
        m.triangles.push([v, v + 1, v + 2]);
        m.tri_material.push(0);
        m.rebuild_weld(0.0);
        assert_eq!(m.remove_degenerate(), 1);
        assert_eq!(m.triangle_count(), 12);
    }

    #[test]
    fn eps_weld_merges_points_across_cell_boundaries() {
        let mut m = Mesh::default();
        // Two points a hair apart but on opposite sides of any grid line at 0.
        m.positions.push(Vec3::new(-1e-6, 0.0, 0.0));
        m.positions.push(Vec3::new(1e-6, 0.0, 0.0));
        m.rebuild_weld(1e-3);
        assert_eq!(m.weld_count, 1);
        assert_eq!(m.weld[0], m.weld[1]);
    }

    #[test]
    fn image_sampling_is_bilinear() {
        let mut img = Image::new(2, 1);
        img.rgba = vec![0, 0, 0, 255, 255, 255, 255, 255];
        let mid = img.sample(Vec2::new(0.5, 0.5));
        assert!((mid[0] - 0.5).abs() < 0.01, "got {mid:?}");
    }
}
