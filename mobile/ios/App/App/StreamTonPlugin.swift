import AVFoundation
import Capacitor
import UIKit

/// Brücke für den nativen Stream-Ton: die Web-App reicht die WHEP-URL ihrer
/// Kachel herein, die Hülle spielt den Ton (`StreamTonEmpfaenger`), das Bild
/// bleibt in der WebView.
///
/// **Ein eigenes Plugin ist die Fähigkeitsliste.** Die Oberfläche fragt es als
/// GANZES ab (`streamTonNativDa`, `web/src/lib/platform/iosStreamTonNativ.ts`):
/// ein Bau ohne dieses Plugin (2.1, 4.1, …) spielt den Ton wie bisher in der
/// WebView. Methoden am `SprachePlugin` hätten dort die Weiche des Sprachwegs
/// mitgezogen (`SPRACHE_METHODEN`, „alle oder keine").
///
/// **Kennungen** sind die der Kachel (`hq:<kanal>:<nutzer>:<slot>`); sie
/// landen nie in einer Diagnose-Zeile.
@objc(StreamTonPlugin)
public class StreamTonPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StreamTonPlugin"
    public let jsName = "StreamTonPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "starten", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stoppen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lautstaerke", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verzoegerung", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fortsetzen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "statistik", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "alleStoppen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addListener", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "removeAllListeners", returnType: CAPPluginReturnPromise)
    ]

    /// **Starten und Stoppen in EINER Kette, in der Reihenfolge der Rufe**
    /// (Muster `Befehlskette`, Bughunt 2 B5). Jeder Ruf liefe sonst in einem
    /// eigenen `Task` — ein „stoppen" direkt nach einem „starten" fände den
    /// Empfänger noch nicht in der Liste, und der Ton spielte ohne Kachel.
    private let kette = Befehlskette()

    public override func load() {
        StreamTonVerwaltung.geteilt.melde = { [weak self] daten in
            self?.ereignisMelden("zustand", daten)
        }
    }

    @objc func starten(_ call: CAPPluginCall) {
        guard let kennung = call.getString("kennung"),
              let roh = call.getString("url"), let url = URL(string: roh),
              url.scheme == "https" || url.scheme == "http" else {
            call.reject("kennung und url sind Pflicht")
            return
        }
        let lautstaerke = call.getDouble("lautstaerke") ?? 1
        let echo = call.getDouble("echoFaktor")
        kette.einreihen({
            try await StreamTonVerwaltung.geteilt.starten(
                kennung: kennung, url: url, lautstaerke: lautstaerke, echoFaktor: echo)
        }) { ergebnis in
            switch ergebnis {
            case .success:
                call.resolve(StreamTonVerwaltung.geteilt.zustand(kennung))
            case .failure(let error):
                let status = (error as? StreamTonWhep.Fehler)?.status ?? 0
                call.reject(error.localizedDescription, "streamton_\(status)", error, ["status": status])
            }
        }
    }

    @objc func stoppen(_ call: CAPPluginCall) {
        let kennung = call.getString("kennung") ?? ""
        kette.einreihen({ await StreamTonVerwaltung.geteilt.stoppen(kennung: kennung) }) { _ in
            call.resolve()
        }
    }

    /// **Alles beenden, was eine frühere Seite gestartet hat** (Gegenprüfung
    /// S2). Die Empfänger leben prozessweit; ein Neuladen der WebView (Deploy,
    /// Absturz des Inhaltsprozesses, Navigation) räumt nur Capacitors Hörer
    /// ab. Ohne diesen Ruf spielte der Ton danach ohne Kachel und ohne
    /// Bedienung weiter und hielte die Session-Anforderung. Die Seite ruft ihn
    /// einmal beim Laden (`iosStreamTonNativ.ts`).
    @objc func alleStoppen(_ call: CAPPluginCall) {
        kette.einreihen({ await StreamTonVerwaltung.geteilt.alleStoppen() }) { _ in
            call.resolve()
        }
    }

    @objc func lautstaerke(_ call: CAPPluginCall) {
        StreamTonVerwaltung.geteilt.empfaenger(call.getString("kennung"))?
            .lautstaerkeSetzen(call.getDouble("wert") ?? 1)
        call.resolve()
    }

    @objc func verzoegerung(_ call: CAPPluginCall) {
        StreamTonVerwaltung.geteilt.empfaenger(call.getString("kennung"))?
            .verzoegerungSetzen(ms: call.getInt("ms") ?? 0)
        call.resolve()
    }

    /// Nach einer Unterbrechung, die kein Ende meldete (WebKit gibt seine
    /// Session ohne `notifyOthers` ab) — auf Berührung „Ton aktivieren".
    @objc func fortsetzen(_ call: CAPPluginCall) {
        StreamTonVerwaltung.geteilt.alleFortsetzen("web")
        call.resolve()
    }

    @objc func statistik(_ call: CAPPluginCall) {
        guard let e = StreamTonVerwaltung.geteilt.empfaenger(call.getString("kennung")) else {
            call.resolve([:])
            return
        }
        Task { call.resolve(await e.statistik()) }
    }
}

/// Alle Empfänger der App — und was für alle zugleich gilt: Echo-Lage,
/// Wiederanlauf nach einer Übergabe, Rückkehr in den Vordergrund.
final class StreamTonVerwaltung: @unchecked Sendable {
    static let geteilt = StreamTonVerwaltung()
    /// −12 dB. Begründung und Gerätefrage an `StreamTonSitzung.echoLage`; der
    /// Wert kommt üblicherweise aus dem Web (`ECHO_FAKTOR`), damit er sich ohne
    /// neuen Bau ändern lässt.
    static let echoVorgabe = 0.25

    var melde: (([String: Any]) -> Void)?
    private let sperre = NSLock()
    private var liste: [String: StreamTonEmpfaenger] = [:]
    private var echoFaktor = echoVorgabe
    private var echoUhr: Timer?
    private var beobachter: [NSObjectProtocol] = []

    func empfaenger(_ kennung: String?) -> StreamTonEmpfaenger? {
        guard let kennung else { return nil }
        return sperre.withLock { liste[kennung] }
    }

    func starten(kennung: String, url: URL, lautstaerke: Double, echoFaktor faktor: Double?) async throws {
        await stoppen(kennung: kennung)
        if let faktor { sperre.withLock { echoFaktor = max(0, min(1, faktor)) } }
        let e = StreamTonEmpfaenger(kennung: kennung)
        e.lautstaerkeSetzen(lautstaerke)
        e.meldung = { [weak self] e, phase, grund in self?.phaseMelden(e, phase, grund) }
        sperre.withLock { liste[kennung] = e }
        await MainActor.run { einrichten() }
        diag("streamton_start", [:])
        do {
            try await e.starten(url: url)
        } catch {
            sperre.withLock { if liste[kennung] === e { liste[kennung] = nil } }
            diag("streamton_start_fehler", ["fehler": error.localizedDescription])
            throw error
        }
    }

    func alleStoppen() async {
        let alle = sperre.withLock { () -> [StreamTonEmpfaenger] in
            defer { liste.removeAll() }
            return Array(liste.values)
        }
        if !alle.isEmpty { diag("streamton_alle_gestoppt", ["anzahl": alle.count]) }
        for e in alle { await e.stoppen() }
    }

    func stoppen(kennung: String) async {
        guard let e = sperre.withLock({ liste.removeValue(forKey: kennung) }) else { return }
        await e.stoppen()
    }

    func zustand(_ kennung: String) -> [String: Any] {
        guard let e = empfaenger(kennung) else { return ["phase": "beendet"] }
        return ["phase": e.phaseJetzt.rawValue, "echoGedaempft": e.echoGedaempft,
                "hardwareKanaele": e.geraet.puffer.ausgabeKanaele]
    }

    func alleFortsetzen(_ grund: String) {
        for e in sperre.withLock({ Array(liste.values) }) { e.geraet.fortsetzen(grund: grund) }
    }

    private func phaseMelden(_ e: StreamTonEmpfaenger, _ phase: StreamTonEmpfaenger.Phase, _ grund: String) {
        diag("streamton_phase", ["phase": phase.rawValue, "grund": grund,
                                 "hwKanaele": e.geraet.puffer.ausgabeKanaele])
        zustandMelden(e, grund: grund, phase: phase)
    }

    /// Ein `zustand`-Ereignis an die Web-App; `phase` überschreibt die
    /// abgelesene, wenn der Anlass sie schon kennt.
    private func zustandMelden(_ e: StreamTonEmpfaenger, grund: String,
                               phase: StreamTonEmpfaenger.Phase? = nil) {
        var daten = zustand(e.kennung)
        daten["kennung"] = e.kennung
        if let phase { daten["phase"] = phase.rawValue }
        daten["grund"] = grund
        melde?(daten)
    }

    private func diag(_ art: String, _ extra: [String: Any]) {
        SpracheRaum.geteilt.diagMelden(art, extra)
    }

    // MARK: - Für alle zugleich (Hauptthread)

    @MainActor private func einrichten() {
        if beobachter.isEmpty {
            let nc = NotificationCenter.default
            StreamTonSitzung.geteilt.wiederanlauf = { [weak self] grund in self?.alleFortsetzen(grund) }
            beobachter.append(nc.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { [weak self] _ in self?.alleFortsetzen("vordergrund") })
            beobachter.append(nc.addObserver(
                forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
            ) { [weak self] _ in MainActor.assumeIsolated { self?.echoPruefen() } })
        }
        echoPruefen()
        guard echoUhr == nil else { return }
        // Das Mikrofon geht auch ohne Routenwechsel auf und zu; einmal je
        // Sekunde nachsehen ist billig und braucht keine Brücke.
        echoUhr = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.echoPruefen() }
        }
    }

    @MainActor private func echoPruefen() {
        let alle = sperre.withLock { Array(liste.values) }
        if alle.isEmpty {
            echoUhr?.invalidate()
            echoUhr = nil
            return
        }
        let lage = StreamTonSitzung.echoLage()
        let faktor = lage ? sperre.withLock { echoFaktor } : 1
        for e in alle {
            let vorher = e.echoGedaempft
            e.echoFaktorSetzen(faktor)
            guard vorher != e.echoGedaempft else { continue }
            diag("streamton_echo", ["gedaempft": e.echoGedaempft])
            zustandMelden(e, grund: "echo")
        }
    }
}
