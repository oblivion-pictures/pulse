import Foundation
import LiveKit
import Network

/// **Messung rund um den Beitritt — Diagnose-Build CarPlay (2026-10-25), ein
/// Versuchsaufbau, kein Endstand.**
///
/// Drei Berichte aus dem Auto trennen zwei Erklärungen nicht: Liefert das
/// Automikrofon keinen Ton, oder trägt die Verbindung zum Server nicht?
/// `setMicrophone` warf beide Male `timedOut` (LiveKit 101) ohne Text, und das
/// SDK 2.17 wirft genau diesen Fehler an drei Stellen des Veröffentlichens
/// (`LocalParticipant._publish`): die Antwort des Servers auf die neue Spur,
/// der Aufbau der Sende-Verbindung (`publisherTransportConnectTimeout`) und der
/// erste Mikrofon-Puffer (5 s, `startWaitingForFrames`). Der LiveKit-Server sah
/// in derselben Minute wiederholte Wiederaufnahmen der Signalverbindung,
/// ICE-Neustarts und am Ende `PEER_CONNECTION_DISCONNECTED`; der Client hing
/// am Mobilfunk.
///
/// Was hier gezählt wird, trennt beides:
/// - Mikrofon-Puffer ab Beitritt (Anzahl, erster, letzter, Spitze) — am
///   selben Haken, an dem das SDK auf den ersten Puffer wartet. Kommen
///   Puffer und trotzdem `timedOut`, war es nicht die Puffer-Frist.
/// - Ton von den anderen (gemischter Empfang) — ob man im Kanal hört.
/// - Das Netz (`NWPathMonitor`): Art, Schnittstellen, IPv4/IPv6 — und jeder
///   Wechsel während der Messung.
/// - Der Weg der Empfangsverbindung aus der Spur-Statistik (Kandidat,
///   Protokoll, Adressfamilie, ICE-Zustand, Paketzahlen); nur mit
///   `statistikNoetig`, weil das SDK sie sonst nicht erhebt.
///
/// **Nie Adressen, Kennungen oder Namen** — die Adresse eines Kandidaten
/// geht nur als „v4“/„v6“ hinaus. Nach dem Befund geht diese Datei wieder
/// heraus, zusammen mit den Varianten in `SpracheRaumMikroNachholen`.
final class TonMessung: @unchecked Sendable {
    static let geteilt = TonMessung()

    /// Zeitpunkte der Messzeilen nach der Beitritts-Zeile, in Sekunden.
    /// Gesetzt, nicht gemessen: dicht in der ersten halben Minute, in der
    /// alle drei Berichte scheiterten, und innerhalb des verlängerten
    /// Sammelfensters des Berichts (`sammelMs` in `iosTonDiagnose.ts`).
    static let zeitpunkte: [UInt64] = [3, 8, 15, 25, 40, 55]

    private let lokal = MikroPufferZaehler()
    private let fern = MikroPufferZaehler()
    private let pfadMonitor = NWPathMonitor()
    private let sperre = NSLock()
    // Ab hier nur unter `sperre`.
    private var pfad: NWPath?
    private var start: CFAbsoluteTime = 0
    private var lokalErst: CFAbsoluteTime?
    private var fernErst: CFAbsoluteTime?
    private var basisLokal: UInt64 = 0
    private var basisFern: UInt64 = 0
    private var laeuft = false

    /// Bei einem Netzwechsel während der Messung — setzt `SpracheRaum`.
    var netzGewechselt: (([String: Any]) -> Void)?

    private init() {
        pfadMonitor.pathUpdateHandler = { [weak self] p in self?.pfadNeu(p) }
        pfadMonitor.start(queue: DispatchQueue(label: "com.howispulse.sprache.netz"))
    }

    /// Vor dem Verbinden (`beitreten`): Zähler auf null, Haken an.
    func beginnen() {
        let l = lokal.ablesen().anzahl, f = fern.ablesen().anzahl
        sperre.lock()
        start = CFAbsoluteTimeGetCurrent()
        lokalErst = nil
        fernErst = nil
        basisLokal = l
        basisFern = f
        let warSchon = laeuft
        laeuft = true
        sperre.unlock()
        lokal.beimNaechsten { [weak self] in self?.erstMerken(lokal: true) }
        fern.beimNaechsten { [weak self] in self?.erstMerken(lokal: false) }
        guard !warSchon else { return }
        AudioManager.shared.add(localAudioRenderer: lokal)
        AudioManager.shared.add(remoteAudioRenderer: fern)
    }

    /// Haken ab — nach der letzten Messzeile oder beim Verlassen.
    func beenden() {
        sperre.lock()
        let warAn = laeuft
        laeuft = false
        sperre.unlock()
        guard warAn else { return }
        AudioManager.shared.remove(localAudioRenderer: lokal)
        AudioManager.shared.remove(remoteAudioRenderer: fern)
    }

    /// Millisekunden seit `beginnen`.
    func seitMs() -> Int {
        sperre.lock()
        defer { sperre.unlock() }
        return Self.ms(CFAbsoluteTimeGetCurrent(), ab: start)
    }

    /// Hängt nur am Mobilfunk (kein WLAN): dann zählt die Statistik mit —
    /// der Gegentest ohne CarPlay im Auto.
    func nurMobilfunk() -> Bool {
        sperre.lock()
        defer { sperre.unlock() }
        guard let p = pfad else { return false }
        return p.usesInterfaceType(.cellular) && !p.usesInterfaceType(.wifi)
    }

    /// Stand der Zähler und des Netzes. Die Spitzen gelten seit der letzten
    /// Zeile (`MikroPufferZaehler.ablesen`). `-1`: noch nichts gekommen.
    func felder() -> [String: Any] {
        let l = lokal.ablesen(), f = fern.ablesen()
        sperre.lock()
        defer { sperre.unlock() }
        let erst = { (t: CFAbsoluteTime?) in t.map { Self.ms($0, ab: self.start) } ?? -1 }
        return [
            "seitMs": Self.ms(CFAbsoluteTimeGetCurrent(), ab: start),
            "lokalPuffer": l.anzahl &- basisLokal,
            "lokalErstMs": erst(lokalErst),
            "lokalLetztMs": l.zuletzt > start ? Self.ms(l.zuletzt, ab: start) : -1,
            "lokalSpitze": Self.gerundet(l.spitze),
            "fernPuffer": f.anzahl &- basisFern,
            "fernErstMs": erst(fernErst),
            "fernSpitze": Self.gerundet(f.spitze)
        ].merging(Self.netzFelder(pfad)) { $1 }
    }

    private func erstMerken(lokal istLokal: Bool) {
        let jetzt = CFAbsoluteTimeGetCurrent()
        sperre.lock()
        if istLokal { lokalErst = jetzt } else { fernErst = jetzt }
        sperre.unlock()
    }

    private func pfadNeu(_ p: NWPath) {
        sperre.lock()
        let alt = pfad
        pfad = p
        let melden = laeuft && alt != nil && alt != p
        sperre.unlock()
        if melden { netzGewechselt?(Self.netzFelder(p).merging(["seitMs": seitMs()]) { $1 }) }
    }

    private static func netzFelder(_ p: NWPath?) -> [String: Any] {
        guard let p else { return ["netz": "unbekannt"] }
        let arten: [(NWInterface.InterfaceType, String)] = [
            (.wifi, "wlan"), (.cellular, "mobil"), (.wiredEthernet, "kabel"), (.other, "andere")
        ]
        let art = { (t: NWInterface.InterfaceType) in arten.first { $0.0 == t }?.1 ?? "lo" }
        return [
            "netz": "\(p.status)",
            "netzArten": arten.filter { p.usesInterfaceType($0.0) }.map(\.1).joined(separator: ","),
            "netzSchnitt": p.availableInterfaces.map { "\($0.name):\(art($0.type))" }
                .joined(separator: ","),
            "netzV4": p.supportsIPv4,
            "netzV6": p.supportsIPv6,
            "netzTeuer": p.isExpensive,
            "netzKnapp": p.isConstrained
        ]
    }

    private static func ms(_ t: CFAbsoluteTime, ab start: CFAbsoluteTime) -> Int {
        Int(((t - start) * 1000).rounded())
    }

    private static func gerundet(_ x: Float) -> Double {
        (Double(x) * 1000).rounded() / 1000
    }
}

extension SpracheRaum {
    /// Statistik der Empfangsspuren erheben? Nur, wo die Messung sie braucht:
    /// im Auto (`carPlayAktiv`) oder allein am Mobilfunk. Sonst nicht — das SDK
    /// fragt dann je Spur jede Sekunde WebRTCs Statistik ab.
    static func statistikNoetig() -> Bool {
        carPlayAktiv() || TonMessung.geteilt.nurMobilfunk()
    }

    /// Nach der Beitritts-Zeile: Messzeilen zu `TonMessung.zeitpunkte`, aber
    /// nur, wenn es etwas zu erklären gibt (Mikrofon gescheitert, Auto,
    /// Mobilfunk). Jeder Beitritt beginnt seine eigene Reihe; die eines
    /// früheren Raums bricht ab (`sitzung`).
    func messReiheBeginnen(sitzung s: Int) {
        guard mikrofonFehler != nil || Self.statistikNoetig() else {
            TonMessung.geteilt.beenden()
            return
        }
        TonMessung.geteilt.netzGewechselt = { [weak self] felder in
            self?.diagMelden("netz_wechsel", felder)
        }
        Task { [weak self] in
            var bisher: UInt64 = 0
            for t in TonMessung.zeitpunkte {
                try? await Task.sleep(nanoseconds: (t - bisher) * 1_000_000_000)
                bisher = t
                guard let self, self.raum != nil, self.sitzung == s else { return }
                self.diagMelden("messung", TonMessung.geteilt.felder().merging(self.wegFelder()) { $1 })
            }
            TonMessung.geteilt.beenden()
        }
    }

    /// Der Weg der Empfangsverbindung, aus der Statistik der ersten fremden
    /// Tonspur. Die Kandidaten-Adresse nur als Familie.
    func wegFelder() -> [String: Any] {
        let spur = raum?.remoteParticipants.values.lazy
            .flatMap { $0.audioTracks }
            .compactMap { $0.track as? RemoteAudioTrack }
            .first
        guard let st = spur?.statistics else { return ["weg": spur == nil ? "keine_spur" : "keine_statistik"] }
        let l = st.localIceCandidate, t = st.transportStats, ein = st.inboundRtpStream.first
        return [
            "wegTyp": l?.candidateType?.rawValue ?? "?",
            "wegProto": l?.protocol ?? "?",
            "wegFamilie": l?.address.map { $0.contains(":") ? "v6" : "v4" } ?? "?",
            "wegFernTyp": st.remoteIceCandidate?.candidateType?.rawValue ?? "?",
            "ice": t?.iceState?.rawValue ?? "?",
            "dtls": t?.dtlsState?.rawValue ?? "?",
            "paarWechsel": t?.selectedCandidatePairChanges ?? 0,
            "empfPakete": ein?.packetsReceived ?? 0,
            "empfVerloren": ein?.packetsLost ?? 0
        ]
    }
}
