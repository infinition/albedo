//! glTF 2.0 import and export.
//!
//! Import leans on the `gltf` crate. Export is written by hand because `gltf`
//! only reads: a writer is roughly two hundred lines and saves pulling in a
//! second, heavier dependency for the one thing we do on every run.

mod accessor;
mod compat;
mod read;
mod write;

pub use compat::{relax_required_extensions, BLOCKING};
pub use read::{load_bytes, load_path};
pub use write::{save_path, to_bytes};
