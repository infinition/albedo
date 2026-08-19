//! Segmentation, the Rust half.
//!
//! Mirrors `retopo.rs` deliberately, down to the child process and the stdout
//! line protocol, because the reasons are the same ones and they are written
//! out at length over there: the release profile keeps `panic = "abort"`, so a
//! malformed mesh reaching an unchecked index has to take a *child* down rather
//! than the window; and a model worth segmenting is tens of megabytes, so it
//! travels as a file rather than as a JSON array of numbers.
//!
//! What is different is the shape of the answer. Retopology hands back a mesh.
//! Segmentation hands back four flat arrays about the mesh you already have,
//! which superface each triangle is in, which superfaces sit across its three
//! edges, the merge order, and what each merge cost, and the interface turns
//! those into every level of the hierarchy without asking again.
//!
//! **They are written as raw little-endian binary, not as JSON.** The existing
//! `retopo_sidecar` returns a `Vec<f32>` and Tauri serialises that as a JSON
//! number array, which is fine for the five thousand triangles of a decimated
//! result and is not fine here: this runs on the *source* mesh, two orders of
//! magnitude larger, where the neighbour table alone is six megabytes and would
//! arrive as twelve megabytes of text to parse. Little-endian because every
//! platform Albedo runs on is, and because the browser side reads these straight
//! into a `Uint32Array`, which uses the platform's own order.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use retopo_core::glb;
use retopo_segment::{SegmentOptions, SegmentReport};

/// This engine's own slot and its own cancel flag.
///
/// Not shared with retopology's, so that pressing Annuler on a decimation
/// cannot reach across and kill a segmentation running beside it. They are
/// separate operations on the same model and a person may well want both.
static RUNNING: Mutex<Option<std::process::Child>> = Mutex::new(None);
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// Where a sidecar for `base` lives. Same convention as the retopology engine's.
fn sidecar(base: &Path, ext: &str) -> PathBuf {
    let mut name = base.file_name().unwrap_or_default().to_os_string();
    name.push(".");
    name.push(ext);
    base.with_file_name(name)
}

fn write_u32(path: &Path, values: &[u32]) -> Result<(), String> {
    let mut out = Vec::with_capacity(values.len() * 4);
    for &v in values {
        out.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, out).map_err(|e| format!("écriture de {} : {e}", path.display()))
}

fn write_f32(path: &Path, values: &[f32]) -> Result<(), String> {
    let mut out = Vec::with_capacity(values.len() * 4);
    for &v in values {
        out.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, out).map_err(|e| format!("écriture de {} : {e}", path.display()))
}

/// Read a part label per triangle, as some other tool wrote it.
///
/// **This is the whole neural bridge.** PartField, P3-SAM and SAMesh all end at
/// the same place, one integer per face and nothing else, so that is the only
/// thing this has to understand, and understanding it is enough for the slider,
/// the families, the split and the map to work on their answers without any of
/// them learning where the answer came from.
///
/// Two spellings accepted, because those tools write both: a JSON array of
/// numbers, which is what a Python demo dumps in one line, and raw
/// little-endian `u32`, which is what `numpy.ndarray.tofile` produces.
///
/// The labels are in the *file's* numbering, so they go through the same
/// renumbering the reader applied when it dropped degenerate faces. A label
/// array of the wrong length is refused by name rather than trusted: it can only
/// mean it describes a different mesh.
fn read_labels(path: &Path, mesh: &retopo_core::Mesh) -> Result<Vec<u32>, String> {
    let raw = std::fs::read(path).map_err(|e| format!("lecture de {}: {e}", path.display()))?;

    let parsed: Vec<u32> = match serde_json::from_slice::<Vec<i64>>(&raw) {
        Ok(list) => list.into_iter().map(|v| v.max(0) as u32).collect(),
        Err(_) => {
            if raw.len() % 4 != 0 || raw.is_empty() {
                return Err(format!(
                    "{} n'est ni un tableau JSON ni une suite d'entiers 32 bits",
                    path.display()
                ));
            }
            raw.chunks_exact(4)
                .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect()
        }
    };

    // How many triangles the file had, which is what the labels are counted in.
    let in_file = if mesh.from_source.is_empty() {
        mesh.triangle_count()
    } else {
        mesh.from_source.len()
    };
    if parsed.len() != in_file {
        return Err(format!(
            "ce fichier d'étiquettes en compte {} alors que le modèle a {} triangles : il décrit un autre maillage",
            parsed.len(),
            in_file
        ));
    }

    if mesh.from_source.is_empty() {
        return Ok(parsed);
    }
    let mut out = vec![0u32; mesh.triangle_count()];
    for (old, &new) in mesh.from_source.iter().enumerate() {
        if new != u32::MAX {
            out[new as usize] = parsed[old];
        }
    }
    Ok(out)
}

/// Segment one file and leave the four sidecars beside `base`.
pub fn segment_file(
    input: &Path,
    base: &Path,
    opts: &SegmentOptions,
    labels: Option<&Path>,
    progress: &mut dyn FnMut(f32),
) -> Result<SegmentReport, String> {
    let mesh = glb::load_path(input).map_err(|e| format!("{e:#}"))?;
    let labels = match labels {
        Some(path) => Some(read_labels(path, &mesh)?),
        None => None,
    };
    let result = retopo_segment::segment_with(&mesh, opts, labels.as_deref(), progress);
    let d = &result.dendrogram;

    /*
     * Answers are given back in the *file's* triangle numbering, not the
     * engine's.
     *
     * The reader drops degenerate faces on import, because they have no normal,
     * break the BVH's surface area heuristic and turn quadric errors into NaN.
     * That is the right thing to do and it silently renumbers every triangle
     * after the first one dropped. A caller laying these ids back onto the mesh
     * it exported would be off by that many from there on, a segmentation that
     * renders perfectly and is wrong. Measured in practice: a 900, 328 triangle
     * column arrived at the engine as 900, 290.
     *
     * Dropped triangles get `u32::MAX`, which the viewer already reads as "no
     * group" and leaves alone. A zero-area triangle has nothing to paint anyway.
     */
    let expand = |values: &[u32], stride: usize| -> Vec<u32> {
        if mesh.from_source.is_empty() {
            return values.to_vec();
        }
        let mut out = vec![u32::MAX; mesh.from_source.len() * stride];
        for (old, &new) in mesh.from_source.iter().enumerate() {
            if new == u32::MAX {
                continue;
            }
            let (a, b) = (new as usize * stride, old * stride);
            out[b..b + stride].copy_from_slice(&values[a..a + stride]);
        }
        out
    };

    write_u32(&sidecar(base, "super"), &expand(&d.super_of_face, 1))?;

    let mut flat = Vec::with_capacity(d.nbr_of_face.len() * 3);
    for n in &d.nbr_of_face {
        flat.extend_from_slice(n);
    }
    write_u32(&sidecar(base, "nbr"), &expand(&flat, 3))?;

    let mut pairs = Vec::with_capacity(d.merges.len() * 2);
    for m in &d.merges {
        pairs.extend_from_slice(m);
    }
    write_u32(&sidecar(base, "merges"), &pairs)?;
    write_f32(&sidecar(base, "costs"), &d.costs)?;

    // Four per superface: the mean colour in OkLab, then the area. What the
    // interface groups disconnected parts by, since the hierarchy above can
    // only ever join things that touch.
    let mut feat = Vec::with_capacity(d.super_colour.len() * 4);
    for (c, a) in d.super_colour.iter().zip(d.super_area.iter()) {
        feat.extend_from_slice(c);
        feat.push(*a);
    }
    write_f32(&sidecar(base, "feat"), &feat)?;

    let mut report = result.report;
    // The count the caller can check against is the one in the file it sent,
    // not the one left after the reader tidied it up.
    if !mesh.from_source.is_empty() {
        report.triangles = mesh.from_source.len();
        report.dropped_triangles = mesh.from_source.len() - mesh.triangles.len();
    }
    Ok(report)
}

// --- the tab ---------------------------------------------------------------

/// Where a run's files live.
#[derive(Clone, Debug, serde::Serialize)]
pub struct SegmentWorkdir {
    /// Where the front end writes the GLB it exported.
    pub input: String,
    /// The prefix the four sidecars hang off.
    pub base: String,
}

/// Pick the paths, in Rust, so the front end never builds one.
///
/// Stamped with the clock for the same reason the retopology workdir is: the
/// viewer caches by URL, and a second run writing over the first would be served
/// the first one's bytes.
#[tauri::command]
pub fn segment_workdir() -> Result<SegmentWorkdir, String> {
    let dir = std::env::temp_dir().join(format!("albedo-segment-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("dossier de travail impossible: {e}"))?;
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(SegmentWorkdir {
        input: dir.join("source.glb").to_string_lossy().into_owned(),
        base: dir.join(format!("groups-{n}")).to_string_lossy().into_owned(),
    })
}

/// Run the engine in a child copy of this executable.
#[tauri::command]
pub async fn segment_run(
    app: tauri::AppHandle,
    input: String,
    base: String,
    request: SegmentOptions,
    labels: Option<String>,
) -> Result<SegmentReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe = std::env::current_exe().map_err(|e| format!("exécutable introuvable: {e}"))?;
        let mut cmd = Command::new(exe);
        cmd.arg("segment")
            .arg(&input)
            .arg("--out")
            .arg(&base)
            .arg("--colour")
            .arg(request.weights.colour.to_string())
            .arg("--concave")
            .arg(request.weights.concavity.to_string())
            .arg("--convex")
            .arg(request.weights.convexity.to_string())
            .arg("--normal")
            .arg(request.weights.normal.to_string())
            .arg("--superface-colour")
            .arg(request.superface_colour.to_string())
            .arg("--superface-angle")
            .arg(request.superface_angle_deg.to_string());
        if request.barriers.uv_island {
            cmd.arg("--keep-islands");
        }
        if !request.barriers.material {
            cmd.arg("--free-materials");
        }
        if !request.barriers.shell {
            cmd.arg("--free-shells");
        }
        if let Some(path) = labels.filter(|p| !p.is_empty()) {
            cmd.arg("--labels").arg(path);
        }
        crate::retopo::drive(&app, cmd, "segment://progress", &RUNNING, &CANCELLED)
    })
    .await
    .map_err(|e| format!("tâche interrompue: {e}"))?
}

/// Stop the run in progress.
#[tauri::command]
pub fn segment_cancel() -> bool {
    let mut slot = RUNNING.lock().unwrap();
    match slot.as_mut() {
        Some(child) => {
            CANCELLED.store(true, Ordering::SeqCst);
            child.kill().is_ok()
        }
        None => false,
    }
}

/// Hand one sidecar to the front end as bytes.
///
/// Four kinds, one reader:
///
/// | kind | one per | meaning |
/// |---|---|---|
/// | `super` | triangle | which superface it landed in |
/// | `nbr` | triangle × 3 | the superface across the edge from corner `k` to `k+1`, `0xffffffff` at an open border |
/// | `merges` | merge × 2 | the two superfaces each step joined, in order |
/// | `costs` | merge | what that step cost, made non decreasing |
/// | `feat` | superface × 4 | mean colour in OkLab, then area |
///
/// **Bytes rather than numbers, which is the whole reason this exists beside
/// `retopo_sidecar` instead of inside it.** That one returns a `Vec<f32>`, which
/// Tauri encodes as a JSON number array. It is the right shape for what it does:
/// it reads channels off a *decimated* result, five thousand triangles or so.
/// This reads them off the **source**, two orders of magnitude bigger, where the
/// neighbour table alone is six megabytes and would cross as twelve megabytes of
/// text to parse. A `Response` crosses as an `ArrayBuffer` the browser wraps in
/// a `Uint32Array` with no parsing and no copy.
#[tauri::command]
pub fn segment_blob(base: String, kind: String) -> Result<tauri::ipc::Response, String> {
    const KINDS: &[&str] = &["super", "nbr", "merges", "costs", "feat"];
    if !KINDS.contains(&kind.as_str()) {
        // The path is built from this, so it is checked against a list rather
        // than trusted to be a file name.
        return Err(format!("type de fichier inconnu: {kind}"));
    }
    let path = sidecar(Path::new(&base), &kind);
    let raw = std::fs::read(&path).map_err(|e| format!("lecture de {}: {e}", path.display()))?;
    Ok(tauri::ipc::Response::new(raw))
}

// --- the command line ------------------------------------------------------

const USAGE: &str = "\
albedo segment <modèle.glb> [options]

 Identifie les parts d'un mesh et écrit quatre fichiers à côté : la superface de
 chaque triangle, ses trois voisines, l'ordre de fusion et son coût. Couper cet
 ordre après N fusions donne N groupes de moins, ce qui est comment l'interface
 fait glisser le nombre de groupes sans rien recalculer.

  --out <base>       préfixe des fichiers produits, par défaut le modèle
  --groups <N>       niveau à résumer à l'écran, par défaut celui suggéré

  --colour <p>       poids de la couleur d'atlas (défaut 1.4)
  --concave <p>      poids d'un pli rentrant (défaut 1.0)
  --convex <p>       poids d'un pli sortant (défaut 0.25)
  --normal <p>       poids de l'écart d'orientation (défaut 0.5)

  --keep-islands     couper aussi aux coutures UV
  --free-materials   ignorer les matériaux du fichier
  --free-shells      autoriser un groupe à couvrir deux coquilles disjointes
  --superface-colour <d>  écart OkLab sous lequel deux triangles sont de la
                          même couleur pour la pré-fusion (défaut 0.02)
  --superface-angle <a>   pli sous lequel la pré-fusion ne voit pas d'arête,
                          en degrés (défaut 3)

  --labels <fichier>  partir d'étiquettes produites ailleurs, une par triangle,
                      en tableau JSON ou en entiers 32 bits bruts. C'est par là
                      qu'arrive un résultat de PartField, P3-SAM ou SAMesh : il
                      devient une barrière, donc le découpage ne réunit jamais
                      deux parts qu'il a séparées, et tout le reste continue de
                      s'appliquer par-dessus.

  --machine          progression et rapport en lignes lisibles par la machine
";

/// `albedo.exe segment …`, or `None` when this is an ordinary launch.
///
/// Called from `main` beside `retopo::cli_main`, and for the same reason: there
/// is no window here, no webview and no event loop, only geometry.
pub fn cli_main() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("segment") {
        return None;
    }
    crate::retopo::attach_console();

    let mut input: Option<String> = None;
    let mut base: Option<String> = None;
    let mut groups: Option<usize> = None;
    let mut opts = SegmentOptions::default();
    let mut labels: Option<PathBuf> = None;
    let mut machine = false;

    let mut i = 1;
    while i < args.len() {
        let take = |i: usize| args.get(i + 1).cloned();
        match args[i].as_str() {
            "--out" => {
                base = take(i);
                i += 2;
            }
            "--groups" => {
                groups = take(i).and_then(|v| v.parse().ok());
                i += 2;
            }
            "--colour" | "--color" => {
                opts.weights.colour = take(i).and_then(|v| v.parse().ok()).unwrap_or(1.4);
                i += 2;
            }
            "--concave" => {
                opts.weights.concavity = take(i).and_then(|v| v.parse().ok()).unwrap_or(1.0);
                i += 2;
            }
            "--convex" => {
                opts.weights.convexity = take(i).and_then(|v| v.parse().ok()).unwrap_or(0.25);
                i += 2;
            }
            "--normal" => {
                opts.weights.normal = take(i).and_then(|v| v.parse().ok()).unwrap_or(0.5);
                i += 2;
            }
            "--superface-colour" | "--superface-color" => {
                opts.superface_colour = take(i).and_then(|v| v.parse().ok()).unwrap_or(0.02);
                i += 2;
            }
            "--superface-angle" => {
                opts.superface_angle_deg = take(i).and_then(|v| v.parse().ok()).unwrap_or(3.0);
                i += 2;
            }
            "--keep-islands" => {
                opts.barriers.uv_island = true;
                i += 1;
            }
            "--free-materials" => {
                opts.barriers.material = false;
                i += 1;
            }
            "--free-shells" => {
                opts.barriers.shell = false;
                i += 1;
            }
            "--labels" => {
                labels = take(i).map(PathBuf::from);
                i += 2;
            }
            "--machine" => {
                machine = true;
                i += 1;
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                return Some(0);
            }
            other if !other.starts_with('-') && input.is_none() => {
                input = Some(other.to_string());
                i += 1;
            }
            other => {
                eprintln!("option inconnue : {other}\n\n{USAGE}");
                return Some(2);
            }
        }
    }

    let Some(input) = input else {
        eprintln!("{USAGE}");
        return Some(2);
    };
    let input = PathBuf::from(input);
    let base = base.map(PathBuf::from).unwrap_or_else(|| input.clone());

    let mut last = -1.0f32;
    let mut progress = |fraction: f32| {
        if !machine {
            return;
        }
        let rounded = (fraction * 100.0).floor();
        if rounded > last {
            last = rounded;
            println!("progress {}", rounded / 100.0);
        }
    };

    match segment_file(&input, &base, &opts, labels.as_deref(), &mut progress) {
        Ok(r) => {
            if machine {
                println!("report {}", serde_json::to_string(&r).unwrap_or_default());
            } else {
                let k = groups.unwrap_or(r.suggested);
                println!(
                    "{} triangles → {} superfaces en {:.2} s",
                    r.triangles,
                    r.superfaces,
                    r.ms as f64 / 1000.0
                );
                println!(
                    "groupes : de {} au minimum à {} au maximum, {} suggérés",
                    r.floor, r.superfaces, r.suggested
                );
                println!(
                    "entrée : {} coquille(s), {} îlot(s) UV, {} matériau(x)",
                    r.shells, r.uv_islands, r.materials
                );
                if !r.colour_textured {
                    // The one result that looks like a bad segmentation and is
                    // not: with no atlas there is nothing for the strongest
                    // feature to read, and the person cannot tell by looking.
                    println!(
                        "attention : aucun matériau ne porte de texture de couleur, \
                         la couleur ne peut donc rien dire de plus que le matériau"
                    );
                }
                if r.non_manifold_edges > 0 {
                    println!(
                        "attention : {} arête(s) non manifold, les plis y sont approximatifs",
                        r.non_manifold_edges
                    );
                }
                if r.labels > 0 {
                    println!("étiquettes importées : {} parts", r.labels);
                }
                println!("coupe demandée : {k} groupes");
            }
            Some(0)
        }
        Err(e) => {
            eprintln!("échec : {e}");
            Some(1)
        }
    }
}
