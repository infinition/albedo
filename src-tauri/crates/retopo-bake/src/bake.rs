//! High to low poly texture transfer.
//!
//! For every texel of the new atlas: find the point on the low poly it belongs
//! to, fire a ray from a cage above that point down into the surface, and read
//! the colour off whatever high poly triangle it lands on. Nothing about the
//! original UV layout is reused, which is exactly why the result cannot tear the
//! way carrying the old coordinates through a decimation does.
//!
//! Two passes. Rasterisation is cheap and runs once, serially, filling a texel
//! to triangle map. Sampling is expensive and embarrassingly parallel, so it
//! runs over that map with rayon.

use anyhow::{bail, Result};
use glam::{Vec2, Vec3};
use retopo_core::{Bvh, Image, Material, Mesh};
use rayon::prelude::*;

use crate::atlas::{self, AtlasOptions};

#[derive(Clone, Debug)]
pub struct BakeOptions {
    pub atlas: AtlasOptions,
    /// How far above the surface the ray starts, as a share of the bounding box
    /// diagonal. Too small and rays miss anything that pokes out of the low
    /// poly; too large and they reach across a gap and hit the wrong part.
    pub cage_out: f32,
    /// How far below the surface the ray keeps looking.
    pub cage_in: f32,
    /// Also produce a tangent space normal map from the high poly geometry.
    pub bake_normal: bool,
    /// Also produce a metallic-roughness map, read off the high poly.
    ///
    /// Without it the whole low poly inherits one pair of scalars, so a gold
    /// ring on a wooden handle comes out as matte wood: the metal is simply
    /// gone. Albedo alone is not a material.
    pub bake_metallic_roughness: bool,
    /// Also produce an emissive map, for anything on the high poly that gives
    /// off light rather than reflecting it.
    pub bake_emissive: bool,
    /// Also produce an ambient occlusion map.
    pub bake_ao: bool,
    /// Rays per texel for occlusion. Sixteen is enough to read; more is only
    /// worth it if the result is going into a final render.
    pub ao_samples: u32,
    /// How far occlusion looks, as a share of the bounding box diagonal.
    /// Short means creases only, long means the whole silhouette shades itself.
    pub ao_distance: f32,
    /// Texels of bleed painted outward from every chart, so bilinear filtering
    /// and mip levels never pull the background into a seam.
    pub dilate: u32,
}

impl Default for BakeOptions {
    fn default() -> Self {
        Self {
            atlas: AtlasOptions::default(),
            cage_out: 0.02,
            cage_in: 0.02,
            bake_normal: true,
            bake_metallic_roughness: true,
            bake_emissive: true,
            bake_ao: false,
            ao_samples: 16,
            ao_distance: 0.15,
            dilate: 8,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct BakeStats {
    pub charts: usize,
    pub utilisation: f32,
    pub texels_total: usize,
    pub texels_covered: usize,
    /// Texels whose ray found the high poly.
    pub hits: usize,
    /// Texels that missed and fell back to the nearest point on the surface.
    /// A large number means the cage is too tight for this pair of meshes.
    pub misses: usize,
    /// Texels nothing defensible could be sampled for, filled by dilation.
    pub unpainted: usize,
    /// Which maps came out of this bake, for the interface to list.
    pub has_normal: bool,
    pub has_ao: bool,
    pub has_metallic_roughness: bool,
    pub has_emissive: bool,
}

pub struct BakeResult {
    /// The low poly, re-indexed with the new atlas and carrying the baked maps.
    pub mesh: Mesh,
    pub stats: BakeStats,
}

pub fn bake(
    low: &Mesh,
    high: &Mesh,
    opts: &BakeOptions,
    progress: &mut dyn FnMut(f32),
) -> Result<BakeResult> {
    if low.triangles.is_empty() {
        bail!("the low poly has no triangles");
    }
    if high.triangles.is_empty() {
        bail!("the high poly has no triangles");
    }

    progress(0.02);
    let atlas = atlas::unwrap(low, &opts.atlas);
    if atlas.triangles.is_empty() {
        bail!("the atlas came out empty");
    }
    let res = opts.atlas.resolution.max(4);
    tracing::debug!(
        charts = atlas.chart_count,
        utilisation = atlas.utilisation,
        "atlas built"
    );

    progress(0.10);
    let bvh = Bvh::build(high);
    let diagonal = high.bounds().diagonal().max(1e-6);
    let out_dist = (opts.cage_out.max(0.0) * diagonal).max(1e-6);
    let in_dist = (opts.cage_in.max(0.0) * diagonal).max(1e-6);
    let ao_dist = (opts.ao_distance.max(0.0) * diagonal).max(1e-6);

    progress(0.16);
    let coverage = rasterise(&atlas, res);
    let covered = coverage.iter().filter(|c| c.is_some()).count();

    progress(0.22);
    let tangents = tangent_frames(&atlas);

    // Sampling: one independent job per texel.
    let sampled: Vec<Option<Texel>> = coverage
        .par_iter()
        .map(|slot| {
            let hit = slot.as_ref()?;
            Some(shade(
                hit, &atlas, &tangents, high, &bvh, out_dist, in_dist, ao_dist, opts,
            ))
        })
        .collect();

    progress(0.80);
    let hits = sampled.iter().flatten().filter(|t| t.direct).count();
    let unpainted = sampled.iter().flatten().filter(|t| t.unpainted).count();
    let misses = sampled.iter().flatten().count() - hits - unpainted;

    let mut albedo = Image::new(res, res);
    let mut normal = opts.bake_normal.then(|| Image::new(res, res));
    let mut ao = opts.bake_ao.then(|| Image::new(res, res));
    let mut mr = opts.bake_metallic_roughness.then(|| Image::new(res, res));
    let mut emissive = opts.bake_emissive.then(|| Image::new(res, res));
    for (i, texel) in sampled.iter().enumerate() {
        let Some(t) = texel else { continue };
        if t.unpainted {
            continue;
        }
        albedo.rgba[i * 4..i * 4 + 4].copy_from_slice(&t.albedo);
        if let Some(n) = normal.as_mut() {
            n.rgba[i * 4..i * 4 + 4].copy_from_slice(&t.normal);
        }
        if let Some(a) = ao.as_mut() {
            a.rgba[i * 4..i * 4 + 4].copy_from_slice(&t.ao);
        }
        if let Some(m) = mr.as_mut() {
            m.rgba[i * 4..i * 4 + 4].copy_from_slice(&t.metallic_roughness);
        }
        if let Some(e) = emissive.as_mut() {
            e.rgba[i * 4..i * 4 + 4].copy_from_slice(&t.emissive);
        }
    }

    progress(0.88);
    let mask: Vec<bool> = sampled
        .iter()
        .map(|t| t.as_ref().is_some_and(|t| !t.unpainted))
        .collect();
    dilate(&mut albedo, &mask, opts.dilate);
    if let Some(n) = normal.as_mut() {
        dilate(n, &mask, opts.dilate);
    }
    if let Some(a) = ao.as_mut() {
        dilate(a, &mask, opts.dilate);
    }
    if let Some(m) = mr.as_mut() {
        dilate(m, &mask, opts.dilate);
    }
    if let Some(e) = emissive.as_mut() {
        dilate(e, &mask, opts.dilate);
    }

    progress(0.95);
    let mesh = assemble(&atlas, low, albedo, normal, ao, mr, emissive);
    progress(1.0);

    Ok(BakeResult {
        mesh,
        stats: BakeStats {
            charts: atlas.chart_count,
            utilisation: atlas.utilisation,
            texels_total: (res * res) as usize,
            texels_covered: covered,
            hits,
            misses,
            unpainted,
            has_normal: opts.bake_normal,
            has_ao: opts.bake_ao,
            has_metallic_roughness: opts.bake_metallic_roughness,
            has_emissive: opts.bake_emissive,
        },
    })
}

/* ------------------------------------------------------------ rasterisation */

/// Which triangle of the atlas owns each texel, and where inside it.
#[derive(Clone, Copy)]
struct Cover {
    tri: u32,
    bary: Vec3,
}

fn rasterise(atlas: &atlas::Atlas, res: u32) -> Vec<Option<Cover>> {
    let mut out: Vec<Option<Cover>> = vec![None; (res * res) as usize];
    let r = res as f32;

    for (t, f) in atlas.triangles.iter().enumerate() {
        let uv: [Vec2; 3] = [
            atlas.uvs[f[0] as usize] * r,
            atlas.uvs[f[1] as usize] * r,
            atlas.uvs[f[2] as usize] * r,
        ];
        let lo = uv[0].min(uv[1]).min(uv[2]);
        let hi = uv[0].max(uv[1]).max(uv[2]);
        // One texel of slack each way: a triangle that only clips a corner of a
        // texel still deserves it, and the dilation pass cleans up the rest.
        let x0 = (lo.x.floor() as i64 - 1).max(0) as u32;
        let y0 = (lo.y.floor() as i64 - 1).max(0) as u32;
        let x1 = ((hi.x.ceil() as i64) + 1).min(res as i64) as u32;
        let y1 = ((hi.y.ceil() as i64) + 1).min(res as i64) as u32;

        let area = (uv[1] - uv[0]).perp_dot(uv[2] - uv[0]);
        if area.abs() < 1e-12 {
            continue;
        }
        let inv = 1.0 / area;

        for y in y0..y1 {
            for x in x0..x1 {
                let p = Vec2::new(x as f32 + 0.5, y as f32 + 0.5);
                let w1 = (p - uv[0]).perp_dot(uv[2] - uv[0]) * inv;
                let w2 = (uv[1] - uv[0]).perp_dot(p - uv[0]) * inv;
                let w0 = 1.0 - w1 - w2;
                // A small negative tolerance keeps the texels straddling a
                // triangle border, which is where seams would otherwise open.
                const EDGE: f32 = -0.5;
                if w0 < EDGE || w1 < EDGE || w2 < EDGE {
                    continue;
                }
                let slot = &mut out[(y * res + x) as usize];
                let bary = Vec3::new(w0, w1, w2);
                // Inside beats straddling: a texel fully covered by one triangle
                // must not be stolen by a neighbour that merely grazes it.
                let inside = w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0;
                match slot {
                    Some(existing) if !inside => {
                        let _ = existing;
                    }
                    _ => {
                        *slot = Some(Cover {
                            tri: t as u32,
                            bary,
                        })
                    }
                }
            }
        }
    }
    out
}

/* ---------------------------------------------------------------- sampling */

struct Texel {
    albedo: [u8; 4],
    normal: [u8; 4],
    ao: [u8; 4],
    /// glTF packing: roughness in green, metallic in blue.
    metallic_roughness: [u8; 4],
    emissive: [u8; 4],
    /// False when the ray missed and the nearest surface point was used instead.
    direct: bool,
    /// True when nothing could be sampled and dilation should fill this texel.
    unpainted: bool,
}

impl Texel {
    const UNPAINTED: Texel = Texel {
        albedo: [0, 0, 0, 0],
        normal: [128, 128, 255, 0],
        ao: [255, 255, 255, 0],
        metallic_roughness: [0, 255, 0, 0],
        emissive: [0, 0, 0, 0],
        direct: false,
        unpainted: true,
    };
}

#[allow(clippy::too_many_arguments)]
fn shade(
    cover: &Cover,
    atlas: &atlas::Atlas,
    tangents: &[Vec3],
    high: &Mesh,
    bvh: &Bvh,
    out_dist: f32,
    in_dist: f32,
    ao_dist: f32,
    opts: &BakeOptions,
) -> Texel {
    let f = atlas.triangles[cover.tri as usize];
    let b = cover.bary;
    let position = atlas.positions[f[0] as usize] * b.x
        + atlas.positions[f[1] as usize] * b.y
        + atlas.positions[f[2] as usize] * b.z;
    let normal = (atlas.normals[f[0] as usize] * b.x
        + atlas.normals[f[1] as usize] * b.y
        + atlas.normals[f[2] as usize] * b.z)
        .normalize_or_zero();
    let normal = if normal == Vec3::ZERO { Vec3::Y } else { normal };

    // Search outward and inward from the surface itself, and keep whichever
    // valid hit is nearest.
    //
    // Starting from an inflated cage instead is the textbook recipe, and it is
    // wrong whenever another part of the model passes closer than the cage: the
    // ray then begins *inside* that part and reads its back face. On a satchel
    // that is the dark lining behind the flap, and it paints a black hole in the
    // middle of the bake. Starting on the surface cannot make that mistake,
    // because the low poly is by construction close to the high poly there.
    let consistent = |h: &retopo_core::RayHit| {
        high.face_normal(h.tri as usize).dot(normal) > 0.0
    };
    let bias = (out_dist + in_dist) * 1e-3;
    let outward = bvh
        .raycast(position + normal * bias, normal, 0.0, out_dist)
        .filter(consistent);
    let inward = bvh
        .raycast(position - normal * bias, -normal, 0.0, in_dist)
        .filter(consistent);

    let nearest = match (outward, inward) {
        (Some(a), Some(b)) => Some(if a.t <= b.t { a } else { b }),
        (a, b) => a.or(b),
    };

    let (tri, bary, direct) = match nearest {
        Some(h) => (h.tri, h.bary, true),
        // The fallback has to answer to the same normal test. Without it, a
        // texel that missed lands on whatever surface happens to be closest,
        // which is usually the one facing the other way.
        None => match bvh
            .closest_point(position)
            .filter(|c| high.face_normal(c.tri as usize).dot(normal) > 0.0)
        {
            Some(c) => (c.tri, c.bary, false),
            // Nothing defensible to sample. Left unpainted on purpose so the
            // dilation pass bleeds real neighbouring colour into the gap,
            // instead of stamping a guess that is visibly wrong.
            None => return Texel::UNPAINTED,
        },
    };

    let albedo = sample_albedo(high, tri, bary);

    let normal_texel = if opts.bake_normal {
        let hf = high.triangles[tri as usize];
        let hn = if high.normals.len() == high.positions.len() {
            (high.normals[hf[0] as usize] * bary.x
                + high.normals[hf[1] as usize] * bary.y
                + high.normals[hf[2] as usize] * bary.z)
                .normalize_or_zero()
        } else {
            high.face_normal(tri as usize)
        };
        encode_tangent_normal(hn, normal, tangents, &f, b)
    } else {
        [128, 128, 255, 255]
    };

    let ao_texel = if opts.bake_ao {
        // Occlusion is measured at the point the ray landed on, not at the low
        // poly surface: the detail that casts the shadow only exists there.
        let point = high_point(high, tri, bary);
        let n = high.face_normal(tri as usize);
        let n = if n.dot(normal) < 0.0 { -n } else { n };
        let visible = occlusion(bvh, point, n, opts.ao_samples, ao_dist);
        let v = (visible.clamp(0.0, 1.0) * 255.0) as u8;
        [v, v, v, 255]
    } else {
        [255, 255, 255, 255]
    };

    let mr_texel = if opts.bake_metallic_roughness {
        sample_metallic_roughness(high, tri, bary)
    } else {
        [0, 255, 0, 255]
    };

    let emissive_texel = if opts.bake_emissive {
        sample_emissive(high, tri, bary)
    } else {
        [0, 0, 0, 255]
    };

    Texel {
        albedo,
        normal: normal_texel,
        ao: ao_texel,
        metallic_roughness: mr_texel,
        emissive: emissive_texel,
        direct,
        unpainted: false,
    }
}

/// Emitted colour at a point on the high poly.
fn sample_emissive(high: &Mesh, tri: u32, bary: Vec3) -> [u8; 4] {
    let material = high
        .tri_material
        .get(tri as usize)
        .and_then(|&m| high.materials.get(m as usize));
    let mut colour = material.map(|m| m.emissive).unwrap_or([0.0; 3]);

    if let Some(image) = material
        .and_then(|m| m.emissive_texture)
        .and_then(|i| high.images.get(i))
    {
        if high.has_uvs() {
            let f = high.triangles[tri as usize];
            let uv = high.uvs[f[0] as usize] * bary.x
                + high.uvs[f[1] as usize] * bary.y
                + high.uvs[f[2] as usize] * bary.z;
            let uv = material.map(|m| m.emissive_uv.apply(uv)).unwrap_or(uv);
            let texel = image.sample(uv);
            for k in 0..3 {
                colour[k] *= texel[k];
            }
        }
    }
    [
        (colour[0].clamp(0.0, 1.0) * 255.0) as u8,
        (colour[1].clamp(0.0, 1.0) * 255.0) as u8,
        (colour[2].clamp(0.0, 1.0) * 255.0) as u8,
        255,
    ]
}

/// Roughness and metallic at a point on the high poly, in glTF's packing.
///
/// Read the same way albedo is: the material's factors multiplied by its map
/// where there is one. A model whose metal lives in a texture rather than a
/// factor is the normal case, not the exception.
fn sample_metallic_roughness(high: &Mesh, tri: u32, bary: Vec3) -> [u8; 4] {
    let material = high
        .tri_material
        .get(tri as usize)
        .and_then(|&m| high.materials.get(m as usize));

    let mut roughness = material.map(|m| m.roughness).unwrap_or(1.0);
    let mut metallic = material.map(|m| m.metallic).unwrap_or(0.0);

    if let Some(image) = material
        .and_then(|m| m.metallic_roughness_texture)
        .and_then(|i| high.images.get(i))
    {
        if high.has_uvs() {
            let f = high.triangles[tri as usize];
            let uv = high.uvs[f[0] as usize] * bary.x
                + high.uvs[f[1] as usize] * bary.y
                + high.uvs[f[2] as usize] * bary.z;
            let uv = material
                .map(|m| m.metallic_roughness_uv.apply(uv))
                .unwrap_or(uv);
            let texel = image.sample(uv);
            roughness *= texel[1];
            metallic *= texel[2];
        }
    }
    [
        0,
        (roughness.clamp(0.0, 1.0) * 255.0) as u8,
        (metallic.clamp(0.0, 1.0) * 255.0) as u8,
        255,
    ]
}

fn high_point(high: &Mesh, tri: u32, bary: Vec3) -> Vec3 {
    let f = high.triangles[tri as usize];
    high.positions[f[0] as usize] * bary.x
        + high.positions[f[1] as usize] * bary.y
        + high.positions[f[2] as usize] * bary.z
}

/// Share of a cosine weighted hemisphere that is not blocked.
///
/// The sequence is deterministic, so two bakes of the same model give the same
/// map. Random sampling would make every run differ slightly, which is
/// unpleasant when you are comparing two settings.
fn occlusion(bvh: &Bvh, point: Vec3, normal: Vec3, samples: u32, distance: f32) -> f32 {
    let samples = samples.max(1);
    let (tangent, bitangent) = basis(normal);
    // Lift off the surface, or every ray hits the triangle it started on.
    let origin = point + normal * distance * 1e-3;

    let mut open = 0u32;
    for i in 0..samples {
        // Hammersley: index over count, and the bit-reversed index.
        let u1 = (i as f32 + 0.5) / samples as f32;
        let u2 = radical_inverse(i);
        // Cosine weighted, so the samples cluster where the light matters.
        let r = u1.sqrt();
        let phi = std::f32::consts::TAU * u2;
        let dir = tangent * (r * phi.cos()) + bitangent * (r * phi.sin())
            + normal * (1.0 - u1).max(0.0).sqrt();
        if !bvh.occluded(origin, dir.normalize_or_zero(), 0.0, distance) {
            open += 1;
        }
    }
    open as f32 / samples as f32
}

fn radical_inverse(mut i: u32) -> f32 {
    i = i.rotate_right(16);
    i = ((i & 0x5555_5555) << 1) | ((i & 0xAAAA_AAAA) >> 1);
    i = ((i & 0x3333_3333) << 2) | ((i & 0xCCCC_CCCC) >> 2);
    i = ((i & 0x0F0F_0F0F) << 4) | ((i & 0xF0F0_F0F0) >> 4);
    i = ((i & 0x00FF_00FF) << 8) | ((i & 0xFF00_FF00) >> 8);
    i as f32 * 2.328_306_4e-10
}

/// An orthonormal pair spanning the plane with this normal.
fn basis(n: Vec3) -> (Vec3, Vec3) {
    let a = n.abs();
    let axis = if a.x <= a.y && a.x <= a.z {
        Vec3::X
    } else if a.y <= a.z {
        Vec3::Y
    } else {
        Vec3::Z
    };
    let t = n.cross(axis).normalize_or_zero();
    let t = if t == Vec3::ZERO { Vec3::X } else { t };
    (t, n.cross(t).normalize_or_zero())
}

fn sample_albedo(high: &Mesh, tri: u32, bary: Vec3) -> [u8; 4] {
    let material = high
        .tri_material
        .get(tri as usize)
        .and_then(|&m| high.materials.get(m as usize));
    let factor = material.map(|m| m.base_color).unwrap_or([0.8, 0.8, 0.8, 1.0]);

    let texture = material
        .and_then(|m| m.base_color_texture)
        .and_then(|i| high.images.get(i));

    let mut colour = factor;
    if let Some(image) = texture {
        if high.has_uvs() {
            let f = high.triangles[tri as usize];
            let uv = high.uvs[f[0] as usize] * bary.x
                + high.uvs[f[1] as usize] * bary.y
                + high.uvs[f[2] as usize] * bary.z;
            // The material may remap the coordinates before sampling. Skipping
            // this reads a fraction of the texture, smeared over the model.
            let uv = material
                .map(|m| m.base_color_uv.apply(uv))
                .unwrap_or(uv);
            let texel = image.sample(uv);
            for k in 0..4 {
                colour[k] *= texel[k];
            }
        }
    }
    [
        (colour[0].clamp(0.0, 1.0) * 255.0) as u8,
        (colour[1].clamp(0.0, 1.0) * 255.0) as u8,
        (colour[2].clamp(0.0, 1.0) * 255.0) as u8,
        (colour[3].clamp(0.0, 1.0) * 255.0) as u8,
    ]
}

fn encode_tangent_normal(
    high_normal: Vec3,
    low_normal: Vec3,
    tangents: &[Vec3],
    face: &[u32; 3],
    bary: Vec3,
) -> [u8; 4] {
    let t = (tangents[face[0] as usize] * bary.x
        + tangents[face[1] as usize] * bary.y
        + tangents[face[2] as usize] * bary.z)
        .normalize_or_zero();
    // Gram-Schmidt against the interpolated normal, so the frame stays
    // orthonormal even where the tangents were averaged across a corner.
    let t = (t - low_normal * low_normal.dot(t)).normalize_or_zero();
    let t = if t == Vec3::ZERO {
        low_normal.any_orthonormal_vector()
    } else {
        t
    };
    let b = low_normal.cross(t);

    let local = Vec3::new(high_normal.dot(t), high_normal.dot(b), high_normal.dot(low_normal));
    let local = local.normalize_or_zero();
    [
        ((local.x * 0.5 + 0.5).clamp(0.0, 1.0) * 255.0) as u8,
        ((local.y * 0.5 + 0.5).clamp(0.0, 1.0) * 255.0) as u8,
        ((local.z * 0.5 + 0.5).clamp(0.0, 1.0) * 255.0) as u8,
        255,
    ]
}

/// Per vertex tangents from the atlas coordinates, Lengyel's averaging.
///
/// Not MikkTSpace. For a normal map to be pixel exact in Blender the basis used
/// at bake time must match the one used at render time, and Blender uses
/// MikkTSpace. The difference shows up as a faint shading error on strongly
/// stretched triangles, which the chart angle bound already keeps small.
fn tangent_frames(atlas: &atlas::Atlas) -> Vec<Vec3> {
    let mut acc = vec![Vec3::ZERO; atlas.positions.len()];
    for f in &atlas.triangles {
        let (p0, p1, p2) = (
            atlas.positions[f[0] as usize],
            atlas.positions[f[1] as usize],
            atlas.positions[f[2] as usize],
        );
        let (u0, u1, u2) = (
            atlas.uvs[f[0] as usize],
            atlas.uvs[f[1] as usize],
            atlas.uvs[f[2] as usize],
        );
        let e1 = p1 - p0;
        let e2 = p2 - p0;
        let d1 = u1 - u0;
        let d2 = u2 - u0;
        let det = d1.x * d2.y - d2.x * d1.y;
        if det.abs() < 1e-20 {
            continue;
        }
        let t = (e1 * d2.y - e2 * d1.y) / det;
        if !t.is_finite() {
            continue;
        }
        for &c in f {
            acc[c as usize] += t;
        }
    }
    acc.iter().map(|t| t.normalize_or_zero()).collect()
}

/* --------------------------------------------------------------- dilation */

/// Bleed covered texels outward.
///
/// Without this, every chart border samples the empty background as soon as the
/// GPU filters between texels or drops to a lower mip, and every seam turns into
/// a dark line.
fn dilate(image: &mut Image, mask: &[bool], rounds: u32) {
    if rounds == 0 {
        return;
    }
    let w = image.width as i64;
    let h = image.height as i64;
    let mut filled = mask.to_vec();

    for _ in 0..rounds {
        let mut next = filled.clone();
        let mut writes: Vec<(usize, [u8; 4])> = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) as usize;
                if filled[i] {
                    continue;
                }
                let mut sum = [0u32; 4];
                let mut n = 0u32;
                for dy in -1..=1i64 {
                    for dx in -1..=1i64 {
                        let (nx, ny) = (x + dx, y + dy);
                        if nx < 0 || ny < 0 || nx >= w || ny >= h {
                            continue;
                        }
                        let j = (ny * w + nx) as usize;
                        if !filled[j] {
                            continue;
                        }
                        for (k, channel) in sum.iter_mut().enumerate() {
                            *channel += image.rgba[j * 4 + k] as u32;
                        }
                        n += 1;
                    }
                }
                if let Some(n) = std::num::NonZeroU32::new(n) {
                    let mean = sum.map(|c| (c / n.get()) as u8);
                    writes.push((i, mean));
                    next[i] = true;
                }
            }
        }
        if writes.is_empty() {
            break;
        }
        for (i, c) in writes {
            image.rgba[i * 4..i * 4 + 4].copy_from_slice(&c);
        }
        filled = next;
    }
}

/* ----------------------------------------------------------------- output */

fn assemble(
    atlas: &atlas::Atlas,
    low: &Mesh,
    albedo: Image,
    normal: Option<Image>,
    ao: Option<Image>,
    metallic_roughness: Option<Image>,
    emissive: Option<Image>,
) -> Mesh {
    let mut images = vec![albedo];
    let normal_index = normal.map(|n| {
        images.push(n);
        images.len() - 1
    });
    let ao_index = ao.map(|a| {
        images.push(a);
        images.len() - 1
    });
    let mr_index = metallic_roughness.map(|m| {
        images.push(m);
        images.len() - 1
    });
    // An all black emissive map is bytes nobody needs. Only kept when something
    // on the model actually emits.
    let emissive_index = emissive.filter(|e| e.rgba.chunks_exact(4).any(|p| p[0] | p[1] | p[2] > 0))
        .map(|e| {
            images.push(e);
            images.len() - 1
        });

    let mut mesh = Mesh {
        positions: atlas.positions.clone(),
        normals: atlas.normals.clone(),
        uvs: atlas.uvs.clone(),
        triangles: atlas.triangles.clone(),
        tri_material: vec![0; atlas.triangles.len()],
        weld: Vec::new(),
        weld_count: 0,
        materials: vec![Material {
            name: "retopo_baked".into(),
            base_color: [1.0, 1.0, 1.0, 1.0],
            base_color_texture: Some(0),
            // The bake writes its own atlas, so the coordinates are already
            // final: any transform the source carried has been applied.
            base_color_uv: Default::default(),
            normal_texture: normal_index,
            normal_uv: Default::default(),
            occlusion_texture: ao_index,
            occlusion_uv: Default::default(),
            metallic_roughness_texture: mr_index,
            metallic_roughness_uv: Default::default(),
            emissive_texture: emissive_index,
            emissive: if emissive_index.is_some() {
                // The factor multiplies the map, so it has to be one or the
                // values just measured get scaled away.
                [1.0, 1.0, 1.0]
            } else {
                [0.0, 0.0, 0.0]
            },
            // Alpha rides in the albedo map's fourth channel, which is where
            // glTF looks for it, so the mode has to come across with it.
            alpha_mode: low
                .materials
                .first()
                .map(|m| m.alpha_mode)
                .unwrap_or_default(),
            alpha_cutoff: low.materials.first().map(|m| m.alpha_cutoff).unwrap_or(0.5),
            // glTF multiplies these factors by the map. With a baked map they
            // must be one, or the values just measured get scaled down again.
            // Without a map they are the only thing left, so the first source
            // material's pair is the least wrong carry over.
            metallic: if mr_index.is_some() {
                1.0
            } else {
                low.materials.first().map(|m| m.metallic).unwrap_or(0.0)
            },
            roughness: if mr_index.is_some() {
                1.0
            } else {
                low.materials.first().map(|m| m.roughness).unwrap_or(0.8)
            },
            double_sided: low.materials.iter().any(|m| m.double_sided),
            ..Material::default()
        }],
        images,
        // A baked mesh is built from the low poly's atlas, not read from a
        // file, so there is no source triangle to point back at.
        from_source: Vec::new(),
    };
    mesh.rebuild_weld(0.0);
    mesh
}

#[cfg(test)]
mod tests {
    use super::*;
    use retopo_core::mesh::Material as CoreMaterial;

    /// A sphere with a checkerboard albedo, so a bad bake is visible in the
    /// numbers rather than only to the eye.
    fn textured_sphere(segments: usize, rings: usize, radius: f32) -> Mesh {
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
                    Vec3::new(theta.sin() * phi.cos(), theta.cos(), theta.sin() * phi.sin())
                };
                m.positions.push(p * radius);
                m.uvs.push(Vec2::new(
                    s as f32 / segments as f32,
                    r as f32 / rings as f32,
                ));
            }
        }
        let idx = |s: usize, r: usize| (r * (segments + 1) + s) as u32;
        for r in 0..rings {
            for s in 0..segments {
                m.triangles.push([idx(s, r), idx(s + 1, r), idx(s + 1, r + 1)]);
                m.triangles.push([idx(s, r), idx(s + 1, r + 1), idx(s, r + 1)]);
                m.tri_material.push(0);
                m.tri_material.push(0);
            }
        }

        // Red and green checks, eight by eight.
        let size = 128u32;
        let mut img = Image::new(size, size);
        for y in 0..size {
            for x in 0..size {
                let on = ((x / 16) + (y / 16)) % 2 == 0;
                let i = ((y * size + x) * 4) as usize;
                img.rgba[i] = if on { 255 } else { 0 };
                img.rgba[i + 1] = if on { 0 } else { 255 };
                img.rgba[i + 2] = 0;
                img.rgba[i + 3] = 255;
            }
        }
        m.images.push(img);
        m.materials.push(CoreMaterial {
            name: "checks".into(),
            base_color_texture: Some(0),
            ..CoreMaterial::default()
        });

        m.rebuild_weld(0.0);
        m.remove_degenerate();
        m.compact();
        m.rebuild_weld(0.0);
        m.compute_normals(40.0);
        m
    }

    /// Resolve a map through its material slot, not its index in the list.
    /// Addressing by position broke the moment a fourth map was added, which is
    /// exactly the kind of coupling a test should not have.
    fn map_of(mesh: &Mesh, slot: fn(&retopo_core::Material) -> Option<usize>) -> &Image {
        let i = slot(&mesh.materials[0]).expect("that map was not produced");
        &mesh.images[i]
    }

    fn small_opts() -> BakeOptions {
        BakeOptions {
            atlas: AtlasOptions {
                resolution: 256,
                padding: 2,
                ..AtlasOptions::default()
            },
            dilate: 4,
            ..BakeOptions::default()
        }
    }

    #[test]
    fn a_bake_produces_a_textured_mesh_with_fresh_uvs() {
        let high = textured_sphere(32, 24, 1.0);
        let low = textured_sphere(10, 8, 1.0);
        let r = bake(&high, &low, &small_opts(), &mut |_| {}).unwrap();

        assert_eq!(r.mesh.triangles.len(), high.triangle_count());
        assert!(r.mesh.has_uvs());
        assert_eq!(r.mesh.materials.len(), 1, "one baked material");
        assert_eq!(r.mesh.materials[0].base_color_texture, Some(0));
        assert!(r.mesh.materials[0].normal_texture.is_some());
        assert!(r.mesh.materials[0].metallic_roughness_texture.is_some());
        assert_eq!(r.mesh.images[0].width, 256);
    }

    #[test]
    fn the_baked_albedo_carries_the_source_colours() {
        // The fixture is pure red and pure green. If the transfer worked, the
        // atlas holds those and nothing else; if it silently sampled the default
        // material we would get uniform grey.
        let high = textured_sphere(32, 24, 1.0);
        let low = textured_sphere(12, 10, 1.0);
        let r = bake(&low, &high, &small_opts(), &mut |_| {}).unwrap();

        let img = &r.mesh.images[0];
        let mut red = 0;
        let mut green = 0;
        for px in img.rgba.chunks_exact(4) {
            if px[0] > 180 && px[1] < 80 {
                red += 1;
            }
            if px[1] > 180 && px[0] < 80 {
                green += 1;
            }
        }
        assert!(red > 500, "only {red} red texels");
        assert!(green > 500, "only {green} green texels");
    }

    #[test]
    fn most_texels_are_reached_by_the_cage_ray() {
        let high = textured_sphere(40, 30, 1.0);
        let low = textured_sphere(12, 10, 1.0);
        let r = bake(&low, &high, &small_opts(), &mut |_| {}).unwrap();

        assert!(r.stats.texels_covered > 0);
        let ratio = r.stats.hits as f32 / (r.stats.hits + r.stats.misses).max(1) as f32;
        assert!(
            ratio > 0.9,
            "only {:.1}% of texels hit directly, cage is wrong",
            ratio * 100.0
        );
    }

    #[test]
    fn scale_does_not_change_the_bake() {
        // The cage is a share of the bounding box, so a model in millimetres and
        // the same model in metres must behave identically.
        for radius in [0.01f32, 1.0, 100.0] {
            let high = textured_sphere(32, 24, radius);
            let low = textured_sphere(12, 10, radius);
            let r = bake(&low, &high, &small_opts(), &mut |_| {}).unwrap();
            let ratio = r.stats.hits as f32 / (r.stats.hits + r.stats.misses).max(1) as f32;
            assert!(ratio > 0.9, "radius {radius}: only {:.0}% direct", ratio * 100.0);
        }
    }

    #[test]
    fn dilation_fills_the_gutters_around_charts() {
        let high = textured_sphere(32, 24, 1.0);
        let low = textured_sphere(10, 8, 1.0);

        let bare = bake(
            &low,
            &high,
            &BakeOptions { dilate: 0, ..small_opts() },
            &mut |_| {},
        )
        .unwrap();
        let padded = bake(&low, &high, &small_opts(), &mut |_| {}).unwrap();

        let painted = |m: &Mesh| {
            m.images[0]
                .rgba
                .chunks_exact(4)
                .filter(|px| px[3] > 0)
                .count()
        };
        assert!(
            painted(&padded.mesh) > painted(&bare.mesh),
            "dilation painted nothing: {} against {}",
            painted(&padded.mesh),
            painted(&bare.mesh)
        );
    }

    #[test]
    fn the_normal_map_is_mostly_flat_when_both_meshes_agree() {
        // Baking a mesh onto itself must give the neutral normal everywhere,
        // which is the cleanest check that the tangent frame is not twisted.
        let m = textured_sphere(24, 18, 1.0);
        let r = bake(&m, &m, &small_opts(), &mut |_| {}).unwrap();
        let n = map_of(&r.mesh, |m| m.normal_texture).clone();

        let mut off = 0;
        let mut total = 0;
        for px in n.rgba.chunks_exact(4) {
            if px[3] == 0 {
                continue;
            }
            total += 1;
            // Neutral is (128, 128, 255). The z channel is the telling one.
            if px[2] < 235 {
                off += 1;
            }
        }
        assert!(total > 0);
        let ratio = off as f32 / total as f32;
        assert!(ratio < 0.15, "{:.0}% of the normal map is tilted", ratio * 100.0);
    }

    #[test]
    fn an_empty_input_is_refused_rather_than_producing_a_blank_atlas() {
        let m = textured_sphere(8, 6, 1.0);
        assert!(bake(&Mesh::default(), &m, &small_opts(), &mut |_| {}).is_err());
        assert!(bake(&m, &Mesh::default(), &small_opts(), &mut |_| {}).is_err());
    }


    /// A panel with a dark lining close behind it, which is what a satchel flap
    /// is. The bake must read the front, never the lining.
    ///
    /// This is the regression guard for a real failure: starting the ray from an
    /// inflated cage put its origin behind the lining whenever the gap was
    /// smaller than the cage, and the result was a black hole punched through
    /// the middle of the bake.
    #[test]
    fn a_close_lining_behind_a_panel_is_not_sampled() {
        fn panel(z: f32, colour: [u8; 4], flip: bool) -> Mesh {
            let mut m = Mesh {
                positions: vec![
                    Vec3::new(-1.0, -1.0, z),
                    Vec3::new(1.0, -1.0, z),
                    Vec3::new(1.0, 1.0, z),
                    Vec3::new(-1.0, 1.0, z),
                ],
                uvs: vec![Vec2::ZERO, Vec2::X, Vec2::ONE, Vec2::Y],
                // The lining faces the other way, like the inside of a bag.
                triangles: if flip {
                    vec![[0, 2, 1], [0, 3, 2]]
                } else {
                    vec![[0, 1, 2], [0, 2, 3]]
                },
                tri_material: vec![0, 0],
                ..Default::default()
            };
            let mut img = Image::new(8, 8);
            for px in img.rgba.chunks_exact_mut(4) {
                px.copy_from_slice(&colour);
            }
            m.images.push(img);
            m.materials.push(CoreMaterial {
                base_color_texture: Some(0),
                ..CoreMaterial::default()
            });
            m.rebuild_weld(0.0);
            m.compute_normals(40.0);
            m
        }

        // Front panel white, lining black, one hundredth of a unit behind it.
        let mut high = panel(0.0, [255, 255, 255, 255], false);
        let lining = panel(-0.01, [0, 0, 0, 255], true);
        high.append(&lining);
        high.rebuild_weld(0.0);
        high.compute_normals(40.0);

        let low = panel(0.0, [255, 255, 255, 255], false);
        let r = bake(
            &low,
            &high,
            &BakeOptions {
                atlas: AtlasOptions { resolution: 128, padding: 2, ..AtlasOptions::default() },
                // Deliberately larger than the gap, the situation that used to break.
                cage_out: 0.2,
                cage_in: 0.2,
                dilate: 2,
                ..BakeOptions::default()
            },
            &mut |_| {},
        )
        .unwrap();

        let mut light = 0;
        let mut dark = 0;
        for px in r.mesh.images[0].rgba.chunks_exact(4) {
            if px[3] == 0 {
                continue;
            }
            if px[0] > 200 {
                light += 1;
            } else if px[0] < 60 {
                dark += 1;
            }
        }
        assert!(light > 100, "the front panel was barely sampled: {light}");
        assert_eq!(dark, 0, "{dark} texels read the lining behind the panel");
    }


    #[test]
    fn occlusion_darkens_a_crevice_and_leaves_open_ground_bright() {
        // Two walls meeting at a right angle. The corner must come out dark and
        // the far end of each wall must stay near white, or the hemisphere is
        // being sampled in the wrong space.
        // Floor, then a wall rising from one edge. Wound so the floor faces up
        // and the wall faces into the corner: get this backwards and the
        // hemisphere is sampled underneath the floor, where there is nothing to
        // occlude anything.
        let mut high = Mesh {
            positions: vec![
                Vec3::new(-1.0, 0.0, -1.0),
                Vec3::new(1.0, 0.0, -1.0),
                Vec3::new(1.0, 0.0, 1.0),
                Vec3::new(-1.0, 0.0, 1.0),
                Vec3::new(-1.0, 2.0, -1.0),
                Vec3::new(1.0, 2.0, -1.0),
            ],
            uvs: vec![Vec2::ZERO; 6],
            triangles: vec![[0, 2, 1], [0, 3, 2], [0, 1, 5], [0, 5, 4]],
            tri_material: vec![0; 4],
            materials: vec![CoreMaterial::default()],
            ..Default::default()
        };
        high.rebuild_weld(0.0);
        high.compute_normals(40.0);

        let r = bake(
            &high,
            &high,
            &BakeOptions {
                atlas: AtlasOptions { resolution: 256, padding: 2, ..AtlasOptions::default() },
                bake_ao: true,
                ao_samples: 24,
                ao_distance: 0.5,
                bake_normal: false,
                dilate: 2,
                ..BakeOptions::default()
            },
            &mut |_| {},
        )
        .unwrap();

        assert!(r.stats.has_ao);
        let ao = map_of(&r.mesh, |m| m.occlusion_texture);
        let mut dark = 0;
        let mut bright = 0;
        for px in ao.rgba.chunks_exact(4) {
            if px[3] == 0 {
                continue;
            }
            if px[0] < 150 {
                dark += 1;
            }
            if px[0] > 230 {
                bright += 1;
            }
        }
        assert!(dark > 50, "the corner never darkened: {dark} dark texels");
        assert!(bright > 50, "everything darkened: {bright} bright texels");
    }

    #[test]
    fn occlusion_is_deterministic() {
        // Two runs must agree exactly, or comparing two settings is guesswork.
        let m = textured_sphere(16, 12, 1.0);
        let opts = BakeOptions {
            atlas: AtlasOptions { resolution: 128, padding: 2, ..AtlasOptions::default() },
            bake_ao: true,
            ao_samples: 8,
            bake_normal: false,
            ..small_opts()
        };
        let a = bake(&m, &m, &opts, &mut |_| {}).unwrap();
        let b = bake(&m, &m, &opts, &mut |_| {}).unwrap();
        assert_eq!(
            map_of(&a.mesh, |m| m.occlusion_texture).rgba,
            map_of(&b.mesh, |m| m.occlusion_texture).rgba
        );
    }

    #[test]
    fn no_ao_means_no_extra_image() {
        let m = textured_sphere(12, 10, 1.0);
        let r = bake(&m, &m, &small_opts(), &mut |_| {}).unwrap();
        assert!(!r.stats.has_ao);
        assert!(r.mesh.materials[0].occlusion_texture.is_none());
    }


    /// The gap a real model exposed: a gold ring on a wooden handle baked out
    /// as matte wood, because only one pair of metallic and roughness scalars
    /// survived for the whole mesh. Albedo alone is not a material.
    #[test]
    fn metal_survives_the_bake() {
        let mut high = textured_sphere(24, 18, 1.0);
        // Half the sphere metal and smooth, half dielectric and rough, written
        // into a map rather than the factors, which is the normal case.
        let size = 64u32;
        let mut mr = Image::new(size, size);
        for y in 0..size {
            for x in 0..size {
                let i = ((y * size + x) * 4) as usize;
                let metal = x < size / 2;
                mr.rgba[i] = 0;
                mr.rgba[i + 1] = if metal { 30 } else { 220 }; // roughness
                mr.rgba[i + 2] = if metal { 255 } else { 0 };  // metallic
                mr.rgba[i + 3] = 255;
            }
        }
        high.images.push(mr);
        let idx = high.images.len() - 1;
        high.materials[0].metallic_roughness_texture = Some(idx);
        high.materials[0].metallic = 1.0;
        high.materials[0].roughness = 1.0;

        let low = textured_sphere(12, 10, 1.0);
        let r = bake(&low, &high, &small_opts(), &mut |_| {}).unwrap();
        assert!(r.stats.has_metallic_roughness);

        let m = &r.mesh.materials[0];
        let baked = m
            .metallic_roughness_texture
            .and_then(|i| r.mesh.images.get(i))
            .expect("a metallic roughness map must be produced");
        assert_eq!(m.metallic, 1.0, "the factor must not scale the baked map down");
        assert_eq!(m.roughness, 1.0);

        let mut metal = 0;
        let mut dielectric = 0;
        for px in baked.rgba.chunks_exact(4) {
            if px[3] == 0 {
                continue;
            }
            if px[2] > 200 {
                metal += 1;
            } else if px[2] < 40 {
                dielectric += 1;
            }
        }
        assert!(metal > 200, "the metal half did not transfer: {metal} texels");
        assert!(dielectric > 200, "the dielectric half did not transfer: {dielectric}");
    }

    #[test]
    fn turning_the_metallic_map_off_leaves_the_factors_alone() {
        let m = textured_sphere(12, 10, 1.0);
        let r = bake(
            &m,
            &m,
            &BakeOptions { bake_metallic_roughness: false, ..small_opts() },
            &mut |_| {},
        )
        .unwrap();
        assert!(!r.stats.has_metallic_roughness);
        assert!(r.mesh.materials[0].metallic_roughness_texture.is_none());
    }

    #[test]
    fn progress_climbs_to_one() {
        let high = textured_sphere(16, 12, 1.0);
        let low = textured_sphere(8, 6, 1.0);
        let mut seen = Vec::new();
        bake(&low, &high, &small_opts(), &mut |p| seen.push(p)).unwrap();
        assert_eq!(seen.last().copied(), Some(1.0));
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "{seen:?}");
    }
}
