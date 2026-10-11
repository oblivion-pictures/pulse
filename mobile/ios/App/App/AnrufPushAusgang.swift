import CallKit
import Foundation

/// **Was ein VoIP-Push auslöst — als reine Entscheidung, ohne Zustand und
/// ohne Aufruf an CallKit.** Ausgeführt wird sie in `AnrufPush.swift`,
/// geprüft im Debug-Bau über `AnrufPushProbe.swift`.
///
/// **Apples Regel** (Doc-Kommentar von `PKPushRegistryDelegate`): auf JEDEN
/// VoIP-Push muss die App im selben Lauf `reportNewIncomingCall` rufen, sonst
/// beendet iOS sie, und nach Wiederholung stellt es ihr die VoIP-Pushes ab.
/// Deshalb kennt `PushAusgang` keinen Fall „nichts tun": jeder der fünf
/// Ausgänge meldet bei CallKit, und welcher es wird, hängt nur daran, was
/// hier über den Anruf bekannt ist.
///
/// **Ein Push für einen Anruf, den CallKit schon führt, meldet ihn mit der
/// BESTEHENDEN UUID erneut** — Apples Vorgabe aus den Developer Forums. CallKit
/// antwortet dann `callUUIDAlreadyExists`, und das gilt als erfüllt. Bis zum
/// 2026-10-11 meldete die App in diesem Fall gar nichts. Seit `eddb1a42`
/// (Bughunt T14) klingelt der Server jedes iOS-Gerät per Push an, auch eines
/// mit wacher WebSocket, und damit ist der Fall alltäglich: die Oberfläche
/// meldet den Anruf über `ankommen`, kurz darauf kommt der Push. Dass iOS die
/// App danach nicht mehr beendet, ist nur am Gerät zu belegen — der Simulator
/// bekommt keinen echten VoIP-Push.
extension Anrufverwaltung {
    /// `art` im Push (`anruf_push.py`): `klingelt` oder `abbruch`. Alles, was
    /// nicht `abbruch` ist, gilt als Klingeln — wie vor der Aufteilung.
    enum PushArt: String {
        case klingeln, abbruch
    }

    enum PushAusgang: Equatable {
        /// Unbekannter Anruf: neu melden, er klingelt.
        case neuMelden
        /// Bekannter Anruf: mit seiner UUID erneut melden, sonst nichts.
        case erneutMelden(UUID)
        /// Bekannter, noch klingelnder Anruf (oder angenommener ohne Raum, A3),
        /// den der Server abbricht: erneut melden, DANN beenden. Andersherum
        /// wäre die UUID bei CallKit schon frei, und die Meldung liesse den
        /// Anruf neu klingeln.
        case erneutMeldenUndBeenden(UUID)
        /// Kein CallKit-Anruf dazu (Abbruch eines unbekannten, Klingeln eines
        /// eben beendeten oder eines Gesprächs, das ohne CallKit läuft): mit
        /// einer Wegwerf-UUID melden und sofort beenden.
        case meldenUndSofortBeenden
        /// Ein NEUER Anruf, während hier schon einer läuft oder klingelt: wie
        /// `meldenUndSofortBeenden`, dazu als beendet merken und dem Web
        /// „ablehnen" sagen (Bughunt 2, A5, `besetzt` unten).
        case besetzt
    }

    /// Was CallKit auf eine Meldung geantwortet hat.
    enum MeldungsFolge: Equatable {
        /// Kein Fehler: CallKit zeigt einen klingelnden Anruf.
        case angezeigt
        /// `callUUIDAlreadyExists`: CallKit führt die UUID schon. Auf eine
        /// erneute Meldung die erwartete Antwort. **Keine Ablehnung** — der
        /// laufende Anruf darunter wird weder vergessen noch bekommt er eine
        /// neue Klingelfrist.
        case schonBekannt
        /// Abgewiesen („Nicht stören", Sperrliste, schon ein Anruf …).
        case abgewiesen
    }

    /// Was nach einer ERNEUTEN Meldung zu tun ist.
    enum NachErneuterMeldung: Equatable {
        case nichts
        /// Der Abbruch eines klingelnden Anrufs (oder eines angenommenen ohne
        /// Raum, A3): beenden.
        case beenden
        /// CallKit kannte die UUID nicht mehr und zeigt nun einen NEUEN Anruf
        /// darunter, den hier keiner führt: sofort wieder beenden.
        case geisterBeenden
    }

    /// **Ein Abbruch beendet nur einen KLINGELNDEN Anruf — oder einen
    /// angenommenen, dessen Raum nie entstand** (`angenommenOhneRaum`, A3).
    /// Ein Gespräch beendet der Server nicht per Push (`anruf_push.py`: das
    /// annehmende Gerät wird ausgetragen); käme für eines mit Raum doch einer,
    /// wird er gemeldet und das Gespräch läuft weiter. Ohne Raum aber heisst
    /// der Abbruch: der Server hat die Annahme nie gesehen — etwa, weil sie
    /// auf dem Sperrbildschirm geschah und die eingefrorene Oberfläche sie
    /// nicht weiterreichte (plausibel, ungemessen). Am Server ist der Anruf
    /// dann verpasst oder anderswo angenommen. Bis zum 2026-10-11 lief er hier
    /// weiter, als stilles Gespräch ohne Ende, und der Kanal blieb angehalten
    /// (Bughunt 2, A3).
    ///
    /// **`ohneCallKit`: das Gespräch läuft, aber CallKit kennt es nicht** (es
    /// hatte abgewiesen). Ein Push dafür darf es nicht neu klingeln lassen —
    /// das klingelte für ein laufendes Gespräch —, melden muss er trotzdem;
    /// es gilt derselbe Ausgang wie ohne Anruf. Ein Abbruch berührt es nicht.
    ///
    /// **`besetzt`: hier läuft oder klingelt schon ein ANDERER Anruf** (A5).
    /// Die Oberfläche lehnt einen zweiten ohnehin ab (`anruf.svelte.ts`,
    /// `eingehend`); klingelte er trotzdem bei CallKit, bot das System
    /// „Beenden & Annehmen" an, und das beendete über `beenden(kennung: nil)`
    /// beide. Gemeldet wird er — Apples Regel —, aber sofort beendet.
    static func pushAusgang(art: PushArt, bekannt: UUID?, klingelt: Bool,
                            kuerzlichBeendet: Bool, ohneCallKit: Bool,
                            angenommenOhneRaum: Bool = false, besetzt: Bool = false) -> PushAusgang {
        if let bekannt {
            let beenden = art == .abbruch && (klingelt || angenommenOhneRaum)
            return beenden ? .erneutMeldenUndBeenden(bekannt) : .erneutMelden(bekannt)
        }
        guard art == .klingeln, !kuerzlichBeendet, !ohneCallKit else { return .meldenUndSofortBeenden }
        return besetzt ? .besetzt : .neuMelden
    }

    /// Ein Duplikat erkennt man an Domäne UND Code — eine `2` aus einer
    /// anderen Domäne ist eine Ablehnung.
    static func meldungsFolge(_ fehler: Error?) -> MeldungsFolge {
        guard let fehler else { return .angezeigt }
        if let callKit = fehler as? CXErrorCodeIncomingCallError, callKit.code == .callUUIDAlreadyExists {
            return .schonBekannt
        }
        return .abgewiesen
    }

    /// `phase`: wo der Anruf steht, wenn CallKit geantwortet hat — nicht, als
    /// der Push kam. Dazwischen kann der Nutzer angenommen oder abgelehnt
    /// haben. `raumBegonnen` ebenso: ist der Raum inzwischen im Aufbau, gilt
    /// der Anruf als Gespräch.
    ///
    /// **Ein laufendes Gespräch wird hier nie beendet**, auch nicht, wenn
    /// CallKit wider Erwarten `angezeigt` meldet: diese Antwort ist eine
    /// Deutung, und ein Irrtum darin legte den echten Anruf auf. Ein
    /// angenommener Anruf ohne Raum ist noch keins (A3, `pushAusgang`). Ein
    /// „Geist" wird nur beendet, wenn hier kein Anruf mehr unter der UUID
    /// steht (der Nutzer hat abgelehnt, während der Push unterwegs war).
    static func nachErneuterMeldung(_ folge: MeldungsFolge, beenden: Bool,
                                    phase: Phase?, raumBegonnen: Bool = true) -> NachErneuterMeldung {
        switch phase {
        case .klingelt?: return beenden ? .beenden : .nichts
        case .angenommen?: return beenden && !raumBegonnen ? .beenden : .nichts
        case nil: return folge == .angezeigt ? .geisterBeenden : .nichts
        case .ausgehend?: return .nichts
        }
    }
}
