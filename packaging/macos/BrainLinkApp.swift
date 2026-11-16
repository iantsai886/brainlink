import AppKit
import Foundation
import WebKit

final class BrainLinkAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var setupProcess: Process?
    private var healthTimer: Timer?
    private var attempts = 0
    private let setupPort = 47800

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        makeMainMenu()

        let configuration = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 850),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "BrainLink"
        window.minSize = NSSize(width: 850, height: 600)
        window.center()
        window.contentView = webView
        window.delegate = self
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        showStatus("Starting BrainLink…")
        ensureSetup()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if hasVisibleWindows { window.makeKeyAndOrderFront(nil) }
        else { window.makeKeyAndOrderFront(nil); ensureSetup() }
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        healthTimer?.invalidate()
        if let process = setupProcess, process.isRunning { process.terminate() }
    }

    func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }

    private func makeMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "About BrainLink", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "Quit BrainLink", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = appMenu
        main.addItem(appItem)
        NSApp.mainMenu = main
    }

    private func showStatus(_ message: String) {
        let html = """
        <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{font:16px -apple-system,BlinkMacSystemFont,sans-serif;color:#333;background:#f7f8fa;display:grid;place-items:center;height:90vh}main{text-align:center}small{color:#777}</style>
        <main><h2>BrainLink</h2><p>\(message)</p><small>You can keep this window open while BrainLink starts.</small></main>
        """
        webView.loadHTMLString(html, baseURL: URL(string: "http://127.0.0.1"))
    }

    private func ensureSetup() {
        healthTimer?.invalidate()
        attempts = 0
        launchSetupServer()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            self.attempts += 1
            if self.setupHealthURL() != nil {
                timer.invalidate()
                self.loadSetupWhenReady()
            } else if self.attempts >= 40 {
                timer.invalidate()
                self.showStatus("BrainLink could not start. Please quit and reopen the app.")
            }
        }
    }

    private func launchSetupServer() {
        guard let resources = Bundle.main.resourceURL else { return }
        let node = resources.appendingPathComponent("node/bin/node")
        let cli = resources.appendingPathComponent("app/bin/brainlink.mjs")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: cli.path) else {
            showStatus("BrainLink files are missing. Reinstall the app and try again.")
            return
        }
        let process = Process()
        process.executableURL = node
        process.arguments = [cli.path, "setup", "--app", "--no-open"]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run(); setupProcess = process }
        catch { showStatus("BrainLink could not start its local service.") }
    }

    private func setupHealthURL() -> URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let appHome = home.appendingPathComponent("Library/Application Support/BrainLink", isDirectory: true)
        let instanceFile = appHome.appendingPathComponent("setup-instance.json")
        var port = setupPort
        if let data = try? Data(contentsOf: instanceFile),
           let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let savedPort = value["port"] as? Int, (1...65535).contains(savedPort) {
            port = savedPort
        }
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return nil }
        // A stale setup-instance marker can point to a dead process. Do not treat the
        // URL's existence as readiness; the desktop shell must wait for BrainLink's
        // authenticated Setup server to answer before replacing its Starting screen.
        let readiness = DispatchSemaphore(value: 0)
        let resultLock = NSLock()
        var isReady = false
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 0.35)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { data, response, _ in
            defer { readiness.signal() }
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  let data, let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  payload["app"] as? String == "brainlink" else { return }
            resultLock.lock(); isReady = true; resultLock.unlock()
        }.resume()
        _ = readiness.wait(timeout: .now() + 0.4)
        resultLock.lock(); defer { resultLock.unlock() }
        return isReady ? url : nil
    }

    private func loadSetupWhenReady() {
        guard let health = setupHealthURL() else { return }
        var request = URLRequest(url: health, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  let data, let health = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (health["app"] as? String) == "brainlink" else { return }
            DispatchQueue.main.async {
                guard let token = self.readSetupToken(), let port = self.setupHealthURL()?.port else {
                    self.showStatus("BrainLink is running, but its local Setup key could not be read.")
                    return
                }
                var components = URLComponents()
                components.scheme = "http"
                components.host = "127.0.0.1"
                components.port = port
                components.path = "/"
                components.queryItems = [URLQueryItem(name: "t", value: token)]
                guard let url = components.url else { return }
                self.webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15))
            }
        }.resume()
    }

    private func readSetupToken() -> String? {
        let file = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/BrainLink/setup-token")
        guard let value = try? String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), value.count >= 20 else { return nil }
        return value
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "obsidian" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else if url.host == "127.0.0.1" || url.host == "localhost" {
            decisionHandler(.allow)
        } else if ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if url.scheme == "obsidian" { NSWorkspace.shared.open(url) }
            else if ["http", "https"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Confirm in BrainLink"
        alert.informativeText = message
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "BrainLink"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }
}

@main
struct BrainLinkAppMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = BrainLinkAppDelegate()
        app.delegate = delegate
        app.run()
    }
}
