"""Wer ein Standplatz-Gerät gerade geweckt hat (ConnectionManager-Mixin).

**Wozu:** zwischen Weckruf und Zustimmung liegt eine Lücke. Das Gerät beginnt
zu übertragen, sobald es geweckt ist, belegt („busy") ist es aber erst, wenn
die Steuer-Anfrage angenommen wurde. In dieser Lücke muss genau EINER schon
zusehen dürfen: der, der geweckt hat — sein Player wartet auf das erste Bild,
bevor er überhaupt anfragt (``web/src/lib/devices/schirme.svelte.ts``). Alle
anderen nicht: ein geweckter, aber noch nicht gesteuerter Rechner zeigt seinen
ungeschützten Schirm (der Sichtschutz greift erst mit der Sitzung).

Der Merker ist deshalb **eng**: ein Gerät, ein Wecker, eine Frist von
:data:`WECKFRIST_S`. Gesetzt in ``handle_wake`` erst nach bestandener Prüfung
(Sicht + Freigabe), gelöscht beim Sitzungsbeginn (dann zählt ``busy``), beim
Sitzungsende, wenn das Gerät offline geht oder vergessen wird — und spätestens
mit der Frist.

**Warum im Prozess und nicht in Redis:** dieselbe Begründung wie beim
Geräteregister (``device_registry.py``) — der Merker gehört zu einer lebenden
Verbindung, und ein verwaister Eintrag nach einem Absturz wäre eine Erlaubnis,
die niemand mehr verantwortet. Fährt der Gateway mehrfach, kennt nur der
Prozess des Geräts den Wecker; ein Zuschauer auf einem anderen Prozess wird
dann abgewiesen — unvollständig, aber in die sichere Richtung.
"""

from __future__ import annotations

import time

#: Wie lange ein Weckruf das Zusehen erlaubt, ohne dass eine Sitzung daraus
#: wird. Deckt den regulären Weg ab — bis zu 25 s auf das erste Bild
#: (``schirme.svelte.ts::WARTEN_MS``) und die Anfrage gleich danach, die bei
#: einem Gerät ohne Dialog in Millisekunden beantwortet wird. Länger wäre ein
#: Fenster, in dem der Wecker einem nicht gesteuerten Rechner zusieht.
WECKFRIST_S = 60.0


class _DeviceWeckerMixin:
    """Ergänzt den ConnectionManager um den Wecker-Merker. Nicht allein
    verwendbar; ``_init_device_wecker()`` einmal im ``__init__`` rufen."""

    #: ``device_id`` → (Kennung des Weckers, monotone Ablaufzeit).
    _device_wecker: dict[int, tuple[str, float]]

    def _init_device_wecker(self) -> None:
        self._device_wecker = {}

    def device_wecker_setzen(self, device_id: int, user_id: int | str) -> None:
        """Den Wecker merken — ein neuer Weckruf ersetzt den alten."""
        self._device_wecker[int(device_id)] = (str(user_id), time.monotonic() + WECKFRIST_S)

    def device_wecker(self, device_id: int) -> str | None:
        """Wer dieses Gerät innerhalb der Frist geweckt hat, sonst ``None``.

        Ein abgelaufener Eintrag wird hier weggeräumt — einen eigenen
        Fegelauf braucht es nicht, die Tabelle hat höchstens einen Eintrag je
        Gerät.
        """
        eintrag = self._device_wecker.get(int(device_id))
        if eintrag is None:
            return None
        wer, bis = eintrag
        if time.monotonic() >= bis:
            self._device_wecker.pop(int(device_id), None)
            return None
        return wer

    def device_wecker_loeschen(self, device_id: int) -> None:
        self._device_wecker.pop(int(device_id), None)
