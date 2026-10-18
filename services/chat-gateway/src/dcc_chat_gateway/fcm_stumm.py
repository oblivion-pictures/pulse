"""Wer sich DM-Pushes verbeten hat — „Nicht stören“ und der DM-Schalter.

Zwei Gründe, einem Konto KEINEN DM-Push zu schicken (iOS und Android, beide
laufen über :func:`dcc_chat_gateway.fcm.dm_push_senden`):

* **Nicht stören.** Der Presence-Status ``dnd`` — Live-Stand in Redis
  (``presence:status:<id>``, 24 h), sonst die dauerhafte Spiegelung in
  ``user_preferences`` (Abschnitt ``presence``); dieselbe Reihenfolge wie im
  ``ready``-Rahmen. Vorher kannte nur der Browser das (Service-Worker) — ein
  Telefon klingelte trotz „Nicht stören“.
* **Der DM-Schalter** („Direktnachrichten“ in den Mitteilungs-Einstellungen).
  Er lag bis dahin nur im Browser (``localStorage``) und kam nie beim Server
  an. Jetzt spiegelt der Klient ihn in ``user_preferences``, Abschnitt
  ``push`` (``{"dm": false}``) — die vorhandene Tabelle, keine Migration.
  **Nur ein ausdrückliches ``false`` schweigt**: ein fehlender Abschnitt, ein
  unlesbarer Wert, ein Konto, das nie etwas eingestellt hat — alles bleibt
  beim Bestandsverhalten (Push an).

**Die Plakette zählt trotzdem.** Wer stumm ist, bekommt keinen Push und damit
keine neue Zahl am Icon (ein Push nur für die Zahl wäre eine eigene
Nutzlast, am Gerät ungetestet). Der Ungelesen-Zähler im Server läuft aber
weiter (``fcm.dm_push_senden``): schaltet der Nutzer „Nicht stören“ aus, trägt
der nächste Push die richtige Zahl, und die wache App korrigiert sie ohnehin.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select

from dcc_chat_gateway.models import UserPreference
from dcc_chat_gateway.presence_keys import PRESENCE_STATUS_KEY
from dcc_chat_gateway.presence_status import (
    PRESENCE_PREFERENCE_SECTION,
    STATUS_DND,
    VALID_SET_STATUSES,
)

log = logging.getLogger(__name__)

#: ``user_preferences.section_name`` des DM-Schalters. Klein geschrieben, weil
#: die Route nur ``^[a-z][a-z0-9_:-]{0,63}$`` annimmt (``routes/preferences.py``);
#: ``web/src/lib/settings-registry/sections/pushDm.ts`` trägt denselben Namen.
PUSH_ABSCHNITT = "push"


def _status_aus(roh: Any) -> str | None:
    if roh is None:
        return None
    wert = roh.decode() if isinstance(roh, bytes) else roh
    return wert if wert in VALID_SET_STATUSES else None


async def stumme_konten(session: Any, redis: Any, user_ids: set[int]) -> set[int]:
    """Die Konten unter ``user_ids``, die gerade keinen DM-Push wollen.

    Ohne Redis zählt nur die dauerhafte Spiegelung des Status. Ein Redis-Fehler
    fällt in dieselbe Richtung (der Push-Weg ist best-effort); ein
    Datenbankfehler wirft weiter — der Aufrufer plant den Versuch dann neu ein.
    """
    if not user_ids:
        return set()
    ids = sorted(user_ids)
    live: dict[int, str | None] = dict.fromkeys(ids)
    if redis is not None:
        try:
            roh = await redis.mget([PRESENCE_STATUS_KEY.format(user_id=u) for u in ids])
            live = {u: _status_aus(r) for u, r in zip(ids, roh, strict=True)}
        except Exception:  # noqa: BLE001
            log.warning("fcm_stumm_status_lesen_fehlgeschlagen")
    zeilen = await session.execute(
        select(UserPreference.user_id, UserPreference.section_name, UserPreference.value).where(
            UserPreference.user_id.in_(ids),
            UserPreference.section_name.in_([PRESENCE_PREFERENCE_SECTION, PUSH_ABSCHNITT]),
        )
    )
    dauerhaft: dict[int, str | None] = {}
    schalter_aus: set[int] = set()
    for uid, abschnitt, wert in zeilen.all():
        if not isinstance(wert, dict):
            continue
        if abschnitt == PUSH_ABSCHNITT and wert.get("dm") is False:
            schalter_aus.add(uid)
        elif abschnitt == PRESENCE_PREFERENCE_SECTION:
            dauerhaft[uid] = _status_aus(wert.get("status"))
    nicht_stoeren = {u for u in ids if (live[u] or dauerhaft.get(u)) == STATUS_DND}
    return (schalter_aus | nicht_stoeren) & user_ids


__all__ = ["PUSH_ABSCHNITT", "stumme_konten"]
