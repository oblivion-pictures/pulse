"""Zustimmung zu den Nutzungsbedingungen (AGB) — Fassung und Pflicht.

**Warum es das gibt.** Bis 2026-10-26 standen AGB und Datenschutzerklärung bei
der Registrierung nur als Links in der Fußzeile; es gab weder ein Häkchen noch
einen Nachweis, wer welcher Fassung wann zugestimmt hat. Ob die AGB damit
überhaupt Vertragsbestandteil wurden, war fraglich. Seitdem gilt:

* ``/register`` verlangt in der Cloud ``agb_akzeptiert`` und speichert Fassung
  und Zeitpunkt am Konto (Migration 0059).
* Ein Konto, dessen gespeicherte Fassung nicht der aktuellen entspricht (alle
  Bestandskonten, und jedes nach einer AGB-Änderung), sieht nach der Anmeldung
  einen Dialog und stimmt über ``POST /me/agb-zustimmung`` zu.

**Nur in der Cloud.** Die AGB gelten ausschließlich für howispulse.com (Hinweis
am Ende von ``web/src/lib/legal/agb.md``). Ein Self-Host mit
``ALLOW_LOCAL_ACCOUNTS`` hat eigene Bedingungen; dort fragt der Server nichts.

**Die Fassung ist das „Stand“-Datum der AGB** (``web/src/lib/legal/agb.md``,
letzte Zeile vor dem Self-Host-Hinweis). ``tests/test_agb.py`` gleicht beide ab:
wer den Text ändert und das Datum nachzieht, muss auch diese Konstante
nachziehen — und löst damit für alle Konten den Zustimmungs-Dialog aus. Eine
reine Änderung der Datenschutzerklärung verlangt keine Zustimmung (sie ist eine
Information, keine Vertragsbedingung).
"""

from __future__ import annotations

from dcc_auth.config import Settings

#: Aktuelle Fassung der Nutzungsbedingungen (ISO-Datum des „Stand“).
AGB_FASSUNG = "2026-10-26"


def agb_pflicht(settings: Settings) -> bool:
    """Verlangt dieser Server eine Zustimmung zu den howispulse.com-AGB?"""
    return settings.pulse_instance_mode == "cloud"


def zustimmung_noetig(settings: Settings, fassung: str | None) -> bool:
    """Muss ein Konto mit dieser gespeicherten Fassung (neu) zustimmen?"""
    return agb_pflicht(settings) and fassung != AGB_FASSUNG
