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
(Sicht + Freigabe) und hinausgegangenem Ruf, gelöscht beim Sitzungsbeginn (dann
zählt ``busy``), beim Sitzungsende, wenn das Gerät offline geht oder vergessen
wird — und spätestens mit der Frist.

**Der Merker regelt nur, wer ein NEUES Lese-Token bekommt.** Ein schon
ausgestelltes überlebte ihn sonst: läuft die Frist ab, ohne dass eine Sitzung
daraus wurde, widerruft ein Zeitgeber die Zuschauer-Token des Geräts
(``geraete_zuschauen.widerrufen_und_trennen``) — nicht, wenn das Gerät
inzwischen belegt ist oder eine Sitzung wartet (deren Ende räumt selbst).
Was dieser Widerruf im Wettlauf verpasst, begrenzt die kurze Laufzeit von
Geräte-Lese-Token (media-svc ``lese_token.GERAET_LESE_TOKEN_TTL_S``).

**Warum im Prozess und nicht in Redis:** dieselbe Begründung wie beim
Geräteregister (``device_registry.py``) — der Merker gehört zu einer lebenden
Verbindung, und ein verwaister Eintrag nach einem Absturz wäre eine Erlaubnis,
die niemand mehr verantwortet. Fährt der Gateway mehrfach, kennt nur der
Prozess des Geräts den Wecker; ein Zuschauer auf einem anderen Prozess wird
dann abgewiesen — unvollständig, aber in die sichere Richtung.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

log = logging.getLogger(__name__)

#: Wie lange ein Weckruf das Abholen eines Lese-Tokens erlaubt, ohne dass eine
#: Sitzung daraus wird. Deckt den regulären Weg ab — bis zu 25 s auf das erste
#: Bild (``schirme.svelte.ts::WARTEN_MS``) und die Anfrage gleich danach, die
#: ein Gerät ohne Dialog beantwortet. Nach Ablauf widerruft ein Zeitgeber die
#: schon ausgestellten Token (s. Modulkopf); was ihm im Wettlauf entgeht, lebt
#: höchstens noch die Laufzeit eines Geräte-Lese-Tokens (120 s). Länger wäre
#: ein Fenster, in dem der Wecker einem nicht gesteuerten Rechner zusieht.
WECKFRIST_S = 60.0


class _DeviceWeckerMixin:
    """Ergänzt den ConnectionManager um den Wecker-Merker. Nicht allein
    verwendbar; ``_init_device_wecker()`` einmal im ``__init__`` rufen."""

    #: ``device_id`` → (Kennung des Weckers, monotone Ablaufzeit).
    _device_wecker: dict[int, tuple[str, float]]
    #: ``device_id`` → Zeitgeber, der beim Fristablauf widerruft.
    _device_wecker_ablauf: dict[int, asyncio.TimerHandle]
    #: Laufende Widerrufe — gehalten, damit der GC sie nicht einsammelt.
    _device_wecker_widerrufe: set[Any]

    def _init_device_wecker(self) -> None:
        self._device_wecker = {}
        self._device_wecker_ablauf = {}
        self._device_wecker_widerrufe = set()

    def device_wecker_setzen(
        self,
        device_id: int,
        user_id: int | str,
        *,
        channel_id: int | None = None,
        owner_id: int | None = None,
    ) -> None:
        """Den Wecker merken — ein neuer Weckruf ersetzt den alten.

        Mit ``channel_id``/``owner_id`` (Standplatz und Besitzer, die der
        Widerruf braucht) läuft ein Zeitgeber bis zum Fristablauf; ohne — oder
        ohne laufende Ereignisschleife — bleibt es beim bloßen Merker.
        """
        did = int(device_id)
        self._wecker_zeitgeber_stoppen(did)
        self._device_wecker[did] = (str(user_id), time.monotonic() + WECKFRIST_S)
        if channel_id is None or owner_id is None:
            return
        try:
            schleife = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._device_wecker_ablauf[did] = schleife.call_later(
            WECKFRIST_S, self._wecker_abgelaufen, did, int(channel_id), int(owner_id)
        )

    def device_wecker(self, device_id: int) -> str | None:
        """Wer dieses Gerät innerhalb der Frist geweckt hat, sonst ``None``.

        Ein abgelaufener Eintrag wird hier weggeräumt — einen eigenen
        Fegelauf braucht es nicht, die Tabelle hat höchstens einen Eintrag je
        Gerät. Den Zeitgeber lässt das stehen: er widerruft trotzdem.
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
        """Merker und Zeitgeber fallen. Beim Sitzungsbeginn zählt danach
        ``busy``, beim Sitzungsende widerruft ``nach_geraetesitzung`` selbst;
        geht das Gerät offline oder wird vergessen, widerruft niemand — dort
        begrenzt allein die kurze Laufzeit der Geräte-Lese-Token den Rest."""
        self._device_wecker.pop(int(device_id), None)
        self._wecker_zeitgeber_stoppen(int(device_id))

    def _wecker_zeitgeber_stoppen(self, device_id: int) -> None:
        zeitgeber = self._device_wecker_ablauf.pop(device_id, None)
        if zeitgeber is not None:
            zeitgeber.cancel()

    def _wecker_abgelaufen(self, device_id: int, channel_id: int, owner_id: int) -> None:
        """Die Frist ist um, und niemand hat den Merker seither gelöscht oder
        ersetzt (beides stoppt diesen Zeitgeber): es wurde keine Sitzung
        daraus. Dann die Token des Weckers (und etwaige Wettlauf-Token)
        widerrufen — außer das Gerät ist belegt oder eine Sitzung wartet."""
        self._device_wecker_ablauf.pop(device_id, None)
        self._device_wecker.pop(device_id, None)
        zustand = getattr(self, "device_state", None)
        if zustand is not None and zustand(device_id)[0] == "busy":
            return
        sitzungen = getattr(self, "_remote_sessions", {})
        if any(s.device_id == str(device_id) for s in sitzungen.values()):
            return
        from dcc_chat_gateway.geraete_zuschauen import widerrufen_und_trennen  # noqa: PLC0415

        auftrag = asyncio.ensure_future(
            widerrufen_und_trennen(
                self, channel_id=channel_id, owner_id=owner_id, device_id=device_id
            )
        )
        self._device_wecker_widerrufe.add(auftrag)
        auftrag.add_done_callback(self._wecker_widerruf_fertig)

    def _wecker_widerruf_fertig(self, auftrag: Any) -> None:
        self._device_wecker_widerrufe.discard(auftrag)
        if not auftrag.cancelled() and auftrag.exception() is not None:
            log.warning("wecker_widerruf_fehlgeschlagen", exc_info=auftrag.exception())
