import Foundation

// Eigene Datei seit dem 2026-10-11 (Grössen-Policy, `PLAN.md` §12.1): stand
// bis dahin am Ende von `SpracheRaum.swift`, gehört aber beiden Räumen.

/// Befehle der Reihe nach — für `SpracheRaum` und `AnrufRaum` dieselbe
/// Mechanik (Begründung an `SpracheRaum.nacheinander`). Jeder Befehl wartet
/// auf den vorigen; ein Fehlschlag reisst die Kette nicht ab.
final class Befehlskette: @unchecked Sendable {
    private let sperre = NSLock()
    private var letzte: Task<Void, Never>?

    func nacheinander<T>(_ arbeit: @escaping () async throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { fortsetzen in
            sperre.lock()
            let vorher = letzte
            letzte = Task {
                await vorher?.value
                do {
                    fortsetzen.resume(returning: try await arbeit())
                } catch {
                    fortsetzen.resume(throwing: error)
                }
            }
            sperre.unlock()
        }
    }
}
