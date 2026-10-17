import AVFoundation
import LiveKitWebRTC

/// Was im Echtzeit-Faden des Stream-Tons passiert: Daten bei WebRTC holen,
/// verzögern, verstärken, Pegel messen.
///
/// **Regeln des Echtzeit-Fadens, und warum hier keine Sperre steht.** Der
/// Renderblock darf nicht warten, nichts zuweisen und nichts freigeben. Die
/// Werte, die andere Fäden setzen (`zielVerstaerkung`, `zielVerzoegerung`),
/// sind einzelne `Float`/`Int`-Felder: auf arm64 sind ausgerichtete Schreib-
/// und Lesezugriffe dieser Breite unteilbar, und ein um einen Takt veralteter
/// Wert schadet nicht — er gilt beim nächsten Aufruf. Die Pegel gehen den
/// anderen Weg (der Faden schreibt, die Statistik liest und setzt zurück);
/// eine verlorene Spitze ist dort ebenso folgenlos.
///
/// **Die Verzögerung (A/V-Ausgleich) springt nie hart.** Ein neuer Wert wird
/// erst ausgeblendet (5 ms), dann umgestellt, dann eingeblendet — ein Sprung
/// mitten im Signal knackt hörbar. Die Lücke dazwischen ist Absicht und kurz.
final class StreamTonPuffer: @unchecked Sendable {
    static let maxBlock = 8192
    /// 0,5 s Vorrat — die obere Grenze des A/V-Ausgleichs liegt deutlich
    /// darunter (`StreamTonEmpfaenger.maxVerzoegerungMs`).
    static let ringFrames = 24_000 + maxBlock
    static let blende = 240

    /// Die Quelle: WebRTCs `getPlayoutData`. Gesetzt nur bei stehender
    /// Maschine (`StreamTonGeraet.starten`/`anhalten`, S10).
    var holen: LKRTCAudioDeviceGetPlayoutDataBlock?
    /// Gewollte Verstärkung (linear). Der Renderblock gleitet hin (100 ms),
    /// damit ein Umschalten (Echo-Lage) nicht knackt.
    var zielVerstaerkung: Float = 1
    /// Gewollte Verzögerung in Frames (48 kHz).
    var zielVerzoegerung = 0
    /// Kanäle der Ausgabe-Hardware, zuletzt beim Bauen gelesen (Diagnose).
    var ausgabeKanaele = 0

    // Pegel seit dem letzten Ablesen (0…1), je Kanal, und gerenderte Frames.
    private(set) var spitzeL: Float = 0
    private(set) var spitzeR: Float = 0
    private(set) var frames: UInt64 = 0

    private let ring = UnsafeMutablePointer<Int16>.allocate(capacity: ringFrames * 2)
    private let zwischen = UnsafeMutablePointer<Int16>.allocate(capacity: maxBlock * 2)
    private var schreib = 0
    private var verzoegerung = 0
    private var verstaerkung: Float = 1
    private var blendeRest = 0
    private var blendeAus = false

    init() {
        ring.initialize(repeating: 0, count: Self.ringFrames * 2)
        zwischen.initialize(repeating: 0, count: Self.maxBlock * 2)
    }

    deinit {
        ring.deallocate()
        zwischen.deallocate()
    }

    /// Pegel und Zähler ablesen und die Spitzen zurücksetzen.
    func pegelAblesen() -> (l: Float, r: Float, frames: UInt64) {
        let wert = (spitzeL, spitzeR, frames)
        spitzeL = 0
        spitzeR = 0
        return wert
    }

    var verzoegerungMs: Int { verzoegerung * 1000 / Int(StreamTonGeraet.abtastrate) }

    func rendern(stille: UnsafeMutablePointer<ObjCBool>, zeit: UnsafePointer<AudioTimeStamp>,
                 anzahl: AVAudioFrameCount, ziel: UnsafeMutablePointer<AudioBufferList>) -> OSStatus {
        let liste = UnsafeMutableAudioBufferListPointer(ziel)
        guard let aus = liste.first?.mData?.assumingMemoryBound(to: Int16.self) else { return noErr }
        let n = Int(anzahl)
        guard n <= Self.maxBlock, let holen else {
            memset(aus, 0, n * 4)
            stille.pointee = true
            return noErr
        }
        // 1. Bei WebRTC holen, in den Zwischenpuffer.
        var abl = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(mNumberChannels: 2, mDataByteSize: UInt32(n * 4),
                                  mData: UnsafeMutableRawPointer(zwischen)))
        var flags = AudioUnitRenderActionFlags()
        _ = holen(&flags, zeit, 0, anzahl, &abl)
        // 2. In den Ring, und um `verzoegerung` versetzt wieder heraus.
        for i in 0 ..< n {
            let w = (schreib + i) % Self.ringFrames
            ring[w * 2] = zwischen[i * 2]
            ring[w * 2 + 1] = zwischen[i * 2 + 1]
        }
        let wunschV = min(max(0, zielVerzoegerung), Self.ringFrames - Self.maxBlock)
        if wunschV != verzoegerung, blendeRest == 0 {
            blendeRest = Self.blende
            blendeAus = true
        }
        let wunschG = min(max(0, zielVerstaerkung), 10)
        let gleit = Float(1) / 4800
        var sl: Float = spitzeL, sr: Float = spitzeR
        for i in 0 ..< n {
            let r = (schreib + i - verzoegerung + Self.ringFrames) % Self.ringFrames
            if verstaerkung < wunschG { verstaerkung = min(wunschG, verstaerkung + gleit) }
            if verstaerkung > wunschG { verstaerkung = max(wunschG, verstaerkung - gleit) }
            var g = verstaerkung
            if blendeRest > 0 {
                let t = Float(blendeRest) / Float(Self.blende)
                g *= blendeAus ? t : (1 - t)
                blendeRest -= 1
                if blendeRest == 0, blendeAus {
                    verzoegerung = wunschV
                    blendeAus = false
                    blendeRest = Self.blende
                }
            }
            let l = Float(ring[r * 2]) * g
            let rr = Float(ring[r * 2 + 1]) * g
            aus[i * 2] = Int16(max(-32768, min(32767, l)))
            aus[i * 2 + 1] = Int16(max(-32768, min(32767, rr)))
            sl = max(sl, abs(l) / 32768)
            sr = max(sr, abs(rr) / 32768)
        }
        spitzeL = sl
        spitzeR = sr
        schreib = (schreib + n) % Self.ringFrames
        frames &+= UInt64(n)
        return noErr
    }
}
