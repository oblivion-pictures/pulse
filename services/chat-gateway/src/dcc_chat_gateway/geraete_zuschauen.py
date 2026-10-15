"""Wer dem Strom eines Remote-Rechners (Standplatz-Gerät) zusehen darf.

**Die Regel (Eigentümer-Entscheid 2026-10-16, R3):** Ein Zuschauer-Token für
den Strom eines Geräts bekommt nur, wer den Standplatz sieht (prüft die Route
wie bei jedem Strom) UND

* (a) der Besitzer ist — der Strom läuft unter seinem Konto, er darf immer,
* (b) gerade steuert (``busy_with``),
* (c) das Gerät innerhalb der Weckfrist geweckt hat (``device_wecker.py``), oder
* (d) das Gerät gerade belegt ist — dann darf jeder zusehen, der den Kanal
  sieht. (b) ist in (d) enthalten und steht nur der Lesbarkeit halber da.

Ein geweckter, aber (noch) nicht gesteuerter Rechner zeigt seinen Schirm ohne
Sichtschutz — der greift erst mit der Sitzung. Bis zum 2026-10-16 bekam ihn
trotzdem jeder, der den Kanal sah.

## Woran ein Gerätestrom erkannt wird — und warum fail-closed

Der Strom eines Geräts läuft unter dem Konto des Besitzers; für MediaMTX sieht
er aus wie jeder andere. Zwei Merkmale, das erste trägt:

1. **Das Gerät sagt es beim Start**: die Stream-Token-Anfrage trägt
   ``device_id`` (``routes/streaming.py`` prüft Besitz und Standplatz), media-svc
   schreibt sie in den Token-Datensatz, der auth-hook übernimmt sie beim
   Publish nach ``stream:active``. Das Merkmal hängt damit am Pfad selbst und
   entsteht VOR dem ersten Bild — es gibt kein Fenster, in dem der Strom schon
   läuft, aber noch nicht als Gerätestrom gilt.
2. **Das Register**, für Geräte-Clients ohne Merkmal (ältere Fassung): ein
   angemeldetes Gerät dieses Besitzers an genau diesem Standplatz meldet genau
   diesen Platz als sendend (``device_streams``). Das hat ein Fenster — die
   Meldung kommt kurz nach dem Start — und ist deshalb nur der Rückfall.

**Wettlauf zwischen Prüfung und Ausstellung:** die Route entscheidet hier, das
Token stellt media-svc aus, und dazwischen kann auf demselben Platz ein neuer
Strom anlaufen. Deshalb nennt die Route media-svc das Gerät, für das sie das
Zusehen erlaubt hat (``geraet=<id>``), und media-svc verweigert jeden
``stream:active``-Datensatz, dessen ``device_id`` davon abweicht — die
Entscheidung fällt dort am selben Datensatz, aus dem der Pfad kommt
(``dcc_media_svc.routes._whep_fuer_zuschauer``). Ein normaler Go-Live-Strom
trägt kein Merkmal und bleibt unverändert.

## Widerruf beim Sitzungsende

Endet die Sitzung, fällt (b)/(d) weg. Die Lese-Token der übrigen Zuschauer
werden dann gelöscht und ihre WHEP-Sitzungen getrennt
(:func:`zuschauer_widerrufen`, gerufen aus ``remote_registry.remote_end``) —
derselbe Weg wie beim Bann (``stream_revoke.py``) und beim Gast-Rauswurf
(``voice_evict.kill_gast_whep_sitzungen``). Der Besitzer behält seins.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from dcc_shared.streaming import active_key, token_key
from fastapi import HTTPException, status
from sqlalchemy import select

from dcc_chat_gateway.models import Device

log = logging.getLogger(__name__)

#: Notbremse für den Widerruf, wie ``stream_revoke._MAX_SCHLUESSEL``: ein
#: Gerätestrom hat realistisch ein paar Zuschauer.
_MAX_SCHLUESSEL = 500


def _merkmal(roh: Any) -> int | None:
    """``device_id`` aus einem ``stream:active``-Datensatz, sonst ``None``."""
    if roh is None:
        return None
    try:
        daten = json.loads(roh.decode() if isinstance(roh, bytes) else roh)
    except (ValueError, TypeError, AttributeError):
        return None
    wert = daten.get("device_id") if isinstance(daten, dict) else None
    if isinstance(wert, str) and wert.isdigit():
        return int(wert)
    return None


async def geraetestrom(
    session, mgr, redis, channel_id: int, streamer_id: int, slot: int
) -> int | None:
    """Ist der Strom (Kanal, Streamer, Platz) der eines Geräts? Liefert dessen
    Kennung oder ``None``.

    Ein Redis-Fehler schlägt durch (der Aufrufer antwortet dann mit einem
    Fehler statt mit einem Token) — fail-closed, und media-svc bräuchte
    dasselbe Redis ohnehin für die Ausstellung.
    """
    if redis is not None:
        geraet = _merkmal(await redis.get(active_key(channel_id, streamer_id, slot)))
        if geraet is not None:
            return geraet
    if mgr is None:
        return None
    kandidaten = [
        d for d in mgr.device_ids_im_kanal(channel_id) if slot in mgr.device_streams(d)
    ]
    if not kandidaten:
        return None
    treffer = await session.execute(
        select(Device.id).where(Device.id.in_(kandidaten), Device.owner_user_id == streamer_id)
    )
    return next(iter(treffer.scalars()), None)


def zuschauen_erlaubt(mgr, viewer_id: int, streamer_id: int, device_id: int) -> bool:
    """(a)–(d) aus dem Modulkopf. Die Sicht auf den Kanal prüft der Aufrufer."""
    if viewer_id == streamer_id:
        return True
    if mgr is None:
        return False
    zustand, _wer = mgr.device_state(device_id)
    if zustand == "busy":
        return True
    return mgr.device_wecker(device_id) == str(viewer_id)


async def whep_geraet_pruefen(
    session, mgr, redis, *, channel_id: int, streamer_id: int, slot: int, viewer_id: int
) -> int | None:
    """Für ``GET /channels/{id}/whep``: Kennung des Geräts, wenn der Strom
    einem gehört UND der Betrachter zusehen darf; ``None`` für einen normalen
    Strom; sonst 403. Ein Redis-Fehler wird zu 503 — fail-closed, nie ein Token
    auf Verdacht. Die Sicht auf den Kanal hat die Route schon geprüft."""
    try:
        geraet = await geraetestrom(session, mgr, redis, channel_id, streamer_id, slot)
    except Exception as exc:  # noqa: BLE001
        log.warning("device stream check failed: %s", exc)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="stream state unavailable"
        ) from exc
    if geraet is not None and not zuschauen_erlaubt(mgr, viewer_id, streamer_id, geraet):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="device stream: only while someone controls it"
        )
    return geraet


async def geraet_fuer_stream_token(session, device_id: int, owner_id: int, channel_id: int) -> bool:
    """Darf ``owner_id`` seinen Strom in ``channel_id`` als den des Geräts
    ``device_id`` ausweisen? Nur für das eigene Gerät an seinem Standplatz —
    sonst könnte jemand ein fremdes Gerät nennen oder das Merkmal an einen
    Kanal heften, in dem das Gerät nicht steht."""
    device = await session.get(Device, device_id)
    return (
        device is not None
        and device.owner_user_id == owner_id
        and device.channel_id == channel_id
    )


async def zuschauer_widerrufen(
    redis, *, channel_id: int, owner_id: int, device_id: int, slots: set[int]
) -> list[str]:
    """Lese-Token aller Zuschauer AUSSER dem Besitzer für die Plätze dieses
    Geräts löschen. Liefert die Token-Werte (zum Trennen der laufenden
    WHEP-Sitzungen), best-effort: Redis-Fehler werden protokolliert.

    Als Gerätestrom zählt ein Platz, den das Register für dieses Gerät führt
    (``slots``) oder dessen ``stream:active``-Datensatz das Merkmal dieses
    Geräts trägt. Andere Plätze des Besitzers (sein eigener Go-Live) bleiben
    unberührt.
    """
    if redis is None:
        return []
    muster = f"stream:read-cache:*:{channel_id}:{owner_id}:*"
    try:
        treffer: list[tuple[bytes | str, int]] = []
        async for key in redis.scan_iter(match=muster, count=100):
            text = key.decode() if isinstance(key, bytes) else key
            teile = text.split(":")
            if len(teile) != 6 or teile[3] != str(channel_id) or teile[4] != str(owner_id):
                continue
            if teile[2] == str(owner_id) or not teile[5].isdigit():
                continue
            treffer.append((key, int(teile[5])))
            if len(treffer) >= _MAX_SCHLUESSEL:
                log.warning("geraet_zuschauer_widerruf_limit device=%s", device_id)
                break
        geraete_plaetze = set(slots)
        for platz in {p for _k, p in treffer} - geraete_plaetze:
            if _merkmal(await redis.get(active_key(channel_id, owner_id, platz))) == device_id:
                geraete_plaetze.add(platz)
        schluessel = [k for k, p in treffer if p in geraete_plaetze]
        if not schluessel:
            return []
        werte = [
            w.decode() if isinstance(w, bytes) else w
            for w in await redis.mget(schluessel)
            if w
        ]
        await redis.delete(*schluessel, *(token_key(w) for w in werte))
    except Exception:  # noqa: BLE001 — ein Sitzungsende darf an Redis nicht hängen
        log.warning("geraet_zuschauer_widerruf_fehlgeschlagen device=%s", device_id, exc_info=True)
        return []
    log.info("geraet_zuschauer_widerrufen device=%s token=%d", device_id, len(werte))
    return werte


#: Laufende Trenn-Aufträge an media-svc — gehalten, damit der Garbage
#: Collector sie nicht mitten im Lauf einsammelt.
_trennen_laufend: set[Any] = set()


async def nach_geraetesitzung(mgr, sess) -> None:
    """Aufräumen, wenn eine Sitzung endet, die einem Gerät galt.

    Gerufen aus ``remote_registry.remote_end`` und ``remote_end_if_pending``
    (Absage/Zeitablauf). Der Wecker-Merker fällt immer (R3c: „gelöscht bei
    Sitzungsende"); die Zuschauer werden nur nach einer ZUSTANDE GEKOMMENEN
    Sitzung widerrufen — vorher durfte ausser Besitzer und Wecker niemand
    zusehen. Das Trennen der laufenden WHEP-Sitzungen geht als eigener Auftrag
    hinaus: ein Ende darf nicht an einem HTTP-Ruf an media-svc hängen.
    """
    if sess.device_id is None:
        return
    device_id = int(sess.device_id)
    loeschen = getattr(mgr, "device_wecker_loeschen", None)
    if loeschen is not None:
        loeschen(device_id)
    if sess.state != "active":
        return
    plaetze = getattr(mgr, "device_streams", None)
    werte = await zuschauer_widerrufen(
        getattr(mgr, "_redis", None),
        channel_id=int(sess.channel_id),
        owner_id=int(sess.host_user_id),
        device_id=device_id,
        slots=set(plaetze(device_id)) if plaetze is not None else set(),
    )
    if werte:
        from dcc_chat_gateway.voice_evict import kill_gast_whep_sitzungen  # noqa: PLC0415

        auftrag = asyncio.create_task(kill_gast_whep_sitzungen(werte))
        _trennen_laufend.add(auftrag)
        auftrag.add_done_callback(_trennen_laufend.discard)
