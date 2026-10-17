import Capacitor
import LocalAuthentication

/// App-Sperre per Face ID / Touch ID (iOS-Liste Punkt 42).
///
/// **`deviceOwnerAuthentication`, nicht `…WithBiometrics`** — und das ist die
/// ganze Entscheidung dieser Datei. Die erste Fassung erlaubt dem System,
/// selbst auf den Geräte-Code zurückzufallen: wenn Face ID nicht eingerichtet
/// ist, das Gesicht nicht erkannt wird oder die Biometrie nach Fehlversuchen
/// gesperrt ist. Die zweite kann nur Biometrie und liefert sonst einen Fehler
/// — der Nutzer stünde vor seiner eigenen App und käme nicht hinein.
///
/// **Ein eigener Pulse-PIN wäre die schlechtere Wahl** (Eigentümer-Entscheid
/// 2026-10-08): ein zweites Geheimnis, das man vergisst, und das wir speichern
/// müssten. Den Geräte-Code kennt nur der Besitzer, und ihn verwaltet das
/// System.
///
/// **Die Sperre ist KEIN Datenschutz gegen jemanden, der das Gerät hat.** Der
/// lokale Verlauf liegt in der IndexedDB der WebView und ist durch den
/// Dateischutz des Containers geschützt, nicht durch diese Abfrage. Was sie
/// leistet: ein gefundenes, entsperrtes Telefon zeigt Pulse nicht sofort.
@objc(SperrePlugin)
public class SperrePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SperrePlugin"
    public let jsName = "Sperre"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "verfuegbar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pruefen", returnType: CAPPluginReturnPromise)
    ]

    /// Kann dieses Gerät überhaupt prüfen? Ohne Code und ohne Biometrie nicht
    /// — dann darf die Oberfläche die Sperre nicht anbieten, sonst baut man
    /// einen Schalter, der einen aussperrt.
    @objc func verfuegbar(_ call: CAPPluginCall) {
        let kontext = LAContext()
        var fehler: NSError?
        let ja = kontext.canEvaluatePolicy(.deviceOwnerAuthentication, error: &fehler)
        call.resolve(["verfuegbar": ja])
    }

    /// Rückgabe: `{ ok: true }` oder `{ ok: false, abgebrochen: Bool, grund: String }`.
    /// `grund == "kein_code"`: das Gerät hat keinen Code mehr, die Sperre kann
    /// nie wieder bestanden werden. Die Oberfläche hebt sie dann NICHT auf
    /// (fail-closed) — sie bietet nur noch das Abmelden an. Sonst ist `grund`
    /// der Systemtext des Fehlers (nur für Diagnose).
    @objc func pruefen(_ call: CAPPluginCall) {
        let grund = call.getString("grund") ?? "Pulse entsperren"
        let kontext = LAContext()
        // Kein eigener Rückfall-Knopf: `deviceOwnerAuthentication` bringt den
        // Geräte-Code selbst mit, und ein zweiter Knopf daneben wäre ein
        // zweiter Weg zum selben Ziel.
        kontext.localizedFallbackTitle = ""
        kontext.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: grund) { ok, fehler in
            DispatchQueue.main.async {
                if ok {
                    call.resolve(["ok": true])
                    return
                }
                // **Abbruch ist kein Fehler.** Wer die Abfrage wegtippt, hat
                // nicht „falsch" geantwortet — er hat nicht geantwortet. Die
                // Oberfläche zeigt dann weiter die Sperre mit einem
                // Erneut-Knopf, keine Fehlermeldung.
                let code = (fehler as? LAError)?.code
                let abgebrochen =
                    code == .userCancel || code == .systemCancel || code == .appCancel
                // **Kein Geräte-Code mehr** (nach dem Einschalten der Sperre
                // entfernt): das ist KEINE Antwort des Nutzers, und
                // Erneut-Versuchen hilft nie. Das Web lässt die Sperre trotzdem
                // stehen (fail-closed) und zeigt den Weg über das Abmelden.
                let keinCode = code == .passcodeNotSet && Self.geraetHatKeinenCode()
                let systemtext = (fehler as NSError?)?.localizedDescription ?? ""
                call.resolve([
                    "ok": false,
                    "abgebrochen": abgebrochen,
                    "grund": keinCode ? "kein_code" : systemtext
                ])
            }
        }
    }

    /// Bestätigt per frischer Abfrage, dass das Gerät wirklich keinen Code hat.
    ///
    /// **Bewusst eng, fail-closed:** NUR `passcodeNotSet`, und nur, wenn eine
    /// frische Abfrage derselben Richtlinie ebenfalls daran scheitert.
    /// `biometryNotAvailable` zählt NICHT — es kann bei gesetztem Code
    /// auftreten (Face-ID-Erlaubnis entzogen, vorübergehend), und die Sperre
    /// würde sich dann selbst öffnen. `deviceOwnerAuthentication` fällt bei
    /// Biometrie-Fehlern ohnehin auf den Geräte-Code zurück, ein
    /// Biometrie-Fehler allein ist also nie ein Grund, die Sperre aufzugeben.
    private static func geraetHatKeinenCode() -> Bool {
        var fehler: NSError?
        let moeglich = LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &fehler)
        return !moeglich && (fehler as? LAError)?.code == .passcodeNotSet
    }
}
