//! UV atlas generation and high to low poly texture transfer.
//!
//! This is what makes a decimated mesh usable. Carrying the original UV layout
//! through a heavy decimation tears it: every point that disappears hands its
//! texture coordinates to a survivor, and past a certain reduction that guess is
//! wrong almost everywhere. Baking sidesteps the problem entirely by building a
//! fresh atlas and reading the colour back off the high poly surface.

pub mod atlas;
pub mod bake;

pub use atlas::{from_uvs, unwrap, Atlas, AtlasOptions};
pub use bake::{bake, BakeOptions, BakeResult, BakeStats, PatchOptions};
