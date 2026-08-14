//! Decimation and remeshing for Albedo's retopology engine.
//!
//! Step 1 ships quadric error decimation, which is what makes the viewer useful
//! on day one. The field-aligned quad remesher (a Rust port of Instant
//! Field-Aligned Meshes, BSD 3-Clause) lands in step 3 next to it.

pub mod decimate;
pub mod holes;
pub mod isotropic;
pub mod quadric;
pub mod quads;
pub mod relax;

pub use decimate::{decimate, DecimateOptions, DecimateStats};
pub use holes::{boundary_loops, fill_holes, FillOptions, FillStats};
pub use isotropic::{isotropic, IsotropicOptions, IsotropicStats};
pub use quadric::Quadric;
pub use quads::{pair_into_quads, Pairing, QuadOptions, QuadStats};
pub use relax::{relax, RelaxOptions, RelaxStats};
