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

    tauri_build::build()
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
