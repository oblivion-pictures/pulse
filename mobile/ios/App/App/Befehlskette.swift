import Capacitor
import Foundation

// Eigene Datei seit dem 2026-10-11 (Grössen-Policy, `PLAN.md` §12.1): stand
// bis dahin am Ende von `SpracheRaum.swift`, gehört aber beiden Räumen.

/// Befehle der Reihe nach — für `SpracheRaum` und `AnrufRaum` dieselbe
/// Mechanik (Begründung an `SpracheRaum.nacheinander`). Jeder Befehl wartet
/// auf den vorigen; ein Fehlschlag reisst die Kette nicht ab.
///
/// **Die Reihenfolge entsteht beim EINREIHEN, nicht beim Start eines Tasks**
/// (iOS-Bughunt 2 vom 2026-10-11, B5). Bis dahin stellte jeder Brücken-Ruf
/// sich aus einem eigenen `Task { … nacheinander … }` an, und zwei solche
/// Tasks starten in keiner zugesagten Reihenfolge — ein „aus" direkt nach
/// einem „an" konnte sich davor drängen, und genau dagegen war die Kette
/// gebaut (G4). `einreihen` legt den Platz in der Kette fest, bevor es
/// zurückkehrt; wer es synchron ruft (die Plugins auf Capacitors serieller
/// Warteschlange, die Anrufverwaltung auf dem Hauptthread), bekommt die
/// Reihenfolge seiner Aufrufe.
final class Befehlskette: @unchecked Sendable {
    private let sperre = NSLock()
    private var letzte: Task<Void, Never>?

    /// `arbeit` sofort einreihen; `fertig` bekommt ihr Ergebnis, auf dem
    /// Faden, auf dem die Arbeit endete.
    func einreihen<T>(_ arbeit: @escaping () async throws -> T,
                      fertig: @escaping (Result<T, Error>) -> Void) {
        sperre.lock()
        let vorher = letzte
        letzte = Task {
            await vorher?.value
            do {
                fertig(.success(try await arbeit()))
            } catch {
                fertig(.failure(error))
            }
        }
        sperre.unlock()
    }

    /// Für Aufrufer, die ohnehin warten. Eingereiht wird, wenn dieser Ruf
    /// sein `await` erreicht — die Reihenfolge gegenüber ANDEREN Aufrufern
    /// sagt das nur zu, wenn deren Ruf ebenso der Reihe nach kommt.
    func nacheinander<T>(_ arbeit: @escaping () async throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { fortsetzen in
            einreihen(arbeit) { fortsetzen.resume(with: $0) }
        }
    }
}

extension CAPPlugin {
    /// Ein Ereignis an die Hörer im Web — **immer auf Capacitors
    /// Brücken-Warteschlange** (iOS-Bughunt 2 vom 2026-10-11, B6).
    ///
    /// Capacitor führt die Hörer-Tabelle in `NSMutableDictionary` und
    /// `NSMutableArray` ohne Sperre (`CAPPlugin.m`, `notifyListeners` liest sie,
    /// `addListener`/`removeListener`/`removeAllListeners` schreiben sie). Die
    /// Schreiber laufen auf `CapacitorBridge.dispatchQueue`: jeder Plugin-Ruf
    /// aus dem Web landet dort (`handleJSCall`), auch die drei Hörer-Methoden.
    /// LiveKit ruft seine Delegaten dagegen von eigenen Fäden, und von dort
    /// liefen Lesen und Schreiben bisher gleichzeitig. Auf der Brücken-
    /// Warteschlange sind sie es nicht mehr.
    ///
    /// **Was offen bleibt, und es ist Capacitors eigenes Rennen:** beim
    /// Navigieren der WebView räumt `CapacitorBridge.reset()` die Tabelle vom
    /// HAUPTthread ab — gegen sein eigenes `addListener` auf der Brücke ist
    /// das genauso ungesichert. Einen Faden, der beide Schreiber abdeckt, gibt
    /// es nicht; die Brücke deckt den häufigen.
    ///
    /// Die Reihenfolge bleibt die der Aufrufe: die Warteschlange ist seriell,
    /// und `notifyListeners` reicht weiter an `DispatchQueue.main` (`toJs`).
    func ereignisMelden(_ name: String, _ daten: [String: Any], aufbewahren: Bool = false) {
        brueckenFaden.async { [weak self] in
            self?.notifyListeners(name, data: daten, retainUntilConsumed: aufbewahren)
        }
    }

    /// Hört im Web jemand auf `name`? Dann das Ereignis melden — Frage und
    /// Meldung in EINEM Schritt auf der Brücke, sonst läse der Faden des
    /// Rufers die Tabelle (B6). `true`, wenn gemeldet wurde.
    func meldenFallsGehoert(_ name: String, _ daten: [String: Any]) async -> Bool {
        await withCheckedContinuation { antwort in
            brueckenFaden.async { [weak self] in
                guard let self, self.hasListeners(name) else {
                    antwort.resume(returning: false)
                    return
                }
                self.notifyListeners(name, data: daten)
                antwort.resume(returning: true)
            }
        }
    }

    /// Capacitors serielle Warteschlange für Plugin-Rufe — dort, und nur
    /// dort, fasst man die Hörer-Tabelle an (s. `ereignisMelden`).
    var brueckenFaden: DispatchQueue {
        (bridge as? CapacitorBridge)?.dispatchQueue ?? DispatchQueue.main
    }
}
