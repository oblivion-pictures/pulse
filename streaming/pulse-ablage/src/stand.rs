//! Der Stand der lokalen Ablage zwischen zwei Faeden — und die Buchfuehrung
//! ueber „wer hat sie zuletzt angefasst".
//!
//! **Warum das hier liegt und nicht im Sidecar:** kein einziger Aufruf ans
//! Betriebssystem steht darin, und die Frage, die es beantwortet — welche
//! Aenderung die eigene ist und welche die des Nutzers — stellt sich auf jeder
//! Plattform, auf der der Ablauf zwei Faeden hat. Bis zum 2026-08-31 lag die
//! Datei als `win-hq-sidecar/src/ablage/geteilt.rs` beim einzigen Verbraucher;
//! dort hingen ihre Tests an **keinem** Gate (`gate-rust.sh` nimmt den
//! Windows-Sidecar ausdruecklich nicht, er baut auf Linux nicht). Dasselbe
//! Argument, mit dem [`crate::lage`] hierher zog.
//!
//! **Wie weit sie plattformfrei ist, ehrlich:** die Zaehl-Regeln (Eigentum
//! verloren = unverbuchte Aenderung, nur Text zaehlt, ein Wechsel verwirft ein
//! gelesenes Ergebnis) und die beiden Handschlaege (Rendervorgang, Lesevorgang)
//! gelten ueberall.
//!
//! **Ob eine Aenderung die eigene war, entscheidet auf Windows der
//! Eigentuemer des Fachs, nicht ein Zaehler** (macOS vergleicht seinen eigenen
//! Zaehlerstand, `macos::faden`). Bis zum 2026-10-15 merkte sich Windows jede
//! eigene Aenderung in einem Zaehler `erwartet` vor und verbuchte die naechste
//! `WM_CLIPBOARDUPDATE` als „das war ich" — die Rechnung ging nur auf, wenn
//! auf jede eigene Aenderung genau eine Meldung folgt. **Anlass des Umbaus:**
//! ein Windows-Host kuendigte an einem ganzen Abend Fernsteuerung genau eine
//! Kopie an (Sender-Berichte vom 2026-10-15, 0.1.110), waehrend die
//! Gegenrichtung jede Kopie abholte. **Die Ursache ist ungeklaert.** Dass der
//! Zaehler volllief, ist unwahrscheinlich: die Wine-Tests, die echtes
//! Windows-Verhalten festhalten (`dlls/user32/tests/clipboard.c`), zeigen die
//! Meldung auch fuer die eigene Aenderung. Der heutige Weg haengt an keiner
//! Annahme ueber Zahl oder Zeitpunkt der Meldungen, und die Zeile
//! „[ablage] Fach geaendert …" macht beim naechsten Mal sichtbar, was ankommt.
//!
//! **Die Invariante, die diese Struktur traegt:** die Sperre darum wird **nie
//! ueber einen Aufruf ans Betriebssystem gehalten**. Auf Windows schickt
//! `EmptyClipboard` dem Eigentuemer synchron ein `WM_DESTROYCLIPBOARD`, und das
//! landet im eigenen Fensterrueckruf auf demselben Faden — eine gehaltene
//! `Mutex` waere dort ein Selbstblock, denn `std::sync::Mutex` ist nicht
//! wiedereintrittsfaehig.

/// Alles, was der Faden mit dem Betriebssystem-Rueckruf und der Takt-Faden
/// gemeinsam sehen.
///
/// [`Ablagestand::neu`] ist `const`, damit die `Mutex` darum ein `static` sein
/// kann — `Default` genuegt dafuer nicht.
pub struct Ablagestand {
    /// Zaehlt Wechsel der Ablage. Die Nachbildung von
    /// `NSPasteboard.changeCount` ist Absicht — dieselbe Bauart wie im
    /// Testdoppel `pulse_ablage::pruefstand::TestAblage` und im Wayland-Weg.
    stand: u64,
    gesehen: u64,
    /// Halten WIR die Ablage gerade? Kommt aus `GetClipboardOwner`, nicht aus
    /// einem Merker: hat der Nutzer selbst kopiert, ist „wir haben
    /// beansprucht" laengst falsch.
    eigen: bool,
    /// Laeuft gerade ein eigener Vorgang am Fach (Beanspruchen, Zurueckschreiben,
    /// Raeumen)? Dann wird nicht ausgewertet: mittendrin stimmen Eigentuemer
    /// und [`Self::eigen`] noch nicht ueberein (nach dem Raeumen gehoert das
    /// Fach niemandem, `eigen` steht aber erst danach auf `false`), und der
    /// Blick ergaebe einen Eigentumsverlust, den es nicht gibt. Ausgewertet
    /// wird beim naechsten Blick — die Nummer ist dann noch nicht verbucht.
    vorgang: bool,
    /// Die zuletzt ausgewertete Aenderungsnummer des Fachs
    /// (`GetClipboardSequenceNumber`). Meldung und Takt schauen beide nach;
    /// dieselbe Nummer zweimal zu verbuchen kuendigte dieselbe Kopie zweimal an.
    nummer: Option<u32>,
    /// Ein `WM_RENDERFORMAT` wartet auf Inhalt — auf Windows blockiert dabei
    /// das einfuegende Programm.
    wartet: bool,
    /// Was der wartende Rendervorgang bekommt, sobald es da ist.
    antwort: Option<String>,
    /// Bricht den wartenden Rendervorgang ab, weil die Ablage gerade neu
    /// beansprucht oder freigegeben wird. Ohne ihn stuende der Befehl dafuer
    /// bis zu einer Abruf-Frist an.
    abbruch: bool,
    /// Ergebnis des letzten Lesevorgangs. `None` = keiner fertig,
    /// `Some(None)` = „nichts zu holen".
    gelesen: Option<Option<String>>,
    /// Ein Lesebefehl ist unterwegs.
    lesen_laeuft: bool,
}

impl Ablagestand {
    pub const fn neu() -> Ablagestand {
        Ablagestand {
            stand: 0,
            gesehen: 0,
            eigen: false,
            vorgang: false,
            nummer: None,
            wartet: false,
            antwort: None,
            abbruch: false,
            gelesen: None,
            lesen_laeuft: false,
        }
    }

    /// Die Ablage hat sich geaendert — gerufen vom Poll (macOS) bzw. ueber
    /// [`Self::meldung`] (Windows).
    ///
    /// `eigner` = gehoert die Ablage jetzt unserem Fenster, `text_da` = liegt
    /// Text darin.
    pub fn systemmeldung(&mut self, eigner: bool, text_da: bool) {
        // Ein Ergebnis gehoert der Ablage, aus der es stammt.
        self.gelesen = None;
        let verloren = self.eigen && !eigner;
        self.eigen = eigner;
        // **Eine eigene Aenderung faellt hier von selbst heraus:** danach sind
        // wir Eigentuemer (`eigner`), und weder ein Verlust noch ein fremder
        // Text liegt vor. Nach dem Raeumen ist `eigen` schon `false` (s.
        // [`Ablagestand::selbst_geaendert`]), ein leeres Fach zaehlt nicht.
        // **Der Eigentumsverlust zaehlt selbst dann, wenn kein Text im Fach
        // liegt** — fail-closed, dieselbe Begruendung wie
        // `AblageZustand::abgeloest` auf Wayland: solange wir die Ablage
        // hielten, war die angekuendigte Generation an unseren Stand gebunden;
        // ist sie weg, stimmt diese Bindung nicht mehr, und ein `hol` darf
        // nicht mit frisch gelesenem Inhalt beantwortet werden.
        //
        // **Nur TEXT bewegt den Zaehler sonst.** Ein kopiertes Bild
        // anzukuendigen braechte der Gegenseite nichts: sie beanspruchte
        // daraufhin ihre Ablage — und loeschte damit den Vorbestand ihres
        // Nutzers — nur um beim Einfuegen ein `weg` zu bekommen.
        if verloren || (!eigner && text_da) {
            self.stand += 1;
        }
    }

    /// Windows: ein Blick aufs Fach, ausgeloest von `WM_CLIPBOARDUPDATE` ODER
    /// vom Takt — `nummer` ist `GetClipboardSequenceNumber`.
    ///
    /// **Ausgewertet wird nur eine neue Nummer und nie mitten in einem eigenen
    /// Vorgang** ([`Self::nummer_neu`]). Der Takt-Blick ist das Netz unter der
    /// Meldung: kommt sie nicht (oder nicht fuer jede Aenderung), sieht der
    /// naechste Takt die Nummer trotzdem.
    ///
    /// **`nummer == 0` heisst „keine Auskunft"** (laut Doku, wenn der
    /// Fensterstation das Recht auf die Zwischenablage fehlt). Dann zaehlt
    /// jeder Blick, der Aufrufer schaut nur auf eine Meldung hin nach — so wie
    /// vor dem 2026-10-15.
    ///
    /// Liefert, ob ausgewertet wurde.
    pub fn meldung(&mut self, nummer: u32, eigner: bool, text_da: bool) -> bool {
        if !self.nummer_neu(nummer) {
            return false;
        }
        if nummer != 0 {
            self.nummer = Some(nummer);
        }
        self.systemmeldung(eigner, text_da);
        true
    }

    /// Lohnt ein Blick? Nur ausserhalb eines eigenen Vorgangs, und nur bei
    /// einer Nummer, die NACH der zuletzt verbuchten liegt — der Aufrufer
    /// fragt das, bevor er Eigentuemer und Inhaltstyp beim Betriebssystem
    /// erfragt.
    ///
    /// **Nur vorwaerts:** Meldung und Takt schauen auf zwei Faeden nach. Liest
    /// der eine N, der andere N+1 und verbucht zuerst, darf das spaete N nicht
    /// mehr ausgewertet werden — sein Eigentuemer ist veraltet. Verglichen wird
    /// mit Ueberlauf, die Nummer ist ein `u32` und laeuft ewig.
    pub fn nummer_neu(&self, nummer: u32) -> bool {
        if self.vorgang {
            return false;
        }
        match self.nummer {
            Some(alt) if nummer != 0 => (nummer.wrapping_sub(alt) as i32) > 0,
            _ => true,
        }
    }

    /// Die Nummer beim Start als gesehen ablegen, **ohne auszuwerten**: was vor
    /// der Sitzung kopiert wurde, wird nicht angekuendigt. Sonst koennte die
    /// Gegenseite einen Inhalt abrufen, den der Nutzer nie waehrend der
    /// Sitzung kopiert hat.
    pub fn nummer_vorgeben(&mut self, nummer: u32) {
        self.nummer = Some(nummer);
    }

    /// Ein eigener Vorgang am Fach beginnt (s. [`Self::vorgang`]).
    pub fn vorgang_beginnen(&mut self) {
        self.vorgang = true;
    }

    /// Ein eigener Vorgang ist gescheitert — es gibt nichts zu verbuchen.
    pub fn vorgang_abbrechen(&mut self) {
        self.vorgang = false;
    }

    /// Eine Aenderung, die wir selbst gerade ausgeloest haben. **Erst nach dem
    /// geglueckten Aufruf ans Betriebssystem rufen.**
    ///
    /// Vorgemerkt wird nichts: die Meldung oder der Poll, der die eigene
    /// Aenderung danach sieht, findet uns als Eigentuemer
    /// ([`Self::systemmeldung`]) — oder, nach dem Raeumen, ein leeres Fach bei
    /// `eigen == false`. Beides zaehlt nicht. **macOS legt den Zaehlerstand
    /// seines eigenen Vorgangs zusaetzlich als gesehen ab** (`macos::faden`),
    /// dort kommt der Poll also gar nicht erst vorbei.
    pub fn selbst_geaendert(&mut self, eigen: bool) {
        self.eigen = eigen;
        self.gelesen = None;
        self.vorgang = false;
    }

    /// Verbrauchend, wie `Beobachter::geaendert` es verlangt.
    pub fn aenderung_abholen(&mut self) -> bool {
        let neu = self.stand != self.gesehen;
        self.gesehen = self.stand;
        neu
    }

    pub fn eigen(&self) -> bool {
        self.eigen
    }

    pub fn wartet(&self) -> bool {
        self.wartet
    }

    /// Ein Rendervorgang beginnt zu warten.
    pub fn warten_beginnen(&mut self) {
        self.wartet = true;
        self.antwort = None;
        self.abbruch = false;
    }

    /// Was der wartende Rendervorgang bekommt — `None`, solange nichts da ist
    /// und nichts abgebrochen wurde.
    pub fn antwort_nehmen(&mut self) -> Option<String> {
        if let Some(text) = self.antwort.take() {
            return Some(text);
        }
        // **Ein abgebrochener Rendervorgang bekommt eine leere Zeichenkette,
        // nicht gar nichts.** Er blockiert ein fremdes Programm; ohne Antwort
        // stuende es bis zu unserer eigenen Frist.
        if self.abbruch { Some(String::new()) } else { None }
    }

    pub fn warten_beenden(&mut self) {
        self.wartet = false;
        self.antwort = None;
        self.abbruch = false;
    }

    /// Inhalt fuer den wartenden Rendervorgang hinterlegen
    /// (`Eigentum::liefern`). Wartet keiner, ist es folgenlos.
    pub fn antwort_setzen(&mut self, text: &str) {
        if self.wartet {
            self.antwort = Some(text.to_string());
        }
    }

    /// Einen wartenden Rendervorgang abbrechen, weil die Ablage gleich neu
    /// belegt wird.
    pub fn abbrechen(&mut self) {
        if self.wartet {
            self.abbruch = true;
        }
    }

    /// Ist noch kein Lesevorgang unterwegs oder fertig?
    pub fn lesen_offen(&self) -> bool {
        !self.lesen_laeuft && self.gelesen.is_none()
    }

    pub fn lesen_beginnen(&mut self) {
        self.lesen_laeuft = true;
    }

    pub fn lesen_fertig(&mut self, text: Option<String>) {
        self.lesen_laeuft = false;
        self.gelesen = Some(text);
    }

    pub fn lesen_bereit(&self) -> bool {
        self.gelesen.is_some()
    }

    pub fn gelesenes(&self) -> Option<String> {
        self.gelesen.clone().flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::Ablagestand;

    /// Der eigene Anspruch darf keine Ankuendigung ausloesen.
    ///
    /// Sonst meldeten wir der Gegenseite ihren eigenen Inhalt als Neuigkeit
    /// zurueck, sie beanspruchte daraufhin ihre Ablage, und das ginge endlos.
    #[test]
    fn der_eigene_anspruch_zaehlt_nicht_als_aenderung() {
        let mut g = Ablagestand::neu();
        g.vorgang_beginnen();
        g.selbst_geaendert(true);
        g.meldung(1, true, true);
        assert!(!g.aenderung_abholen(), "die eigene Aenderung darf nicht hinausgehen");
    }

    /// **Der Fehler vom 2026-10-15:** eigene Ansprueche, fuer die keine Meldung
    /// kommt, duerfen keine spaetere Kopie des Nutzers verschlucken.
    #[test]
    fn eigene_ansprueche_ohne_meldung_schlucken_keine_kopie() {
        let mut g = Ablagestand::neu();
        for _ in 0..7 {
            g.vorgang_beginnen();
            g.selbst_geaendert(true);
        }
        // Der Nutzer kopiert selbst — ein anderes Programm wird Eigentuemer.
        g.meldung(8, false, true);
        assert!(g.aenderung_abholen(), "die Kopie des Nutzers muss angekuendigt werden");
    }

    /// Kopiert der Nutzer selbst, geht genau eine Ankuendigung hinaus — auch
    /// wenn Meldung UND Takt dieselbe Nummer sehen.
    #[test]
    fn fremdes_kopieren_zaehlt_einmal() {
        let mut g = Ablagestand::neu();
        g.meldung(3, false, true);
        g.meldung(3, false, true);
        assert!(g.aenderung_abholen());
        assert!(!g.aenderung_abholen(), "verbrauchend, sonst antwortet jedes hol mit veraltet");
    }

    /// Mitten in einem eigenen Vorgang wird nicht ausgewertet — und die Nummer
    /// nicht verbucht, damit der naechste Blick sie nachholt.
    #[test]
    fn mitten_im_eigenen_vorgang_wird_nicht_ausgewertet() {
        let mut g = Ablagestand::neu();
        g.vorgang_beginnen();
        g.selbst_geaendert(true);
        g.meldung(1, true, true);
        g.aenderung_abholen();
        // Raeumen: das Fach gehoert gleich niemandem, `eigen` steht aber noch.
        g.vorgang_beginnen();
        assert!(!g.nummer_neu(2));
        g.meldung(2, false, false);
        g.selbst_geaendert(false);
        g.meldung(2, false, false);
        assert!(!g.aenderung_abholen(), "das eigene Raeumen ist kein Eigentumsverlust");
    }

    /// Ein gescheiterter Vorgang gibt die Auswertung wieder frei.
    #[test]
    fn ein_gescheiterter_vorgang_sperrt_nicht_dauerhaft() {
        let mut g = Ablagestand::neu();
        g.vorgang_beginnen();
        g.vorgang_abbrechen();
        g.meldung(4, false, true);
        assert!(g.aenderung_abholen());
    }

    /// Eine aeltere Nummer, die nach einer neueren eintrifft, wird nicht mehr
    /// ausgewertet — ihr Eigentuemer ist veraltet. Auch ueber den Ueberlauf.
    #[test]
    fn nur_neuere_nummern_werden_ausgewertet() {
        let mut g = Ablagestand::neu();
        g.nummer_vorgeben(u32::MAX);
        assert!(g.meldung(1, false, true), "nach dem Ueberlauf ist 1 neuer");
        g.aenderung_abholen();
        assert!(!g.meldung(u32::MAX, true, true), "die alte Nummer kommt zu spaet");
        assert!(!g.eigen(), "ihr veralteter Eigentuemer darf nichts verbuchen");
    }

    /// Ohne Auskunft (Nummer 0) zaehlt jede Meldung, wie vor dem Umbau.
    #[test]
    fn ohne_nummer_zaehlt_jede_meldung() {
        let mut g = Ablagestand::neu();
        g.nummer_vorgeben(0);
        assert!(g.meldung(0, false, true));
        assert!(g.aenderung_abholen());
        assert!(g.meldung(0, false, true));
    }

    /// Was vor der Sitzung im Fach lag, wird nicht angekuendigt.
    #[test]
    fn der_stand_beim_start_wird_nicht_angekuendigt() {
        let mut g = Ablagestand::neu();
        g.nummer_vorgeben(17);
        g.meldung(17, false, true);
        assert!(!g.aenderung_abholen());
        g.meldung(18, false, true);
        assert!(g.aenderung_abholen(), "die erste Kopie danach schon");
    }

    /// **Der Eigentumsverlust ist eine unverbuchte Aenderung** — auch ohne Text
    /// im Fach, fail-closed.
    ///
    /// Solange wir die Ablage hielten, war die angekuendigte Generation an
    /// unseren Stand gebunden. Ist sie weg, stimmt das nicht mehr, und
    /// `Ankuendiger::beantworte` darf ein `hol` nicht mit frisch gelesenem
    /// Inhalt beantworten.
    #[test]
    fn eigentumsverlust_zaehlt_auch_ohne_text() {
        let mut g = Ablagestand::neu();
        g.selbst_geaendert(true);
        g.systemmeldung(true, false);
        g.aenderung_abholen();
        // Ein anderes Programm raeumt die Ablage: kein Text, aber wir sind raus.
        g.systemmeldung(false, false);
        assert!(g.aenderung_abholen(), "der Verlust selbst ist die Aenderung");
        assert!(!g.eigen());
    }

    /// Ein kopiertes Bild bewegt den Zaehler nicht: die Gegenseite loeschte
    /// dafuer den Vorbestand ihres Nutzers und bekaeme beim Einfuegen ein `weg`.
    #[test]
    fn ein_fach_ohne_text_kuendigt_nichts_an() {
        let mut g = Ablagestand::neu();
        g.systemmeldung(false, false);
        assert!(!g.aenderung_abholen());
    }

    /// Ein abgebrochener Rendervorgang bekommt eine leere Antwort statt gar
    /// keiner — sonst haengt das einfuegende Programm.
    #[test]
    fn ein_abbruch_beantwortet_den_wartenden_leer() {
        let mut g = Ablagestand::neu();
        g.warten_beginnen();
        assert_eq!(g.antwort_nehmen(), None, "solange nichts da ist, wird gewartet");
        g.abbrechen();
        assert_eq!(g.antwort_nehmen().as_deref(), Some(""));
    }

    /// **macOS: der Poll-Weg** — nach einer eigenen Aenderung zaehlt die
    /// naechste FREMDE sofort.
    #[test]
    fn nach_der_eigenen_aenderung_zaehlt_die_naechste_fremde_sofort() {
        let mut g = Ablagestand::neu();
        g.selbst_geaendert(true);
        assert!(!g.aenderung_abholen(), "die eigene Aenderung darf nicht hinausgehen");
        assert!(g.eigen());
        // Der Nutzer kopiert selbst — der Poll sieht einen fremden Stand.
        g.systemmeldung(false, true);
        assert!(g.aenderung_abholen(), "die naechste fremde Aenderung zaehlt sofort");
    }

    /// Eine Aenderung der Ablage macht ein bereits gelesenes Ergebnis
    /// ungueltig — es gehoert dem Fach, aus dem es stammt.
    #[test]
    fn eine_aenderung_verwirft_das_gelesene() {
        let mut g = Ablagestand::neu();
        g.lesen_beginnen();
        g.lesen_fertig(Some("alt".into()));
        assert!(g.lesen_bereit());
        g.systemmeldung(false, true);
        assert!(!g.lesen_bereit(), "sonst antwortete ein hol mit dem Inhalt von vorhin");
        assert!(g.lesen_offen(), "und ein neuer Lesevorgang muss moeglich sein");
    }
}
