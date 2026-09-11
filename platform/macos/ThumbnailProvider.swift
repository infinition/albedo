import AppKit
import QuickLookThumbnailing
import WebKit
import os

// An extension renders in its own process and sandbox. It never launches the
// GUI application or assumes a logged-in application's cache already exists.
@objc(ThumbnailProvider)
final class ThumbnailProvider: QLThumbnailProvider {
    private var jobs: [UUID: ThumbnailJob] = [:]

    override func provideThumbnail(for request: QLFileThumbnailRequest,
                                   _ handler: @escaping (QLThumbnailReply?, Error?) -> Void) {
        DispatchQueue.main.async {
            let id = UUID()
            let job = ThumbnailJob(request: request) { reply, error in
                self.jobs.removeValue(forKey: id)
                handler(reply, error)
            }
            self.jobs[id] = job
            job.start()
        }
    }
}

private final class ThumbnailJob: NSObject, WKURLSchemeHandler, WKScriptMessageHandler, WKNavigationDelegate {
    private let request: QLFileThumbnailRequest
    private var completion: ((QLThumbnailReply?, Error?) -> Void)?
    private var view: WKWebView?
    private var timeout: DispatchWorkItem?
    private var scopedAccess = false
    private let assets = Bundle.main.resourceURL!.appendingPathComponent("dist", isDirectory: true)

    init(request: QLFileThumbnailRequest, completion: @escaping (QLThumbnailReply?, Error?) -> Void) {
        self.request = request
        self.completion = completion
    }

    func start() {
        scopedAccess = request.fileURL.startAccessingSecurityScopedResource()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(self, forURLScheme: "albedo")
        config.userContentController.add(self, name: "thumbnail")
        let webview = WKWebView(frame: CGRect(x: 0, y: 0, width: 512, height: 512), configuration: config)
        webview.navigationDelegate = self
        view = webview
        let deadline = DispatchWorkItem { [weak self] in self?.fail("Thumbnail rendering timed out") }
        timeout = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 35, execute: deadline)
        webview.load(URLRequest(url: URL(string: "albedo://local/thumbnail.html")!))
    }

    private func finish(_ reply: QLThumbnailReply?, _ error: Error?) {
        guard let callback = completion else { return }
        completion = nil
        timeout?.cancel()
        view?.stopLoading()
        view?.configuration.userContentController.removeScriptMessageHandler(forName: "thumbnail")
        view = nil
        if scopedAccess { request.fileURL.stopAccessingSecurityScopedResource(); scopedAccess = false }
        callback(reply, error)
    }

    private func fail(_ text: String) {
        // Quick Look reports every failure as its own opaque code; the reason
        // is only visible here: log stream --predicate 'process == "AlbedoThumbnail"'
        os_log("thumbnail failed for %{public}@: %{public}@", log: .default, type: .error, request.fileURL.lastPathComponent, text)
        finish(nil, NSError(domain: "com.infinition.albedo.thumbnail", code: 1,
                            userInfo: [NSLocalizedDescriptionKey: text]))
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let text = message.body as? String,
              let encoded = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
            fail("Invalid thumbnail response"); return
        }
        guard let url = json["data"] as? String, url.hasPrefix("data:image/png;base64,"),
              let data = Data(base64Encoded: String(url.dropFirst(22))),
              let image = NSBitmapImageRep(data: data), let cgImage = image.cgImage else {
            fail(json["error"] as? String ?? "Invalid thumbnail image"); return
        }
        // Quick Look sizes are points; the canvas renders request.scale pixels.
        let extent = min(request.maximumSize.width, request.maximumSize.height)
        let size = CGSize(width: extent, height: extent)
        finish(QLThumbnailReply(contextSize: size, drawing: { context in
            // The context is contextSize * request.scale pixels with an identity
            // transform, so a rectangle in points would cover only one quarter.
            let pixels = CGRect(x: 0, y: 0, width: CGFloat(context.width), height: CGFloat(context.height))
            context.draw(cgImage, in: pixels)
            return true
        }), nil)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("Navigation failed: \(error.localizedDescription)") }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail("Navigation failed: \(error.localizedDescription)") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("WebKit renderer terminated") }

    private func modelURL(_ relative: String) -> String {
        var parts = URLComponents()
        parts.scheme = "albedo"; parts.host = "local"; parts.path = "/model/" + relative
        return parts.url!.absoluteString
    }

    private func jobData() throws -> Data {
        let parent = request.fileURL.deletingLastPathComponent()
        var candidates: [[String: String]] = []
        for folder in [""] + ["textures", "texture", "tex", "maps", "materials", "images"] {
            let dir = folder.isEmpty ? parent : parent.appendingPathComponent(folder)
            let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            for file in files.sorted(by: { $0.path < $1.path }) where candidates.count < 400 {
                if ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tga", "dds"].contains(file.pathExtension.lowercased()) {
                    let relative = folder.isEmpty ? file.lastPathComponent : folder + "/" + file.lastPathComponent
                    candidates.append(["name": file.lastPathComponent, "url": modelURL(relative)])
                }
            }
        }
        return try JSONSerialization.data(withJSONObject: [
            "url": modelURL(request.fileURL.lastPathComponent), "name": request.fileURL.lastPathComponent,
            "size": max(32, min(2048, Int(min(request.maximumSize.width, request.maximumSize.height) * request.scale))),
            "candidates": candidates
        ])
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        do {
            guard let url = task.request.url, url.host == "local" else { throw CocoaError(.fileReadNoPermission) }
            let relative = String(url.path.dropFirst())
            let data: Data
            let mime: String
            if relative == "job.json" {
                data = try jobData(); mime = "application/json"
            } else {
                let isModel = relative.hasPrefix("model/")
                let root = (isModel ? request.fileURL.deletingLastPathComponent() : assets).resolvingSymlinksInPath()
                let path = root.appendingPathComponent(isModel ? String(relative.dropFirst(6)) : relative).resolvingSymlinksInPath()
                guard path.path.hasPrefix(root.path + "/") else { throw CocoaError(.fileReadNoPermission) }
                data = try Data(contentsOf: path)
                mime = ["html": "text/html", "js": "text/javascript", "css": "text/css", "json": "application/json", "wasm": "application/wasm", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp" ][path.pathExtension.lowercased()] ?? "application/octet-stream"
            }
            // fetch() sees no status on a plain URLResponse, so `response.ok` is
            // false and the page reports a missing job; an HTTP response fixes that.
            guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                                 headerFields: ["Content-Type": mime, "Content-Length": String(data.count)]) else {
                throw CocoaError(.fileReadUnknown)
            }
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
        } catch { task.didFailWithError(error) }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
