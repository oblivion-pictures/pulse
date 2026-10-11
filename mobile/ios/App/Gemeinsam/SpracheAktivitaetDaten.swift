import ActivityKit
import Foundation

/// Die Live Activity „Im Sprachkanal“ (Roadmap Punkt 28) — die Form, die App
/// und Widget-Erweiterung teilen.
///
/// **In BEIDE Targets übersetzt, mit Absicht.** ActivityKit findet die
/// Darstellung (in der Erweiterung, `SpracheAktivitaetWidget`) über diesen
/// Typ; die App startet und füttert sie (`SpracheLiveAktivitaet`). Zwei Kopien
/// liefen beim ersten neuen Feld auseinander.
///
/// **Was hier steht, sieht man auf dem Sperrbildschirm.** Kanal, Community und
/// die Namen derer, die sprechen — genau das, was der Auftrag für Punkt 28
/// vorsieht, und nichts aus Nachrichten: die sind Ende-zu-Ende verschlüsselt,
/// und die Hülle kennt sie nicht. ActivityKit begrenzt den Inhalt auf 4 kB;
/// Namen werden deshalb gekürzt (`SpracheLiveAktivitaet.kurz`).
struct SpracheAktivitaet: ActivityAttributes {
    /// Fest für die Dauer der Aktivität: ein Kanalwechsel beendet sie und
    /// beginnt eine neue (`SpracheRaum.beitreten` verlässt zuerst).
    let kanalName: String
    /// Leer, wenn die Oberfläche keinen mitschickt (ältere Web-App) — die
    /// Ansicht lässt die Zeile dann weg.
    let communityName: String

    struct ContentState: Codable, Hashable {
        /// Alle im Raum, man selbst eingeschlossen.
        var teilnehmer: Int
        /// Das eigene Mikrofon ist zu.
        var stumm: Bool
        /// Man hört nicht mit — selbst gewählt ODER weil ein Anruf den Kanal
        /// anhält (der WIRKSAME Stand, wie `eigenerZustand` ihn meldet).
        var taub: Bool
        /// Ein Direktanruf hält den Kanal an (`SpracheRaumStumm.swift`).
        var pausiert: Bool
        /// Die Moderation hat einen stummgeschaltet. Dann bietet die
        /// Aktivität keinen Mikrofon-Knopf an — einschalten ginge nicht.
        var gesperrt: Bool
        /// Steht die Verbindung? `false` während eines Wiederaufbaus.
        var verbunden: Bool
        /// Wer gerade spricht (ohne einen selbst), höchstens zwei Namen.
        var sprechend: [String]
        /// Wie viele ausserdem sprechen.
        var weitereSprechend: Int
    }

    /// Bietet die Aktivität „Mikrofon einschalten“ an? Dieselben Regeln, die
    /// `SpracheRaum.ausLiveAktivitaet` beim Ausführen noch einmal prüft:
    /// nicht gegen die Moderation, nicht aus dem Taubstellen heraus (das Web
    /// verweigert das ebenso, `toggleMic`), nicht während eines Anrufs.
    static func mikrofonSchaltbar(_ s: ContentState) -> Bool {
        if s.pausiert || s.gesperrt { return false }
        return !(s.stumm && s.taub)
    }
}
