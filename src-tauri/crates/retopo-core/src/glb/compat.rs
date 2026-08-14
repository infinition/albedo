//! Making real world glTF files loadable.
//!
//! The `gltf` crate refuses any file whose `extensionsRequired` names something
//! it does not know, and its allowlist is short. In practice almost every modern
//! exporter and every AI mesh generator declares `KHR_mesh_quantization`, so the
//! strict reading rejects most of the files this tool exists to process.
//!
//! Most extensions only change how a material or a texture is interpreted, and a
//! retopology tool can ignore them safely. A few change the *byte layout* of the
//! buffers, and ignoring those would hand the mesh reader noise. So the required
//! list is cleared, except for the ones on [`BLOCKING`], which fail loudly.

use std::borrow::Cow;

use anyhow::{bail, Result};

/// Extensions that rewrite buffer bytes. Ignoring one of these produces a mesh
/// made of garbage rather than an error, so they are refused up front.
pub const BLOCKING: &[&str] = &[
    "KHR_draco_mesh_compression",
    "EXT_meshopt_compression",
    "EXT_mesh_gpu_instancing",
];

const GLB_MAGIC: &[u8; 4] = b"glTF";
const CHUNK_JSON: u32 = 0x4E4F_534A;

/// Clear `extensionsRequired` so a strict reader will accept the file.
///
/// Returns the input untouched when there is nothing to relax, which is the
/// common case and costs no allocation.
pub fn relax_required_extensions(bytes: &[u8]) -> Result<Cow<'_, [u8]>> {
    if bytes.len() >= 4 && &bytes[0..4] == GLB_MAGIC {
        relax_glb(bytes)
    } else {
        match relax_json(bytes)? {
            Some(new_json) => Ok(Cow::Owned(new_json)),
            None => Ok(Cow::Borrowed(bytes)),
        }
    }
}

fn relax_glb(bytes: &[u8]) -> Result<Cow<'_, [u8]>> {
    if bytes.len() < 20 {
        bail!("truncated GLB: {} bytes", bytes.len());
    }
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());

    let json_len = u32_at(12) as usize;
    if u32_at(16) != CHUNK_JSON {
        bail!("the first GLB chunk is not JSON");
    }
    let json_start: usize = 20;
    let json_end = json_start
        .checked_add(json_len)
        .filter(|e| *e <= bytes.len())
        .ok_or_else(|| anyhow::anyhow!("GLB declares a JSON chunk longer than the file"))?;

    let Some(mut new_json) = relax_json(&bytes[json_start..json_end])? else {
        return Ok(Cow::Borrowed(bytes));
    };
    while !new_json.len().is_multiple_of(4) {
        new_json.push(b' ');
    }

    let rest = &bytes[json_end..];
    let total = 12 + 8 + new_json.len() + rest.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(GLB_MAGIC);
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(new_json.len() as u32).to_le_bytes());
    out.extend_from_slice(&CHUNK_JSON.to_le_bytes());
    out.extend_from_slice(&new_json);
    out.extend_from_slice(rest);
    Ok(Cow::Owned(out))
}

/// `Ok(None)` when the document needs no change.
fn relax_json(json: &[u8]) -> Result<Option<Vec<u8>>> {
    let mut root: serde_json::Value = match serde_json::from_slice(json) {
        Ok(v) => v,
        // Not our problem to diagnose: hand it back and let the real parser
        // produce the proper error message.
        Err(_) => return Ok(None),
    };

    let required: Vec<String> = root
        .get("extensionsRequired")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    if required.is_empty() {
        return Ok(None);
    }

    let blocked: Vec<&String> = required.iter().filter(|e| BLOCKING.contains(&e.as_str())).collect();
    if !blocked.is_empty() {
        bail!(
            "this file needs {}, which changes how the buffers are encoded. \
             Re-export it without that extension, or run it through gltfpack first.",
            blocked
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(" and ")
        );
    }

    tracing::debug!(?required, "ignoring required extensions");
    if let Some(obj) = root.as_object_mut() {
        obj.remove("extensionsRequired");
    }
    Ok(Some(serde_json::to_vec(&root)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glb_with(json: &str) -> Vec<u8> {
        let mut j = json.as_bytes().to_vec();
        while !j.len().is_multiple_of(4) {
            j.push(b' ');
        }
        let bin: Vec<u8> = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let total = 12 + 8 + j.len() + 8 + bin.len();
        let mut out = Vec::new();
        out.extend_from_slice(GLB_MAGIC);
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&(total as u32).to_le_bytes());
        out.extend_from_slice(&(j.len() as u32).to_le_bytes());
        out.extend_from_slice(&CHUNK_JSON.to_le_bytes());
        out.extend_from_slice(&j);
        out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
        out.extend_from_slice(&0x004E_4942u32.to_le_bytes());
        out.extend_from_slice(&bin);
        out
    }

    fn json_chunk(glb: &[u8]) -> serde_json::Value {
        let len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
        serde_json::from_slice(&glb[20..20 + len]).unwrap()
    }

    #[test]
    fn a_file_with_nothing_required_is_returned_untouched() {
        let src = glb_with(r#"{"asset":{"version":"2.0"}}"#);
        let out = relax_required_extensions(&src).unwrap();
        assert!(matches!(out, Cow::Borrowed(_)), "should not have copied");
    }

    #[test]
    fn quantization_is_dropped_from_the_required_list() {
        let src = glb_with(
            r#"{"asset":{"version":"2.0"},"extensionsUsed":["KHR_mesh_quantization"],"extensionsRequired":["KHR_mesh_quantization"]}"#,
        );
        let out = relax_required_extensions(&src).unwrap().into_owned();
        let root = json_chunk(&out);
        assert!(root.get("extensionsRequired").is_none());
        assert!(
            root.get("extensionsUsed").is_some(),
            "extensionsUsed must survive: it is only informational"
        );
    }

    #[test]
    fn the_rewritten_container_stays_a_valid_glb() {
        let src = glb_with(
            r#"{"asset":{"version":"2.0"},"extensionsRequired":["KHR_mesh_quantization"]}"#,
        );
        let out = relax_required_extensions(&src).unwrap().into_owned();
        assert_eq!(&out[0..4], GLB_MAGIC);
        assert_eq!(
            u32::from_le_bytes(out[8..12].try_into().unwrap()) as usize,
            out.len(),
            "the declared length must match"
        );
        let json_len = u32::from_le_bytes(out[12..16].try_into().unwrap()) as usize;
        assert!(json_len.is_multiple_of(4), "chunks stay four byte aligned");
        // The binary chunk must have survived byte for byte.
        assert_eq!(&out[out.len() - 8..], &[1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn compression_extensions_are_refused_with_a_usable_message() {
        let src = glb_with(
            r#"{"asset":{"version":"2.0"},"extensionsRequired":["EXT_meshopt_compression"]}"#,
        );
        let err = relax_required_extensions(&src).unwrap_err().to_string();
        assert!(err.contains("EXT_meshopt_compression"), "{err}");
        assert!(err.contains("gltfpack"), "the message should say what to do: {err}");
    }

    #[test]
    fn a_plain_gltf_document_is_relaxed_too() {
        let src = br#"{"asset":{"version":"2.0"},"extensionsRequired":["KHR_texture_transform"]}"#;
        let out = relax_required_extensions(src).unwrap().into_owned();
        let root: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert!(root.get("extensionsRequired").is_none());
    }

    #[test]
    fn junk_is_handed_on_rather_than_diagnosed_here() {
        let src = b"not json at all";
        assert!(matches!(
            relax_required_extensions(src).unwrap(),
            Cow::Borrowed(_)
        ));
    }
}
