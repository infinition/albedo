//! Decimation and remeshing for Albedo's retopology engine.
//!
//! Quadric decimation, feature-preserving uniform/adaptive triangle remeshing,
//! and direction-guided quad pairing. Pairing is quad-dominant; it does not
//! promise a globally parameterized quad layout or animation-ready loops.

pub mod decimate;
mod field;
pub mod holes;
pub mod isotropic;
pub mod quadric;
pub mod quads;
pub mod relax;
mod sizing;

pub use decimate::{decimate, DecimateOptions, DecimateStats};
pub use holes::{boundary_loops, fill_holes, FillOptions, FillStats};
pub use isotropic::{isotropic, IsotropicOptions, IsotropicStats};
pub use quadric::Quadric;
pub use quads::{pair_into_quads, Pairing, QuadOptions, QuadStats};
pub use relax::{relax, RelaxOptions, RelaxStats};
