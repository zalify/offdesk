#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

public struct NativeTerminalItem: Identifiable, Decodable {
    public let id: String
    public let machine_id: String
    public let title: String
    public let cwd: String
    public let reachable: Bool
    public let waiting: Bool
    public let last_activity_ms: Int64?

    public var isWorking: Bool {
        guard let ms = last_activity_ms else { return false }
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        return (nowMs - ms) < 60_000
    }
}

private struct NativeInventoryPayload: Decodable {
    let terminals: [NativeTerminalItem]
}

/// Full native iOS SwiftUI Agent Console shell backed by `liboffdesk_term.a` (120Hz Metal GPU).
/// Zero WebView / zero xterm.js: native SwiftUI header, sessions sheet, and IME input bar
/// wrapping the shared Rust GPU terminal surface.
public struct NativeConsoleView: View {
    public let hubUrl: String
    public let token: String
    public let deviceId: String

    @State private var terminals: [NativeTerminalItem] = []
    @State private var activeTerminal: NativeTerminalItem?
    @State private var sheetOpen = false
    @State private var filter = "all"
    @State private var composeText = ""
    @State private var showKeys = false
    @State private var metalView: OffdeskMetalTerminalView?

    public init(hubUrl: String, token: String, deviceId: String) {
        self.hubUrl = hubUrl
        self.token = token
        self.deviceId = deviceId
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Top bar
            HStack(spacing: 8) {
                Button {
                    sheetOpen = true
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(activeTerminal?.title ?? "Connecting…")
                            .font(.system(size: 13, weight: .semibold, design: .monospaced))
                            .foregroundColor(.white)
                            .lineLimit(1)
                        Text(activeTerminal?.cwd ?? hubUrl)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.gray)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color(white: 0.14))
                    .cornerRadius(6)
                }

                if let waiting = terminals.first(where: { $0.waiting && $0.id != activeTerminal?.id }) {
                    Button {
                        select(waiting)
                    } label: {
                        Text("● waiting")
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundColor(.red)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Color.red.opacity(0.18))
                            .clipShape(Capsule())
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color(white: 0.09))

            // 120Hz Metal GPU terminal surface
            MetalTerminalHost(
                hubUrl: hubUrl,
                token: token,
                deviceId: deviceId,
                onReady: { view in
                    self.metalView = view
                }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Native iOS Compose Bar (Chinese IME + dictation)
            HStack(alignment: .bottom, spacing: 6) {
                TextField("Message agent…", text: $composeText, axis: .vertical)
                    .lineLimit(1...4)
                    .padding(8)
                    .background(Color(white: 0.08))
                    .foregroundColor(.white)
                    .cornerRadius(8)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(white: 0.2), lineWidth: 1))

                Button {
                    showKeys.toggle()
                } label: {
                    Image(systemName: showKeys ? "chevron.down" : "keyboard")
                        .frame(width: 34, height: 34)
                        .foregroundColor(.gray)
                }

                Button {
                    guard !composeText.isEmpty else { return }
                    metalView?.sendText(composeText, appendEnter: true)
                    composeText = ""
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .bold))
                        .frame(width: 34, height: 34)
                        .background(composeText.isEmpty ? Color.gray.opacity(0.3) : Color.green)
                        .foregroundColor(.black)
                        .cornerRadius(8)
                }
                .disabled(composeText.isEmpty)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(Color(white: 0.09))

            if showKeys {
                HStack(spacing: 8) {
                    quickKey("^C", "\u{03}")
                    quickKey("esc", "\u{1B}")
                    quickKey("tab", "\t")
                    quickKey("↑", "\u{1B}[A")
                    quickKey("↓", "\u{1B}[B")
                    quickKey("enter", "\r")
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 6)
                .background(Color(white: 0.09))
            }
        }
        .background(Color(white: 0.075).ignoresSafeArea())
        .task {
            while !Task.isCancelled {
                if let raw = metalView?.inventoryJson(),
                   let data = raw.data(using: .utf8),
                   let decoded = try? JSONDecoder().decode(NativeInventoryPayload.self, from: data)
                {
                    terminals = decoded.terminals
                    if activeTerminal == nil, let first = decoded.terminals.first {
                        select(first)
                    }
                }
                try? await Task.sleep(nanoseconds: 1_500_000_000)
            }
        }
        .sheet(isPresented: $sheetOpen) {
            sessionsSheet
        }
    }

    private func select(_ item: NativeTerminalItem) {
        activeTerminal = item
        metalView?.selectTerminal(machineId: item.machine_id, terminalId: item.id)
    }

    private func quickKey(_ label: String, _ seq: String) -> some View {
        Button {
            metalView?.sendText(seq, appendEnter: false)
        } label: {
            Text(label)
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundColor(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background(Color(white: 0.16))
                .cornerRadius(5)
        }
    }

    private var sessionsSheet: some View {
        NavigationStack {
            VStack(spacing: 8) {
                Picker("Filter", selection: $filter) {
                    Text("All").tag("all")
                    Text("Waiting").tag("waiting")
                    Text("Working").tag("working")
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)

                List(filteredTerminals) { item in
                    Button {
                        select(item)
                        sheetOpen = false
                    } label: {
                        HStack(spacing: 10) {
                            Circle()
                                .fill(item.waiting ? Color.red : item.isWorking ? Color.green : Color.gray)
                                .frame(width: 8, height: 8)
                            Text(item.title)
                                .foregroundColor(.primary)
                                .lineLimit(1)
                        }
                    }
                }
            }
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
    }

    private var filteredTerminals: [NativeTerminalItem] {
        switch filter {
        case "waiting": return terminals.filter { $0.waiting }
        case "working": return terminals.filter { $0.isWorking }
        default: return terminals
        }
    }
}

private struct MetalTerminalHost: UIViewRepresentable {
    let hubUrl: String
    let token: String
    let deviceId: String
    let onReady: (OffdeskMetalTerminalView) -> Void

    func makeUIView(context: Context) -> OffdeskMetalTerminalView {
        let view = OffdeskMetalTerminalView()
        view.connect(hubUrl: hubUrl, token: token, deviceId: deviceId)
        DispatchQueue.main.async { onReady(view) }
        return view
    }

    func updateUIView(_ uiView: OffdeskMetalTerminalView, context: Context) {}
}
#endif
