"""Security-Scan 2026-11-04: Niemand wird ohne Zustimmung Mitglied einer Community.

``POST /guilds/{id}/members`` fügte jedes Konto per Nutzer-ID direkt hinzu —
ohne Annahme, ohne Blockade-Prüfung, ohne Bremse. In der Cloud darf jedes
Konto eine Community anlegen; zusammen mit dem Herbeiholen in einen
Sprachkanal (``voice_pull``, der Client verbindet sofort) reichte das zum
Mithören bei beliebigen Konten. Der Weg ist abgeschafft: Mitglied wird man
nur noch durch Einlösen einer Einladung (Link, Nutzername, Freundes-Karte).
"""

from __future__ import annotations

import random

import pytest
from dcc_chat_gateway.models import GuildMember


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_direktes_hinzufuegen_gibt_es_nicht_mehr(client, _auth_signer, session_factory):
    owner = random.randint(1, 1_000_000)
    t_owner = _auth_signer.issue_access(owner, f"u{owner}")
    opfer = random.randint(1_000_001, 2_000_000)
    gid = (await client.post("/guilds", json={"name": "g"}, headers=auth(t_owner))).json()["id"]

    r = await client.post(
        f"/guilds/{gid}/members", json={"user_id": str(opfer)}, headers=auth(t_owner)
    )
    assert r.status_code == 405
    async with session_factory() as s:
        assert await s.get(GuildMember, (int(gid), opfer)) is None
