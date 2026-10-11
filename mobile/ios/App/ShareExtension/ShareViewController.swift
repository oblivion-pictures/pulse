import UIKit

/// Die Teilen-Erweiterung (Punkt 41 der iOS-Liste): nimmt Text, eine
/// Web-Adresse oder ein Bild aus einer anderen App entgegen, legt es in den
/// gemeinsamen Container (`TeilenAblage`) und bestätigt kurz. Abgeholt wird
/// das Paket von der App (`ShareReceiverPlugin`), sobald sie das nächste Mal
/// startet oder in den Vordergrund kommt; den Chat wählt der Nutzer dort —
/// wie auf Android.
///
/// **Keine Auswahl, deshalb kein `SLComposeServiceViewController`.** Dessen
/// Eingabefeld und Konto-Zeilen hätten hier nichts zu tragen. Eine eigene,
/// schlichte Bestätigung genügt.
///
/// **Pulse öffnet sich NICHT von selbst, und das ist keine Lücke im Bau.**
/// `extensionContext.open(_:)` gibt es nur für Heute-Widgets und
/// iMessage-Erweiterungen; einer Teilen-Erweiterung antwortet es mit `false`.
/// Der verbreitete Umweg — ein `openURL:` die Responder-Kette hinauf — ruft
/// eine nicht öffentliche Schnittstelle und fällt in der App-Prüfung durch.
/// Der Nutzer öffnet Pulse deshalb selbst; die Bestätigung sagt ihm das.
/// Wie es anders ginge, ist eine Produktfrage (Roadmap Punkt 41).
final class ShareViewController: UIViewController {
    private let zeichen = UIImageView()
    private let titel = UILabel()
    private let hinweis = UILabel()
    private let knopf = UIButton(type: .system)
    private let rad = UIActivityIndicatorView(style: .large)
    private var beendet = false
    /// Steht ein Ergebnis auf der Karte? Bis dahin bricht der Knopf ab.
    private var ergebnisSteht = false
    private let wettlauf = TeilenWettlauf()

    /// So lange darf das Einsammeln dauern (iOS-Bughunt 2, D3). **Gesetzt,
    /// nicht gemessen** — grosszügig, weil ein Foto aus iCloud erst geladen
    /// werden muss; wer nicht warten will, hat den Knopf „Abbrechen“.
    private static let frist: TimeInterval = 60

    /// Die Markenfarbe der App (`SpracheFarben.marke`), hier nachgestellt:
    /// die Erweiterung ist ein eigenes Programm und sieht den App-Code nicht.
    private static let marke = UIColor { merkmale in
        merkmale.userInterfaceStyle == .dark
            ? UIColor(red: 0.231, green: 0.510, blue: 0.965, alpha: 1)
            : UIColor(red: 0.145, green: 0.388, blue: 0.922, alpha: 1)
    }

    /// Als Karte über dem Teilen-Blatt statt als eigenes, bildschirmhohes
    /// Blatt: eine Bestätigung aus drei Zeilen verlor sich dort in einer
    /// leeren weissen Fläche (im Simulator so gesehen, iOS 26.3). Den
    /// Hintergrund dunkelt die Erweiterung selbst ab, `.overFullScreen`
    /// lässt dafür die Quell-App durchscheinen.
    override init(nibName: String?, bundle: Bundle?) {
        super.init(nibName: nibName, bundle: bundle)
        modalPresentationStyle = .overFullScreen
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        modalPresentationStyle = .overFullScreen
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        aufbauen()
        Task { await uebergeben() }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.frist) { [weak self] in
            self?.fristAbgelaufen()
        }
    }

    private func uebergeben() async {
        let ausgang = await TeilenEinsammeln.einsammelnUndAblegen(
            extensionContext?.inputItems ?? [], wettlauf: wettlauf)
        switch ausgang {
        case .abgelegt:
            zeigen(symbol: "checkmark.circle.fill", farbe: Self.marke,
                   titel: NSLocalizedString("An Pulse übergeben", comment: "Teilen"),
                   hinweis: NSLocalizedString("Öffne Pulse und wähle den Chat, in den es soll.", comment: "Teilen"),
                   knopf: NSLocalizedString("OK", comment: "Teilen"))
            // Kurz stehen lassen, damit der Hinweis gelesen werden kann; wer
            // ihn kennt, tippt „OK“ und ist sofort zurück.
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            beenden()
        case .nichtsBrauchbares, .fehlgeschlagen:
            zeigen(symbol: "exclamationmark.triangle.fill", farbe: .systemOrange,
                   titel: ausgang == .nichtsBrauchbares
                       ? NSLocalizedString("Nichts zum Übergeben gefunden", comment: "Teilen")
                       : NSLocalizedString("Konnte nicht an Pulse übergeben werden", comment: "Teilen"),
                   hinweis: NSLocalizedString("Pulse nimmt Text, Links und ein Bild entgegen.", comment: "Teilen"),
                   knopf: NSLocalizedString("Schließen", comment: "Teilen"))
        case .ueberholt:
            // Frist oder Abbruch waren schneller: die Frist steht schon auf
            // der Karte, ein Abbruch hat sie geschlossen.
            break
        }
    }

    /// **Abbruch und Frist** (iOS-Bughunt 2, D3). Bis dahin zeigte die Karte
    /// beim Laden nur ein Rad, ohne Knopf: lud ein Anbieter nie zu Ende, kam
    /// man aus der Karte nicht heraus. Was zuerst kommt — das Ergebnis der
    /// Arbeit, die Frist, der Abbruch —, entscheidet `TeilenWettlauf`; die
    /// anderen tun danach nichts.
    private func fristAbgelaufen() {
        guard wettlauf.entscheiden(.abgelaufen) else { return }
        NSLog("[PulseTeilen] Frist abgelaufen, nichts abgelegt")
        zeigen(symbol: "exclamationmark.triangle.fill", farbe: .systemOrange,
               titel: NSLocalizedString("Konnte nicht an Pulse übergeben werden", comment: "Teilen"),
               hinweis: NSLocalizedString("Das Laden hat zu lange gedauert. Versuche es noch einmal.",
                                          comment: "Teilen"),
               knopf: NSLocalizedString("Schließen", comment: "Teilen"))
    }

    @objc private func knopfGetippt() {
        if ergebnisSteht {
            beenden()
            return
        }
        // Noch beim Laden: abbrechen — es sei denn, die Arbeit ist schon
        // fertig; dann steht das Ergebnis gleich da.
        guard wettlauf.entscheiden(.abgebrochen) else { return }
        beendet = true
        extensionContext?.cancelRequest(
            withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }

    private func beenden() {
        guard !beendet else { return }
        beendet = true
        extensionContext?.completeRequest(returningItems: nil)
    }

    private func zeigen(symbol: String, farbe: UIColor, titel text: String, hinweis zeile: String, knopf beschriftung: String) {
        rad.stopAnimating()
        zeichen.image = UIImage(systemName: symbol)
        zeichen.tintColor = farbe
        zeichen.isHidden = false
        titel.text = text
        hinweis.text = zeile
        knopf.setTitle(beschriftung, for: .normal)
        ergebnisSteht = true
        // Der Wechsel von „Wird übergeben …“ auf das Ergebnis geschieht ohne
        // Zutun des Nutzers; VoiceOver auf die neue Zeile setzen, damit er
        // ihn hört (aus Apples Doku gefolgert, mit VoiceOver nicht geprüft).
        UIAccessibility.post(notification: .layoutChanged, argument: titel)
    }

    private func aufbauen() {
        view.backgroundColor = UIColor.black.withAlphaComponent(0.25)
        let karte = UIView()
        karte.backgroundColor = .systemBackground
        karte.layer.cornerRadius = 24
        karte.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(karte)
        zeichen.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 44, weight: .semibold)
        zeichen.isHidden = true
        titel.font = .preferredFont(forTextStyle: .headline)
        titel.text = NSLocalizedString("Wird an Pulse übergeben …", comment: "Teilen")
        for zeile in [titel, hinweis] {
            zeile.adjustsFontForContentSizeCategory = true
            zeile.numberOfLines = 0
            zeile.textAlignment = .center
        }
        hinweis.font = .preferredFont(forTextStyle: .subheadline)
        hinweis.textColor = .secondaryLabel
        knopf.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        // Schon beim Laden da, als „Abbrechen“ (D3); `zeigen` macht daraus
        // den Knopf zum Ergebnis.
        knopf.setTitle(NSLocalizedString("Abbrechen", comment: "Teilen"), for: .normal)
        knopf.addTarget(self, action: #selector(knopfGetippt), for: .touchUpInside)
        rad.startAnimating()

        let stapel = UIStackView(arrangedSubviews: [rad, zeichen, titel, hinweis, knopf])
        stapel.axis = .vertical
        stapel.alignment = .center
        stapel.spacing = 12
        stapel.setCustomSpacing(20, after: hinweis)
        stapel.translatesAutoresizingMaskIntoConstraints = false
        karte.addSubview(stapel)
        NSLayoutConstraint.activate([
            karte.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            karte.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            karte.widthAnchor.constraint(equalToConstant: 300),
            stapel.topAnchor.constraint(equalTo: karte.topAnchor, constant: 28),
            stapel.bottomAnchor.constraint(equalTo: karte.bottomAnchor, constant: -16),
            stapel.leadingAnchor.constraint(equalTo: karte.leadingAnchor, constant: 20),
            stapel.trailingAnchor.constraint(equalTo: karte.trailingAnchor, constant: -20),
            knopf.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
        ])
    }
}
