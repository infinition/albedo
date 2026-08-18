//! Geometry core for Albedo's retopology engine.
//!
//! Everything downstream (decimation, field-aligned remeshing, segmentation,
//! baking) is written against the types in here, so the invariants documented on
//! [`Mesh`] are the contract for the whole tool.

pub mod adjacency;
pub mod bvh;
pub mod glb;
pub mod mesh;
pub mod paint;
pub mod util;
pub mod wire;

pub use adjacency::{Adjacency, Edge};
pub use bvh::{Bvh, ClosestHit, RayHit};
pub use mesh::{Aabb, AlphaMode, Image, Material, Mesh, UvTransform};
pub use paint::{Guide, PaintField, Painting, Sample, VertexField};

pub use glam;
