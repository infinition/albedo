"""Host-independent checks for native packaging and resource confinement."""
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("thumbnailer", ROOT / "platform/linux/thumbnailer.py")
thumbnailer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(thumbnailer)


class Platforms(unittest.TestCase):
    def test_thumbnail_requests_cannot_escape_the_granted_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertEqual(thumbnailer.confined(root, "textures/a.png"), root.resolve() / "textures/a.png")
            for bad in ["../secret", "../../secret", str(root.parent / "secret")]:
                with self.assertRaises(ValueError): thumbnailer.confined(root, bad)

    def test_every_supported_extension_has_native_metadata(self):
        config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
        extensions = {ext for entry in config["bundle"]["fileAssociations"] for ext in entry["ext"]}
        with (ROOT / "platform/macos/AppInfo.plist").open("rb") as file: app = plistlib.load(file)
        with (ROOT / "platform/macos/ThumbnailInfo.plist").open("rb") as file: provider = plistlib.load(file)
        declared = app["UTImportedTypeDeclarations"]
        self.assertEqual(extensions, {ext for uti in declared for ext in uti["UTTypeTagSpecification"]["public.filename-extension"]})
        supported = provider["NSExtension"]["NSExtensionAttributes"]["QLSupportedContentTypes"]
        self.assertTrue(all(uti["UTTypeIdentifier"] in supported for uti in declared))
        self.assertEqual(provider["CFBundleVersion"], config["version"])
        mime = ET.parse(ROOT / "platform/linux/albedo.xml")
        self.assertEqual(extensions, {n.attrib["pattern"][2:] for n in mime.findall(".//{*}glob")})
        entry = (ROOT / "platform/linux/albedo.thumbnailer").read_text()
        self.assertTrue(all(n.attrib["type"] + ";" in entry for n in mime.findall("{*}mime-type")))

    def test_windows_resources_do_not_leak_into_other_packages(self):
        common = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
        self.assertNotIn("resources", common["bundle"])
        for platform in ("linux", "macos"):
            self.assertNotIn(".dll", (ROOT / f"src-tauri/tauri.{platform}.conf.json").read_text())


if __name__ == "__main__": unittest.main()
