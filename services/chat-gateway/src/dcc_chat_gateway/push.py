"""Web-Push (RFC 8030) sender.

``send_push_to_user`` fans a payload dict out to every
``WebPushSubscription`` owned by ``user_id``, drops endpoints that
push services reject with 404/410 (RFC 8030 §7.3 — "gone"), and
refreshes ``last_used_at`` on success. pywebpush is sync-only; we run
each send in a worker thread so a slow push service can't block the
event loop.

VAPID key management (``ensure_vapid`` etc.) lives in
``dcc_chat_gateway.vapid``; we re-export the public surface here so
existing ``from dcc_chat_gateway.push import ensure_vapid`` callers
keep working.

The payload shape — the contract with the FE Service Worker and the
Electron-side notifier — is documented in ``push_ereignisse.py`` under
``MENTION_PAYLOAD_SCHEMA``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway import fcm_warteschlange
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.fcm_stumm import ohne_stumme_gruppenmitglieder
from dcc_chat_gateway.models import WebPushSubscription
from dcc_chat_gateway.vapid import (
    VapidKeys,
    ensure_vapid,
    reset_vapid_cache_for_tests,
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Sender


async def send_push_to_user(
    user_id: int, payload: dict, session: AsyncSession
) -> int:
    """Push ``payload`` to every device subscribed by ``user_id``.

    Returns the count of *successful* deliveries. Failed endpoints (404,
    410, unrecoverable cryptography errors) are dropped from the DB
    inline so the next send doesn't waste a round-trip on them. Other
    failures (timeouts, 5xx) are logged at WARN and the subscription
    is left alone — push services are allowed to be flaky, and a single
    failed send mustn't permanently disable notifications.

    Never raises; a misconfigured VAPID or a dead push service must not
    turn a successful message-write into a 500.
    """
    settings = get_settings()
    vapid = ensure_vapid(settings)
    if vapid is None:
        return 0

    rows = (
        await session.execute(
            select(WebPushSubscription).where(WebPushSubscription.user_id == user_id)
        )
    ).scalars().all()
    if not rows:
        return 0

    body = json.dumps(payload, separators=(",", ":"))
    vapid_claims = {"sub": settings.vapid_subject}

    # pywebpush is sync; offload each send to a thread so a slow push
    # service can't stall the event loop. Concurrency-bound by the default
    # thread pool — typical user has 1-3 subscriptions.
    #
    # ``return_exceptions=True`` keeps a CancelledError (BaseException, raised
    # if the calling task is cancelled while the gather is pending) from
    # propagating out and skipping the dead-endpoint cleanup below — stale
    # 404/410 subscriptions would otherwise accumulate forever.  The
    # individual ``_send_one`` calls never raise (they always return a
    # status string); any exception entry here is a cancelled future, which
    # we treat as a transient skip.
    results = await asyncio.gather(
        *(
            asyncio.to_thread(
                _send_one,
                endpoint=r.endpoint,
                p256dh=r.p256dh,
                auth_secret=r.auth_secret,
                body=body,
                vapid_pem=vapid.private_pem,
                vapid_claims=vapid_claims,
            )
            for r in rows
        ),
        return_exceptions=True,
    )

    ok_ids: list[int] = []
    dead_ids: list[int] = []
    for row, outcome in zip(rows, results, strict=True):
        if outcome == "ok":
            ok_ids.append(row.id)
        elif outcome == "dead":
            dead_ids.append(row.id)
        # "warn" → leave alone (transient).

    if dead_ids:
        await session.execute(
            delete(WebPushSubscription).where(WebPushSubscription.id.in_(dead_ids))
        )
    if ok_ids:
        await session.execute(
            update(WebPushSubscription)
            .where(WebPushSubscription.id.in_(ok_ids))
            .values(last_used_at=datetime.now(UTC))
        )
    if dead_ids or ok_ids:
        await session.commit()
    return len(ok_ids)


def _send_one(
    *,
    endpoint: str,
    p256dh: str,
    auth_secret: str,
    body: str,
    vapid_pem: str,
    vapid_claims: dict,
) -> str:
    """Single push attempt. Returns ``"ok"``, ``"dead"``, or ``"warn"``.

    Imports pywebpush lazily so the chat-gateway can boot without the
    library installed (tests that mock the sender don't need it either —
    they monkey-patch ``send_push_to_user`` upstream of this function).

    NEVER logs ``body``, ``p256dh``, ``auth_secret``, or ``vapid_pem`` —
    those are sensitive (payload may carry message snippets; the keys
    let anyone send pushes to the user's browser). Only the endpoint
    host + status code go to logs.
    """
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        log.error("pywebpush not installed; push disabled")
        return "warn"
    try:
        webpush(
            subscription_info={
                "endpoint": endpoint,
                "keys": {"p256dh": p256dh, "auth": auth_secret},
            },
            data=body,
            vapid_private_key=vapid_pem,
            vapid_claims=dict(vapid_claims),
            timeout=10,  # ohne Timeout hängt ein zäher Vendor-POST einen
            # to_thread-Worker dauerhaft und verhungert den ganzen Push-Versand
        )
        return "ok"
    except WebPushException as exc:  # noqa: BLE001
        status = getattr(exc.response, "status_code", None) if exc.response else None
        if status in (404, 410):
            return "dead"
        # Endpoint host only — never the path (path can carry the
        # subscription token for some push services).
        host = endpoint.split("/", 3)[2] if "://" in endpoint else "<unknown>"
        log.warning("web-push send failed: host=%s status=%s", host, status)
        return "warn"
    except Exception:  # noqa: BLE001
        host = endpoint.split("/", 3)[2] if "://" in endpoint else "<unknown>"
        log.exception("web-push unexpected error: host=%s", host)
        return "warn"


async def _fan_out_payload(user_ids: set[int], payload: dict) -> None:
    """Open a short-lived session and push ``payload`` to each user.

    Self-contained mirror of ``fan_out_mention_push``'s session handling for
    payloads that aren't mentions (DMs, friend events). Never raises — push
    is best-effort and must not break the originating REST path.
    """
    if not user_ids:
        return
    if ensure_vapid(get_settings()) is None:
        return
    from dcc_chat_gateway.routes import ws_ops as _routes_ws_ops

    try:
        async with _routes_ws_ops.SessionLocal() as session:
            for uid in user_ids:
                await send_push_to_user(uid, payload, session)
    except Exception:  # noqa: BLE001
        log.exception("_fan_out_payload failed")


async def fan_out_dm_push(
    *,
    recipient_id: int,
    author_name: str,
    channel_id: int,
    message_id: int,
    manager=None,
) -> None:
    """Push a closed-browser notification for a new DM to its recipient.

    The in-app path (``dm_bump`` WS frame) covers the tab-open case; this
    covers the tab-closed case. ``guild_id: None`` makes the SW route the
    click to ``/app/@me/<channel_id>``. DND is honoured SW-side; the per-type
    ``onDM`` toggle gates the in-page path (matching mention push).

    Security-Audit 2026-09-16: ``body`` ist inhaltsfrei. Der Push-Dienst
    (Drittanbieter) sah bisher den Klartext der DM — dieselbe Information wie
    im verschlüsselten Postfach-Weg (``fan_out_dm_push_encrypted``), das
    Absender und Kanal nennt, aber nie Inhalt.
    ``manager`` (ConnectionManager) reicht Redis und die Socket-Zählung an
    das FCM-Bein: wer dort welchen Push bekommt, entscheidet
    ``fcm_empfaenger.empfangende_geraete`` (nur iOS-Bauten ohne die Zusage
    ``dm_vordergrund`` hängen noch an der wachen Verbindung).
    """
    payload = {
        "type": "dm",
        "title": author_name or "Pulse",
        "body": "Neue Direktnachricht",
        "channel_id": str(channel_id),
        "message_id": str(message_id),
        "guild_id": None,
        "author_name": author_name or "",
        "icon": None,
    }
    await _fan_out_payload({recipient_id}, payload)
    # Das Handy-Bein wartet (``fcm_warteschlange.py``); der Web-Push oben nicht.
    await fcm_warteschlange.vormerken(
        recipient_ids={recipient_id},
        author_name=author_name,
        channel_id=channel_id,
        manager=manager,
        message_id=message_id,
    )


async def fan_out_dm_push_encrypted(
    *,
    recipient_ids: set[int],
    author_name: str,
    channel_id: int,
    manager=None,
    hat_anhang: bool = False,
    art: str = "dm",
    zustellungen: dict[int, dict[str, list[int]]] | None = None,
) -> None:
    """Push eine geschlossene-Browser-Benachrichtigung fuer eine ende-zu-
    ende-verschluesselte DM aus.

    Gegenstueck zu ``fan_out_dm_push`` fuer den Postfach-Weg
    (``routes/postfach.py``): der Server oeffnet den Umschlag nie und kennt
    deshalb weder Klartext noch Nachrichten-Id — ``body`` ist derselbe
    inhaltsfreie Text wie die In-App-Benachrichtigung des Klienten fuer
    diesen Fall (``chat_handler_dm_notification_body`` im Paraglide-
    Katalog: "Neue Direktnachricht"), ``message_id`` bleibt ``null``. Absender
    und Kanal duerfen genannt werden — das tut der Klartext-Weg auch.

    ``manager`` gated das FCM-Bein wie in ``fan_out_dm_push``. ``art``
    (``dm``/``gruppe``) und ``zustellungen`` (je Empfaenger die Zustellungs-IDs
    je Geraet) braucht die Warteschlange des Handy-Beins fuer die Frage, ob
    die Nachricht inzwischen woanders gelesen wurde (``fcm_gelesen.py``).
    """
    payload = {
        "type": "dm",
        "title": author_name or "Pulse",
        "body": "Neue Direktnachricht",
        "channel_id": str(channel_id),
        "message_id": None,
        "guild_id": None,
        "author_name": author_name or "",
        "icon": None,
    }
    web_empfaenger = recipient_ids
    if art == "gruppe":
        # Wer die Gruppe stummgeschaltet hat, bekommt auch keinen Web-Push.
        # Das Handy-Bein prüft dasselbe erst beim Senden (``fcm_stumm``).
        from dcc_chat_gateway.routes import ws_ops as _routes_ws_ops

        web_empfaenger = await ohne_stumme_gruppenmitglieder(
            _routes_ws_ops.SessionLocal, channel_id, set(recipient_ids)
        )
    await _fan_out_payload(web_empfaenger, payload)
    # Nur das FCM-Bein trägt den Anhang-Hinweis: dort landet er auf einem
    # Sperrbildschirm, wo er den Unterschied macht. Der Web-Push oben bleibt
    # wie er war — er erscheint im Browser, wo die App meist ohnehin offen
    # ist, und sein Text weicht seit jeher ab ("Neue Direktnachricht").
    await fcm_warteschlange.vormerken(
        recipient_ids=recipient_ids,
        author_name=author_name,
        channel_id=channel_id,
        manager=manager,
        hat_anhang=hat_anhang,
        art=art,
        zustellungen=zustellungen,
    )


# Bestandsschutz: Erwähnungs-, Freundes- und Einladungs-Pushes stehen seit
# dem 2026-10-20 in ``push_ereignisse.py`` (Größen-Policy); Aufrufer und
# Tests holen sie weiter von hier. Unten, weil ``push_ereignisse`` dieses
# Modul beim Senden selbst braucht.
from dcc_chat_gateway.push_ereignisse import (  # noqa: E402
    MENTION_PAYLOAD_SCHEMA,
    fan_out_community_invite_push,
    fan_out_friend_push,
    fan_out_mention_push,
)

__all__ = [
    "MENTION_PAYLOAD_SCHEMA",
    "VapidKeys",
    "ensure_vapid",
    "fan_out_dm_push",
    "fan_out_dm_push_encrypted",
    "fan_out_community_invite_push",
    "fan_out_friend_push",
    "fan_out_mention_push",
    "reset_vapid_cache_for_tests",
    "send_push_to_user",
]
