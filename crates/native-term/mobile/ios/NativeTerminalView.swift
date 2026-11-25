#if canImport(UIKit)
import QuartzCore
import SwiftUI
import UIKit

/// Drop-in 120Hz Metal-backed UIView wrapping `liboffdesk_term.a` (`crates/native-term`).
/// Shares the exact same `wgpu + glyphon + alacritty_terminal` GPU engine as the desktop client.
public final class OffdeskMetalTerminalView: UIView {
    public override class var layerClass: AnyClass { CAMetalLayer.self }

    private var handle: OpaquePointer?
    private var displayLink: CADisplayLink?
    private var scrollAccumulator: CGFloat = 0

    public var metalLayer: CAMetalLayer { layer as! CAMetalLayer }

    public override init(frame: CGRect) {
        super.init(frame: frame)
        setup()
    }

    public required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    private func setup() {
        contentScaleFactor = UIScreen.main.scale
        metalLayer.contentsScale = contentScaleFactor
        metalLayer.isOpaque = true

        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        addGestureRecognizer(pan)
    }

    public func connect(hubUrl: String, token: String, deviceId: String, fontSizePt: Float = 14.0) {
        disconnect()
        let scaledFont = fontSizePt * Float(contentScaleFactor)
        handle = hubUrl.withCString { urlPtr in
            token.withCString { tokenPtr in
                deviceId.withCString { devPtr in
                    offdesk_term_create(urlPtr, tokenPtr, devPtr, scaledFont)
                }
            }
        }
        attachSurfaceIfReady()
        startDisplayLink()
    }

    public func selectTerminal(machineId: String, terminalId: String) {
        guard let handle else { return }
        machineId.withCString { mid in
            terminalId.withCString { tid in
                _ = offdesk_term_select_terminal(handle, mid, tid)
            }
        }
    }

    public func sendText(_ text: String, appendEnter: Bool = false) {
        guard let handle else { return }
        let payload = appendEnter ? text + "\r" : text
        let bytes = Array(payload.utf8)
        bytes.withUnsafeBufferPointer { buf in
            guard let base = buf.baseAddress else { return }
            _ = offdesk_term_send_input(handle, base, buf.count)
        }
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let w = UInt32(max(1, bounds.width * contentScaleFactor))
        let h = UInt32(max(1, bounds.height * contentScaleFactor))
        metalLayer.drawableSize = CGSize(width: CGFloat(w), height: CGFloat(h))
        if let handle {
            _ = offdesk_term_resize(handle, w, h)
        }
    }

    private func attachSurfaceIfReady() {
        guard let handle else { return }
        let w = UInt32(max(1, bounds.width * contentScaleFactor))
        let h = UInt32(max(1, bounds.height * contentScaleFactor))
        let rawLayer = Unmanaged.passUnretained(metalLayer).toOpaque()
        _ = offdesk_term_attach_metal_layer(handle, rawLayer, w, h)
    }

    private func startDisplayLink() {
        displayLink?.invalidate()
        let link = CADisplayLink(target: self, selector: #selector(renderFrame))
        displayLink = link
        link.add(to: .main, forMode: .common)
    }

    @objc private func renderFrame() {
        guard let handle else { return }
        _ = offdesk_term_render(handle)
    }

    @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
        guard let handle else { return }
        let dy = gesture.translation(in: self).y
        gesture.setTranslation(.zero, in: self)
        scrollAccumulator += dy
        let linePt: CGFloat = 18.0
        let lines = Int32((scrollAccumulator / linePt).rounded(.towardZero))
        if lines != 0 {
            scrollAccumulator -= CGFloat(lines) * linePt
            _ = offdesk_term_scroll(handle, lines)
        }
    }

    public func disconnect() {
        displayLink?.invalidate()
        displayLink = nil
        if let handle {
            offdesk_term_destroy(handle)
            self.handle = nil
        }
    }

    deinit {
        disconnect()
    }
}

/// SwiftUI wrapper ready to drop into an iOS SwiftUI Agent Console shell.
public struct NativeTerminalView: UIViewRepresentable {
    public let hubUrl: String
    public let token: String
    public let deviceId: String
    public let machineId: String
    public let terminalId: String

    public init(hubUrl: String, token: String, deviceId: String, machineId: String, terminalId: String) {
        self.hubUrl = hubUrl
        self.token = token
        self.deviceId = deviceId
        self.machineId = machineId
        self.terminalId = terminalId
    }

    public func makeUIView(context: Context) -> OffdeskMetalTerminalView {
        let view = OffdeskMetalTerminalView()
        view.connect(hubUrl: hubUrl, token: token, deviceId: deviceId)
        view.selectTerminal(machineId: machineId, terminalId: terminalId)
        return view
    }

    public func updateUIView(_ uiView: OffdeskMetalTerminalView, context: Context) {
        uiView.selectTerminal(machineId: machineId, terminalId: terminalId)
    }
}
#endif
