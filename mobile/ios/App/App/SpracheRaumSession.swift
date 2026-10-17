import AVFoundation
import LiveKit
import UIKit

/// Was die Audio-Session der Hülle tut, während der Raum steht — beobachtet,
/// nicht gesteuert.
///
/// **Warum eine eigene Datei.** Hier steht nichts, was etwas bewirkt: nur
/// Beobachter und ihre Begründungen — was sie anstossen, entscheidet der
/// Mikrofon-Wächter (`SpracheMikroWache.swift`). Zusammen mit der Steuerung lag
/// `SpracheRaum.swift` über der Grössen-Policy (`PLAN.md` §12.1). Reine
/// Verschiebung, Verhalten unverändert; `sessionBeobachter` liegt weiter am
/// Typ, weil eine Erweiterung keine gespeicherte Eigenschaft tragen kann.
extension SpracheRaum {
    /// Horcht auf Routenwechsel UND Unterbrechungen der Session — einmal fuers
    /// ganze Leben des Singletons, nicht je Beitritt (beide haengen am
    /// einen Merker, sie werden zusammen angelegt).
    ///
    /// **Der Routenwechsel ist ASYNCHRON, und das war eine Messfalle.** Am
    /// 2026-10-10 am Gerät gemessen lagen zwischen `setCategory` und dem
    /// `routeChangeNotification` mit der neuen Route 8–17 ms. Wer die Route
    /// direkt nach dem Umschalten liest, liest deshalb noch die alte — genau
    /// diese Zahl stand stundenlang als Beleg dafür, dass der Schalter nicht
    /// trägt. Die Oberfläche braucht die Wahrheit ausserdem auch dann, wenn
    /// sie den Wechsel nicht selbst ausgelöst hat (Kopfhörer rein, AirPods).
    func sessionBeobachtenFallsNoetig() {
        SpracheFunkHq.geteilt.maschinenBeobachtenFallsNoetig()
        guard sessionBeobachter == nil else { return }
        sessionBeobachter = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil
        ) { [weak self] n in
            guard let self else { return }
            let grund = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 99
            NSLog("[PulseSprache] Routenwechsel grund=%lu neu=%@ kat=%@ modus=%@ opt=%lu funk=%@",
                  grund, routeJetzt(),
                  AVAudioSession.sharedInstance().category.rawValue,
                  AVAudioSession.sharedInstance().mode.rawValue,
                  AVAudioSession.sharedInstance().categoryOptions.rawValue,
                  funkFelder().map { "\($0.key)=\($0.value)" }.sorted().joined(separator: " "))
            // Kopfhörer rein/raus, und jeder Kategoriewechsel (auch der
            // eigene): der Bluetooth-Weg folgt der Route (`SpracheFunkHq`).
            if raum != nil {
                SpracheFunkHq.geteilt.kopfhoererWeg(volle: ton.volle)
                schickeEigenen()
                funkHqAnstossen("route")
                funkHqNachRoute()
            }
        }
        // **Eine Unterbrechung heisst: jemand anderes hat die Session.** Das
        // ist die Zeile, an der der Hoermuschel-Fehler hing — die Oberfläche
        // spielte ihren Beitritts-Ton, WebKit richtete dafür seine eigene,
        // nicht mischbare Session ein, und iOS nahm uns die unsere. Danach
        // bewegt kein `setCategory` mehr eine Route. Ohne diese Meldung sieht
        // genau das aus wie „der SDK-Schalter trägt nicht".
        //
        // `eingaenge` steht mit im Log, weil `AVAudioSession` nicht sagt, ob
        // sie aktiv ist: eine nicht aktivierte `.playAndRecord`-Session führt
        // keinen Eingang.
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: nil
        ) { [weak self] n in
            guard let self, raum != nil else { return }
            let info = n.userInfo ?? [:]
            let roh = info[AVAudioSessionInterruptionTypeKey] as? UInt ?? 99
            let optionen = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let weiter = AVAudioSession.InterruptionOptions(rawValue: optionen).contains(.shouldResume)
            let grund = info[AVAudioSessionInterruptionReasonKey] as? UInt ?? 99
            NSLog("[PulseSprache] Unterbrechung art=%@ route=%@ engine=%@ eing=%@",
                  roh == 1 ? "begonnen" : (roh == 0 ? "beendet" : "\(roh)"),
                  routeJetzt(),
                  AudioManager.shared.isEngineRunning ? "laeuft" : "aus",
                  AVAudioSession.sharedInstance().currentRoute.inputs
                      .map { $0.portType.rawValue }.joined(separator: ","))
            diagMelden(roh == 1 ? "unterbrechung_beginn" : "unterbrechung_ende",
                       ["grund": grund, "shouldResume": weiter])
            wache.unterbrechung(begonnen: roh == 1)
        }
        // **Die Mediendienste starten neu** (selten, aber dann ist ALLES weg:
        // Session, Maschine, Routen). Die Wächter-Leiter heilt das wie jeden
        // anderen Ausfall; gemeldet wird es eigens, weil es ein Anlass für den
        // Diagnosebericht ist.
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil
        ) { [weak self] _ in
            guard let self, raum != nil else { return }
            diagMelden("media_reset", [:])
            wache.anstossen("media_reset")
        }
        // Zurück im Vordergrund: sofort nachsehen, ob das Mikrofon noch liefert
        // — der Nutzer schaut gerade hin, und ein toter Kanal soll nicht erst
        // nach dem nächsten Takt auffallen.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            // Der Merker IMMER, auch ohne Raum — sonst bliebe er nach einem
            // Verlassen im Hintergrund auf „hinten" stehen (Gegenprüfung 2, U1).
            wache.vordergrund(true)
            if raum != nil { wache.anstossen("vordergrund") }
        }
        // Im Hintergrund greift der Wächter nicht in die Kette ein — iOS lehnt
        // dort das Aktivieren gegen einen fremden Halter ab (Gegenprüfung T1).
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { [weak self] _ in
            self?.wache.vordergrund(false)
        }
    }
}
