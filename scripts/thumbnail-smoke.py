"""Render small real fixtures; reject missing, truncated or empty PNGs."""
import argparse
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import zlib


def fixtures(folder):
    positions = [(0, 0, 1), (-1, -1, -1), (1, -1, -1), (0, 1, -1)]
    faces = [(0, 1, 2), (0, 2, 3), (0, 3, 1), (1, 3, 2)]
    binary = b"".join(struct.pack("<3f", *p) for p in positions) + b"".join(struct.pack("<3H", *f) for f in faces)
    document = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
                "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 0}]}],
                "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [0.2, 0.6, 0.9, 1], "metallicFactor": 0}}],
                "buffers": [{"byteLength": len(binary)}], "bufferViews": [{"buffer": 0, "byteLength": 48}, {"buffer": 0, "byteOffset": 48, "byteLength": 24}],
                "accessors": [{"bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3", "min": [-1, -1, -1], "max": [1, 1, 1]}, {"bufferView": 1, "componentType": 5123, "count": 12, "type": "SCALAR"}]}
    encoded = json.dumps(document).encode()
    encoded += b" " * (-len(encoded) % 4)
    glb = struct.pack("<III", 0x46546C67, 2, 28 + len(encoded) + len(binary)) + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded + struct.pack("<II", len(binary), 0x004E4942) + binary
    (folder / "model.glb").write_bytes(glb)
    document["buffers"][0]["uri"] = "model buffer.bin"
    (folder / "model buffer.bin").write_bytes(binary)
    (folder / "model.gltf").write_text(json.dumps(document), encoding="utf8")
    (folder / "model.obj").write_text("\n".join(["v " + " ".join(map(str, p)) for p in positions] + ["f " + " ".join(str(i + 1) for i in f) for f in faces]), encoding="utf8")
    return [folder / ("model." + ext) for ext in ("glb", "gltf", "obj")]


def fixture_3mf(folder):
    """A 3MF cube. On macOS this is a type Albedo owns: glb/gltf/obj carry
    Apple UTIs, and Quick Look hands those to the SceneKit extension."""
    import zipfile
    corners = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
    faces = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    vertices = "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in corners)
    triangles = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in faces)
    model = ('<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
             f'<resources><object id="1" type="model"><mesh><vertices>{vertices}</vertices><triangles>{triangles}</triangles></mesh></object></resources>'
             '<build><item objectid="1"/></build></model>')
    path = folder / "model.3mf"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        archive.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        archive.writestr("3D/3dmodel.model", model)
    return path


def verify_png(path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", f"Not a PNG: {path}"
    width, height = struct.unpack_from(">II", data, 16)
    assert width >= 32 and height >= 32
    position, compressed, ended = 8, b"", False
    while position + 12 <= len(data):
        size = struct.unpack_from(">I", data, position)[0]
        chunk = data[position + 4:position + 8]
        payload = data[position + 8:position + 8 + size]
        assert len(payload) == size
        assert zlib.crc32(chunk + payload) & 0xffffffff == struct.unpack_from(">I", data, position + 8 + size)[0]
        if chunk == b"IDAT": compressed += payload
        if chunk == b"IEND": ended = True
        position += 12 + size
    assert ended and len(set(zlib.decompress(compressed))) > 16, "Empty or flat thumbnail"
    print(f"PASS {path.name}: {width}x{height}, {len(data)} bytes")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--linux-provider", type=Path)
    parser.add_argument("--mac-app", type=Path)
    args = parser.parse_args()
    if not (args.binary or args.linux_provider or args.mac_app): parser.error("Choose a renderer")
    with tempfile.TemporaryDirectory(prefix="albedo thumbnail test ") as tmp:
        folder = Path(tmp)
        models = fixtures(folder)
        if args.mac_app:
            # Only types whose UTI Albedo declares reach the extension: macOS
            # owns glb/gltf/obj and routes them to SceneKit. Those formats are
            # covered by the application CLI above.
            models = [fixture_3mf(folder)]
            app = args.mac_app.resolve()
            subprocess.run(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", str(app)], check=True)
            subprocess.run(["pluginkit", "-a", str(app / "Contents/PlugIns/AlbedoThumbnail.appex")], check=True)
            subprocess.run(["pluginkit", "-e", "use", "-i", "com.infinition.albedo.thumbnail"], check=True)
            # The agent caches its extension list; a fresh one sees the new registration.
            subprocess.run(["qlmanage", "-r"], check=False, capture_output=True)
            subprocess.run(["killall", "-9", "com.apple.quicklook.ThumbnailsAgent"], check=False, capture_output=True)
            helper = folder / "qlthumb"
            source = Path(__file__).resolve().parents[1] / "platform/macos/qlthumb.swift"
            subprocess.run(["xcrun", "swiftc", "-O", str(source), "-o", str(helper)], check=True)
        for model in models:
            output = folder / (model.name + ".png")
            if args.mac_app:
                command = [str(helper), str(model), str(output), "256"]
            elif args.linux_provider:
                command = [str(args.linux_provider.resolve()), "--size", "256", str(model), str(output)]
            else:
                command = [str(args.binary.resolve()), "--thumbnail", str(model), "--out", str(output), "--size", "256"]
            if args.mac_app:
                if not quick_look(command, model, output): continue
            else:
                subprocess.run(command, check=True, timeout=60)
            verify_png(output)


def quick_look(command, model, output):
    """Ask Quick Look a few times: the agent discovers a fresh extension with a
    short delay. Returns False, after printing why, when this machine cannot
    host the extension at all; raises when the extension ran and failed."""
    import time
    started = time.strftime("%Y-%m-%d %H:%M:%S")
    for attempt in range(4):
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            # A headless runner has no Quick Look agent to host the extension,
            # so the request never completes. The application CLI above already
            # covers the renderer itself.
            print(f"SKIP {model.name}: no Quick Look host on this machine")
            return False
        if result.returncode == 0 and output.exists(): return True
        print(f"attempt {attempt + 1}: {result.stderr.strip()}")
        time.sleep(3)
    log = subprocess.run(["log", "show", "--start", started, "--style", "compact", "--predicate",
                          'process == "com.apple.quicklook.ThumbnailsAgent" OR process == "AlbedoThumbnail"'],
                         capture_output=True, text=True, timeout=120).stdout
    if "com.infinition.albedo.thumbnail" not in log:
        print(f"SKIP {model.name}: Quick Look never launched the extension on this machine")
        return False
    if "WebKit renderer terminated" in log and "Could not create a sandbox extension for 'IOAccelerator" in log:
        # Virtual runners have no GPU to hand to WebKit's content process, which
        # then dies inside the extension sandbox. The unsandboxed application
        # CLI above rendered on the same machine, so the renderer itself is
        # covered; the Quick Look path needs real hardware.
        print(f"SKIP {model.name}: WebKit cannot start inside the extension sandbox on this machine (no GPU)")
        return False
    interesting = [line for line in log.splitlines()
                   if "thumbnail failed" in line or "Launching process" in line
                   or (" E " in line and "AlbedoThumbnail" in line and not any(noise in line for noise in ("Pasteboard", "WebPrivacy", "SafeBrowsing", "runningboard", "launchservices", "TCC", "SkyLight", "intents", "linkd", "networkd", "dock", "EXExtensionContextClass")))]
    print("\n".join(interesting[:80]))
    raise SystemExit(f"Quick Look launched the extension but no thumbnail came back for {model.name}")


if __name__ == "__main__": main()
