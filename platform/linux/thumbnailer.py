#!/usr/bin/env python3
"""Small WebKit host for Albedo's shared thumbnail page; no editor process."""
import argparse
import base64
import json
import mimetypes
import os
from pathlib import Path
import sys
from urllib.parse import unquote, urlparse, quote


def confined(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Path leaves the granted directory")
    return path


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("--size", type=int, default=256)
    parser.add_argument("model", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--assets", type=Path, default=Path(__file__).parent / "dist")
    args = parser.parse_args()
    model = args.model.resolve(strict=True)
    assets = args.assets.resolve(strict=True)
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import Gtk, WebKit2, GLib, Gio

    model_url = "albedo://local/model/" + quote(model.name)
    candidates = []
    for folder in [model.parent] + [model.parent / p for p in ("textures", "texture", "tex", "maps", "materials", "images")]:
        try:
            for path in sorted(folder.iterdir()):
                if len(candidates) >= 400:
                    break
                if path.is_file() and path.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tga", ".dds"):
                    candidates.append({"name": path.name, "url": "albedo://local/model/" + quote(str(path.relative_to(model.parent)))})
        except OSError:
            pass  # File-manager sandboxes may grant only the requested file.
    job = json.dumps({"url": model_url, "name": model.name, "size": max(32, min(2048, args.size)), "candidates": candidates}).encode()

    def request(req):
        try:
            url = urlparse(req.get_uri())
            if url.netloc != "local":
                raise ValueError("Unknown resource host")
            relative = unquote(url.path).lstrip("/")
            if relative == "job.json":
                data, mime = job, "application/json"
            else:
                path = confined(model.parent, relative[6:]) if relative.startswith("model/") else confined(assets, relative)
                data = path.read_bytes()
                mime = {".js": "text/javascript", ".wasm": "application/wasm"}.get(path.suffix, mimetypes.guess_type(path)[0] or "application/octet-stream")
            req.finish(Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(data)), len(data), mime)
        except Exception as error:
            req.finish_error(GLib.Error(str(error)))

    result = 1

    def message(_manager, payload):
        nonlocal result
        try:
            value = json.loads(payload.get_js_value().to_string())
            if "error" in value:
                raise ValueError(value["error"])
            data = base64.b64decode(value["data"].split(",", 1)[1], validate=True)
            if not data.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("Renderer did not return a PNG")
            part = args.output.with_suffix(args.output.suffix + ".part")
            part.write_bytes(data)
            os.replace(part, args.output)
            result = 0
        except Exception as error:
            print(error, file=sys.stderr)
        Gtk.main_quit()

    context = WebKit2.WebContext.new_ephemeral()
    context.register_uri_scheme("albedo", request)
    security = context.get_security_manager()
    security.register_uri_scheme_as_secure("albedo")
    security.register_uri_scheme_as_cors_enabled("albedo")
    manager = WebKit2.UserContentManager()
    manager.connect("script-message-received::thumbnail", message)
    manager.register_script_message_handler("thumbnail")
    view = WebKit2.WebView(web_context=context, user_content_manager=manager)
    view.get_settings().set_enable_webgl(True)
    # Realize on the private Xvfb display so WebKit creates its drawing context.
    window = Gtk.Window()
    window.set_default_size(512, 512)
    window.add(view)
    window.show_all()
    GLib.timeout_add_seconds(45, lambda: (Gtk.main_quit(), False)[1])
    view.load_uri("albedo://local/thumbnail.html")
    Gtk.main()
    window.destroy()
    return result


if __name__ == "__main__":
    sys.exit(run())
