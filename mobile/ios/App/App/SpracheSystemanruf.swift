import AVFoundation
import CallKit
import LiveKit

/// Der Sprachkanal als Systemanruf (CallKit) — Schalter der iPhone-
/// Einstellungen, Vorgabe aus (`systemanruf` am `SprachePlugin`).
///
/// **Wofür.** Der CarPlay-Befund vom 2026-10-25 (Kopf von
/// `SpracheRaumMikroNachholen.swift`): das Automikrofon nimmt auf, aber in dem
/// Moment, in dem das Auto beim Start der Aufnahme in den Telefon-Modus
/// schaltete, riss die Signalverbindung, und das Mikrofon blieb stumm. Jitsi
/// Meet und Nextcloud Talk melden jedes Gespräch an CallKit — dann aktiviert
/// das SYSTEM die Session, bevor irgendetwas verbindet. Das tut dieser Weg
/// auch: erst der Start bei CallKit, dann die Aktivierung, dann erst verbindet
/// `SpracheRaum.beitreten`. **An den Quellen beider Apps abgelesen, nicht im
/// Auto gemessen** — ob es den Befund behebt, zeigt erst die Fahrt.
///
/// **Eigener Zustand, die 1:1-Anrufe bleiben unberührt.** In `Anrufverwaltung`
/// heißt „CallKit führt" (`callkitAktiv`) bis heute „ein 1:1-Anruf läuft",
/// und viele Stellen bauen darauf: Die Rückgabe hebt die Anruf-Pause auf,
/// der Wächter schweigt, `ohneRaum` zählt die Einträge. Deshalb hat der Kanal
/// hier ein eigenes `fuehrt` und eine eigene UUID, und `callkitAktiv` wird
/// nie gesetzt. Die Delegat-Aktionen verteilt `AnrufCallKit.swift` nach UUID.
///
/// **Der Kanal weicht.** Die Hülle trägt EINEN CallKit-Anruf
/// (`maximumCallsPerCallGroup = 1`, `Anrufverwaltung.starten()`). Wird ein
/// 1:1-Anruf gemeldet oder begonnen, endet der Systemanruf des Kanals zuerst
/// (`weichen`) — derselbe Weg wie `.abloesen` für einen überholten
/// Klingel-Anruf: erst beenden, dann melden, im selben Lauf. Der Kanal selbst
/// läuft weiter, wie ohne Schalter; ein neuer Beitritt versucht es wieder.
///
/// **Nicht gemessen:** Beide Fristen (je 3 s) sind gesetzt; ob der Weg den
/// Befund behebt und ob die Fristen reichen, zeigt erst das Gerät.
///
/// Die Session-Seite — Ende, Rückgabe, Kategorie, Maschine, Ausgabe — steht in
/// `SpracheSystemanrufSession.swift` (Grössen-Policy, `PLAN.md` §12.1). Da
/// `private` in Swift je DATEI gilt, sind die Glieder, die beide brauchen,
/// intern statt privat.
final class SpracheSystemanruf: @unchecked Sendable {
    static let geteilt = SpracheSystemanruf()

    /// Wie lange die Aktivierung ausbleiben darf, bevor der Systemanruf als
    /// gescheitert gilt und der Kanal ohne ihn weiterläuft.
    static let aktivierungsFrist: TimeInterval = 3
    /// Wie lange CallKit Zeit hat, die Session nach dem Ende zurückzugeben.
    static let rueckgabeFrist: TimeInterval = 3

    let sperre = NSLock()
    /// Der Schalter aus dem Web. Hinter der Sperre: gesetzt vom Plugin-Faden,
    /// gelesen vom Beitritt. Das einzige Feld hinter der Sperre, das nur
    /// diese Datei schreibt.
    private var _wunsch = false
    var _uuid: UUID?
    var _fuehrt = false
    var _rueckgabeAusstehend = false

    var wunsch: Bool { sperre.withLock { _wunsch } }
    /// Die UUID des Systemanrufs, solange er bei CallKit steht.
    var uuid: UUID? { sperre.withLock { _uuid } }
    /// Führt der Systemanruf des Kanals gerade die Audio-Session?
    var fuehrt: Bool { sperre.withLock { _fuehrt } }
    /// Der Anruf ist beendet, CallKit hat die Session noch nicht freigegeben.
    var rueckgabeAusstehend: Bool { sperre.withLock { _rueckgabeAusstehend } }

    // Ab hier nur auf dem Hauptthread — dort rufen CallKit (`queue: .main`)
    // und PushKit, und dorthin hüpft alles andere (`aufHauptthread`).
    var sessionAktiv = false
    private var verbundenGemeldet = false
    /// Wartet `beginnen` noch auf die Aktivierung, steht hier seine Fortsetzung.
    var fortsetzung: CheckedContinuation<Bool, Never>?
    var fristenUhr: DispatchWorkItem?
    var rueckgabeUhr: DispatchWorkItem?
    /// Wie der Kanal im System-Bildschirm heisst.
    private var name = ""

    private init() {}

    /// Gehört diese CallKit-UUID dem Systemanruf des Kanals?
    func gehoert(_ uuid: UUID) -> Bool { self.uuid == uuid }

    /// Auf den Hauptthread — sofort, wenn schon dort, sonst asynchron.
    /// Bewusst nie synchron hin: `main.sync` von einem Faden der Befehlskette
    /// könnte sich mit dem Hauptthread verhängen (derselbe Grund wie in
    /// `SpracheFunkHq.swift`). Die Stellen, die Reihenfolge verlangen
    /// (`weichen`), laufen von sich aus schon dort.
    func aufHauptthread(_ tun: @escaping () -> Void) {
        if Thread.isMainThread { tun() } else { DispatchQueue.main.async(execute: tun) }
    }

    // MARK: - Der Schalter

    /// Aus dem Web (`SprachePlugin.systemanruf`). Wirkt sofort: Einschalten
    /// übernimmt die Session für einen laufenden Kanal, Ausschalten gibt sie
    /// zurück. Gleicher Wunsch wie vorher: nichts zu tun.
    func wunschSetzen(_ an: Bool, grund: String) {
        aufHauptthread { [self] in
            let alt = wunsch
            sperre.withLock { _wunsch = an }
            guard alt != an else { return }
            NSLog("[PulseSprache] Systemanruf des Kanals: %@", an ? "an" : "aus")
            Task { await anwenden(grund: grund) }
        }
    }

    /// Den Schalter am laufenden Kanal anwenden. `name` steht schon aus dem
    /// letzten Beitritt (`beitrittVorlauf`).
    private func anwenden(grund: String) async {
        let (steht, kanal) = await MainActor.run { () -> (Bool, String) in
            (SpracheRaum.geteilt.raum != nil,
             self.name.isEmpty ? SpracheRaum.geteilt.kanalName : self.name)
        }
        if wunsch {
            if steht, !fuehrt { _ = await beginnen(name: kanal, grund: grund) }
        } else if fuehrt {
            await MainActor.run { self.weichen(grund: grund) }
        }
    }

    // MARK: - Beginnen

    /// Vor dem Verbinden (`SpracheRaum.beitreten`). `systemanruf` heisst: Der
    /// Systemanruf führt, die Session ist aktiv — dann ist kein Vorwärmen
    /// nötig. Sonst das CarPlay-Vorwärmen wie bisher.
    func beitrittVorlauf(
        communityName: String, kanalName: String
    ) async -> (systemanruf: Bool, vorgewaermt: Bool) {
        let voll = Self.anzeigename(communityName: communityName, kanalName: kanalName)
        await MainActor.run { self.name = voll }
        // Ein noch führender Systemanruf gehört zum VORIGEN Kanal. Sein Ende
        // ist in `raumLoesen` nur angestossen (asynchron zum Hauptthread) —
        // hier wird es sicher und die Rückgabe abgewartet, sonst sähe
        // `beginnen` noch „führt" und schriebe den neuen Raum hinein.
        if fuehrt { await MainActor.run { self.weichen(grund: "beitritt") } }
        if wunsch, await beginnen(name: voll, grund: "beitritt") { return (true, false) }
        return (false, await SpracheRaum.geteilt.carPlayVorwaermen())
    }

    /// Wie der Kanal im System-Bildschirm heisst: die Community davor, wenn
    /// es sie gibt.
    static func anzeigename(communityName: String, kanalName: String) -> String {
        communityName.isEmpty ? kanalName : "\(communityName) · \(kanalName)"
    }

    /// Den Systemanruf beginnen und auf die Aktivierung warten. `false`: Er
    /// führt nicht — der Kanal läuft ohne ihn weiter, wie ohne Schalter.
    /// Führt schon einer, gilt er — dann käme keine zweite Aktivierung, auf
    /// die sich warten ließe.
    private func beginnen(name neu: String, grund: String) async -> Bool {
        if fuehrt { return true }
        await rueckgabeAbwarten()
        let gestellt = await MainActor.run { self.beginnenSynchron(name: neu, grund: grund) }
        guard gestellt else { return false }
        return await aufAktivierungWarten()
    }

    /// Der vorige Systemanruf ist beendet, CallKit gibt die Session erst mit
    /// `didDeactivate` zurück — höchstens `rueckgabeFrist`. Vorher zu
    /// übernehmen hieße: Das SDK richtet sie ein, und CallKit deaktiviert sie
    /// Augenblicke später unter dem neuen Kanal weg. Intern, weil
    /// `SpracheRaumNeustart.swift` vor jedem Beitritt dasselbe wartet.
    func rueckgabeAbwarten() async {
        for _ in 0 ..< 35 where rueckgabeAusstehend {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    /// Auf dem Hauptthread. `true`, wenn der Start beantragt wurde.
    private func beginnenSynchron(name neu: String, grund: String) -> Bool {
        guard wunsch, Anrufverwaltung.geteilt.anbieter != nil, Self.lageRuhig() else {
            SpracheRaum.geteilt.diagMelden("systemanruf_nein", ["grund": grund])
            return false
        }
        name = neu
        uebernehmen()
        let frisch = UUID()
        sperre.withLock {
            _uuid = frisch
            _fuehrt = true
        }
        sessionAktiv = false
        verbundenGemeldet = false
        SpracheRaum.geteilt.diagMelden("systemanruf_begonnen", ["grund": grund])
        return true
    }

    /// Kein 1:1-Anruf in Sicht — die Hülle hat nur den einen Slot, und der
    /// 1:1-Anruf hat Vorrang. Ein KLINGELNDER zählt hier mit: Er belegt ihn.
    private static func lageRuhig() -> Bool {
        let v = Anrufverwaltung.geteilt
        return !v.callkitAktiv && !v.ohneCallKit && v.kennungen.isEmpty
            && AnrufRaum.geteilt.raum == nil
    }

    /// CallKit übernimmt die Session — der Weg des 1:1-Anrufs
    /// (`AnrufSitzung.sessionUebernehmen`) mit drei Unterschieden, alle
    /// desselben Grundes, dass der Kanal der Grund des Anrufs ist:
    /// keine Anruf-Pause; `automatikAus` OHNE `anruf: true`, damit der
    /// Stream-Ton neben dem Kanal weiterspielt statt wie in einem
    /// Telefonat anzuhalten; die Rückgabe kommt mit `grund: "systemanruf"`
    /// und räumt damit nichts auf, was dem 1:1-Anruf gehört. Erst die
    /// Automatik aus, dann die Maschine anhalten — andersherum sähe das SDK
    /// seine Maschine stoppen und deaktivierte die Session selbst, mitten in
    /// CallKits Übernahme.
    private func uebernehmen() {
        SpracheFunkHq.geteilt.loslassen()
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = false
        StreamTonSitzung.geteilt.automatikAus()
        Anrufverwaltung.geteilt.maschineStellen(.none, "anhalten")
        Anrufverwaltung.geteilt.kategorieSetzen()
    }

    /// Den Start bei CallKit beantragen und warten, bis `aktiviert` (oder
    /// `fehlgeschlagen`) die Fortsetzung auflöst.
    private func aufAktivierungWarten() async -> Bool {
        guard let frisch = uuid else { return false }
        return await withCheckedContinuation { (fort: CheckedContinuation<Bool, Never>) in
            aufHauptthread { [self] in
                fortsetzung = fort
                let uhr = DispatchWorkItem { [weak self] in
                    self?.fehlgeschlagen("keine_aktivierung", nil)
                }
                fristenUhr = uhr
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.aktivierungsFrist, execute: uhr)
                let start = CXStartCallAction(call: frisch, handle: CXHandle(type: .generic, value: name))
                start.isVideo = false
                Anrufverwaltung.geteilt.steuerung.request(CXTransaction(action: start)) { fehler in
                    DispatchQueue.main.async { [self] in
                        if let fehler { self.fehlgeschlagen("start", fehler) }
                    }
                }
            }
        }
    }

    /// Der Start kam nicht an, oder die Aktivierung blieb aus: kein
    /// Systemanruf — der Kanal läuft weiter wie ohne Schalter. Nur auf dem
    /// Hauptthread. Nach `"start"` steht bei CallKit nichts, das enden müsste.
    private func fehlgeschlagen(_ grund: String, _ fehler: Error?) {
        guard let fort = fortsetzung else { return }
        fortsetzung = nil
        fristenUhr?.cancel()
        fristenUhr = nil
        SpracheRaum.geteilt.diagMelden(
            "systemanruf_fehlgeschlagen",
            ["grund": grund, "fehler": fehler?.localizedDescription ?? ""])
        if grund != "start", let u = uuid {
            Anrufverwaltung.geteilt.anbieter?.reportCall(with: u, endedAt: nil, reason: .failed)
        }
        sperre.withLock {
            _fuehrt = false
            _uuid = nil
        }
        Self.zurueckgeben()
        fort.resume(returning: false)
    }

    // MARK: - Was das System meldet

    /// `CXStartCallAction` für die UUID des Kanals. Nur auf dem Hauptthread.
    func startAusgefuehrt(_ anbieter: CXProvider, _ action: CXStartCallAction) {
        guard fuehrt, uuid == action.callUUID else {
            action.fail()
            return
        }
        let stand = CXCallUpdate()
        stand.localizedCallerName = name
        stand.remoteHandle = CXHandle(type: .generic, value: name)
        stand.hasVideo = false
        stand.supportsHolding = false
        stand.supportsGrouping = false
        stand.supportsUngrouping = false
        stand.supportsDTMF = false
        anbieter.reportCall(with: action.callUUID, updated: stand)
        anbieter.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
        action.fulfill()
    }

    /// `didActivate`. `true`: Der Systemanruf des Kanals führt, die Aktivierung
    /// gehört ihm. Nur auf dem Hauptthread.
    func aktiviert() -> Bool {
        guard fuehrt else { return false }
        sessionAktiv = true
        Anrufverwaltung.geteilt.kategorieSetzen()
        Self.ausgabeAnwenden(lautsprecher: AudioManager.shared.isSpeakerOutputPreferred)
        Self.maschineFreigeben()
        NSLog("[PulseSprache] Systemanruf: Session aktiv, Route: %@", Anrufverwaltung.routeJetzt())
        fristenUhr?.cancel()
        fristenUhr = nil
        let fort = fortsetzung
        fortsetzung = nil
        fort?.resume(returning: true)
        SpracheRaum.geteilt.schickeEigenen()
        return true
    }

    /// `didDeactivate`. `true`: Der Systemanruf führt noch (ein Mobilfunk-
    /// Gespräch drängte sich dazwischen, `didActivate` kommt wieder) — dann
    /// bleibt die Maschine sein. Steht nur die Rückgabe aus, ist der Anruf zu
    /// Ende: CallKit gibt die Session jetzt frei. Nur auf dem Hauptthread.
    func deaktiviert() -> Bool {
        sessionAktiv = false
        if fuehrt {
            Anrufverwaltung.geteilt.maschineStellen(.none, "anhalten")
            return true
        }
        rueckgabeAbschliessen()
        return false
    }

    /// Der Raum ist verbunden — ab hier zählt CallKit die Dauer. Einmal je
    /// Systemanruf; ein Wiederverbinden zählt nicht noch einmal.
    func verbunden() {
        aufHauptthread { [self] in
            guard fuehrt, !verbundenGemeldet, let u = uuid else { return }
            verbundenGemeldet = true
            Anrufverwaltung.geteilt.anbieter?.reportOutgoingCall(with: u, connectedAt: nil)
        }
    }

    /// Die Stummschaltung im System-Bildschirm — auf die Spur des Kanals, wie
    /// `AnrufRaum.mikrofonVonCallKit`. Ein Fehlschlag wird gemeldet, nicht
    /// geworfen: CallKit wartet auf keine Antwort. Nur auf dem Hauptthread.
    func stumm(_ action: CXSetMutedCallAction) {
        guard fuehrt, uuid == action.callUUID else {
            action.fulfill()
            return
        }
        let stumm = action.isMuted
        SpracheRaum.geteilt.einreihen({ try await SpracheRaum.geteilt.mikrofon(!stumm) }) { _ in
            SpracheRaum.geteilt.schickeEigenen()
        }
        action.fulfill()
    }

    /// „Beenden" im System-Bildschirm: den Kanal verlassen — derselbe Weg wie
    /// der Auflegen-Knopf der Live Activity (`auflegenVonAussen`). Nur auf dem
    /// Hauptthread.
    func vomSystemBeendet(_ action: CXEndCallAction) {
        guard fuehrt, uuid == action.callUUID else {
            action.fulfill()
            return
        }
        action.fulfill()
        NSLog("[PulseSprache] Systemanruf: Beenden im System-Bildschirm — der Kanal wird verlassen")
        // Der Eintrag ist vom System beendet, kein Melden mehr. Buchführung
        // und Rückgabe aber wie bei jedem Ende.
        fortsetzen(grund: "system_beenden")
        Task { await SpracheRaum.geteilt.auflegenVonAussen() }
    }
}
