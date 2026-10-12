"""Benachrichtigungen von auth-svc an einzelne Nutzer (Redis Pub/Sub).

``USER_EVENTS_CHANNEL`` (``user:events``) stellt chat-gateway genau einem
Nutzer zu. ``instance_status.py`` meldet darüber, ob ein Heim-Server läuft;
``publish_instanz_verbunden`` (aus ``routes_verbinden.py``) meldet, dass ein
Server sich mit dem Konto verbunden hat.

Best-effort: Redis weg oder Publish fehlgeschlagen → ein verlorenes Ereignis
kostet nur die Sofortigkeit, die Aktion selbst ist da schon geschehen. Eine
Benachrichtigung darf niemals die Aktion scheitern lassen.

Bis Oktober 2026 lagen hier auch die Antrags-Meldungen
(``admin_application_pending`` an die Admins über ``admin:events``,
``application_decided`` an den Antragsteller). Mit Antrag und Freigabe sind
sie entfallen (Spec E11).
"""

from __future__ import annotations

import json
import logging

from fastapi import Request

from dcc_shared.events.instances import InstanzVerbundenData, InstanzVerbundenEvent

log = logging.getLogger(__name__)

# Direct-Delivery an genau einen User. chat-gateway routet über
# ``_target_user_id`` und streift das Feld vor der Zustellung ab.
USER_EVENTS_CHANNEL = "user:events"


async def _publish(request: Request, channel: str, payload: dict) -> None:
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        return
    try:
        await redis.publish(channel, json.dumps(payload))
    except Exception:  # noqa: BLE001
        log.warning("publish auf %s fehlgeschlagen: %r", channel, payload, exc_info=True)


async def publish_instanz_verbunden(request: Request, *, user_id: int, instance_id: int) -> None:
    """Meldet dem Besitzer, dass ein Server mit seinem Konto verbunden ist und
    seine Zugangsdaten abgeholt hat — seine offenen Geräte nehmen ihn sofort
    in die Leiste (Spec 2026-10-09, E3).

    Gebaut aus dem Modell statt als Wörterbuch: der chat-gateway verwirft im
    strikten Modus jede Form, die das Register nicht annimmt. Best-effort wie
    alles hier — ein verlorenes Ereignis kostet nur die Sofortigkeit, das
    Abholen ist da schon geschehen.
    """
    ereignis = InstanzVerbundenEvent(data=InstanzVerbundenData(instance_id=str(instance_id)))
    await _publish(
        request,
        USER_EVENTS_CHANNEL,
        {**ereignis.model_dump(mode="json"), "_target_user_id": str(user_id)},
    )
