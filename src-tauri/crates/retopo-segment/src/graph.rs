//! What it costs to decide two neighbouring pieces of surface are one part.
//!
//! Every term below answers on the same scale: zero means "these are
//! indistinguishable", one means "as different as this feature gets". That is
//! not tidiness for its own sake. It is what makes the weights mean anything: a
//! colour weight of 2 and a crease weight of 1 says colour matters twice as
//! much, and it only says that if neither term can quietly run to a hundred
//! while the other tops out at one.
//!
//! **Concave and convex are not the same event and do not share a weight.** The
//! gap between two fingers is concave, and so is the line where a rock meets the
//! ground it sits on; that is the boundary a segmenter exists to find. A ridge
//! along the top of the same rock is convex and usually runs through the
//! *middle* of a part rather than around it. Giving them one weight forces a
//! choice between missing the first and inventing the second, which is the
//! failure the signed dihedral in `retopo-core` was put there to avoid.

use glam::Vec3;
use serde::{Deserialize, Serialize};

use crate::features::{EdgeFeatures, FaceFeatures};

/// A colour difference that counts as completely different.
///
/// In OkLab, one unit of L is black to white, a just-noticeable difference is
/// around 0.02, and two colours a person would call unrelated sit around 0.3.
/// Anything past that is still "different", not "more different", so the term
/// saturates rather than growing without bound and drowning every other signal.
const COLOUR_FULL: f32 = 0.30;

/// How much each feature counts. All non negative; zero switches one off.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Weights {
    /// A fold inwards. The strongest part boundary there is.
    pub concavity: f32,
    /// A fold outwards. Deliberately much weaker, see the module docs.
    pub convexity: f32,
    /// Distance between mean surface colours, in OkLab.
    pub colour: f32,
    /// How far the two surfaces face apart, independent of any crease between
    /// them. This is what separates a flat ground plane from a wall standing on
    /// it when the join has been smoothed and there is no crease left to find.
    pub normal: f32,
    /// Difference in local object thickness. Separates a thin limb from the
    /// thick body it grows out of.
    pub sdf: f32,
}

impl Default for Weights {
    fn default() -> Self {
        Self {
            concavity: 1.0,
            convexity: 0.25,
            // Above the others on purpose. On the input this tool exists for,
            // one shell, one material, one atlas, colour is the only feature
            // carrying information about anything the geometry does not already
            // say twice.
            colour: 1.4,
            normal: 0.5,
            sdf: 0.6,
        }
    }
}

/// Identities that stop a merge outright rather than making it expensive.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Barriers {
    /// Two triangles the file gave different materials are never one group.
    pub material: bool,
    /// Two disconnected pieces of surface are never one group.
    ///
    /// On by default and almost free: on an AI mesh there is only one shell, so
    /// it costs nothing; on a kitbash it does the obvious right thing.
    pub shell: bool,
    /// Two triangles on opposite sides of a UV seam are never one group.
    ///
    /// **Off by default, and that is the important default in this struct.** On
    /// a hand-authored asset the islands follow the parts and this is free
    /// accuracy. On an atlas an AI packer produced, the islands are arbitrary
    /// chunks cut for packing efficiency, and treating them as barriers shatters
    /// every group along lines that mean nothing about the model.
    pub uv_island: bool,
}

impl Default for Barriers {
    fn default() -> Self {
        Self {
            material: true,
            shell: true,
            uv_island: false,
        }
    }
}

/// Everything the caller may set.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SegmentOptions {
    pub weights: Weights,
    pub barriers: Barriers,

    /// Colour difference, in OkLab, below which the pre-merge calls two
    /// triangles the same colour.
    ///
    /// **A tolerance and not a cost, and that distinction was paid for.** This
    /// used to be a threshold on the same weighted cost the clustering uses,
    /// which made it meaningless in two directions at once: raising the colour
    /// weight silently tightened it, and on a real textured model the ordinary
    /// grain of a photograph already exceeded it, so a 700, 000 triangle mesh
    /// produced 630, 000 superfaces and the pre-merge did nothing at all.
    ///
    /// The default is a just-noticeable difference. Below it, two triangles are
    /// not "similar enough to risk merging"; they are the same colour.
    pub superface_colour: f32,
    /// Dihedral angle, in degrees, below which the pre-merge sees no crease.
    pub superface_angle_deg: f32,
    /// Ceiling on how many triangles one superface may swallow.
    ///
    /// A threshold merge is single linkage, and single linkage chains: a smooth
    /// gradient from sand to grass has no single edge above the threshold
    /// anywhere along it, so without a ceiling the whole gradient becomes one
    /// superface and no later stage can undo it.
    pub max_superface_faces: u32,

    /// A region smaller than this share of the total area is pulled into its
    /// neighbours first, whatever it looks like.
    ///
    /// Handled inside the hierarchy rather than as a pass afterwards, so that
    /// no position of the slider ever shows confetti.
    pub min_area_ratio: f32,

    /// Measure local thickness. The expensive feature, and the only one that
    /// needs a BVH and a few hundred thousand rays.
    ///
    /// Off until the pass that fills it exists. The weight above is read
    /// regardless, and reads zero, so turning this on later changes results
    /// rather than breaking callers.
    pub sdf: bool,
    /// Rays per superface.
    pub sdf_rays: u32,
    /// Half angle of the cone they are fired into, in degrees.
    pub sdf_cone_deg: f32,
}

impl Default for SegmentOptions {
    fn default() -> Self {
        Self {
            weights: Weights::default(),
            barriers: Barriers::default(),
            // Measured rather than picked. At a just-noticeable 0.02 and three
            // degrees, a 119k triangle model kept 69k superfaces, which is the
            // pre-merge barely running; at 0.04 and twelve it kept 31k, which
            // starts risking a real crease on a hard surface model. These sit
            // between, at about one and a half JND and an angle below anything
            // anybody models on purpose.
            superface_colour: 0.03,
            superface_angle_deg: 6.0,
            max_superface_faces: 2048,
            min_area_ratio: 0.0015,
            sdf: false,
            sdf_rays: 24,
            sdf_cone_deg: 60.0,
        }
    }
}

/// The dissimilarity of the two faces meeting at one edge, in `0..=1` per term.
///
/// Returned split rather than summed, because the clustering stage averages the
/// crease part along a whole shared border while taking the others from region
/// means. Summing here would force it to un-sum them.
#[derive(Clone, Copy, Debug, Default)]
pub struct EdgeTerms {
    /// Crease, already weighted, since concave and convex fold into one number
    /// that nothing downstream needs to take apart again.
    pub crease: f32,
    /// True when no weight in the world should join these two.
    pub barrier: bool,
}

/// Read one edge of the adjacency.
pub fn edge_terms(
    edge: usize,
    a: usize,
    b: usize,
    ff: &FaceFeatures,
    ef: &EdgeFeatures,
    opts: &SegmentOptions,
) -> EdgeTerms {
    let barrier = (opts.barriers.material && ff.material[a] != ff.material[b])
        || (opts.barriers.shell && ff.shell[a] != ff.shell[b])
        || (opts.barriers.uv_island && ff.uv_island[a] != ff.uv_island[b])
        // Imported labels have no switch. Somebody supplied an answer about
        // this mesh; honouring it only when a checkbox agrees would make the
        // import mean something different from what it says.
        || (!ff.label.is_empty() && ff.label[a] != ff.label[b]);

    // Positive is convex, negative is concave. Pinned by a test in this crate
    // rather than taken on trust from the doc comment upstream, because the
    // whole asymmetry below is built on it.
    let d = ef.dihedral[edge];
    let concave = (-d).max(0.0) / std::f32::consts::PI;
    let convex = d.max(0.0) / std::f32::consts::PI;
    let crease = opts.weights.concavity * concave + opts.weights.convexity * convex;

    EdgeTerms { crease, barrier }
}

/// How unlike each other two regions are, from their means.
///
/// `crease` arrives already averaged along the border the two share.
pub fn region_cost(
    crease: f32,
    colour_a: Vec3,
    colour_b: Vec3,
    normal_a: Vec3,
    normal_b: Vec3,
    sdf_a: f32,
    sdf_b: f32,
    opts: &SegmentOptions,
) -> f32 {
    let w = &opts.weights;

    let colour = (colour_a.distance(colour_b) / COLOUR_FULL).min(1.0);
    // Zero when the two face the same way, one when they face opposite ways.
    let normal = ((1.0 - normal_a.dot(normal_b)) * 0.5).clamp(0.0, 1.0);
    let sdf = (sdf_a - sdf_b).abs().clamp(0.0, 1.0);

    crease + w.colour * colour + w.normal * normal + w.sdf * sdf
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;
    use retopo_core::mesh::{Material, Mesh};
    use retopo_core::Adjacency;

    /// A hinge: two triangles sharing the edge from (0, 0, 0) to (1, 0, 0), the
    /// second folded out of the plane by `lift` along z.
    ///
    /// Positive `lift` folds the second triangle up towards the first's normal
    /// side, which is a valley, which is concave.
    fn hinge(lift: f32) -> Mesh {
        let mut m = Mesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.5, 1.0, 0.0),
                Vec3::new(0.5, -1.0, lift),
            ],
            normals: vec![Vec3::Z; 4],
            triangles: vec![[0, 1, 2], [1, 0, 3]],
            tri_material: vec![0, 0],
            materials: vec![Material::default()],
            ..Default::default()
        };
        m.rebuild_weld(0.0);
        m
    }

    fn interior_dihedral(m: &Mesh) -> f32 {
        let adj = Adjacency::build(m);
        let e = adj.edges.iter().position(|e| !e.is_boundary()).unwrap();
        adj.dihedral_angles(m)[e]
    }

    /// The one assumption every weight in this module rests on.
    ///
    /// `retopo-core` documents the convention in its header and then contradicts
    /// itself in an inline comment three lines further down, so it is pinned
    /// here rather than believed.
    #[test]
    fn the_dihedral_sign_is_positive_for_convex_and_negative_for_concave() {
        let valley = interior_dihedral(&hinge(1.0));
        let ridge = interior_dihedral(&hinge(-1.0));
        assert!(valley < 0.0, "a valley folds inwards: got {valley}");
        assert!(ridge > 0.0, "a ridge folds outwards: got {ridge}");
        assert!(
            (valley.abs() - ridge.abs()).abs() < 1e-4,
            "the two folds are mirror images and should measure the same angle"
        );
    }

    #[test]
    fn a_concave_fold_costs_more_than_the_convex_one_of_the_same_angle() {
        let opts = SegmentOptions::default();
        let pi = std::f32::consts::PI;

        let ef = EdgeFeatures {
            dihedral: vec![-pi * 0.5, pi * 0.5],
            uv_seam: vec![false, false],
        };
        let ff = FaceFeatures {
            shell: vec![0, 0],
            material: vec![0, 0],
            uv_island: vec![0, 0],
            ..Default::default()
        };

        let concave = edge_terms(0, 0, 1, &ff, &ef, &opts);
        let convex = edge_terms(1, 0, 1, &ff, &ef, &opts);
        assert!(
            concave.crease > convex.crease * 2.0,
            "concave {} should dominate convex {}",
            concave.crease,
            convex.crease
        );
    }

    #[test]
    fn a_material_change_is_a_barrier_and_a_uv_seam_is_not_by_default() {
        let opts = SegmentOptions::default();
        let ef = EdgeFeatures {
            dihedral: vec![0.0],
            uv_seam: vec![true],
        };

        let mut ff = FaceFeatures {
            shell: vec![0, 0],
            material: vec![0, 1],
            uv_island: vec![0, 1],
            ..Default::default()
        };
        assert!(edge_terms(0, 0, 1, &ff, &ef, &opts).barrier);

        ff.material = vec![0, 0];
        assert!(
            !edge_terms(0, 0, 1, &ff, &ef, &opts).barrier,
            "an AI atlas cuts its islands for packing, not for meaning"
        );

        let strict = SegmentOptions {
            barriers: Barriers {
                uv_island: true,
                ..Barriers::default()
            },
            ..opts
        };
        assert!(edge_terms(0, 0, 1, &ff, &ef, &strict).barrier);
    }

    #[test]
    fn the_colour_term_saturates_instead_of_running_away() {
        let opts = SegmentOptions::default();
        let flat = Vec3::Z;
        let near = region_cost(0.0, Vec3::ZERO, Vec3::X * 0.3, flat, flat, 0.0, 0.0, &opts);
        let far = region_cost(0.0, Vec3::ZERO, Vec3::X * 3.0, flat, flat, 0.0, 0.0, &opts);
        assert!((near - far).abs() < 1e-5, "past 0.3 OkLab it is just different");
        assert!((far - opts.weights.colour).abs() < 1e-5);
    }

    #[test]
    fn identical_regions_cost_nothing() {
        let opts = SegmentOptions::default();
        let c = Vec3::new(0.5, 0.1, -0.1);
        assert_eq!(region_cost(0.0, c, c, Vec3::Z, Vec3::Z, 0.4, 0.4, &opts), 0.0);
    }
}
