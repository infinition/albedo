//! GLB export.
//!
//! Written by hand: the `gltf` crate only reads. One shared set of vertex
//! accessors is reused by every primitive, and only the index accessor changes
//! per material, so splitting a mesh across twenty materials does not duplicate
//! the vertex buffer twenty times.

use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;

use crate::mesh::Mesh;

// Bytes 'g','l','T','F' read back as one little endian u32.
const MAGIC: u32 = 0x4654_6C67;
const CHUNK_JSON: u32 = 0x4E4F_534A;
const CHUNK_BIN: u32 = 0x004E_4942;

const ARRAY_BUFFER: u32 = 34962;
const ELEMENT_ARRAY_BUFFER: u32 = 34963;
const FLOAT: u32 = 5126;
const UNSIGNED_INT: u32 = 5125;

pub fn save_path(mesh: &Mesh, path: &Path) -> Result<()> {
    let bytes = to_bytes(mesh)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

pub fn to_bytes(mesh: &Mesh) -> Result<Vec<u8>> {
    if mesh.triangles.is_empty() {
        bail!("refusing to write a glTF with no triangles");
    }
    if mesh.normals.len() != mesh.positions.len() {
        bail!(
            "normals ({}) and positions ({}) disagree; call Mesh::compute_normals first",
            mesh.normals.len(),
            mesh.positions.len()
        );
    }

    let mut bin: Vec<u8> = Vec::with_capacity(mesh.positions.len() * 32);
    let mut views: Vec<Value> = Vec::new();
    let mut accessors: Vec<Value> = Vec::new();

    // POSITION. The spec requires min and max on this one accessor.
    let bounds = mesh.bounds();
    let pos_view = push_view(&mut bin, &mut views, Some(ARRAY_BUFFER), |b| {
        for p in &mesh.positions {
            b.extend_from_slice(&p.x.to_le_bytes());
            b.extend_from_slice(&p.y.to_le_bytes());
            b.extend_from_slice(&p.z.to_le_bytes());
        }
    });
    let pos_accessor = accessors.len();
    accessors.push(json!({
        "bufferView": pos_view,
        "componentType": FLOAT,
        "count": mesh.positions.len(),
        "type": "VEC3",
        "min": [bounds.min.x, bounds.min.y, bounds.min.z],
        "max": [bounds.max.x, bounds.max.y, bounds.max.z],
    }));

    let nrm_view = push_view(&mut bin, &mut views, Some(ARRAY_BUFFER), |b| {
        for n in &mesh.normals {
            b.extend_from_slice(&n.x.to_le_bytes());
            b.extend_from_slice(&n.y.to_le_bytes());
            b.extend_from_slice(&n.z.to_le_bytes());
        }
    });
    let nrm_accessor = accessors.len();
    accessors.push(json!({
        "bufferView": nrm_view,
        "componentType": FLOAT,
        "count": mesh.normals.len(),
        "type": "VEC3",
    }));

    let uv_accessor = if mesh.has_uvs() {
        let view = push_view(&mut bin, &mut views, Some(ARRAY_BUFFER), |b| {
            for uv in &mesh.uvs {
                b.extend_from_slice(&uv.x.to_le_bytes());
                b.extend_from_slice(&uv.y.to_le_bytes());
            }
        });
        let a = accessors.len();
        accessors.push(json!({
            "bufferView": view,
            "componentType": FLOAT,
            "count": mesh.uvs.len(),
            "type": "VEC2",
        }));
        Some(a)
    } else {
        None
    };

    // One primitive per material, sharing the vertex accessors above.
    let material_count = mesh.materials.len().max(1);
    let mut groups: Vec<Vec<u32>> = vec![Vec::new(); material_count];
    for (t, f) in mesh.triangles.iter().enumerate() {
        let m = mesh
            .tri_material
            .get(t)
            .copied()
            .unwrap_or(0)
            .min(material_count as u32 - 1) as usize;
        groups[m].extend_from_slice(f);
    }

    let mut primitives: Vec<Value> = Vec::new();
    for (m, idx) in groups.iter().enumerate() {
        if idx.is_empty() {
            continue;
        }
        let view = push_view(&mut bin, &mut views, Some(ELEMENT_ARRAY_BUFFER), |b| {
            for &i in idx {
                b.extend_from_slice(&i.to_le_bytes());
            }
        });
        let a = accessors.len();
        accessors.push(json!({
            "bufferView": view,
            "componentType": UNSIGNED_INT,
            "count": idx.len(),
            "type": "SCALAR",
        }));

        let mut attributes = json!({
            "POSITION": pos_accessor,
            "NORMAL": nrm_accessor,
        });
        if let Some(uv) = uv_accessor {
            attributes["TEXCOORD_0"] = json!(uv);
        }
        primitives.push(json!({
            "attributes": attributes,
            "indices": a,
            "material": m,
            "mode": 4,
        }));
    }

    // Images, one texture each, so a texture index equals its image index.
    let mut images_json: Vec<Value> = Vec::new();
    for img in &mesh.images {
        let png = encode_png(img)?;
        let view = push_view(&mut bin, &mut views, None, |b| b.extend_from_slice(&png));
        images_json.push(json!({ "bufferView": view, "mimeType": "image/png" }));
    }
    let textures_json: Vec<Value> = (0..mesh.images.len())
        .map(|i| json!({ "source": i, "sampler": 0 }))
        .collect();

    let materials_json: Vec<Value> = if mesh.materials.is_empty() {
        vec![json!({ "pbrMetallicRoughness": { "baseColorFactor": [0.8, 0.8, 0.8, 1.0] } })]
    } else {
        mesh.materials
            .iter()
            .map(|m| {
                let mut pbr = json!({
                    "baseColorFactor": m.base_color,
                    "metallicFactor": m.metallic,
                    "roughnessFactor": m.roughness,
                });
                if let Some(t) = m.base_color_texture.filter(|&t| t < mesh.images.len()) {
                    pbr["baseColorTexture"] = texture_ref(t, &m.base_color_uv);
                }
                if let Some(t) = m
                    .metallic_roughness_texture
                    .filter(|&t| t < mesh.images.len())
                {
                    pbr["metallicRoughnessTexture"] = texture_ref(t, &m.metallic_roughness_uv);
                }
                let mut out = json!({
                    "pbrMetallicRoughness": pbr,
                    "doubleSided": m.double_sided,
                });
                if !m.name.is_empty() {
                    out["name"] = json!(m.name);
                }
                if let Some(t) = m.normal_texture.filter(|&t| t < mesh.images.len()) {
                    let mut n = texture_ref(t, &m.normal_uv);
                    if m.normal_scale != 1.0 {
                        n["scale"] = json!(m.normal_scale);
                    }
                    out["normalTexture"] = n;
                }
                if let Some(t) = m.occlusion_texture.filter(|&t| t < mesh.images.len()) {
                    let mut o = texture_ref(t, &m.occlusion_uv);
                    if m.occlusion_strength != 1.0 {
                        o["strength"] = json!(m.occlusion_strength);
                    }
                    out["occlusionTexture"] = o;
                }
                if m.emissive != [0.0, 0.0, 0.0] {
                    out["emissiveFactor"] = json!(m.emissive);
                }
                if let Some(t) = m.emissive_texture.filter(|&t| t < mesh.images.len()) {
                    out["emissiveTexture"] = texture_ref(t, &m.emissive_uv);
                }
                match m.alpha_mode {
                    crate::mesh::AlphaMode::Opaque => {}
                    crate::mesh::AlphaMode::Mask => {
                        out["alphaMode"] = json!("MASK");
                        out["alphaCutoff"] = json!(m.alpha_cutoff);
                    }
                    crate::mesh::AlphaMode::Blend => out["alphaMode"] = json!("BLEND"),
                }
                out
            })
            .collect()
    };

    // A file that carries a transform has to declare the extension, or strict
    // readers ignore it and land exactly where we started: the wrong texels.
    let uses_transform = mesh
        .materials
        .iter()
        .any(|m| {
            !m.base_color_uv.is_identity()
                || !m.normal_uv.is_identity()
                || !m.metallic_roughness_uv.is_identity()
                || !m.occlusion_uv.is_identity()
                || !m.emissive_uv.is_identity()
        });

    let mut root = json!({
        "asset": { "version": "2.0", "generator": concat!("albedo ", env!("CARGO_PKG_VERSION")) },
        "scene": 0,
        "scenes": [{ "nodes": [0] }],
        "nodes": [{ "mesh": 0, "name": "retopo" }],
        "meshes": [{ "primitives": primitives }],
        "materials": materials_json,
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{ "byteLength": bin.len() }],
    });
    if uses_transform {
        root["extensionsUsed"] = json!(["KHR_texture_transform"]);
    }
    if !images_json.is_empty() {
        root["images"] = json!(images_json);
        root["textures"] = json!(textures_json);
        root["samplers"] = json!([{
            "magFilter": 9729,
            "minFilter": 9987,
            "wrapS": 10497,
            "wrapT": 10497,
        }]);
    }

    let mut json_bytes = serde_json::to_vec(&root)?;
    // The JSON chunk pads with spaces, the binary chunk with zeros. Both chunks
    // must land on a four byte boundary or strict loaders reject the file.
    while !json_bytes.len().is_multiple_of(4) {
        json_bytes.push(b' ');
    }
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }

    let total = 12 + 8 + json_bytes.len() + if bin.is_empty() { 0 } else { 8 + bin.len() };
    let mut out = Vec::with_capacity(total);
    out.write_all(&MAGIC.to_le_bytes())?;
    out.write_all(&2u32.to_le_bytes())?;
    out.write_all(&(total as u32).to_le_bytes())?;
    out.write_all(&(json_bytes.len() as u32).to_le_bytes())?;
    out.write_all(&CHUNK_JSON.to_le_bytes())?;
    out.write_all(&json_bytes)?;
    if !bin.is_empty() {
        out.write_all(&(bin.len() as u32).to_le_bytes())?;
        out.write_all(&CHUNK_BIN.to_le_bytes())?;
        out.write_all(&bin)?;
    }
    Ok(out)
}

/// Append a buffer view, four byte aligned, and return its index.
fn push_view(
    bin: &mut Vec<u8>,
    views: &mut Vec<Value>,
    target: Option<u32>,
    fill: impl FnOnce(&mut Vec<u8>),
) -> usize {
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let offset = bin.len();
    fill(bin);
    let mut view = json!({
        "buffer": 0,
        "byteOffset": offset,
        "byteLength": bin.len() - offset,
    });
    if let Some(t) = target {
        view["target"] = json!(t);
    }
    views.push(view);
    views.len() - 1
}

/// A texture reference, carrying its UV transform when it has one.
fn texture_ref(index: usize, uv: &crate::mesh::UvTransform) -> Value {
    let mut out = json!({ "index": index });
    if !uv.is_identity() {
        out["extensions"] = json!({
            "KHR_texture_transform": {
                "offset": [uv.offset.x, uv.offset.y],
                "scale": [uv.scale.x, uv.scale.y],
                "rotation": uv.rotation,
            }
        });
    }
    out
}

fn encode_png(img: &crate::mesh::Image) -> Result<Vec<u8>> {
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder};
    let mut out = Vec::new();
    PngEncoder::new(&mut out).write_image(
        &img.rgba,
        img.width,
        img.height,
        ExtendedColorType::Rgba8,
    )?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::{Image, Material};
    use glam::{Vec2, Vec3};

    fn triangle_mesh() -> Mesh {
        let mut m = Mesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 2.0, 0.0),
            ],
            uvs: vec![Vec2::ZERO, Vec2::X, Vec2::Y],
            triangles: vec![[0, 1, 2]],
            tri_material: vec![0],
            materials: vec![Material::default()],
            ..Default::default()
        };
        m.rebuild_weld(0.0);
        m.compute_normals(40.0);
        m
    }

    #[test]
    fn a_written_glb_reads_back_identically() {
        let m = triangle_mesh();
        let bytes = to_bytes(&m).unwrap();
        let back = crate::glb::load_bytes(&bytes).unwrap();
        assert_eq!(back.triangle_count(), 1);
        assert_eq!(back.vertex_count(), 3);
        assert!(back.has_uvs());
        let b = back.bounds();
        assert!(b.max.abs_diff_eq(Vec3::new(1.0, 2.0, 0.0), 1e-5), "{:?}", b.max);
    }

    #[test]
    fn header_is_a_valid_glb_container() {
        let bytes = to_bytes(&triangle_mesh()).unwrap();
        assert_eq!(&bytes[0..4], b"glTF");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 2);
        assert_eq!(
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize,
            bytes.len(),
            "the declared total length must match the file"
        );
        assert_eq!(bytes.len() % 4, 0, "chunks must stay four byte aligned");
    }

    #[test]
    fn several_materials_become_several_primitives_on_one_vertex_buffer() {
        let mut m = triangle_mesh();
        let base = m.positions.len() as u32;
        m.positions.extend([
            Vec3::new(3.0, 0.0, 0.0),
            Vec3::new(4.0, 0.0, 0.0),
            Vec3::new(3.0, 1.0, 0.0),
        ]);
        m.uvs.extend([Vec2::ZERO, Vec2::X, Vec2::Y]);
        m.triangles.push([base, base + 1, base + 2]);
        m.tri_material.push(1);
        m.materials.push(Material {
            name: "second".into(),
            ..Material::default()
        });
        m.rebuild_weld(0.0);
        m.compute_normals(40.0);

        let bytes = to_bytes(&m).unwrap();
        let json_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        let root: Value = serde_json::from_slice(&bytes[20..20 + json_len]).unwrap();
        let prims = root["meshes"][0]["primitives"].as_array().unwrap();
        assert_eq!(prims.len(), 2);
        assert_eq!(
            prims[0]["attributes"]["POSITION"],
            prims[1]["attributes"]["POSITION"],
            "both primitives must share one position accessor"
        );

        let back = crate::glb::load_bytes(&bytes).unwrap();
        assert_eq!(back.triangle_count(), 2);
    }

    #[test]
    fn textures_survive_the_round_trip() {
        let mut m = triangle_mesh();
        let mut img = Image::new(2, 2);
        img.rgba = vec![
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
        ];
        m.images.push(img);
        m.materials[0].base_color_texture = Some(0);

        let bytes = to_bytes(&m).unwrap();
        let back = crate::glb::load_bytes(&bytes).unwrap();
        assert_eq!(back.images.len(), 1);
        assert_eq!(back.images[0].width, 2);
        assert_eq!(back.images[0].rgba[0..4], [255, 0, 0, 255]);
        assert_eq!(back.materials[0].base_color_texture, Some(0));
    }


    #[test]
    fn a_texture_transform_survives_the_round_trip() {
        // Quantising exporters put the real UV range in this scale. Losing it on
        // export means the file we hand back shows a fraction of its own texture,
        // which is exactly the bug this guards.
        use crate::mesh::UvTransform;
        let mut m = triangle_mesh();
        m.images.push(Image::new(4, 4));
        m.materials[0].base_color_texture = Some(0);
        m.materials[0].base_color_uv = UvTransform {
            offset: Vec2::new(0.25, 0.5),
            scale: Vec2::new(16.0, 8.0),
            rotation: 0.5,
        };

        let bytes = to_bytes(&m).unwrap();
        let json_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        let root: Value = serde_json::from_slice(&bytes[20..20 + json_len]).unwrap();
        assert_eq!(
            root["extensionsUsed"],
            serde_json::json!(["KHR_texture_transform"]),
            "the extension has to be declared or readers ignore it"
        );

        let back = crate::glb::load_bytes(&bytes).unwrap();
        let uv = back.materials[0].base_color_uv;
        assert!((uv.scale.x - 16.0).abs() < 1e-4, "{uv:?}");
        assert!((uv.scale.y - 8.0).abs() < 1e-4, "{uv:?}");
        assert!((uv.offset.x - 0.25).abs() < 1e-4, "{uv:?}");
        assert!((uv.rotation - 0.5).abs() < 1e-4, "{uv:?}");
    }

    #[test]
    fn an_identity_transform_is_not_written() {
        let mut m = triangle_mesh();
        m.images.push(Image::new(4, 4));
        m.materials[0].base_color_texture = Some(0);
        let bytes = to_bytes(&m).unwrap();
        let json_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        let root: Value = serde_json::from_slice(&bytes[20..20 + json_len]).unwrap();
        assert!(root.get("extensionsUsed").is_none());
        assert!(root["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]
            .get("extensions")
            .is_none());
    }

    #[test]
    fn the_uv_transform_maths_follow_the_specification() {
        use crate::mesh::UvTransform;
        // Scale, then rotate, then translate.
        let t = UvTransform {
            offset: Vec2::new(1.0, 2.0),
            scale: Vec2::new(4.0, 4.0),
            rotation: 0.0,
        };
        assert_eq!(t.apply(Vec2::new(0.5, 0.25)), Vec2::new(3.0, 3.0));
        assert!(UvTransform::default().is_identity());
        assert_eq!(UvTransform::default().apply(Vec2::new(0.3, 0.7)), Vec2::new(0.3, 0.7));
    }

    #[test]
    fn writing_without_normals_is_refused_rather_than_silently_wrong() {
        let mut m = triangle_mesh();
        m.normals.clear();
        assert!(to_bytes(&m).is_err());
    }
}
