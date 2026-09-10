import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const extensions = config.bundle.fileAssociations.flatMap((f) => f.ext);
const mime = { glb: "model/gltf-binary", gltf: "model/gltf+json", obj: "model/obj", stl: "model/stl", ply: "application/x-ply", dae: "model/vnd.collada+xml", "3mf": "model/3mf", "3ds": "image/x-3ds", fbx: "application/vnd.autodesk.fbx", usdz: "model/vnd.usdz+zip" };
const mimetypes = extensions.map((ext) => mime[ext] || `model/x-albedo-${ext}`);
const linuxPath = "src-tauri/tauri.linux.conf.json";
const linux = JSON.parse(readFileSync(linuxPath, "utf8"));
linux.bundle.fileAssociations = extensions.map((ext, i) => ({ ext: [ext], mimeType: mimetypes[i], name: `${ext.toUpperCase()} 3D model`, role: "Viewer" }));
writeFileSync(linuxPath, JSON.stringify(linux, null, 2) + "\n");
const xml = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function value(v) {
  if (Array.isArray(v)) return `<array>${v.map(value).join("")}</array>`;
  if (typeof v === "object") return `<dict>${Object.entries(v).map(([k, x]) => `<key>${xml(k)}</key>${value(x)}`).join("")}</dict>`;
  if (typeof v === "number") return `<integer>${v}</integer>`;
  return `<string>${xml(v)}</string>`;
}
const plist = (v) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${value(v)}</plist>\n`;
mkdirSync("platform/linux", { recursive: true });
mkdirSync("platform/macos", { recursive: true });
writeFileSync("platform/linux/albedo.thumbnailer", `[Thumbnailer Entry]\nTryExec=/usr/bin/albedo-thumbnailer\nExec=/usr/bin/albedo-thumbnailer --size %s %i %o\nMimeType=${mimetypes.join(";")};\n`);
writeFileSync("platform/linux/albedo.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">\n${extensions.map((ext, i) => `  <mime-type type="${mimetypes[i]}"><comment>${ext.toUpperCase()} 3D model</comment><glob pattern="*.${ext}"/></mime-type>`).join("\n")}\n</mime-info>\n`);
const utis = extensions.map((ext) => `com.infinition.albedo.${ext}`);
const imported = extensions.map((ext, i) => ({ UTTypeIdentifier: utis[i], UTTypeDescription: `${ext.toUpperCase()} 3D model`, UTTypeConformsTo: ["public.data", "public.3d-content"], UTTypeTagSpecification: { "public.filename-extension": [ext], "public.mime-type": [mimetypes[i]] } }));
// Include system/industry UTIs as well: Launch Services may already know these
// extensions through another application, and should still offer our provider.
const known = ["org.khronos.glb", "org.khronos.gltf", "public.geometry-definition-format", "public.standard-tesselated-geometry-format", "public.polygon-file-format", "com.autodesk.fbx", "com.pixar.universal-scene-description", "com.pixar.universal-scene-description-mobile"];
writeFileSync("platform/macos/AppInfo.plist", plist({ UTImportedTypeDeclarations: imported, CFBundleDocumentTypes: [{ CFBundleTypeName: "3D Model", CFBundleTypeRole: "Viewer", LSHandlerRank: "Alternate", LSItemContentTypes: [...utis, ...known], CFBundleTypeExtensions: extensions }] }));
writeFileSync("platform/macos/ThumbnailInfo.plist", plist({ CFBundleExecutable: "AlbedoThumbnail", CFBundleIdentifier: "com.infinition.albedo.thumbnail", CFBundleName: "Albedo Thumbnail", CFBundleDisplayName: "Albedo 3D Thumbnails", CFBundlePackageType: "XPC!", CFBundleVersion: config.version, CFBundleShortVersionString: config.version, LSMinimumSystemVersion: "12.0", NSExtension: { NSExtensionPointIdentifier: "com.apple.quicklook.thumbnail", NSExtensionPrincipalClass: "ThumbnailProvider", NSExtensionAttributes: { QLSupportedContentTypes: [...utis, ...known], QLThumbnailMinimumDimension: 32 } } }));
