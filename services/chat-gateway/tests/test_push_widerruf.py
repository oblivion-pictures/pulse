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

from dcc_chat_gateway.models import FcmToken, VoipToken
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
async def test_meldung_ueber_redis_loescht_die_zeilen(app, client, session_factory, _auth_signer):
    uid = random.randint(40_000_001, 50_000_000)
    await _anmelden(client, _auth_signer, uid, "verloren", "kette-x")
    text = nachricht(user_id=uid, ketten=["kette-x"])
    assert text is not None
    await app.state.redis.publish(KANAL, text)
    for _ in range(50):
        if (await _geraete(session_factory, uid))["fcm_tokens"] == []:
            break
        await asyncio.sleep(0.05)
    assert await _geraete(session_factory, uid) == {"fcm_tokens": [], "voip_tokens": []}
