import Foundation

/// Der HTTP-Teil von WHEP (`draft-ietf-wish-whep`) für den nativen Stream-Ton
/// — dieselbe Mechanik wie `web/src/lib/stream/whep.ts`, ohne Trickle:
/// Angebot mit allen Kandidaten per POST, 201 mit Antwort und `Location`,
/// DELETE beim Ende.
///
/// **Die URL trägt das Lese-Token** (`?token=…`, von media-svc in `GET /whep`
/// gemintet, an Kanal und Nutzer gebunden und MEHRFACH nutzbar — deshalb
/// darf diese zweite Lesesitzung dieselbe URL nehmen wie die WebView). Sie
/// steht deshalb nie im Log; gemeldet wird höchstens der Statuscode.
enum StreamTonWhep {
    /// **Ohne Weiterleitungen** (Gegenprüfung 2, V6). `URLSession` folgt einer
    /// 307/308 von selbst und schickte denselben POST — samt SDP-Angebot mit
    /// den ICE-Kandidaten des Telefons — an ein beliebiges https-Ziel; die
    /// Host-Prüfung der Seite (`whepHostErlaubt`) sähe davon nichts. Für den
    /// WHEP-Weg ist keine Weiterleitung vorgesehen; kommt doch eine, endet der
    /// Start mit ihrem Status (kein 2xx), und die Kachel fällt nach ihren
    /// Versuchen auf den WebView-Ton zurück. Flüchtig: nichts hier braucht
    /// Cookies oder einen Cache.
    private static let sitzung = URLSession(
        configuration: .ephemeral, delegate: KeineWeiterleitung(), delegateQueue: nil)

    private final class KeineWeiterleitung: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    struct Fehler: LocalizedError {
        let status: Int
        let text: String
        var errorDescription: String? { status > 0 ? "whep_http_\(status)" : text }
    }

    /// Stereo-Opus erbitten — VOR `setLocalDescription`, nicht danach: die
    /// fmtp-Zeile der LOKALEN Beschreibung stellt den Opus-DECODER ein
    /// (gemessen 2026-07-16 im Web, Begründung an `preferStereoOpus` in
    /// `whep.ts`). Ohne `stereo=1` dekodiert WebRTC nach RFC 7587 mono.
    static func stereoErbitten(_ sdp: String) -> String {
        let zeilen = sdp.components(separatedBy: "\r\n")
        var opus = Set<String>()
        for z in zeilen where z.lowercased().hasPrefix("a=rtpmap:") && z.lowercased().contains(" opus/") {
            let pt = z.dropFirst("a=rtpmap:".count).prefix { $0.isNumber }
            if !pt.isEmpty { opus.insert(String(pt)) }
        }
        guard !opus.isEmpty else { return sdp }
        var aus: [String] = []
        var mitFmtp = Set<String>()
        for z in zeilen {
            if z.hasPrefix("a=fmtp:") {
                let pt = String(z.dropFirst("a=fmtp:".count).prefix { $0.isNumber })
                if opus.contains(pt) {
                    mitFmtp.insert(pt)
                    if !z.contains("stereo=") {
                        aus.append(z + ";stereo=1;sprop-stereo=1")
                        continue
                    }
                }
            }
            aus.append(z)
        }
        // Opus ganz ohne fmtp-Zeile: eine anlegen, sonst geht der Wunsch verloren.
        for pt in opus where !mitFmtp.contains(pt) {
            if let i = aus.firstIndex(where: { $0.lowercased().hasPrefix("a=rtpmap:\(pt) opus/") }) {
                aus.insert("a=fmtp:\(pt) stereo=1;sprop-stereo=1", at: i + 1)
            }
        }
        return aus.joined(separator: "\r\n")
    }

    /// Angebot senden. Rückgabe: Antwort-SDP und die Ressource für DELETE
    /// (`nil`, wenn der Server keine oder eine fremde Adresse nennt).
    static func anbieten(_ url: URL, sdp: String) async throws -> (antwort: String, ressource: URL?) {
        var anfrage = URLRequest(url: url, timeoutInterval: 10)
        anfrage.httpMethod = "POST"
        anfrage.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        anfrage.httpBody = Data(sdp.utf8)
        let (daten, antwort): (Data, URLResponse)
        do {
            (daten, antwort) = try await sitzung.data(for: anfrage)
        } catch {
            throw Fehler(status: 0, text: "whep_netz")
        }
        let http = antwort as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else { throw Fehler(status: status, text: "") }
        let text = String(decoding: daten, as: UTF8.self)
        guard text.contains("v=") else { throw Fehler(status: 0, text: "whep_keine_sdp") }
        let ort = http?.value(forHTTPHeaderField: "Location")
        return (text, ressource(ort, basis: url))
    }

    /// Nur derselben Herkunft folgen — ein fremder oder verbogener
    /// `Location`-Kopf darf das DELETE nicht woanders hinlenken (wie `whep.ts`).
    static func ressource(_ ort: String?, basis: URL) -> URL? {
        guard let ort, let ziel = URL(string: ort, relativeTo: basis)?.absoluteURL else { return nil }
        guard ziel.scheme == basis.scheme, ziel.host == basis.host, ziel.port == basis.port else { return nil }
        return ziel
    }

    /// Bestmöglich — der Server räumt die Sitzung ohnehin nach einer Frist ab.
    static func beenden(_ ressource: URL?) {
        guard let ressource else { return }
        var anfrage = URLRequest(url: ressource, timeoutInterval: 3)
        anfrage.httpMethod = "DELETE"
        sitzung.dataTask(with: anfrage).resume()
    }
}
