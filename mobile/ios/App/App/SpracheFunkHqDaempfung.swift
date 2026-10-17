import Foundation
import LiveKit

/// Die Wiedergabe des Kanals stumm, solange er nach Bluetooth-HQ am
/// Lautsprecher noch ohne VPIO läuft (`SpracheFunkHq.kopfhoererWeg`, B3).
/// LiveKits Mischer (`mixer.outputVolume` → `mainMixerNode`); das Mikrofon
/// läuft über den eigenen Eingangsmischer und bleibt unberührt, der
/// Stream-Ton hat seine eigene Maschine und bleibt hörbar.
///
/// **Die Fristen, seit Gegenprüfung C2:**
/// - `ohneVpio` zählt ab dem Augenblick, in dem die Verarbeitung ZURÜCK ist,
///   nicht ab dem Dämpfen — sonst war sie nach einem langen Befehl in der
///   Kette schon abgelaufen, und es wurde vor dem VPIO-Neubau wieder laut.
/// - `hoechstens` ist ein eigener Zeitgeber, unabhängig von den Gettern des
///   SDK: die blockieren, solange WebRTCs Faden hängt (etwa im Neubau).
/// - Geprüft wird zuerst die Frist, erst dann gelesen.
final class FunkDaempfung: @unchecked Sendable {
    static let hoechstens: TimeInterval = 8
    /// Ohne VPIO-Rückmeldung (Simulator, oder sie kommt nicht): so lange nach
    /// dem Zurückstellen der Verarbeitung, dann wieder hörbar.
    static let ohneVpio: CFAbsoluteTime = 1.5

    private let sperre = NSLock()
    /// Jede Dämpfung hat ihre Nummer — ein Zeitgeber einer früheren hebt
    /// keine spätere auf.
    private var runde = 0
    private var aktiv = false
    private var zurueckSeit: CFAbsoluteTime?
    private var vorher: Float = 1

    func an() {
        let r = sperre.withLock { () -> Int? in
            guard !aktiv else { return nil }
            aktiv = true
            zurueckSeit = nil
            runde += 1
            return runde
        }
        guard let r else { return }
        let mixer = AudioManager.shared.mixer
        let v = mixer.outputVolume
        sperre.withLock { vorher = v }
        mixer.outputVolume = 0
        DispatchQueue.global().async { SpracheRaum.geteilt.diagMelden("funk_daempfung", ["an": true]) }
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.hoechstens) { [self] in
            aus(grund: "hoechstens", runde: r)
        }
        pruefen(r)
    }

    /// Liest die blockierenden Getter des SDK auf einem eigenen Faden, nie auf
    /// einem von WebRTC (dieselbe Regel wie `tonBeleg`).
    private func pruefen(_ r: Int) {
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) { [self] in
            let seit = sperre.withLock { () -> CFAbsoluteTime?? in
                aktiv && runde == r ? .some(zurueckSeit) : nil
            }
            guard let seit else { return }
            if let seit, CFAbsoluteTimeGetCurrent() - seit >= Self.ohneVpio {
                aus(grund: "frist", runde: r)
                return
            }
            let am = AudioManager.shared
            let zurueck = am.audioProcessingState.echoCancellation.requested?.mode != .software
            if zurueck, am.platformVoiceProcessingState.voiceProcessingEnabled.isActive {
                aus(grund: "vpio", runde: r)
                return
            }
            if zurueck {
                sperre.withLock { if zurueckSeit == nil { zurueckSeit = CFAbsoluteTimeGetCurrent() } }
            }
            pruefen(r)
        }
    }

    /// `runde`: nur diese Dämpfung beenden (Zeitgeber); `nil` = jede.
    func aus(grund: String, runde r: Int? = nil) {
        let v = sperre.withLock { () -> Float? in
            guard aktiv, r == nil || r == runde else { return nil }
            aktiv = false
            return vorher
        }
        guard let v else { return }
        AudioManager.shared.mixer.outputVolume = v
        DispatchQueue.global().async {
            SpracheRaum.geteilt.diagMelden("funk_daempfung", ["an": false, "grund": grund])
        }
    }
}
