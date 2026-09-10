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
            # Quick Look grants the selected document, not arbitrary sibling
            # buffers. External glTF is covered by the application CLI above.
            models = [model for model in models if model.suffix != ".gltf"]
            app = args.mac_app.resolve()
            subprocess.run(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", str(app)], check=True)
            subprocess.run(["pluginkit", "-a", str(app / "Contents/PlugIns/AlbedoThumbnail.appex")], check=True)
            subprocess.run(["pluginkit", "-e", "use", "-i", "com.infinition.albedo.thumbnail"], check=True)
        for model in models:
            output = folder / (model.name + ".png")
            if args.mac_app:
                command = ["qlmanage", "-t", "-s", "256", "-o", str(folder), str(model)]
            elif args.linux_provider:
                command = [str(args.linux_provider.resolve()), "--size", "256", str(model), str(output)]
            else:
                command = [str(args.binary.resolve()), "--thumbnail", str(model), "--out", str(output), "--size", "256"]
            subprocess.run(command, check=True, timeout=60)
            verify_png(output)


if __name__ == "__main__": main()
