import ActivityKit
import SwiftUI
import WidgetKit

/// Die Live Activity „Im Sprachkanal“ (Roadmap Punkt 28) — Sperrbildschirm und
/// Dynamic Island. Begonnen, gefüttert und beendet wird sie von der App
/// (`App/SpracheLiveAktivitaet.swift`); hier wird nur gezeichnet, was im
/// Stand steht.
///
/// **Knöpfe erst ab iOS 17** (`Button(intent:)` gibt es vorher nicht).
/// Darunter zeigt die Aktivität nur an, und ein Tipp öffnet die App — das tut
/// jede Live Activity von selbst.
struct SpracheAktivitaetWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SpracheAktivitaet.self) { kontext in
            SperrbildAnsicht(form: kontext.attributes, stand: kontext.state, veraltet: veraltet(kontext))
        } dynamicIsland: { kontext in
            let stand = kontext.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    KopfZeichen(stand: stand)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    TeilnehmerZahl(stand: stand)
                        .font(.headline)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    KanalKopf(form: kontext.attributes, hell: true)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 12) {
                        Statuszeile(stand: stand, veraltet: veraltet(kontext))
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.75))
                        Spacer(minLength: 0)
                        AktivitaetKnoepfe(stand: stand)
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                MikrofonZeichen(stand: stand, gross: false)
            } compactTrailing: {
                TeilnehmerZahl(stand: stand)
                    .font(.caption.weight(.semibold))
            } minimal: {
                MikrofonZeichen(stand: stand, gross: false)
            }
            .keylineTint(WidgetFarben.marke)
        }
    }
}

/// **Hat die App den Stand zu lange nicht aufgefrischt?** (iOS-Bughunt 2 vom
/// 2026-10-11, D4) Die App schiebt `staleDate` mit jedem Herzschlag nach
/// vorn (`SpracheLiveAktivitaet.haltbarkeit`); bleibt er aus, ist sie
/// abgestürzt oder beendet, und „verbunden" wäre eine Behauptung. Vor iOS 16.2
/// gibt es kein `staleDate`.
private func veraltet(_ kontext: ActivityViewContext<SpracheAktivitaet>) -> Bool {
    if #available(iOSApplicationExtension 16.2, *) { return kontext.isStale }
    return false
}

/// Der Sperrbildschirm (und das Banner auf Geräten ohne Dynamic Island).
struct SperrbildAnsicht: View {
    let form: SpracheAktivitaet
    let stand: SpracheAktivitaet.ContentState
    var veraltet = false

    /// Zustand und Sprecher in einer EIGENEN Zeile unter der Kopfzeile: neben
    /// den beiden Knöpfen blieb für „Sprechen: …“ kaum Platz, der zweite Name
    /// wurde abgeschnitten (im Simulator so gesehen).
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                KopfZeichen(stand: stand)
                KanalKopf(form: form, hell: false)
                Spacer(minLength: 0)
                AktivitaetKnoepfe(stand: stand)
            }
            HStack(spacing: 8) {
                TeilnehmerZahl(stand: stand)
                Statuszeile(stand: stand, veraltet: veraltet)
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .padding(16)
    }
}
