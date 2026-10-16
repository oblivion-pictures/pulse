import AVFoundation
import LiveKit

/// Zählt die Puffer, die das eigene Mikrofon liefert — am Ende der
/// Aufnahme-Verarbeitung des SDK (`AudioManager.add(localAudioRenderer:)`,
/// derselbe Haken, mit dem das SDK selbst auf das erste Bild wartet:
/// `LocalAudioTrack.startWaitingForFrames`).
///
/// **Warum es das braucht** (Befund TestFlight 2.1): im Sprachkanal fiel das
/// Mikrofon aus, ohne dass es irgendwo sichtbar wurde — kein oranger Punkt, der
/// Desktop hörte nichts, und die Oberfläche zeigte ein offenes Mikrofon. Ein
/// stehender Aufnahmepfad liefert schlicht keine Puffer mehr; genau das zählt
/// diese Klasse.
///
/// Läuft auf dem Audio-Faden des SDK: nur eine Sperre und drei Zahlen, kein
/// Brückenverkehr, keine Zuteilung.
final class MikroPufferZaehler: NSObject, AudioRenderer, @unchecked Sendable {
    private let sperre = NSLock()
    private var anzahl: UInt64 = 0
    private var spitze: Float = 0
    private var zuletzt: CFAbsoluteTime = 0
    private var beimErsten: (() -> Void)?

    func render(pcmBuffer: AVAudioPCMBuffer) {
        let p = Self.spitze(pcmBuffer)
        let jetzt = CFAbsoluteTimeGetCurrent()
        sperre.lock()
        anzahl &+= 1
        if p > spitze { spitze = p }
        zuletzt = jetzt
        let erster = beimErsten
        beimErsten = nil
        sperre.unlock()
        erster?()
    }

    /// Einmal rufen, sobald der nächste Puffer kommt — für „das Mikrofon
    /// liefert", ohne auf den nächsten Takt zu warten.
    func beimNaechsten(_ f: @escaping () -> Void) {
        sperre.lock()
        beimErsten = f
        sperre.unlock()
    }

    /// Stand lesen; die Spitze gilt seit dem letzten Ablesen.
    func ablesen() -> (anzahl: UInt64, spitze: Float, zuletzt: CFAbsoluteTime) {
        sperre.lock()
        defer {
            spitze = 0
            sperre.unlock()
        }
        return (anzahl, spitze, zuletzt)
    }

    /// Spitze 0…1. Das SDK reicht Int16 (`LKAudioBuffer.toAVAudioPCMBuffer`);
    /// Float wird der Vollständigkeit halber gelesen.
    static func spitze(_ b: AVAudioPCMBuffer) -> Float {
        let n = Int(b.frameLength)
        guard n > 0 else { return 0 }
        if let k = b.int16ChannelData?[0] {
            var m: Int32 = 0
            for i in 0 ..< n { m = max(m, abs(Int32(k[i]))) }
            return Float(m) / 32768
        }
        if let k = b.floatChannelData?[0] {
            var m: Float = 0
            for i in 0 ..< n { m = max(m, abs(k[i])) }
            return m
        }
        return 0
    }
}

/// Die Regeln des Mikrofon-Wächters (`SpracheMikroWache.swift`) — rein,
/// ohne Zustand, damit sie an einer Stelle stehen und nachlesbar bleiben.
enum WacheRegeln {
    /// So lange gilt eine offene Unterbrechung als berechtigt (Siri, Diktat,
    /// Wecker, eine andere App). **60 s statt der ersten 15** (Gegenprüfung 2,
    /// U3): ein echtes K1-Merkmal sieht die Hülle nicht — ob WebKit seine
    /// Erklärung verloren hat, weiss nur die WebView, und eine eigene Meldung
    /// dafür bräuchte einen neuen Befehl, den kein Bau im Feld kennt. Die
    /// erste Heilung von K1 kommt ohnehin sofort und ohne Risiko über Stufe 1
    /// (WebKit neu erklären); die Maschine anzufassen ist erst die zweite Wahl.
    /// Ein Diktat oder Siri dauert selten eine Minute, K1 endet nie von
    /// selbst — die längere Geduld kostet also nur bei K1 Zeit, und schützt
    /// jede berechtigte Unterbrechung. Gesetzt, nicht gemessen.
    static let unterbrechungsGeduld: CFAbsoluteTime = 60
    static let nachholStart: TimeInterval = 2
    static let nachholHoechstens: TimeInterval = 30

    /// Darf der Wächter als nächstes Stufe `stufe` (1…4) fahren?
    ///
    /// - Stufe 1 (nur das Web erklärt WebKit neu) immer.
    /// - **Nie gegen fremden Ton** (Gegenprüfung T1): die Maschine
    ///   freizugeben heisst, die Session zu aktivieren, und das lehnt iOS
    ///   gegen eine fremde, nicht mischbare Session ab.
    /// - **Im Hintergrund ja, wenn nichts Fremdes läuft** (U2): ein gesperrtes
    ///   Telefon im Kanal ist der Normalbetrieb, und dort sollen K2 und ein
    ///   Neustart der Mediendienste heilen. Ein Fehlschlag kostet nichts
    ///   Dauerhaftes mehr — das Nachholen gibt die Maschine wieder frei.
    /// - **Während einer offenen Unterbrechung** nur Stufe 2, nur im
    ///   Vordergrund und erst nach `unterbrechungsGeduld` (U3) — Stufe 3 und 4
    ///   nie: kein Spur-Neuaufbau und kein Band mitten in Siri.
    static func stufeErlaubt(_ stufe: Int, vordergrund: Bool, fremdTon: Bool,
                             unterbrochenSeit: CFAbsoluteTime?, jetzt: CFAbsoluteTime) -> Bool {
        if stufe <= 1 { return true }
        if fremdTon { return false }
        guard let seit = unterbrochenSeit else { return true }
        return stufe == 2 && vordergrund && jetzt - seit >= unterbrechungsGeduld
    }

    /// Ist die Maschine gesperrt, obwohl sie laufen soll? Ohne Mikrofon-
    /// Erlaubnis genügt die Ausgabe.
    static func maschineGesperrt(_ a: AudioEngineAvailability, erlaubt: Bool) -> Bool {
        !a.isOutputAvailable || (erlaubt && !a.isInputAvailable)
    }

    static func naechsterNachholAbstand(_ a: TimeInterval) -> TimeInterval {
        min(nachholHoechstens, max(nachholStart, a * 2))
    }
}
