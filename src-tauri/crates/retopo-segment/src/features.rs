//! What each triangle is, expressed as numbers a clustering step can compare.
//!
//! Six of them, and they are deliberately of two different kinds. Four are
//! *identities*: which shell, which material, which UV island. Two are
//! *measurements*: the face normal, and the colour the atlas paints on it.
//! Identities can only ever be equal or not, which makes them barriers; a
//! measurement has a distance, which makes it a cost. Confusing the two is how a
//! segmenter ends up with a material weight it cannot tune.
//!
//! **Colour is the load bearing one here, and that is not the usual answer.**
//! The classical literature — Shapira, Katz, the whole Princeton benchmark —
//! segments untextured meshes, so none of it looks at colour at all. But a mesh
//! that came out of Hunyuan3D or Meshy arrives as one shell, one material and
//! one UV atlas, which means three of the six features are constant across the
//! entire model and carry exactly zero information. What actually separates the
//! ground from the rocks sitting on it, on that kind of input, is that somebody
//! painted them different colours.

use glam::{Vec2, Vec3};
use retopo_core::{Adjacency, Mesh};
use retopo_core::util::UnionFind;

/// Where inside a triangle the atlas gets sampled.
///
/// Six points rather than the centroid, because one bilinear tap on a detailed
/// atlas is noise rather than a colour: a triangle covering a hundred texels of
/// lichen would be read as whichever texel happened to sit under its middle.
///
/// All six stay clear of the edges. A sample landing exactly on a triangle
/// border is a sample landing on a UV island border in the atlas, where the
/// neighbouring chart's pixels have been bled outwards on purpose, and reading
/// that bleed is reading the wrong part of the model.
const SAMPLES: [[f32; 3]; 6] = [
    [0.3334, 0.3333, 0.3333],
    [0.6000, 0.2000, 0.2000],
    [0.2000, 0.6000, 0.2000],
    [0.2000, 0.2000, 0.6000],
    [0.4500, 0.4500, 0.1000],
    [0.1000, 0.4500, 0.4500],
];

/// One decoded sRGB channel, as linear light.
///
/// `Image::texel` hands back `u8 / 255.0` and stops there, which is the right
/// call for a bake writing the same encoding straight back out. It is the wrong
/// number to take a difference of: sRGB spends half its range on the darkest
/// fifth of the light, so two dark greys read as further apart than they are and
/// two bright ones as closer. Every colour distance below would be wrong by a
/// factor that varies with brightness, which is the sort of wrong that still
/// looks plausible in a screenshot.
#[inline]
fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Linear sRGB to OkLab.
///
/// OkLab rather than CIELAB: same job, one matrix and a cube root instead of a
/// white point and a piecewise transfer, and noticeably better hue linearity in
/// the blues, which is where CIELAB is known to bend. A plain euclidean distance
/// in here is a perceptual difference, which is what the merge cost wants.
#[inline]
pub fn linear_to_oklab(rgb: Vec3) -> Vec3 {
    let l = 0.412_221_5 * rgb.x + 0.536_332_5 * rgb.y + 0.051_445_995 * rgb.z;
    let m = 0.211_903_5 * rgb.x + 0.680_699_5 * rgb.y + 0.107_396_96 * rgb.z;
    let s = 0.088_302_46 * rgb.x + 0.281_718_85 * rgb.y + 0.629_978_7 * rgb.z;

    let l = l.cbrt();
    let m = m.cbrt();
    let s = s.cbrt();

    Vec3::new(
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    )
}

/// Everything known about every triangle, in arrays parallel to `Mesh::triangles`.
#[derive(Clone, Debug, Default)]
pub struct FaceFeatures {
    /// Connected component over the welded surface. Constant on an AI mesh.
    pub shell: Vec<u32>,
    /// The material slot the file gave this triangle.
    pub material: Vec<u32>,
    /// Chart id, where a chart stops at a UV seam.
    pub uv_island: Vec<u32>,
    pub normal: Vec<Vec3>,
    /// Area, used to weight everything that averages over a region.
    pub area: Vec<f32>,
    /// Mean surface colour, in OkLab.
    pub colour: Vec<Vec3>,
    /// Local object diameter, normalised. Filled by the SDF pass, absent until then.
    pub sdf: Option<Vec<f32>>,

    /// Whether `colour` came from an atlas rather than from flat material
    /// factors. False means every triangle of a material shares one value, so
    /// the colour term can only ever restate the material term.
    pub colour_is_textured: bool,
    /// How many distinct shells the mesh turned out to have.
    pub shell_count: usize,
    pub uv_island_count: usize,
}

/// Facts about each edge of the adjacency, which is where the cost lives.
#[derive(Clone, Debug, Default)]
pub struct EdgeFeatures {
    /// Signed: positive convex, negative concave. From `Adjacency::dihedral_angles`.
    pub dihedral: Vec<f32>,
    /// The two triangles disagree about the texture coordinate at this edge.
    pub uv_seam: Vec<bool>,
}

impl EdgeFeatures {
    pub fn build(mesh: &Mesh, adj: &Adjacency) -> Self {
        Self {
            dihedral: adj.dihedral_angles(mesh),
            uv_seam: uv_seams(mesh, adj),
        }
    }
}

/// One flag per edge: the two sides do not agree on the texture coordinate.
///
/// Asked of the *UVs* rather than of the render indices. Two triangles can hold
/// a welded point in two different render vertices for reasons that have nothing
/// to do with the atlas — a hard normal split does exactly that — and calling
/// those a seam would cut the model along every crease a second time.
fn uv_seams(mesh: &Mesh, adj: &Adjacency) -> Vec<bool> {
    if !mesh.has_uvs() {
        return vec![false; adj.edges.len()];
    }
    // Generous: a quantised exporter routinely lands the two sides of a shared
    // border a few ten-thousandths apart, and calling that a seam would shatter
    // the model into one island per triangle.
    const SAME: f32 = 1e-4;

    adj.edges
        .iter()
        .map(|e| {
            let (Some(a), Some(b)) = (e.tri[0], e.tri[1]) else {
                return false;
            };
            // For each shared welded endpoint, the UV each side reads there.
            for &w in &e.v {
                let ua = corner_uv(mesh, a as usize, w);
                let ub = corner_uv(mesh, b as usize, w);
                match (ua, ub) {
                    (Some(ua), Some(ub)) if ua.distance_squared(ub) > SAME * SAME => return true,
                    _ => {}
                }
            }
            false
        })
        .collect()
}

/// The UV that triangle `t` uses at welded point `w`, if it touches it at all.
#[inline]
fn corner_uv(mesh: &Mesh, t: usize, w: u32) -> Option<Vec2> {
    let f = mesh.triangles[t];
    for &c in &f {
        if mesh.weld[c as usize] == w {
            return mesh.uvs.get(c as usize).copied();
        }
    }
    None
}

impl FaceFeatures {
    pub fn build(mesh: &Mesh, adj: &Adjacency, edges: &EdgeFeatures) -> Self {
        let nt = mesh.triangle_count();

        let normal: Vec<Vec3> = (0..nt).map(|t| mesh.face_normal(t)).collect();
        let area: Vec<f32> = (0..nt).map(|t| mesh.face_area(t)).collect();
        let material = mesh.tri_material.clone();

        let (shell, shell_count) = components(nt, adj, |_| true);
        let (uv_island, uv_island_count) = components(nt, adj, |e| !edges.uv_seam[e]);
        let (colour, colour_is_textured) = surface_colours(mesh);

        Self {
            shell,
            material,
            uv_island,
            normal,
            area,
            colour,
            sdf: None,
            colour_is_textured,
            shell_count,
            uv_island_count,
        }
    }
}

/// Label every triangle by the connected component it belongs to, crossing only
/// the edges `passable` accepts.
///
/// One routine for two questions: with every edge passable it answers "which
/// shell", and with the seams closed it answers "which UV island". They are the
/// same walk over the same graph and there is no reason to write it twice.
///
/// Ids come out dense and in first-seen order, so a caller can size an array by
/// the count rather than by the maximum.
fn components(nt: usize, adj: &Adjacency, passable: impl Fn(usize) -> bool) -> (Vec<u32>, usize) {
    let mut uf = UnionFind::new(nt);
    for (id, e) in adj.edges.iter().enumerate() {
        let (Some(a), Some(b)) = (e.tri[0], e.tri[1]) else {
            continue;
        };
        if passable(id) {
            uf.union(a, b);
        }
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

/// The mean colour of every triangle, in OkLab.
///
/// Averaged in linear light and converted once at the end, rather than converted
/// per sample and averaged in OkLab. The mean of six texels is a question about
/// light, and OkLab is not linear in light: averaging in it would pull the
/// result toward whichever sample was darkest.
///
/// Returns false alongside when no material on the mesh carries a base colour
/// texture, meaning every value here is a material constant wearing a colour's
/// clothes.
fn surface_colours(mesh: &Mesh) -> (Vec<Vec3>, bool) {
    let textured = mesh
        .materials
        .iter()
        .any(|m| m.base_color_texture.is_some_and(|i| i < mesh.images.len()));

    let flat: Vec<Vec3> = mesh
        .materials
        .iter()
        .map(|m| {
            linear_to_oklab(Vec3::new(
                srgb_to_linear(m.base_color[0]),
                srgb_to_linear(m.base_color[1]),
                srgb_to_linear(m.base_color[2]),
            ))
        })
        .collect();
    // glTF says the base colour factor is already linear, unlike the texture it
    // multiplies. Decoding it above is therefore wrong in principle and right in
    // practice: exporters write it as the sRGB value the artist picked far more
    // often than not, and the two only disagree on a model with no texture at
    // all, where every face shares one value and the difference cancels.
    let fallback = |t: usize| -> Vec3 {
        mesh.tri_material
            .get(t)
            .and_then(|&m| flat.get(m as usize))
            .copied()
            .unwrap_or(Vec3::ZERO)
    };

    if !textured || !mesh.has_uvs() {
        return ((0..mesh.triangle_count()).map(fallback).collect(), false);
    }

    let colours = (0..mesh.triangle_count())
        .map(|t| {
            let slot = mesh.tri_material.get(t).copied().unwrap_or(0) as usize;
            let Some(mat) = mesh.materials.get(slot) else {
                return fallback(t);
            };
            let Some(img) = mat
                .base_color_texture
                .and_then(|i| mesh.images.get(i))
                .filter(|i| i.width > 0 && i.height > 0)
            else {
                return fallback(t);
            };

            let f = mesh.triangles[t];
            let uv = [
                mesh.uvs[f[0] as usize],
                mesh.uvs[f[1] as usize],
                mesh.uvs[f[2] as usize],
            ];

            let mut sum = Vec3::ZERO;
            for w in SAMPLES {
                let at = mat
                    .base_color_uv
                    .apply(uv[0] * w[0] + uv[1] * w[1] + uv[2] * w[2]);
                let px = img.sample(at);
                sum += Vec3::new(
                    srgb_to_linear(px[0]),
                    srgb_to_linear(px[1]),
                    srgb_to_linear(px[2]),
                );
            }
            let mean = sum / SAMPLES.len() as f32;
            // The factor multiplies the texture, in linear light, per glTF.
            let tint = Vec3::from_slice(&mat.base_color[..3]);
            linear_to_oklab(mean * tint)
        })
        .collect();

    (colours, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use retopo_core::mesh::{Image, Material};

    /// Two triangles sharing one edge, flat, one material.
    fn quad() -> Mesh {
        let mut m = Mesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(1.0, 1.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            ],
            uvs: vec![
                Vec2::new(0.0, 0.0),
                Vec2::new(1.0, 0.0),
                Vec2::new(1.0, 1.0),
                Vec2::new(0.0, 1.0),
            ],
            triangles: vec![[0, 1, 2], [0, 2, 3]],
            tri_material: vec![0, 0],
            materials: vec![Material::default()],
            ..Default::default()
        };
        m.normals = vec![Vec3::Z; 4];
        m.rebuild_weld(0.0);
        m
    }

    /// Two quads that share no vertex at all.
    fn two_shells() -> Mesh {
        let mut m = quad();
        let base = m.positions.len() as u32;
        for i in 0..4 {
            let p = m.positions[i] + Vec3::new(10.0, 0.0, 0.0);
            let uv = m.uvs[i];
            m.positions.push(p);
            m.normals.push(Vec3::Z);
            m.uvs.push(uv);
        }
        m.triangles.push([base, base + 1, base + 2]);
        m.triangles.push([base, base + 2, base + 3]);
        m.tri_material.extend([0, 0]);
        m.rebuild_weld(0.0);
        m
    }

    #[test]
    fn one_quad_is_one_shell_and_one_island() {
        let m = quad();
        let adj = Adjacency::build(&m);
        let ef = EdgeFeatures::build(&m, &adj);
        let ff = FaceFeatures::build(&m, &adj, &ef);
        assert_eq!(ff.shell_count, 1);
        assert_eq!(ff.shell, vec![0, 0]);
        assert_eq!(ff.uv_island_count, 1, "a continuous UV map has no seam");
    }

    #[test]
    fn disjoint_quads_are_two_shells() {
        let m = two_shells();
        let adj = Adjacency::build(&m);
        let ef = EdgeFeatures::build(&m, &adj);
        let ff = FaceFeatures::build(&m, &adj, &ef);
        assert_eq!(ff.shell_count, 2);
        assert_eq!(ff.shell, vec![0, 0, 1, 1]);
    }

    #[test]
    fn a_uv_jump_across_the_shared_edge_is_a_seam() {
        let mut m = quad();
        // Tear the second triangle's texture coordinates away from the first's,
        // keeping the geometry welded. That is what a seam is.
        let (p0, p2) = (m.positions[0], m.positions[2]);
        m.positions.push(p0);
        m.positions.push(p2);
        m.normals.push(Vec3::Z);
        m.normals.push(Vec3::Z);
        m.uvs.push(Vec2::new(0.5, 0.0));
        m.uvs.push(Vec2::new(0.5, 1.0));
        m.triangles[1] = [4, 5, 3];
        m.rebuild_weld(0.0);

        let adj = Adjacency::build(&m);
        let ef = EdgeFeatures::build(&m, &adj);
        assert!(ef.uv_seam.iter().any(|&s| s), "the shared edge is a seam");
        let ff = FaceFeatures::build(&m, &adj, &ef);
        assert_eq!(ff.shell_count, 1, "a seam does not cut the surface");
        assert_eq!(ff.uv_island_count, 2, "but it does cut the atlas");
    }

    #[test]
    fn an_untextured_mesh_reports_its_colour_as_flat() {
        let m = quad();
        let adj = Adjacency::build(&m);
        let ef = EdgeFeatures::build(&m, &adj);
        let ff = FaceFeatures::build(&m, &adj, &ef);
        assert!(!ff.colour_is_textured);
        assert_eq!(ff.colour[0], ff.colour[1], "one material, one colour");
    }

    #[test]
    fn two_halves_of_an_atlas_give_two_colours() {
        let mut m = quad();
        // Left half red, right half green. The diagonal of the quad runs from
        // (0,0) to (1,1), so one triangle sits mostly left and the other right.
        let mut img = Image::new(2, 1);
        img.rgba.copy_from_slice(&[255, 0, 0, 255, 0, 255, 0, 255]);
        m.images.push(img);
        m.materials[0].base_color_texture = Some(0);

        let adj = Adjacency::build(&m);
        let ef = EdgeFeatures::build(&m, &adj);
        let ff = FaceFeatures::build(&m, &adj, &ef);
        assert!(ff.colour_is_textured);
        assert!(
            ff.colour[0].distance(ff.colour[1]) > 0.1,
            "red and green are not the same colour: {:?} vs {:?}",
            ff.colour[0],
            ff.colour[1]
        );
    }

    #[test]
    fn oklab_puts_black_at_the_origin_and_white_at_one() {
        let black = linear_to_oklab(Vec3::ZERO);
        let white = linear_to_oklab(Vec3::ONE);
        assert!(black.length() < 1e-5, "black is the origin, got {black:?}");
        assert!((white.x - 1.0).abs() < 1e-3, "white is L=1, got {white:?}");
        assert!(white.y.abs() < 1e-3 && white.z.abs() < 1e-3, "white has no chroma");
    }

    #[test]
    fn srgb_decode_is_monotone_and_pins_the_ends() {
        assert_eq!(srgb_to_linear(0.0), 0.0);
        assert!((srgb_to_linear(1.0) - 1.0).abs() < 1e-6);
        // Mid grey is famously not 0.5 in linear light, which is the whole point
        // of decoding before taking a difference.
        assert!(srgb_to_linear(0.5) < 0.25);
    }
}
