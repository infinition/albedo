//! `PMSH`, the binary mesh format the server streams to the viewer.
//!
//! The alternative was sending a GLB and writing a glTF parser in JavaScript.
//! This is a flat header plus tightly packed arrays, so the browser reads it
//! with a handful of typed array views and uploads them straight to WebGL with
//! no copy and no parsing.
//!
//! Layout, little endian throughout:
//!
//! ```text
//! offset  size  field
//! 0       4     magic "PMSH"
//! 4       4     version
//! 8       4     flags
//! 12      4     vertex count
//! 16      4     triangle count
//! 20      4     reserved, zero
//! 24      12    aabb min, 3 x f32
//! 36      12    aabb max, 3 x f32
//! 48      -     positions, 3 x f32 per vertex
//! ...           normals,   3 x f32 per vertex
//! ...           uvs,       2 x f32 per vertex   (FLAG_UV)
//! ...           indices,   3 x u32 per triangle
//! ...           groups,    1 x u32 per triangle (FLAG_GROUPS)
//! ...           materials, 1 x u32 per triangle (FLAG_MATERIALS)
//! ...           deviation, 1 x f32 per vertex   (FLAG_DEVIATION)
//! ...           edgemask,  1 x u32 per triangle (FLAG_EDGEMASK)
//! ```

use glam::{Vec2, Vec3};

use crate::mesh::{Aabb, Mesh};

pub const MAGIC: u32 = 0x4853_4D50;
pub const VERSION: u32 = 1;
pub const HEADER_BYTES: usize = 48;

pub const FLAG_UV: u32 = 1 << 0;
pub const FLAG_GROUPS: u32 = 1 << 1;
pub const FLAG_MATERIALS: u32 = 1 << 2;
pub const FLAG_DEVIATION: u32 = 1 << 3;
/// Three low bits per triangle: which of its edges the wireframe should draw.
///
/// A quad is two triangles with the diagonal hidden, which is how quad topology
/// travels through a format that has no quads.
pub const FLAG_EDGEMASK: u32 = 1 << 4;

/// Optional per element channels that ride along with the geometry.
#[derive(Clone, Copy, Debug, Default)]
pub struct Extras<'a> {
    /// Polygroup id per triangle.
    pub groups: Option<&'a [u32]>,
    /// Distance from each vertex to the surface it was derived from, in model
    /// units. Drives the deviation heatmap.
    pub deviation: Option<&'a [f32]>,
    /// Per triangle wireframe edge mask, three low bits.
    pub edge_mask: Option<&'a [u32]>,
}

/// Serialise a mesh for the viewer.
pub fn encode(mesh: &Mesh, extras: Extras<'_>) -> Vec<u8> {
    let nv = mesh.positions.len();
    let nt = mesh.triangles.len();
    let has_uv = mesh.has_uvs();
    let groups = extras.groups.filter(|g| g.len() == nt);
    let deviation = extras.deviation.filter(|d| d.len() == nv);
    let edge_mask = extras.edge_mask.filter(|m| m.len() == nt);
    // Materials are only worth sending when there is a choice to make.
    let materials =
        (mesh.tri_material.len() == nt && mesh.materials.len() > 1).then_some(&mesh.tri_material);

    let mut flags = 0u32;
    if has_uv {
        flags |= FLAG_UV;
    }
    if groups.is_some() {
        flags |= FLAG_GROUPS;
    }
    if materials.is_some() {
        flags |= FLAG_MATERIALS;
    }
    if deviation.is_some() {
        flags |= FLAG_DEVIATION;
    }
    if edge_mask.is_some() {
        flags |= FLAG_EDGEMASK;
    }

    let mut out = Vec::with_capacity(
        HEADER_BYTES + nv * (12 + 12 + if has_uv { 8 } else { 0 }) + nt * (12 + 4),
    );

    let b = mesh.bounds();
    let b = if b.is_empty() {
        Aabb {
            min: Vec3::ZERO,
            max: Vec3::ZERO,
        }
    } else {
        b
    };

    out.extend_from_slice(&MAGIC.to_le_bytes());
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&flags.to_le_bytes());
    out.extend_from_slice(&(nv as u32).to_le_bytes());
    out.extend_from_slice(&(nt as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    push_vec3(&mut out, b.min);
    push_vec3(&mut out, b.max);

    for p in &mesh.positions {
        push_vec3(&mut out, *p);
    }
    // Normals may be missing on a freshly synthesised mesh; zeros are safe, the
    // shader falls back to a face normal derived from screen space derivatives.
    for i in 0..nv {
        push_vec3(&mut out, mesh.normals.get(i).copied().unwrap_or(Vec3::Y));
    }
    if has_uv {
        for uv in &mesh.uvs {
            push_vec2(&mut out, *uv);
        }
    }
    for f in &mesh.triangles {
        out.extend_from_slice(&f[0].to_le_bytes());
        out.extend_from_slice(&f[1].to_le_bytes());
        out.extend_from_slice(&f[2].to_le_bytes());
    }
    if let Some(g) = groups {
        for &id in g {
            out.extend_from_slice(&id.to_le_bytes());
        }
    }
    if let Some(m) = materials {
        for &id in m {
            out.extend_from_slice(&id.to_le_bytes());
        }
    }
    if let Some(d) = deviation {
        for &v in d {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    if let Some(m) = edge_mask {
        for &v in m {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    out
}

/// Distance from every vertex of `mesh` to the closest point on `reference`.
///
/// This is the honest answer to "did the shape survive": not a triangle count,
/// but how far the surface actually moved, per vertex, ready to be painted.
pub fn deviation_against(mesh: &Mesh, reference: &crate::bvh::Bvh) -> Vec<f32> {
    use rayon::prelude::*;
    mesh.positions
        .par_iter()
        .map(|p| {
            reference
                .closest_point(*p)
                .map(|h| h.dist2.max(0.0).sqrt())
                .unwrap_or(0.0)
        })
        .collect()
}

#[inline]
fn push_vec3(out: &mut Vec<u8>, v: Vec3) {
    out.extend_from_slice(&v.x.to_le_bytes());
    out.extend_from_slice(&v.y.to_le_bytes());
    out.extend_from_slice(&v.z.to_le_bytes());
}

#[inline]
fn push_vec2(out: &mut Vec<u8>, v: Vec2) {
    out.extend_from_slice(&v.x.to_le_bytes());
    out.extend_from_slice(&v.y.to_le_bytes());
}

/// What a decoder finds in the header. Mirrors the JavaScript side, and exists
/// mostly so the round trip can be tested in Rust.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Header {
    pub version: u32,
    pub flags: u32,
    pub vertex_count: u32,
    pub triangle_count: u32,
    pub bounds: Aabb,
}

pub fn decode_header(bytes: &[u8]) -> Option<Header> {
    if bytes.len() < HEADER_BYTES {
        return None;
    }
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let f32_at = |o: usize| f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    if u32_at(0) != MAGIC {
        return None;
    }
    Some(Header {
        version: u32_at(4),
        flags: u32_at(8),
        vertex_count: u32_at(12),
        triangle_count: u32_at(16),
        bounds: Aabb {
            min: Vec3::new(f32_at(24), f32_at(28), f32_at(32)),
            max: Vec3::new(f32_at(36), f32_at(40), f32_at(44)),
        },
    })
}

/// Byte length a payload with this header must have. The viewer uses the same
/// arithmetic to slice its typed arrays, so a mismatch here is a real bug.
pub fn expected_len(h: &Header) -> usize {
    let nv = h.vertex_count as usize;
    let nt = h.triangle_count as usize;
    HEADER_BYTES
        + nv * 12
        + nv * 12
        + if h.flags & FLAG_UV != 0 { nv * 8 } else { 0 }
        + nt * 12
        + if h.flags & FLAG_GROUPS != 0 { nt * 4 } else { 0 }
        + if h.flags & FLAG_MATERIALS != 0 { nt * 4 } else { 0 }
        + if h.flags & FLAG_DEVIATION != 0 { nv * 4 } else { 0 }
        + if h.flags & FLAG_EDGEMASK != 0 { nt * 4 } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::Material;

    fn quad() -> Mesh {
        let mut m = Mesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(2.0, 0.0, 0.0),
                Vec3::new(2.0, 3.0, 0.0),
                Vec3::new(0.0, 3.0, 0.0),
            ],
            uvs: vec![Vec2::ZERO, Vec2::X, Vec2::ONE, Vec2::Y],
            triangles: vec![[0, 1, 2], [0, 2, 3]],
            tri_material: vec![0, 0],
            materials: vec![Material::default()],
            ..Default::default()
        };
        m.rebuild_weld(0.0);
        m.compute_normals(40.0);
        m
    }

    #[test]
    fn header_round_trips_and_length_matches() {
        let m = quad();
        let bytes = encode(&m, Extras::default());
        let h = decode_header(&bytes).expect("magic must match");
        assert_eq!(h.version, VERSION);
        assert_eq!(h.vertex_count, 4);
        assert_eq!(h.triangle_count, 2);
        assert_eq!(h.flags & FLAG_UV, FLAG_UV);
        assert_eq!(h.flags & FLAG_GROUPS, 0);
        assert_eq!(h.bounds.max, Vec3::new(2.0, 3.0, 0.0));
        assert_eq!(bytes.len(), expected_len(&h));
    }

    #[test]
    fn groups_add_exactly_one_u32_per_triangle() {
        let m = quad();
        let plain = encode(&m, Extras::default()).len();
        let with_groups = encode(&m, Extras { groups: Some(&[0, 1]), ..Default::default() }).len();
        assert_eq!(with_groups - plain, 8);
        let h = decode_header(&encode(&m, Extras { groups: Some(&[0, 1]), ..Default::default() })).unwrap();
        assert_eq!(h.flags & FLAG_GROUPS, FLAG_GROUPS);
    }

    #[test]
    fn a_group_array_of_the_wrong_length_is_ignored() {
        let m = quad();
        let bytes = encode(&m, Extras { groups: Some(&[0]), ..Default::default() });
        let h = decode_header(&bytes).unwrap();
        assert_eq!(h.flags & FLAG_GROUPS, 0, "a short array must not be trusted");
        assert_eq!(bytes.len(), expected_len(&h));
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(decode_header(&[0u8; 8]).is_none());
        assert!(decode_header(&[0u8; 64]).is_none());
    }

    #[test]
    fn an_edge_mask_adds_one_u32_per_triangle() {
        let m = quad();
        let plain = encode(&m, Extras::default()).len();
        let masked = encode(
            &m,
            Extras { edge_mask: Some(&[0b011, 0b110]), ..Default::default() },
        );
        assert_eq!(masked.len() - plain, 8);
        let h = decode_header(&masked).unwrap();
        assert_eq!(h.flags & FLAG_EDGEMASK, FLAG_EDGEMASK);
        assert_eq!(masked.len(), expected_len(&h));
    }

    #[test]
    fn a_mesh_without_uvs_omits_the_block() {
        let mut m = quad();
        m.uvs.clear();
        let bytes = encode(&m, Extras::default());
        let h = decode_header(&bytes).unwrap();
        assert_eq!(h.flags & FLAG_UV, 0);
        assert_eq!(bytes.len(), expected_len(&h));
    }
}
