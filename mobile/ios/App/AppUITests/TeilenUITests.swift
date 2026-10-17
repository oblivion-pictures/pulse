import XCTest

/// Teilen-Empfang (Punkt 41 der iOS-Liste): aus Safari über das Teilen-Blatt
/// bis in die Bestätigung der Erweiterung.
///
/// **Was der Test belegt.** Die Erweiterung erscheint im Teilen-Blatt einer
/// fremden App, startet, und meldet „1 Element bereit“ (die Adresse) — und das meldet
/// sie NUR, wenn das Paket im gemeinsamen Container liegt
/// (`TeilenEinsammeln.einsammelnUndAblegen` → `.abgelegt`). Die andere Hälfte,
/// das Abholen über die Brücke, belegt der Prüfpfad `-PulseTeilenProbe`
/// (`ShareReceiverProbe.swift`) — getrennt, weil die Web-App das Paket beim
/// Start selbst abholt, sobald ihr iOS-Riegel ausgeliefert ist, und ein
/// Abholen hier danach nichts mehr fände.
///
/// **Bedient fremde Oberfläche** (Safari, das Teilen-Blatt) und hängt deshalb
/// an deren Beschriftungen. Gefunden am 2026-10-11 im Simulator, iOS 26.3,
/// deutsche Systemsprache; ändert Apple Safari, ist hier nachzuziehen —
/// Baum ausgeben (`print(safari.debugDescription)`), nicht raten.
final class TeilenUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testAdresseAusSafariErreichtDieErweiterung() throws {
        guard #available(iOS 16.4, *) else { throw XCTSkip("XCUIApplication.open braucht iOS 16.4") }
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        // Erst starten, dann öffnen: ein `open` auf ein nicht laufendes Safari
        // scheiterte mit „has not loaded accessibility“.
        safari.launch()
        safari.open(URL(string: "https://example.com/")!)

        // Safari unter iOS 26: Teilen steckt im Menü „Weitere“ (…) der Leiste.
        let weitere = safari.buttons["Weitere"]
        XCTAssertTrue(weitere.waitForExistence(timeout: 30), "Safari-Leiste nicht gefunden")
        weitere.tap()
        let teilen = safari.buttons["Teilen"].firstMatch
        XCTAssertTrue(teilen.waitForExistence(timeout: 10), "Menüpunkt Teilen nicht gefunden")
        teilen.tap()

        let pulse = safari.descendants(matching: .any)
            .matching(NSPredicate(format: "label == 'Pulse'")).firstMatch
        if !pulse.waitForExistence(timeout: 15) {
            print("=== BAUM/BLATT ===\n\(safari.debugDescription)\n=== /BAUM ===")
            XCTFail("Pulse steht nicht im Teilen-Blatt")
        }
        pulse.tap()

        // Die Karte bleibt stehen, bis „OK“ getippt wird. Deutsch, wie die
        // Systemsprache des Testgeräts; englisch zur Sicherheit mit.
        let bestaetigung = safari.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH '1 Element bereit' OR label BEGINSWITH '1 item ready'")).firstMatch
        if !bestaetigung.waitForExistence(timeout: 15) {
            print("=== BAUM/ERWEITERUNG ===\n\(safari.debugDescription)\n=== /BAUM ===")
            XCTFail("Bestätigung der Erweiterung nicht erschienen")
        }
        // „OK“ schliesst die Karte.
        safari.buttons["OK"].tap()
        let weg = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: bestaetigung)
        wait(for: [weg], timeout: 10)
    }
}
