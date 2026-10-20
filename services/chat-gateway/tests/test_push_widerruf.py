"""Gerätetoken enden mit ihrer Anmelde-Kette (iOS-Bughunt 2, C2).

Ein verlorenes Telefon, dessen Sitzung widerrufen wurde, zeigte weiter Banner
und klingelte: seine FCM- und PushKit-Token blieben stehen. Seitdem merkt sich
die Anmeldung die Kette aus dem Zugriffs-Token, und auth-svc meldet jedes
Kettenende (``dcc_shared.anmeldeketten``) — hier: Ablegen und Löschen, und der
Weg über Redis bis in die Tabellen.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from dcc_shared.anmeldeketten import KANAL, KettenEnde, nachricht
from sqlalchemy import select

from dcc_chat_gateway.models import FcmToken, VoipToken, WebPushSubscription
from dcc_chat_gateway.push_widerruf import geraetetoken_loeschen


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _anmelden(client, _auth_signer, uid: int, geraet: str, kette: str | None) -> None:
    token = _auth_signer.issue_access(uid, f"u{uid}", kette=kette)
    for weg in ("fcm", "voip"):
        r = await client.post(
            f"/{weg}/token",
            json={"token": f"{weg}-{uid}-{geraet}", "geraet_id": geraet},
            headers=_auth(token),
        )
        assert r.status_code == 204, r.text


async def _geraete(session_factory, uid: int) -> dict[str, list[str]]:
    async with session_factory() as s:
        ergebnis: dict[str, list[str]] = {}
        for modell in (FcmToken, VoipToken):
            zeilen = await s.execute(
                select(modell.geraet_id, modell.kette)
                .where(modell.user_id == uid)
                .order_by(modell.geraet_id)
            )
            ergebnis[modell.__tablename__] = [f"{g}:{k}" for g, k in zeilen.all()]
        return ergebnis


@pytest.mark.asyncio
async def test_anmeldung_merkt_sich_die_kette(client, session_factory, _auth_signer):
    uid = random.randint(10_000_000, 20_000_000)
    await _anmelden(client, _auth_signer, uid, "handy", "kette-1")
    await _anmelden(client, _auth_signer, uid, "alt", None)
    assert await _geraete(session_factory, uid) == {
        "fcm_tokens": ["alt:None", "handy:kette-1"],
        "voip_tokens": ["alt:None", "handy:kette-1"],
    }
    # Neu angemeldet unter einer neuen Kette: die jüngste gewinnt.
    await _anmelden(client, _auth_signer, uid, "handy", "kette-2")
    assert (await _geraete(session_factory, uid))["fcm_tokens"] == ["alt:None", "handy:kette-2"]


@pytest.mark.asyncio
async def test_kettenende_trifft_nur_diese_kette(client, session_factory, _auth_signer):
    uid = random.randint(20_000_001, 30_000_000)
    await _anmelden(client, _auth_signer, uid, "verloren", "kette-weg")
    await _anmelden(client, _auth_signer, uid, "behalten", "kette-bleibt")
    await _anmelden(client, _auth_signer, uid, "alt", None)
    async with session_factory() as s:
        n = await geraetetoken_loeschen(s, KettenEnde(uid, frozenset({"kette-weg"})))
    assert n == 2
    assert await _geraete(session_factory, uid) == {
        "fcm_tokens": ["alt:None", "behalten:kette-bleibt"],
        "voip_tokens": ["alt:None", "behalten:kette-bleibt"],
    }


@pytest.mark.asyncio
async def test_ende_aller_ketten_trifft_auch_zeilen_ohne_vermerk(
    client, session_factory, _auth_signer
):
    uid = random.randint(30_000_001, 40_000_000)
    fremd = uid + 1
    await _anmelden(client, _auth_signer, uid, "a", "kette-a")
    await _anmelden(client, _auth_signer, uid, "alt", None)
    await _anmelden(client, _auth_signer, fremd, "a", "kette-a")
    async with session_factory() as s:
        await geraetetoken_loeschen(s, KettenEnde(uid, frozenset(), alle=True))
    assert await _geraete(session_factory, uid) == {"fcm_tokens": [], "voip_tokens": []}
    # Ein anderes Konto bleibt unberührt — auch bei gleichlautender Kette.
    assert (await _geraete(session_factory, fremd))["fcm_tokens"] == ["a:kette-a"]


@pytest.mark.asyncio
async def test_meldung_ueber_redis_loescht_die_zeilen(
    app, client, session_factory, _auth_signer, caplog
):
    uid = random.randint(40_000_001, 50_000_000)
    await _anmelden(client, _auth_signer, uid, "verloren", "kette-x")
    text = nachricht(user_id=uid, ketten=["kette-x"])
    assert text is not None
    caplog.set_level("WARNING", logger="dcc_chat_gateway.push_widerruf")
    await app.state.redis.publish(KANAL, text)
    # Auf die Log-Zeile des Handlers warten, NICHT die Tabelle abfragen: die
    # Test-Datenbank hängt an EINER geteilten Verbindung (``StaticPool``), und
    # eine Lese-Sitzung, die sich schliesst, kann dabei die noch offene
    # Transaktion des Handlers zurückrollen. Beobachtet, seit er drei Tabellen
    # löscht: der Handler meldete gelöschte Zeilen, die Tabelle hatte sie noch.
    for _ in range(100):
        if f"user={uid}" in caplog.text:
            break
        await asyncio.sleep(0.05)
    assert await _geraete(session_factory, uid) == {"fcm_tokens": [], "voip_tokens": []}


async def _web_abo(session_factory, uid: int, endpunkt: str, kette: str | None) -> None:
    async with session_factory() as s:
        s.add(
            WebPushSubscription(
                id=random.randint(1, 2**62), user_id=uid, endpoint=endpunkt,
                p256dh="p", auth_secret="a", kette=kette,
            )
        )
        await s.commit()


async def _web_abos(session_factory, uid: int) -> list[str]:
    async with session_factory() as s:
        zeilen = await s.execute(
            select(WebPushSubscription.endpoint)
            .where(WebPushSubscription.user_id == uid)
            .order_by(WebPushSubscription.endpoint)
        )
        return list(zeilen.scalars())


@pytest.mark.asyncio
async def test_kettenende_trifft_auch_web_push_abos(client, session_factory, _auth_signer):
    """Push-Bughunt 2026-10-20: ein Browser, dessen Sitzung beendet wurde,
    zeigte weiter Mitteilungen — sein Abo kannte keine Kette (Migration 0108)."""
    uid = random.randint(50_000_001, 60_000_000)
    await _web_abo(session_factory, uid, "https://a.example/weg", "kette-weg")
    await _web_abo(session_factory, uid, "https://a.example/bleibt", "kette-bleibt")
    await _web_abo(session_factory, uid, "https://a.example/alt", None)
    async with session_factory() as s:
        await geraetetoken_loeschen(s, KettenEnde(uid, frozenset({"kette-weg"})))
    assert await _web_abos(session_factory, uid) == [
        "https://a.example/alt", "https://a.example/bleibt"
    ]
    async with session_factory() as s:
        await geraetetoken_loeschen(s, KettenEnde(uid, frozenset(), alle=True))
    assert await _web_abos(session_factory, uid) == []
