import Foundation
import LiveKit

/// Begrenzer am Ende der Wiedergabe — das native Gegenstück zum Limiter des
/// Web-Wegs (`RemoteAudioElements.LIMITER` in `web/src/lib/voice/audioElements.ts`,
/// Einstellung `limiterEnabled`, Vorgabe an).
///
/// **Warum es ihn nativ gibt, obwohl der Mobil-Web-Weg ihn nie hatte.** Im Web
/// ist er ein Knoten im Web-Audio-Graphen, und den baut nur der Rechner-Weg;
/// auf dem Telefon spielt jede Spur über ein `<audio>`-Element, und die
/// Einstellung war dort wirkungslos — angeboten wurde sie trotzdem. Auf dem
/// nativen Weg gibt es eine saubere Stelle ohne neue Abhängigkeit: LiveKits
/// `AudioManager.renderPreProcessingDelegate`, laut Doc-Kommentar des SDK
/// „modify the combined remote audio buffer (all tracks) before it is played
/// to the user".
///
/// **Was er sieht, ist die fertige Mischung.** Die Lautstärke je Teilnehmer
/// (`RemoteAudioTrack.volume`) wirkt davor — dieselbe Reihenfolge wie im Web
/// (Gain, dann Begrenzer). Weil es EINE Mischung je Prozess gibt, wirkt er auf
/// alles, was die Hülle abspielt, solange er eingehängt ist: steht neben dem
/// Sprachkanal ein Anruf, wird auch der begrenzt. Eingehängt ist er nur,
/// solange ein Sprachkanal steht (`SpracheRaum.begrenzerSetzen`).
///
/// **Bewusst ohne Aufholverstärkung.** Der Web-Weg nimmt einen
/// `DynamicsCompressorNode`, und der hebt nach der Web-Audio-Spezifikation
/// alles um eine aus Schwelle und Verhältnis errechnete Verstärkung an (bei
/// diesen Werten etwa +3,4 dB — gerechnet, nicht gemessen). Das hier ist ein
/// reiner Begrenzer: unterhalb der Schwelle ändert er nichts, und das Telefon
/// klingt mit ihm so laut wie bisher ohne ihn.
///
/// **Ohne Vorschau.** Der Anstieg braucht 3 ms; die ersten Proben eines
/// plötzlichen Knalls kommen durch.
///
/// Alles ausser den Konstanten läuft auf WebRTCs Ton-Faden: keine Sperre,
/// keine Speicheranforderung im Takt.
final class Wiedergabebegrenzer: NSObject, AudioCustomProcessingDelegate, @unchecked Sendable {
    static let geteilt = Wiedergabebegrenzer()

    /// Dieselben Werte wie `RemoteAudioElements.LIMITER` im Web.
    static let schwelleDb: Float = -6
    static let verhaeltnis: Float = 20
    static let anstiegSekunden: Float = 0.003
    static let abfallSekunden: Float = 0.1

    /// WebRTC reicht die Proben als Float im Wertebereich von Int16, nicht
    /// ±1 — dieselbe Annahme trifft das SDK in `LKAudioBuffer.toAVAudioPCMBuffer`.
    static let vollaussteuerung: Float = 32768
    static let schwelle = vollaussteuerung * powf(10, schwelleDb / 20)
    /// Über der Schwelle gilt Ausgang = Schwelle · (Eingang/Schwelle)^(1/Verhältnis),
    /// als Verstärkung (Ausgang/Eingang) also (Eingang/Schwelle)^exponent.
    static let exponent = 1 / verhaeltnis - 1

    private var anstieg: Float = 0
    private var abfall: Float = 0
    private var verstaerkung: Float = 1

    #if DEBUG
        /// Nur für den Prüfpfad: lauteste Probe vor und nach dem Begrenzer
        /// seit dem letzten Ablesen. Ungeschützt geteilt — ein Messwert, der
        /// um einen Block daneben liegt, stört dort nicht.
        var spitzeEin: Float = 0
        var spitzeAus: Float = 0
    #endif

    func audioProcessingInitialize(sampleRate sampleRateHz: Int, channels _: Int) {
        let rate = Float(max(sampleRateHz, 1))
        anstieg = expf(-1 / (Self.anstiegSekunden * rate))
        abfall = expf(-1 / (Self.abfallSekunden * rate))
        verstaerkung = 1
    }

    func audioProcessingProcess(audioBuffer: LKAudioBuffer) {
        let kanaele = audioBuffer.channels
        let proben = audioBuffer.frames
        guard kanaele > 0 else { return }
        withUnsafeTemporaryAllocation(of: UnsafeMutablePointer<Float>.self, capacity: kanaele) { zeiger in
            for k in 0 ..< kanaele { zeiger[k] = audioBuffer.rawBuffer(forChannel: k) }
            for i in 0 ..< proben {
                // Gekoppelt über alle Kanäle: getrennt begrenzt verschöbe sich
                // das Stereobild bei jedem lauten Einsatz.
                var spitze: Float = 0
                for k in 0 ..< kanaele { spitze = max(spitze, abs(zeiger[k][i])) }
                let ziel = spitze > Self.schwelle ? powf(spitze / Self.schwelle, Self.exponent) : 1
                let glaettung = ziel < verstaerkung ? anstieg : abfall
                verstaerkung = ziel + glaettung * (verstaerkung - ziel)
                // Nahe der 1 einrasten: die Hüllkurve nähert sich ihr sonst nur
                // langsam an, und so lange liefe die Multiplikation unten weiter.
                if ziel == 1, verstaerkung > 0.9999 { verstaerkung = 1 }
                #if DEBUG
                    spitzeEin = max(spitzeEin, spitze)
                    spitzeAus = max(spitzeAus, spitze * verstaerkung)
                #endif
                guard verstaerkung < 1 else { continue }
                for k in 0 ..< kanaele { zeiger[k][i] *= verstaerkung }
            }
        }
    }

    func audioProcessingRelease() {}
}
