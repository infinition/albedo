// Ask Quick Look for a thumbnail the way Finder does. `qlmanage -t` bypasses
// modern thumbnail extensions, so it cannot exercise the appex at all.
// Usage: qlthumb <file> <out.png> [size]
import AppKit
import QuickLookThumbnailing

let arguments = CommandLine.arguments
guard arguments.count >= 3 else { FileHandle.standardError.write("usage: qlthumb <file> <out.png> [size]\n".data(using: .utf8)!); exit(2) }
let size = CGFloat(Double(arguments.count > 3 ? arguments[3] : "256") ?? 256)
let request = QLThumbnailGenerator.Request(fileAt: URL(fileURLWithPath: arguments[1]), size: CGSize(width: size, height: size), scale: 2, representationTypes: .thumbnail)
let done = DispatchSemaphore(value: 0)
var status: Int32 = 1
QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { representation, error in
    defer { done.signal() }
    guard let representation = representation else {
        FileHandle.standardError.write("\(error.map { "\($0)" } ?? "no thumbnail")\n".data(using: .utf8)!); return
    }
    let bitmap = NSBitmapImageRep(cgImage: representation.cgImage)
    guard let png = bitmap.representation(using: .png, properties: [:]) else { return }
    do { try png.write(to: URL(fileURLWithPath: arguments[2])); status = 0 } catch { FileHandle.standardError.write("\(error)\n".data(using: .utf8)!) }
}
done.wait()
exit(status)
