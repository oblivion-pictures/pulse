import Capacitor
import UIKit
import UserNotifications

/// Eine DM-Mitteilung, während die App vorn ist, nicht als Banner zeigen
/// (iOS-Bughunt 2, C1).
///
/// **Warum es das braucht.** Der Server pusht eine DM an jedes iOS-Gerät des
/// Empfängers (erkannt am PushKit-Token), auch an eines mit offener WebSocket
/// (`services/chat-gateway/.../fcm_empfaenger.py`): ein eben weggestecktes
/// iPhone gilt ihm noch bis zu 95 s als wach, während sein JS schon
/// eingefroren ist — ohne Push ging die Mitteilung dann verloren. Ist die App
/// aber wirklich vorn, meldet die Oberfläche die Nachricht selbst (Ton,
/// In-App-Meldung, Zähler) — ein Systembanner obendrauf wäre doppelt, im
/// offenen Chat sogar über genau der Nachricht, die man gerade liest.
///
/// **Wie.** Capacitors `NotificationRouter` fragt bei einer Push-Mitteilung im
/// Vordergrund seinen `pushNotificationHandler` — das FirebaseMessaging-Plugin
/// — nach den Darstellungsoptionen (Vorgabe dort: Banner, Ton, Plakette).
/// Dieser Typ legt sich dazwischen. Er reicht jeden Ruf an das Plugin weiter,
/// dessen Ereignis `notificationReceived` und Firebase' eigene Verbuchung
/// bleiben also; er nimmt nur bei einer DM, solange die App AKTIV ist, die
/// Optionen weg. Ohne `.badge` setzt der Push dann auch die Plakette nicht
/// (Apples Doku zu `UNNotificationPresentationOptions`, nicht gemessen) — die
/// legt im Vordergrund das Web selbst an (`badgeMelden.ts`).
///
/// Im Simulator per `simctl push` belegt: eine DM bei aktiver App antwortet
/// SpringBoard mit Optionen 0 (kein Banner), eine andere Kategorie mit 7; im
/// Hintergrund fragt das System gar nicht und zeigt den Banner selbst.
///
/// **Warum nicht `presentationOptions` in `capacitor.config.json`.** Die
/// gälten für jede Push-Art und auch im Zustand `inactive` (gefolgert:
/// `inactive` ist laut Apple ein Vordergrund-Zustand) — dann liegt das
/// Kontrollzentrum oder ein Systemdialog über der App, und niemand sieht die
/// Oberfläche. Ein Banner ist dort richtig.
///
/// **Eingehängt in `applicationDidBecomeActive`**, nicht beim Start: das
/// Plugin trägt sich erst ein, wenn die Brücke seine Plugins lädt, und die
/// Reihenfolge der Plugins ist keine Zusage. Vor dem ersten `didBecomeActive`
/// ist die App nie aktiv, die Regel griffe dort also ohnehin nicht. Das
/// Einhängen ist idempotent und läuft bei jeder Aktivierung erneut.
final class MitteilungImVordergrund: NSObject, NotificationHandlerProtocol {
    /// Mitteilungs-Kategorie der DMs — dieselbe wie `fcm.py::DM_KATEGORIE`
    /// und `AppDelegate.mitteilungsAktionenRegistrieren`.
    static let dmKategorie = "dm"

    /// Die Fähigkeit, die dieser Bau mit seinem PushKit-Token meldet
    /// (`AnrufPlugin.faehigkeiten`, Nachprüfung der Fix-Runden S2). Steht hier,
    /// weil sie genau das zusagt, was dieser Typ tut — wer ihn entfernt,
    /// entfernt sie mit.
    static let faehigkeit = "dm_vordergrund"

    /// Der Router hält seinen Handler nur `weak` — gehalten wird er hier.
    private static var eingehaengt: MitteilungImVordergrund?

    /// Der vorherige Handler, Firebase' `FirebaseMessaging`; stark hält ihn
    /// sein Plugin-Objekt (`FirebaseMessagingPlugin.implementation`).
    private weak var innen: NotificationHandlerProtocol?

    private init(innen: NotificationHandlerProtocol) {
        self.innen = innen
    }

    /// Vor den aktuellen Handler des Routers legen. Tut nichts, solange keiner
    /// eingetragen ist oder die Weiche schon davor liegt.
    static func einhaengen(_ router: NotificationRouter?) {
        guard let router, let aktuell = router.pushNotificationHandler,
              !(aktuell is MitteilungImVordergrund)
        else { return }
        let weiche = MitteilungImVordergrund(innen: aktuell)
        eingehaengt = weiche
        router.pushNotificationHandler = weiche
    }

    /// Die Regel, ohne UIKit prüfbar.
    static func optionen(_ vorschlag: UNNotificationPresentationOptions,
                         kategorie: String, aktiv: Bool) -> UNNotificationPresentationOptions {
        (kategorie == dmKategorie && aktiv) ? [] : vorschlag
    }

    func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        let vorschlag = innen?.willPresent(notification: notification) ?? []
        let kategorie = notification.request.content.categoryIdentifier
        let ergebnis = Self.optionen(vorschlag, kategorie: kategorie, aktiv: Self.appAktiv())
        #if DEBUG
            NSLog("[PulseMitteilung] Vordergrund: Kategorie '%@', %@", kategorie,
                  ergebnis.isEmpty ? "unterdrückt" : "gezeigt")
        #endif
        return ergebnis
    }

    func didReceive(response: UNNotificationResponse) {
        innen?.didReceive(response: response)
    }

    /// `applicationState` gehört dem Hauptthread. Das Mitteilungszentrum ruft
    /// seinen Delegaten dort; zugesagt ist es nicht, daher der Rückweg.
    private static func appAktiv() -> Bool {
        if Thread.isMainThread { return UIApplication.shared.applicationState == .active }
        return DispatchQueue.main.sync { UIApplication.shared.applicationState == .active }
    }
}
