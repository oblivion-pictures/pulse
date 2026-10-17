import AppIntents
import SwiftUI
import WidgetKit

// Die Bausteine der Live Activity „Im Sprachkanal“ — geteilt zwischen
// Sperrbildschirm und Dynamic Island (`SpracheAktivitaetWidget.swift`).

/// Das eigene Mikrofon. Dieselben Zeichen und Farben wie die Kanalansicht
/// (`SpracheSteuerleiste.swift`): offen in der Markenfarbe, zu in Rot, von der
/// Moderation geschaltet mit dem Schild.
struct MikrofonZeichen: View {
    let stand: SpracheAktivitaet.ContentState
    let gross: Bool

    var body: some View {
        let bild = Image(systemName: symbol)
            .font(.system(size: gross ? 18 : 13, weight: .semibold))
            .foregroundStyle(gross ? .white : farbe)
        Group {
            if gross {
                bild.frame(width: 40, height: 40).background(farbe, in: Circle())
            } else {
                bild
            }
        }
        .accessibilityLabel(Text(beschriftung))
    }

    private var symbol: String {
        if stand.pausiert { return "phone.fill" }
        return stand.stumm ? "mic.slash.fill" : "mic.fill"
    }

    private var farbe: Color {
        if stand.gesperrt { return WidgetFarben.schild }
        if stand.pausiert { return .gray }
        return stand.stumm ? WidgetFarben.schlecht : WidgetFarben.marke
    }

    private var beschriftung: String {
        if stand.pausiert { return String(localized: "Angehalten, ein Anruf läuft") }
        if stand.gesperrt { return String(localized: "Vom Mod stummgeschaltet") }
        return stand.stumm ? String(localized: "Mikrofon aus") : String(localized: "Mikrofon an")
    }
}

/// Das grosse Zeichen links (Sperrbildschirm, aufgeklappte Island). **Steht
/// der Mikrofon-Knopf daneben** (ab iOS 17, wenn er schaltbar ist), zeigt es
/// nicht ein zweites Mal das Mikrofon, sondern ob gerade jemand spricht; sonst
/// ist es die einzige Anzeige des Mikrofons und zeigt dieses.
struct KopfZeichen: View {
    let stand: SpracheAktivitaet.ContentState
    /// Bei veraltetem Stand stehen keine Knöpfe daneben (`AktivitaetKnoepfe`).
    var veraltet = false

    var body: some View {
        if mikrofonKnopfDaneben {
            sprechZeichen
        } else {
            MikrofonZeichen(stand: stand, gross: true)
        }
    }

    /// Dieselbe Bedingung, unter der `AktivitaetKnoepfe` den Mikrofon-Knopf zeigt.
    private var mikrofonKnopfDaneben: Bool {
        guard #available(iOSApplicationExtension 17.0, *), !veraltet else { return false }
        return SpracheAktivitaet.mikrofonSchaltbar(stand)
    }

    private var sprechZeichen: some View {
        let still = stand.sprechend.isEmpty
        return Image(systemName: "waveform")
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 40, height: 40)
            .background(still ? Color.gray : WidgetFarben.marke, in: Circle())
            .accessibilityLabel(Text(still ? String(localized: "Niemand spricht") : String(localized: "Jemand spricht")))
    }
}

struct TeilnehmerZahl: View {
    let stand: SpracheAktivitaet.ContentState

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "person.2.fill")
            Text(stand.teilnehmer, format: .number)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(stand.teilnehmer) im Kanal"))
    }
}

/// Kanal und Community. `hell`: in der Dynamic Island, deren Grund immer
/// schwarz ist — dort trägt die Systemfarbe des hellen Themas nicht.
struct KanalKopf: View {
    let form: SpracheAktivitaet
    let hell: Bool

    var body: some View {
        VStack(alignment: hell ? .center : .leading, spacing: 1) {
            Text(form.kanalName.isEmpty ? String(localized: "Sprachkanal") : form.kanalName)
                .font(.headline)
                .foregroundStyle(hell ? Color.white : Color.primary)
                .lineLimit(1)
            if !form.communityName.isEmpty {
                Text(form.communityName)
                    .font(.caption)
                    .foregroundStyle(hell ? Color.white.opacity(0.7) : Color.secondary)
                    .lineLimit(1)
            }
        }
    }
}

/// Eine Zeile Zustand: was gerade das Wichtigste ist, in dieser Reihenfolge —
/// zuerst was die Anzeige selbst unglaubwürdig macht (veraltet, getrennt,
/// angehalten), dann der eigene Zustand (gesperrt, taub), zuletzt wer spricht.
struct Statuszeile: View {
    let stand: SpracheAktivitaet.ContentState
    /// Die App hat den Stand nicht mehr aufgefrischt (D4) — dann gilt nichts
    /// von dem, was er sagt.
    var veraltet = false

    var body: some View {
        if let text {
            Text(text).lineLimit(1)
        }
    }

    private var text: String? {
        if veraltet { return String(localized: "Stand unklar – App öffnen") }
        if !stand.verbunden { return String(localized: "Verbindung wird wiederhergestellt …") }
        if stand.pausiert { return String(localized: "Angehalten, Anruf läuft") }
        if stand.gesperrt { return String(localized: "Vom Mod stummgeschaltet") }
        if stand.taub { return String(localized: "Mithören aus") }
        if !stand.sprechend.isEmpty {
            let namen = stand.sprechend.joined(separator: ", ")
            let mehr = stand.weitereSprechend > 0 ? " +\(stand.weitereSprechend)" : ""
            let wer = namen + mehr
            return stand.sprechend.count + stand.weitereSprechend > 1
                ? String(localized: "Sprechen: \(wer)")
                : String(localized: "Spricht: \(wer)")
        }
        return nil
    }
}

/// Stumm und Verlassen — ab iOS 17, im Prozess der App ausgeführt
/// (`Gemeinsam/SpracheAktivitaetAbsichten.swift`).
///
/// **Der Mikrofon-Knopf fehlt, wo er nichts tun dürfte** (Moderation, Anruf,
/// Taubstellen; `SpracheAktivitaet.mikrofonSchaltbar`) — ein Knopf, der still
/// nichts tut, ist schlimmer als keiner. Die App prüft beim Ausführen trotzdem
/// noch einmal: der Stand hier kann um die Drosselung veraltet sein.
///
/// **Feste Plätze:** Mikrofon links, Verlassen rechts aussen (rot), mit
/// deutlichem Abstand — ein Fehltipp auf „Verlassen" beendet das Gespräch.
/// Fehlt der Mikrofon-Knopf, bleibt sein Platz leer, statt dass „Verlassen"
/// an dessen Stelle rutscht (ein Daumen, der eben noch stumm schaltete, träfe
/// sonst das Auflegen). **Bei veraltetem Stand gar keine Knöpfe:** sie
/// handelten nach einem Bild, das nicht mehr stimmt.
struct AktivitaetKnoepfe: View {
    let stand: SpracheAktivitaet.ContentState
    var veraltet = false

    var body: some View {
        if #available(iOSApplicationExtension 17.0, *), !veraltet {
            HStack(spacing: 28) {
                if SpracheAktivitaet.mikrofonSchaltbar(stand) {
                    Button(intent: SpracheMikrofonAbsicht(stumm: !stand.stumm)) {
                        rund(stand.stumm ? "mic.slash.fill" : "mic.fill",
                             stand.stumm ? WidgetFarben.schlecht : WidgetFarben.marke)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text(stand.stumm
                        ? String(localized: "Mikrofon einschalten") : String(localized: "Mikrofon stummschalten")))
                } else {
                    Color.clear.frame(width: 44, height: 44)
                        .accessibilityHidden(true)
                }
                Button(intent: SpracheVerlassenAbsicht()) {
                    rund("phone.down.fill", WidgetFarben.schlecht)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Kanal verlassen"))
            }
        }
    }

    private func rund(_ symbol: String, _ farbe: Color) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 44, height: 44)
            .background(farbe, in: Circle())
    }
}
