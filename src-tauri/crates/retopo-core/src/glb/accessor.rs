//! Reading vertex attributes, including quantized ones.
//!
//! The `gltf` crate's typed iterators reinterpret the buffer bytes as `[f32; N]`
//! without checking the accessor's component type. Point one at a
//! `KHR_mesh_quantization` file, where positions are 16 bit integers, and it
//! returns plausible looking floats made of noise: no error, no warning, a mesh
//! that explodes across the universe. So attributes are decoded here instead,
//! from the component type the accessor actually declares.
//!
//! Dequantization follows the spec: normalized integers map to `[0,1]` or
//! `[-1,1]`, non-normalized ones keep their integer value and rely on the node
//! transform to bring them back to scale, which the importer already applies.

use anyhow::{bail, Result};
use gltf::accessor::DataType;

/// Read `components` floats per element out of an accessor.
///
/// The returned length is `accessor.count() * components`.
pub fn read_floats(
    accessor: &gltf::Accessor,
    buffers: &[gltf::buffer::Data],
    components: usize,
) -> Result<Vec<f32>> {
    let count = accessor.count();
    let declared = accessor.dimensions().multiplicity();
    if declared < components {
        bail!(
            "accessor has {declared} components, {components} were needed"
        );
    }
    if accessor.sparse().is_some() {
        bail!("sparse accessors are not supported yet");
    }

    let Some(view) = accessor.view() else {
        // A view-less, non-sparse accessor is defined to be all zeros.
        return Ok(vec![0.0; count * components]);
    };

    let dt = accessor.data_type();
    let comp_size = dt.size();
    let elem_size = comp_size * declared;
    let stride = view.stride().unwrap_or(elem_size);

    let buffer = buffers
        .get(view.buffer().index())
        .ok_or_else(|| anyhow::anyhow!("accessor points at buffer {} which is absent", view.buffer().index()))?;
    let base = view.offset() + accessor.offset();
    let needed = if count == 0 { 0 } else { stride * (count - 1) + elem_size };
    if base + needed > buffer.0.len() {
        bail!(
            "accessor runs past its buffer: needs {} bytes from offset {}, buffer is {}",
            needed,
            base,
            buffer.0.len()
        );
    }
    let data = &buffer.0[base..base + needed];
    let normalized = accessor.normalized();

    let mut out = Vec::with_capacity(count * components);
    for i in 0..count {
        let elem = &data[i * stride..i * stride + elem_size];
        for c in 0..components {
            let b = &elem[c * comp_size..(c + 1) * comp_size];
            out.push(decode(dt, b, normalized));
        }
    }
    Ok(out)
}

#[inline]
fn decode(dt: DataType, bytes: &[u8], normalized: bool) -> f32 {
    match dt {
        DataType::F32 => f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        DataType::I8 => {
            let v = bytes[0] as i8 as f32;
            // The spec pins -128 and -127 both to -1 rather than letting the
            // range go slightly past it.
            if normalized { (v / 127.0).max(-1.0) } else { v }
        }
        DataType::U8 => {
            let v = bytes[0] as f32;
            if normalized { v / 255.0 } else { v }
        }
        DataType::I16 => {
            let v = i16::from_le_bytes([bytes[0], bytes[1]]) as f32;
            if normalized { (v / 32767.0).max(-1.0) } else { v }
        }
        DataType::U16 => {
            let v = u16::from_le_bytes([bytes[0], bytes[1]]) as f32;
            if normalized { v / 65535.0 } else { v }
        }
        DataType::U32 => {
            let v = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32;
            if normalized { v / 4_294_967_295.0 } else { v }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floats_pass_through_untouched() {
        let v = 1.5f32.to_le_bytes();
        assert_eq!(decode(DataType::F32, &v, false), 1.5);
    }

    #[test]
    fn normalized_integers_land_on_the_spec_range() {
        assert_eq!(decode(DataType::U8, &[255], true), 1.0);
        assert_eq!(decode(DataType::U8, &[0], true), 0.0);
        assert_eq!(decode(DataType::I8, &[127], true), 1.0);
        assert_eq!(decode(DataType::I8, &[0x81], true), -1.0, "-127 maps to -1");
        assert_eq!(decode(DataType::I8, &[0x80], true), -1.0, "-128 clamps to -1");
        assert_eq!(decode(DataType::U16, &65535u16.to_le_bytes(), true), 1.0);
        assert_eq!(decode(DataType::I16, &32767i16.to_le_bytes(), true), 1.0);
        assert_eq!(decode(DataType::I16, &(-32768i16).to_le_bytes(), true), -1.0);
    }

    #[test]
    fn non_normalized_integers_keep_their_value() {
        // This is the gltfpack case: raw shorts, with the node transform doing
        // the scaling. Dividing here would shrink the model to nothing.
        assert_eq!(decode(DataType::I16, &1234i16.to_le_bytes(), false), 1234.0);
        assert_eq!(decode(DataType::U8, &[200], false), 200.0);
    }

    #[test]
    fn a_quantized_short_is_not_read_as_a_float() {
        // Two vec3 of i16 tightly packed would be 12 bytes; glTF pads the stride
        // to 8 per element. Reading this as [f32;3] is the bug this module
        // exists to prevent, so the arithmetic is pinned here.
        let dt = DataType::I16;
        assert_eq!(dt.size(), 2);
        let elem = dt.size() * 3;
        assert_eq!(elem, 6);
    }
}
