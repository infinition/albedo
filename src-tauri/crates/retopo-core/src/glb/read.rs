//! glTF and GLB import.

use anyhow::{bail, Context, Result};
use glam::{Mat3, Mat4, Vec2, Vec3};
use std::path::Path;

use crate::mesh::{AlphaMode, Image, Material, Mesh, UvTransform};

/// Load a `.glb` or a self contained `.gltf` from memory.
///
/// A `.gltf` that points at sibling `.bin` or image files cannot be resolved
/// from bytes alone; use [`load_path`] for those.
pub fn load_bytes(bytes: &[u8]) -> Result<Mesh> {
    // Real files routinely require extensions the strict reader rejects. See
    // glb::compat for what is relaxed and what is refused.
    let relaxed = super::compat::relax_required_extensions(bytes)?;
    let (doc, buffers, images) =
        gltf::import_slice(relaxed.as_ref()).context("this does not parse as glTF 2.0 or GLB")?;
    assemble(&doc, &buffers, &images)
}

/// Load from disk, resolving any external buffers and images next to the file.
pub fn load_path(path: &Path) -> Result<Mesh> {
    let bytes = std::fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    // A GLB is self contained, so it can take the in-memory path and get the
    // extension relaxation with it. A .gltf may point at sibling .bin and image
    // files, which only the path based importer can resolve.
    if bytes.starts_with(b"glTF") {
        return load_bytes(&bytes).with_context(|| format!("failed to read {}", path.display()));
    }
    let (doc, buffers, images) =
        gltf::import(path).with_context(|| format!("failed to read {}", path.display()))?;
    assemble(&doc, &buffers, &images)
}

fn assemble(
    doc: &gltf::Document,
    buffers: &[gltf::buffer::Data],
    images: &[gltf::image::Data],
) -> Result<Mesh> {
    let mut mesh = Mesh::default();

    for img in images {
        mesh.images.push(convert_image(img));
    }

    for mat in doc.materials() {
        let pbr = mat.pbr_metallic_roughness();
        let base = pbr.base_color_texture();
        let mr = pbr.metallic_roughness_texture();
        let normal = mat.normal_texture();
        let occlusion = mat.occlusion_texture();
        let emissive = mat.emissive_texture();
        mesh.materials.push(Material {
            name: mat.name().unwrap_or_default().to_string(),
            base_color: pbr.base_color_factor(),
            base_color_texture: base.as_ref().map(|t| t.texture().source().index()),
            base_color_uv: base
                .as_ref()
                .and_then(|t| t.texture_transform())
                .map(read_transform)
                .unwrap_or_default(),
            metallic: pbr.metallic_factor(),
            roughness: pbr.roughness_factor(),
            metallic_roughness_texture: mr.as_ref().map(|t| t.texture().source().index()),
            metallic_roughness_uv: mr
                .as_ref()
                .and_then(|t| t.texture_transform())
                .map(read_transform)
                .unwrap_or_default(),
            normal_texture: normal.as_ref().map(|t| t.texture().source().index()),
            // The typed accessor only exists on texture::Info, not on the
            // normal slot, so that one is read straight out of the extension.
            normal_uv: normal
                .as_ref()
                .and_then(|t| t.extension_value("KHR_texture_transform"))
                .and_then(transform_from_json)
                .unwrap_or_default(),
            normal_scale: normal.as_ref().map(|t| t.scale()).unwrap_or(1.0),
            occlusion_texture: occlusion.as_ref().map(|t| t.texture().source().index()),
            occlusion_uv: occlusion
                .as_ref()
                .and_then(|t| t.extension_value("KHR_texture_transform"))
                .and_then(transform_from_json)
                .unwrap_or_default(),
            occlusion_strength: occlusion.as_ref().map(|t| t.strength()).unwrap_or(1.0),
            emissive: mat.emissive_factor(),
            emissive_texture: emissive.as_ref().map(|t| t.texture().source().index()),
            emissive_uv: emissive
                .as_ref()
                .and_then(|t| t.texture_transform())
                .map(read_transform)
                .unwrap_or_default(),
            alpha_mode: match mat.alpha_mode() {
                gltf::material::AlphaMode::Opaque => AlphaMode::Opaque,
                gltf::material::AlphaMode::Mask => AlphaMode::Mask,
                gltf::material::AlphaMode::Blend => AlphaMode::Blend,
            },
            alpha_cutoff: mat.alpha_cutoff().unwrap_or(0.5),
            double_sided: mat.double_sided(),
        });
    }
    // glTF lets a primitive omit the material. The fallback goes at the end so
    // it never shifts the indices the document itself uses, and it is only added
    // when something actually needs it: an unused extra material would show up
    // in the interface as a material the file does not have.
    let default_material = mesh.materials.len() as u32;
    let mut needs_default = false;

    // Iterative walk over the scene graph, carrying the accumulated transform.
    let mut stack: Vec<(gltf::Node, Mat4)> = Vec::new();
    for scene in doc.scenes() {
        for node in scene.nodes() {
            stack.push((node, Mat4::IDENTITY));
        }
    }
    if stack.is_empty() {
        // Some exporters write meshes with no scene at all.
        for m in doc.meshes() {
            add_mesh(&mut mesh, &m, Mat4::IDENTITY, buffers, default_material, &mut needs_default)?;
        }
    }

    while let Some((node, parent)) = stack.pop() {
        let local = Mat4::from_cols_array_2d(&node.transform().matrix());
        let world = parent * local;
        if let Some(m) = node.mesh() {
            add_mesh(&mut mesh, &m, world, buffers, default_material, &mut needs_default)?;
        }
        for child in node.children() {
            stack.push((child, world));
        }
    }

    if mesh.triangles.is_empty() {
        bail!("no triangles found: the file has no triangle primitives");
    }
    if needs_default {
        mesh.materials.push(Material {
            name: "default".into(),
            ..Material::default()
        });
    }

    mesh.rebuild_weld(0.0);
    let dropped = mesh.remove_degenerate();
    if dropped > 0 {
        tracing::debug!(dropped, "removed degenerate triangles on import");
    }
    if mesh.normals.len() != mesh.positions.len() {
        mesh.compute_normals(40.0);
    }
    if !mesh.uvs.is_empty() && mesh.uvs.len() != mesh.positions.len() {
        mesh.uvs.resize(mesh.positions.len(), Vec2::ZERO);
    }
    Ok(mesh)
}

fn add_mesh(
    out: &mut Mesh,
    m: &gltf::Mesh,
    world: Mat4,
    buffers: &[gltf::buffer::Data],
    default_material: u32,
    needs_default: &mut bool,
) -> Result<()> {
    // Normals transform by the inverse transpose, otherwise any non uniform
    // scale in the node chain tilts them off the surface.
    let normal_matrix = Mat3::from_mat4(world).inverse().transpose();

    for prim in m.primitives() {
        if prim.mode() != gltf::mesh::Mode::Triangles {
            tracing::debug!(mode = ?prim.mode(), "skipping non triangle primitive");
            continue;
        }
        let reader = prim.reader(|b| buffers.get(b.index()).map(|d| &d.0[..]));

        // Attributes go through our own decoder so quantized component types are
        // read as what they are, rather than reinterpreted as floats.
        let Some(pos_acc) = prim.get(&gltf::Semantic::Positions) else {
            continue;
        };
        let raw = super::accessor::read_floats(&pos_acc, buffers, 3)
            .context("could not read POSITION")?;
        let base = out.positions.len() as u32;
        for p in raw.chunks_exact(3) {
            out.positions
                .push(world.transform_point3(Vec3::new(p[0], p[1], p[2])));
        }
        let added = out.positions.len() as u32 - base;

        // When normals are absent the buffer is left short on purpose:
        // `assemble` notices the length mismatch and recomputes all of them.
        if let Some(acc) = prim.get(&gltf::Semantic::Normals) {
            match super::accessor::read_floats(&acc, buffers, 3) {
                Ok(raw) => {
                    for n in raw.chunks_exact(3) {
                        out.normals.push(
                            (normal_matrix * Vec3::new(n[0], n[1], n[2])).normalize_or_zero(),
                        );
                    }
                }
                Err(e) => tracing::debug!("ignoring NORMAL: {e:#}"),
            }
        }

        let had_uvs = out.uvs.len() == base as usize;
        let uvs = prim
            .get(&gltf::Semantic::TexCoords(0))
            .and_then(|acc| super::accessor::read_floats(&acc, buffers, 2).ok());
        match uvs {
            Some(raw) => {
                if !had_uvs {
                    out.uvs.resize(base as usize, Vec2::ZERO);
                }
                for uv in raw.chunks_exact(2) {
                    out.uvs.push(Vec2::new(uv[0], uv[1]));
                }
                out.uvs.resize((base + added) as usize, Vec2::ZERO);
            }
            None => {
                if had_uvs && base > 0 {
                    out.uvs.resize((base + added) as usize, Vec2::ZERO);
                }
            }
        }

        let material = match prim.material().index() {
            Some(i) => i as u32,
            None => {
                *needs_default = true;
                default_material
            }
        };

        match reader.read_indices() {
            Some(idx) => {
                let idx: Vec<u32> = idx.into_u32().collect();
                for c in idx.chunks_exact(3) {
                    out.triangles
                        .push([base + c[0], base + c[1], base + c[2]]);
                    out.tri_material.push(material);
                }
            }
            None => {
                for i in (0..added).step_by(3) {
                    if i + 2 < added {
                        out.triangles.push([base + i, base + i + 1, base + i + 2]);
                        out.tri_material.push(material);
                    }
                }
            }
        }
    }
    Ok(())
}

fn transform_from_json(v: &serde_json::Value) -> Option<UvTransform> {
    let pair = |key: &str, fallback: Vec2| -> Vec2 {
        v.get(key)
            .and_then(|a| a.as_array())
            .filter(|a| a.len() == 2)
            .and_then(|a| {
                Some(Vec2::new(
                    a[0].as_f64()? as f32,
                    a[1].as_f64()? as f32,
                ))
            })
            .unwrap_or(fallback)
    };
    Some(UvTransform {
        offset: pair("offset", Vec2::ZERO),
        scale: pair("scale", Vec2::ONE),
        rotation: v.get("rotation").and_then(|r| r.as_f64()).unwrap_or(0.0) as f32,
    })
}

fn read_transform(t: gltf::texture::TextureTransform) -> UvTransform {
    let offset = t.offset();
    let scale = t.scale();
    UvTransform {
        offset: Vec2::from_array(offset),
        scale: Vec2::from_array(scale),
        rotation: t.rotation(),
    }
}

fn convert_image(src: &gltf::image::Data) -> Image {
    use gltf::image::Format;
    let n = (src.width as usize) * (src.height as usize);
    let mut rgba = vec![255u8; n * 4];

    // Every source format is widened to RGBA8 so sampling never branches. The
    // 16 bit and float paths lose precision on purpose: albedo transfer works in
    // 8 bit, and carrying wider pixels through the bake would quadruple memory.
    match src.format {
        Format::R8 => {
            for i in 0..n {
                let v = src.pixels[i];
                rgba[i * 4] = v;
                rgba[i * 4 + 1] = v;
                rgba[i * 4 + 2] = v;
            }
        }
        Format::R8G8 => {
            for i in 0..n {
                rgba[i * 4] = src.pixels[i * 2];
                rgba[i * 4 + 1] = src.pixels[i * 2 + 1];
            }
        }
        Format::R8G8B8 => {
            for i in 0..n {
                rgba[i * 4..i * 4 + 3].copy_from_slice(&src.pixels[i * 3..i * 3 + 3]);
            }
        }
        Format::R8G8B8A8 => {
            rgba.copy_from_slice(&src.pixels[..n * 4]);
        }
        Format::R16 | Format::R16G16 | Format::R16G16B16 | Format::R16G16B16A16 => {
            let channels = match src.format {
                Format::R16 => 1,
                Format::R16G16 => 2,
                Format::R16G16B16 => 3,
                _ => 4,
            };
            for i in 0..n {
                for c in 0..channels {
                    let o = (i * channels + c) * 2;
                    let v = u16::from_le_bytes([src.pixels[o], src.pixels[o + 1]]);
                    rgba[i * 4 + c] = (v >> 8) as u8;
                }
                if channels == 1 {
                    rgba[i * 4 + 1] = rgba[i * 4];
                    rgba[i * 4 + 2] = rgba[i * 4];
                }
            }
        }
        Format::R32G32B32FLOAT | Format::R32G32B32A32FLOAT => {
            let channels = if matches!(src.format, Format::R32G32B32FLOAT) {
                3
            } else {
                4
            };
            for i in 0..n {
                for c in 0..channels {
                    let o = (i * channels + c) * 4;
                    let v = f32::from_le_bytes([
                        src.pixels[o],
                        src.pixels[o + 1],
                        src.pixels[o + 2],
                        src.pixels[o + 3],
                    ]);
                    rgba[i * 4 + c] = (v.clamp(0.0, 1.0) * 255.0) as u8;
                }
            }
        }
    }

    Image {
        width: src.width,
        height: src.height,
        rgba,
    }
}
