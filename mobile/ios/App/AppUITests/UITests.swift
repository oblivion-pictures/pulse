import XCTest

/// UI-Durchlauf gegen die echte App im Simulator (XCUITest — Accessibility-
/// Queries statt Koordinaten). Dev-Konto dev/***REMOVED*** wird vorausgesetzt;
/// ein bereits angemeldeter Zustand wird über die Freundeszeile erkannt.
/// Kaltstart + Vite-Load dauern bis ~30 s, deshalb die Fristen.
///
/// **Die Sprachkanal-Tests prüfen den NATIVEN Raum** (umgestellt nach der
/// Nachprüfung der Fix-Runden vom 2026-10-11). Bis dahin stammten sie aus der
/// Zeit vor der nativen Kanalansicht (`c0c67af2`): sie suchten Knöpfe der
/// Web-Leiste, die unter dem nativen Blatt liegen, und ihr Messmittel,
/// WebKits RTCStats, sieht den nativen Raum nicht. Jetzt lesen sie die native
/// Ansicht selbst — deren Zeilen und Knöpfe hängen am LiveKit-Raum der Hülle
/// (`SpracheAnsicht.swift`, `SpracheSteuerleiste.swift`), gefunden über
/// Kennungen (`sprache.*`), nicht über die übersetzten Beschriftungen.
///
/// **Was ohne Mikrofon nicht messbar ist, steht je Test unter „Nicht
/// geprüft"** — vor allem, ob das Mikrofon TRÄGT. Dafür braucht es Schall am
/// Mikrofon und die Sprecher-Erkennung des Servers (Abnahme-Checkliste 0.6,
/// Punkt 3); der Mac der Hauptsitzung hat keins, und der Simulator meldet
/// ohne Eingabegerät den Fehler -4010.
final class AppUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    // MARK: - Gemeinsame Handgriffe

    /// Ein Element BELIEBIGER Art, dessen Beschriftung `teil` enthaelt.
    ///
    /// **Typunabhaengig suchen.** Ob eine Kachel als Button, Link oder
    /// StaticText im Baum erscheint, entscheidet das Markup — und das darf
    /// einen Test nicht zum Scheitern bringen, wenn das Element sichtbar da
    /// ist. `descendants(matching: .any)` sucht ueber alle Arten.
    ///
    /// Jeder Ruf baut die Abfrage neu und haelt KEIN Element fest:
    /// `firstMatch` beschreibt nur, wonach gesucht wird — aufgeloest wird es
    /// erst beim Zugriff (`waitForExistence`, `tap`). Genau deshalb traegt ein
    /// zweiter Ruf auch dann, wenn die Route ihre Liste neu gebaut hat.
    private func elementMit(_ app: XCUIApplication, _ teil: String) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS[c] %@", teil)
        ).firstMatch
    }

    /// Zeitmarke zum Abgleich mit dem Geraetelog. UTC, weil `idevicesyslog`
    /// daneben in UTC stempelt — eine Ortszeit hier kostete bei jedem
    /// Vergleich eine Umrechnung im Kopf.
    private func stempel() -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: Date())
    }

    func testNachrichtSendenImChat() throws {
        let app = XCUIApplication()
        app.launch()

        // Freunde-Ansicht: der schnelle „Nachricht senden"-Knopf der ersten
        // Zeile (Label aus dem Accessibility-Baum, s. Dump 2026-10-06).
        let schnell = app.webViews.buttons["Nachricht senden"].firstMatch
        XCTAssertTrue(schnell.waitForExistence(timeout: 30), "Freundesliste nicht geladen")
        schnell.tap()

        // Composer: der Platzhalter des Eingabefelds (textarea wird erst mit
        // Fokus als Eingabeelement exponiert — Antippen fokussiert).
        let composerPlatzhalter = app.webViews.staticTexts["Nachricht senden"].firstMatch
        XCTAssertTrue(composerPlatzhalter.waitForExistence(timeout: 20), "Composer nicht gefunden")
        // Der Platzhalter ist während des Ladens teils nicht „hittable" —
        // Koordinaten-Tap auf das Element umgeht den Hittability-Check.
        composerPlatzhalter.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        app.typeText("UI-Test: Nachricht aus XCUITest")

        let senden = app.webViews.buttons["Senden"].firstMatch
        XCTAssertTrue(senden.waitForExistence(timeout: 10), "Senden-Knopf nicht gefunden")
        senden.tap()

        // Die gesendete Nachricht muss im Verlauf auftauchen.
        let blase = app.webViews.staticTexts.matching(
            NSPredicate(format: "label CONTAINS 'UI-Test: Nachricht'")
        ).firstMatch
        XCTAssertTrue(blase.waitForExistence(timeout: 20), "Gesendete Nachricht nicht im Verlauf")
    }

    // MARK: - Der native Sprachraum

    /// Die Zustandszeile der nativen Kanalansicht („Verbunden · …“). Sie
    /// liest `raum.connectionState` der Hülle — der Zustand des NATIVEN
    /// Raums, nicht der Oberfläche.
    private func nativerZustand(_ app: XCUIApplication) -> XCUIElement {
        app.staticTexts["sprache.zustand"]
    }

    /// Ein Knopf der nativen Steuerleiste (`SpracheSteuerleiste.swift`).
    private func nativerKnopf(_ app: XCUIApplication, _ kennung: String) -> XCUIElement {
        app.buttons[kennung]
    }

    /// Wartet, bis die native Ansicht „Verbunden“ meldet. Die Zeile kommt
    /// deutsch oder englisch, je nach Sprache des Simulators.
    private func nativVerbunden(_ app: XCUIApplication, frist: TimeInterval = 30) -> Bool {
        let zeile = nativerZustand(app)
        guard zeile.waitForExistence(timeout: frist) else { return false }
        let verbunden = NSPredicate(
            format: "label BEGINSWITH 'Verbunden' OR label BEGINSWITH 'Connected'")
        let erwartung = XCTNSPredicateExpectation(predicate: verbunden, object: zeile)
        return XCTWaiter().wait(for: [erwartung], timeout: frist) == .completed
    }

    /// Den Stand der Hülle in eine Zeile — zum Abgleich mit `[PulseSprache]`
    /// im Gerätelog.
    private func huellenStand(_ app: XCUIApplication, _ marke: String) {
        func beschriftung(_ e: XCUIElement) -> String { e.exists ? e.label : "(fehlt)" }
        print("=== HUELLE \(marke) \(stempel()): zustand='\(beschriftung(nativerZustand(app)))' "
            + "mikro='\(beschriftung(nativerKnopf(app, "sprache.mikrofon")))' "
            + "ausgabe='\(beschriftung(nativerKnopf(app, "sprache.ausgabe")))' ===")
    }

    /// App laden, Räume → `dev-stack` → `test-voice` antippen. Ein Tipp IN
    /// der App: die Kanal-Route tritt bei, und weil der Nutzer auf den Kanal
    /// schaut, legt sich die native Ansicht darüber (`routeZeigtKanal`).
    private func sprachkanalBetreten(_ app: XCUIApplication) {
        let geladen = app.webViews.buttons["Nachricht senden"].firstMatch
        XCTAssertTrue(geladen.waitForExistence(timeout: 40), "App nicht geladen")
        // **Ein `Link`, kein Button** — die Bereichsleiste sind echte
        // Routen-Links (Baum-Ausgabe vom 2026-10-10).
        let raeume = app.webViews.links["Räume"].firstMatch
        XCTAssertTrue(raeume.waitForExistence(timeout: 15), "Bereichs-Link Raeume nicht gefunden")
        raeume.tap()
        let community = elementMit(app, "dev-stack")
        XCTAssertTrue(community.waitForExistence(timeout: 20), "Community nicht gefunden")
        community.tap()
        Thread.sleep(forTimeInterval: 3)
        let kanal = elementMit(app, "test-voice")
        XCTAssertTrue(kanal.waitForExistence(timeout: 20), "Sprachkanal nicht gefunden")
        // Koordinaten-Tipp: waehrend des Aufbaus ist die Kachel teils nicht
        // „hittable“, der Treffer aber eindeutig.
        kanal.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(nativVerbunden(app), "Native Ansicht meldet nicht „Verbunden“")
    }

    /// Sprachkanal betreten und die Ausgabe umschalten — über die NATIVE
    /// Ansicht, am echten Geraet.
    ///
    /// **Geprüft:** der native Raum ist verbunden, und der Ausgabe-Knopf folgt
    /// jedem Tipp in beide Richtungen (seine Beschriftung nennt den Weg, auf
    /// den er umschaltet). **Nicht geprüft:** wohin der Ton wirklich geht —
    /// das sagt das Gerätelog daneben (`[PulseSprache] Ausgabe '…' gewuenscht`,
    /// `Routenwechsel … neu=Receiver`) und am Ende das Ohr (Checkliste 1.3/1.4).
    func testSprachkanalAusgabeUmschalten() throws {
        let app = XCUIApplication()
        app.launch()
        sprachkanalBetreten(app)
        huellenStand(app, "IM-KANAL")

        let ausgabe = nativerKnopf(app, "sprache.ausgabe")
        XCTAssertTrue(ausgabe.waitForExistence(timeout: 10), "Nativer Ausgabe-Knopf fehlt")
        let anfang = ausgabe.label
        for runde in 1...2 {
            let vorher = ausgabe.label
            print("=== TIPPE AUSGABE \(runde) '\(vorher)' \(stempel()) ===")
            ausgabe.tap()
            Thread.sleep(forTimeInterval: 4)
            huellenStand(app, "NACH-AUSGABE-\(runde)")
            XCTAssertNotEqual(ausgabe.label, vorher, "Ausgabe-Knopf folgt dem Tipp nicht (Runde \(runde))")
        }
        XCTAssertEqual(ausgabe.label, anfang, "Nach zwei Tipps nicht zurück am Anfang")

        // Unter der Ansicht liegt die Oberfläche: nach dem Schliessen zeigt die
        // Web-Leiste den Griff zurück in die native Ansicht — der Beleg, dass
        // das Web den nativen Raum kennt.
        nativerKnopf(app, "sprache.schliessen").tap()
        let griff = app.webViews.buttons["Zurück in den Kanal"].firstMatch
        XCTAssertTrue(griff.waitForExistence(timeout: 10), "Web-Leiste zeigt den nativen Raum nicht")
        Thread.sleep(forTimeInterval: 5)
    }

    /// **Differenz-Versuch zum stummen Mikrofon**, jetzt am nativen Raum.
    ///
    /// Der Befund vom 2026-10-10 (WebKit-Weg): nach dem Beitritt trug das
    /// Mikrofon keinen Ton, nach einmal Stummschalten und wieder Einschalten
    /// schon. Der Test stellt beide Zustaende her und markiert sie mit
    /// Zeitstempeln.
    ///
    /// **Geprüft:** der Mikrofon-Knopf der Hülle schaltet in beide Richtungen
    /// (seine Beschriftung folgt `isMicrophoneEnabled()` des nativen Raums).
    /// **Nicht geprüft, ohne Mikrofon nicht messbar:** ob in Phase A und B
    /// Ton GETRAGEN wird. WebKits `media-source` sieht den nativen Raum nicht;
    /// das Ersatz-Messmittel ist das Ereignis `sprechen` bzw. `isSpeaking` vom
    /// Server (`SpracheRaumZustand.swift`), und das braucht Schall am Mikrofon.
    func testMikrofonVorUndNachMuteZyklus() throws {
        let app = XCUIApplication()
        app.launch()
        sprachkanalBetreten(app)

        print("=== PHASE-A-START \(stempel()) ===")
        Thread.sleep(forTimeInterval: 12)
        print("=== PHASE-A-ENDE \(stempel()) ===")

        let mikro = nativerKnopf(app, "sprache.mikrofon")
        XCTAssertTrue(mikro.waitForExistence(timeout: 10), "Nativer Mikrofon-Knopf fehlt")
        let anfang = mikro.label
        huellenStand(app, "VOR-MUTE")
        mikro.tap()
        Thread.sleep(forTimeInterval: 3)
        huellenStand(app, "NACH-MUTE")
        XCTAssertNotEqual(mikro.label, anfang, "Stummschalten kam nicht an")
        mikro.tap()
        Thread.sleep(forTimeInterval: 3)
        huellenStand(app, "NACH-UNMUTE")
        XCTAssertEqual(mikro.label, anfang, "Wieder einschalten kam nicht an")

        print("=== PHASE-B-START \(stempel()) ===")
        Thread.sleep(forTimeInterval: 12)
        print("=== PHASE-B-ENDE \(stempel()) ===")
    }

    /// **Mehrfach-Beitritt: das Rennen einfangen**, am nativen Raum.
    ///
    /// Ein einzelner Beitritt beweist nichts (der Befund vom 2026-10-10 war
    /// ein Rennen). Also drei hintereinander, in EINEM Lauf: der erste über
    /// die Kanal-Liste, die weiteren über „Beitreten“ auf der Kanalseite.
    ///
    /// **Geprüft:** jeder Beitritt verbindet den nativen Raum, und jedes
    /// „Auflegen“ in der nativen Ansicht schliesst ihn — die Ansicht ist weg,
    /// und die Oberfläche zeigt wieder „Beitreten“ (sonst bewiese der Lauf
    /// das Verlassen nicht: genau dieser Fehler war am 2026-10-10 im nativen
    /// Weg drin). **Nicht geprüft:** ob jeder Beitritt Ton trägt (s. oben).
    func testBeitrittDreimalHintereinander() throws {
        let app = XCUIApplication()
        app.launch()
        for runde in 1...3 {
            if runde == 1 {
                sprachkanalBetreten(app)
            } else {
                // **Frisch suchen, nicht merken** — die Seite baut nach dem
                // Auflegen neu auf.
                let beitreten = app.webViews.buttons["Beitreten"].firstMatch
                XCTAssertTrue(beitreten.waitForExistence(timeout: 15), "Kein „Beitreten“ (Runde \(runde))")
                beitreten.tap()
                XCTAssertTrue(nativVerbunden(app), "Nicht verbunden (Runde \(runde))")
            }
            print("=== BEITRITT-\(runde)-DRIN \(stempel()) ===")
            Thread.sleep(forTimeInterval: 15)
            huellenStand(app, "BEITRITT-\(runde)-ENDE")

            let auflegen = nativerKnopf(app, "sprache.auflegen")
            XCTAssertTrue(auflegen.waitForExistence(timeout: 5), "Kein „Auflegen“ (Runde \(runde))")
            auflegen.tap()
            XCTAssertTrue(
                nativerZustand(app).waitForNonExistence(timeout: 10),
                "Nach dem Auflegen steht die native Ansicht noch (Runde \(runde))")
            XCTAssertTrue(
                app.webViews.buttons["Beitreten"].firstMatch.waitForExistence(timeout: 15),
                "Die Oberfläche hat das Auflegen nicht mitbekommen (Runde \(runde))")
            print("=== VERLASSEN-\(runde) \(stempel()) ===")
        }
    }

    /// **Bleibt der native Raum stehen, wenn die App in den Hintergrund geht?**
    ///
    /// **Geprüft:** nach 25 s im Hintergrund meldet die native Ansicht weiter
    /// „Verbunden“ — ohne Neubeitritt (ein Raum, der nur überlebt, weil neu
    /// verbunden wurde, wäre keiner). Danach ein Mute-Zyklus am nativen Knopf.
    /// **Nicht geprüft:** der gesperrte Bildschirm (XCUITest drückt keine
    /// Seitentaste) und ob im Hintergrund Ton GETRAGEN wird — dafür braucht es
    /// Schall am Mikrofon (s. Klassenkommentar) und das Ohr der Gegenstelle
    /// (Checkliste Block 3).
    func testTonImHintergrund() throws {
        let app = XCUIApplication()
        app.launch()
        sprachkanalBetreten(app)

        print("=== VORDERGRUND-START \(stempel()) ===")
        Thread.sleep(forTimeInterval: 12)
        print("=== VORDERGRUND-ENDE \(stempel()) ===")

        XCUIDevice.shared.press(.home)
        print("=== HINTERGRUND-START \(stempel()) ===")
        Thread.sleep(forTimeInterval: 25)
        print("=== HINTERGRUND-ENDE \(stempel()) ===")

        app.activate()
        print("=== ZURUECK-START \(stempel()) ===")
        XCTAssertTrue(nativVerbunden(app, frist: 15), "Nach dem Hintergrund steht der native Raum nicht mehr")
        huellenStand(app, "ZURUECK")

        let mikro = nativerKnopf(app, "sprache.mikrofon")
        if mikro.waitForExistence(timeout: 10) {
            let anfang = mikro.label
            mikro.tap()
            Thread.sleep(forTimeInterval: 4)
            huellenStand(app, "ZYKLUS-MITTE")
            mikro.tap()
            Thread.sleep(forTimeInterval: 4)
            huellenStand(app, "ZYKLUS-NACH")
            XCTAssertEqual(mikro.label, anfang, "Mute-Zyklus nach dem Hintergrund kam nicht an")
            Thread.sleep(forTimeInterval: 22)
            print("=== ZYKLUS-ENDE \(stempel()) ===")
        } else {
            print("=== MIKROFON-KNOPF NICHT GEFUNDEN ===")
        }
    }

    /// **Tritt bei und bleibt dann stehen — ohne zu urteilen.**
    ///
    /// Gebaut am 2026-10-10, als der Beitritt scheiterte und die Ursache nicht
    /// zu fassen war: die anderen Läufe beenden die App am Ende, und damit ist
    /// der Zustand weg, den man lesen müsste. Dieser hält sie 90 s offen und
    /// gibt den Baum aus — samt nativer Ansicht und ihrer Zustandszeile.
    ///
    /// Ohne Zusicherungen, mit Absicht: er soll nicht scheitern, er soll einen
    /// Zustand stehen lassen.
    func testBeitretenUndStehenbleiben() throws {
        let app = XCUIApplication()
        app.launch()
        let geladen = app.webViews.buttons["Nachricht senden"].firstMatch
        _ = geladen.waitForExistence(timeout: 40)
        let raeume = app.webViews.links["Räume"].firstMatch
        if raeume.waitForExistence(timeout: 15) { raeume.tap() }
        let community = elementMit(app, "dev-stack")
        if community.waitForExistence(timeout: 20) { community.tap() }
        Thread.sleep(forTimeInterval: 3)
        let kanal = elementMit(app, "test-voice")
        if kanal.waitForExistence(timeout: 20) {
            kanal.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            print("=== KANAL GETIPPT \(stempel()) ===")
        } else {
            print("=== KANAL NICHT GEFUNDEN \(stempel()) ===")
        }
        Thread.sleep(forTimeInterval: 15)
        huellenStand(app, "NACH-TIPP")
        print("=== BAUM NACH TIPP \(stempel()) ===\n\(app.debugDescription)\n=== /BAUM ===")
        Thread.sleep(forTimeInterval: 60)
        print("=== ENDE \(stempel()) ===")
    }
}
