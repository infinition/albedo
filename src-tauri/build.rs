use std::path::Path;

fn main() {
    // The frontend is baked into the binary at compile time, and cargo only
    // rebuilds when it sees a reason to. With no Rust file touched it declared
    // the executable fresh and kept the assets already inside it: a whole
    // afternoon of frontend work could be built, shipped and run without a
    // single change reaching the window. Watching the bundle makes the compiler
    // agree with the truth.
    watch(Path::new("../dist"));
    println!("cargo:rerun-if-changed=../index.html");
    println!("cargo:rerun-if-changed=../src");

    embed_thumbnail_provider();
    tauri_build::build()
}

/// Carry the shell provider inside the executable, when there is one to carry.
///
/// A single file that can be handed to someone has to hold everything it needs;
/// a provider shipped beside it is a provider that gets separated from it. The
/// bytes are written into a generated file rather than reached with a bare
/// `include_bytes!`, because that would make the whole application refuse to
/// compile on a tree where the provider has not been built yet. Absent, the
/// application still builds and still runs, and only says the integration is
/// unavailable.
fn embed_thumbnail_provider() {
    let dll = Path::new("../shell-thumbnails/target/release/albedo_thumbnails.dll");
    println!("cargo:rerun-if-changed={}", dll.display());

    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("provider.rs");
    let body = match std::fs::canonicalize(dll) {
        Ok(full) => format!(
            "pub const PROVIDER: Option<&[u8]> = Some(include_bytes!(r\"{}\"));",
            full.display()
        ),
        Err(_) => "pub const PROVIDER: Option<&[u8]> = None;".to_string(),
    };
    std::fs::write(out, body).expect("write provider.rs");
}

/// `rerun-if-changed` on a directory only covers its own entries, so the tree
/// is walked and each file named.
fn watch(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    println!("cargo:rerun-if-changed={}", dir.display());
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            watch(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}
