import Foundation

/// Wer beim Teilen zuerst entscheidet: die Arbeit, die Frist oder der Nutzer
/// (iOS-Bughunt 2, D3).
///
/// **Warum es das braucht.** Die Teilen-Erweiterung zeigte beim Laden nur ein
/// Rad. Lädt ein Anbieter nie zu Ende — ein Foto, das erst aus iCloud kommen
/// muss, ein Anbieter, der seinen Rückruf nie ruft —, stand die Karte für
/// immer da; einen Weg hinaus gab es nicht, denn die Karte liegt als
/// `overFullScreen` über allem.
///
/// Jetzt gibt es drei Ausgänge, und genau einer gewinnt. Das ist die eigentliche
/// Aufgabe dieses Typs: läuft die Frist ab, während die Arbeit gerade
/// ablegen will, darf nicht beides geschehen — sonst läge ein Paket in der
/// Ablage, obwohl die Karte „nicht übergeben" sagt, und Pulse böte beim
/// nächsten Start etwas an, das der Nutzer verloren glaubt.
///
/// In `Gemeinsam/`, damit die App ihn im Prüfpfad fahren kann
/// (`ShareReceiverProbe`, `wettlauf`); benutzt wird er von der Erweiterung.
final class TeilenWettlauf: @unchecked Sendable {
    enum Ausgang: Equatable {
        /// Die Arbeit ist durch: sie legt ab, oder sie meldet, dass es nichts
        /// Brauchbares gab. Beides zeigt die Karte als Ergebnis.
        case fertig
        /// Die Frist ist um, bevor die Arbeit fertig war.
        case abgelaufen
        /// Der Nutzer hat abgebrochen.
        case abgebrochen
    }

    /// `@unchecked Sendable` hält, was es sagt: `ausgang` liegt hinter der Sperre.
    private let sperre = NSLock()
    private var ausgang: Ausgang?

    /// Will `a` entscheiden? `true` heisst: entschieden, und zwar so — jeder
    /// spätere Versuch bekommt `false`.
    func entscheiden(_ a: Ausgang) -> Bool {
        sperre.lock()
        defer { sperre.unlock() }
        guard ausgang == nil else { return false }
        ausgang = a
        return true
    }
}
