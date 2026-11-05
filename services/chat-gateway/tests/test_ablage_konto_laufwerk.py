"""Das Konto-Laufwerk widerrufen — ``DELETE /ablage/archiv/laufwerk``.

**Die Fehlerklasse, gegen die diese Datei steht, ist wieder der stille
Fehlschlag**, diesmal in seiner unangenehmsten Form: ein Trennen, das nur
lokal wirkt. Der Zwei-Browser-Nachweis
(``web/tests/e2e/e2e-anhang-archiv-hetzner.spec.ts``) hat am 2026-09-01
gemessen, dass das Gegenueber nach dem Trennen weiter einen Anhang-Knopf
sah: die Adresse blieb serverseitig stehen, die Bereitschafts-Auskunft
meldete weiter „kann empfangen", und die Verteilung haette in einen Ordner
geschrieben, den der Nutzer abgehaengt hat.

Der letzte Test hier ist deshalb der wichtigste — er prueft nicht den
Statuscode der Loeschroute, sondern die Auskunft, die daran haengt.
"""

from __future__ import annotations

import random

import pytest

from dcc_chat_gateway.models import AblageKontoLaufwerk

pytestmark = pytest.mark.usefixtures("cloud_mode")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _laufwerk_setzen(client, token: str, adresse: str) -> None:
    antwort = await client.put(
        "/ablage/archiv/laufwerk",
        json={"freigabe_adresse": adresse},
        headers=_auth(token),
    )
    assert antwort.status_code == 204, antwort.text


async def _zeile(session_factory, user_id: int) -> AblageKontoLaufwerk | None:
    async with session_factory() as s:
        return await s.get(AblageKontoLaufwerk, user_id)


@pytest.mark.asyncio
async def test_loeschen_nimmt_die_adresse_weg(client, session_factory, _auth_signer):
    token, uid = await _register(_auth_signer)
    await _laufwerk_setzen(client, token, "https://wolke.example/abc")
    assert await _zeile(session_factory, uid) is not None

    antwort = await client.delete("/ablage/archiv/laufwerk", headers=_auth(token))

    assert antwort.status_code == 204, antwort.text
    assert await _zeile(session_factory, uid) is None


@pytest.mark.asyncio
async def test_ohne_hinterlegte_adresse_ist_das_loeschen_erfolgreich(client, _auth_signer):
    """Idempotent — s. Docstring der Route.

    Der Klient bricht sein Trennen ab, wenn der Server nicht quittiert. Ein
    404 fuer „war ohnehin schon weg" liesse ihn genau dort haengen, ohne
    dass es etwas zu heilen gaebe.
    """
    token, _uid = await _register(_auth_signer)

    antwort = await client.delete("/ablage/archiv/laufwerk", headers=_auth(token))

    assert antwort.status_code == 204, antwort.text


@pytest.mark.asyncio
async def test_danach_gibt_es_nichts_mehr_abzurufen(client, _auth_signer):
    """Die Folgeroute faellt auf 404 zurueck — nicht auf einen 502 gegen die
    inzwischen widerrufene Freigabe."""
    token, _uid = await _register(_auth_signer)
    await _laufwerk_setzen(client, token, "https://wolke.example/abc")
    await client.delete("/ablage/archiv/laufwerk", headers=_auth(token))

    antwort = await client.get("/ablage/archiv/liste", headers=_auth(token))

    assert antwort.status_code == 404, antwort.text


@pytest.mark.asyncio
async def test_es_trifft_nur_das_eigene_konto(client, session_factory, _auth_signer):
    """Der Primaerschluessel ist die eigene Nutzer-Id — geprueft, nicht
    angenommen: eine Loeschung ohne ``WHERE`` faellt nur hier auf."""
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await _laufwerk_setzen(client, token_a, "https://wolke.example/a")
    await _laufwerk_setzen(client, token_b, "https://wolke.example/b")

    await client.delete("/ablage/archiv/laufwerk", headers=_auth(token_a))

    assert await _zeile(session_factory, uid_a) is None
    assert await _zeile(session_factory, uid_b) is not None


@pytest.mark.asyncio
async def test_ohne_anmeldung_wird_nichts_geloescht(client, session_factory, _auth_signer):
    token, uid = await _register(_auth_signer)
    await _laufwerk_setzen(client, token, "https://wolke.example/abc")

    antwort = await client.delete("/ablage/archiv/laufwerk")

    assert antwort.status_code == 401, antwort.text
    assert await _zeile(session_factory, uid) is not None


@pytest.mark.asyncio
async def test_die_bereitschaft_faellt_mit(client, _auth_signer, friend_pair):
    """**Der eigentliche Befund.**

    Nach dem Trennen muss das Gespraech als „kann keine Anhaenge tragen"
    gelten, und die Auskunft muss den Verursacher benennen — sonst zeigt die
    Gegenseite weiter einen Anhang-Knopf, dessen Verteilung (Alles-oder-
    nichts) am ersten Ziel scheitert.
    """
    token_a, uid_a = await _register(_auth_signer)
    token_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    for token in (token_a, token_b):
        await _laufwerk_setzen(client, token, "https://wolke.example/x")

    erstellt = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=_auth(token_a)
    )
    assert erstellt.status_code == 201, erstellt.text
    kanal = erstellt.json()["id"]

    vorher = await client.get(
        "/postfach/anhaenge/bereitschaft",
        params={"channel_id": kanal},
        headers=_auth(token_a),
    )
    assert vorher.status_code == 200, vorher.text
    assert vorher.json()["moeglich"] is True

    await client.delete("/ablage/archiv/laufwerk", headers=_auth(token_b))

    nachher = await client.get(
        "/postfach/anhaenge/bereitschaft",
        params={"channel_id": kanal},
        headers=_auth(token_a),
    )
    assert nachher.status_code == 200, nachher.text
    assert nachher.json()["moeglich"] is False
    assert nachher.json()["ohne_laufwerk"] == [str(uid_b)]


# ---------------------------------------------------------------------------
# Gegenprüfung des Security-Audits (2026-11-05): kein offener Proxy mehr
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_eine_adresse_ohne_bestandene_probe_wird_nicht_gespeichert(
    client, session_factory, _auth_signer, monkeypatch
):
    """Eine beliebige Webseite als „Laufwerk" machte den Server zum offenen
    HTTP-Proxy. Was die Verbindungsprobe nicht besteht, wird nicht gespeichert."""
    from dcc_chat_gateway import ablage_probe, laufwerk_bestaetigung

    async def _gescheitert(**_kw):
        return ablage_probe.ProbeErgebnis(False, "schreiben", "status_405")

    monkeypatch.setattr(laufwerk_bestaetigung, "_probiere", _gescheitert)
    token, uid = await _register(_auth_signer)
    r = await client.put(
        "/ablage/archiv/laufwerk",
        json={"freigabe_adresse": "https://eine-beliebige-seite.example/"},
        headers=_auth(token),
    )
    assert r.status_code == 400, r.text
    assert "drive probe failed" in r.json()["detail"]
    assert await _zeile(session_factory, uid) is None


@pytest.mark.asyncio
async def test_eine_unveraenderte_adresse_wird_nicht_erneut_geprobt(
    client, _auth_signer, monkeypatch
):
    """Der Klient trägt die gemerkte Adresse selbsttätig nach — jedes Mal eine
    Probedatei zu schreiben, wäre Last ohne Erkenntnis."""
    from dcc_chat_gateway import ablage_probe, laufwerk_bestaetigung

    aufrufe: list[str] = []

    async def _zaehlend(**kw):
        aufrufe.append(kw["freigabe_adresse"])
        return ablage_probe.ProbeErgebnis(True)

    monkeypatch.setattr(laufwerk_bestaetigung, "_probiere", _zaehlend)
    token, _ = await _register(_auth_signer)
    for _ in range(2):
        await _laufwerk_setzen(client, token, "https://cloud.example/s/abc")
    await _laufwerk_setzen(client, token, "https://cloud.example/s/neu")
    assert aufrufe == ["https://cloud.example/s/abc", "https://cloud.example/s/neu"]


def _webdav_nachstellen(monkeypatch, *, schreibbar: bool = True) -> dict[str, bytes]:
    """Ein öffentliches WebDAV-Laufwerk unter ``cloud.example`` (öffentliche
    Doku-IP), über die Namen, die `ablage_ssrf` und `ablage_schreiben` für
    Client und Namensauflösung benutzen. Gibt die abgelegten Dateien zurück."""
    import httpx

    from dcc_chat_gateway import ablage_schreiben, ablage_ssrf

    dateien: dict[str, bytes] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        pfad = request.url.path
        if request.method == "PUT":
            if not schreibbar:
                return httpx.Response(405)
            dateien[pfad] = request.content
            return httpx.Response(201)
        if request.method == "GET":
            if pfad not in dateien:
                return httpx.Response(404)
            return httpx.Response(200, content=dateien[pfad])
        if request.method == "DELETE":
            dateien.pop(pfad, None)
            return httpx.Response(204)
        return httpx.Response(405)

    def _ctor(*args, **kwargs):
        kwargs.pop("transport", None)
        return httpx.AsyncClient(*args, transport=httpx.MockTransport(handler), **kwargs)

    async def _resolver(host: str) -> list[str]:
        return {"cloud.example": ["203.0.113.10"]}[host]

    for modul in (ablage_ssrf, ablage_schreiben):
        monkeypatch.setattr(modul, "client_ctor", _ctor)
        monkeypatch.setattr(modul, "standard_resolver", _resolver)
    return dateien


def _echte_probe(monkeypatch) -> None:
    from dcc_chat_gateway import laufwerk_bestaetigung

    monkeypatch.setattr(
        laufwerk_bestaetigung, "_probiere", laufwerk_bestaetigung._ueber_die_echten_wege
    )


@pytest.mark.asyncio
async def test_die_webdav_basis_des_archivs_besteht_die_probe(
    client, session_factory, _auth_signer, monkeypatch
):
    """Regressionstest: das Archiv speichert die WebDAV-Basis
    (`…/public.php/dav/files/<token>`), keinen Freigabe-Link. Die erste Fassung
    der Probe nahm nur Freigabe-Links an, und jede neue Archiv-Verbindung
    scheiterte. Die Probe läuft über dieselben Wege wie das Archiv selbst und
    lässt keine Probedatei zurück."""
    dateien = _webdav_nachstellen(monkeypatch)
    _echte_probe(monkeypatch)
    token, uid = await _register(_auth_signer)
    adresse = "https://cloud.example/public.php/dav/files/AbCdEf123"
    await _laufwerk_setzen(client, token, adresse)
    assert (await _zeile(session_factory, uid)).freigabe_adresse == adresse
    assert dateien == {}


@pytest.mark.asyncio
async def test_eine_nicht_beschreibbare_seite_besteht_die_probe_nicht(
    client, session_factory, _auth_signer, monkeypatch
):
    _webdav_nachstellen(monkeypatch, schreibbar=False)
    _echte_probe(monkeypatch)
    token, uid = await _register(_auth_signer)
    r = await client.put(
        "/ablage/archiv/laufwerk",
        json={"freigabe_adresse": "https://cloud.example/irgendeine-seite"},
        headers=_auth(token),
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"].startswith("drive probe failed: schreiben/")
    assert await _zeile(session_factory, uid) is None


@pytest.mark.asyncio
async def test_eine_adresse_ohne_https_wird_abgewiesen(client, session_factory, _auth_signer):
    """Bei http:// könnte der Name nach der Probe auf eine fremde IP umgebogen
    werden (DNS-Rebinding); mit TLS scheitert das am Zertifikat."""
    token, uid = await _register(_auth_signer)
    r = await client.put(
        "/ablage/archiv/laufwerk",
        json={"freigabe_adresse": "http://cloud.example/public.php/dav/files/x"},
        headers=_auth(token),
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "drive address must use https"
    assert await _zeile(session_factory, uid) is None


@pytest.mark.parametrize(
    "adresse",
    [
        "https://cloud.example/public.php/dav/files/x?weiter=1",
        "https://cloud.example/public.php/dav/files/x#teil",
        "https://nutzer:geheim@cloud.example/public.php/dav/files/x",
        "https://cloud.example:99999/public.php/dav/files/x",
    ],
)
@pytest.mark.asyncio
async def test_query_fragment_zugangsdaten_und_kaputter_port_werden_abgewiesen(
    client, session_factory, _auth_signer, adresse
):
    """Die Basis wird stumpf um Pfadsegmente verlängert — eine Query oder ein
    Fragment schöbe den Pfad dorthin, Zugangsdaten prüft niemand."""
    token, uid = await _register(_auth_signer)
    r = await client.put(
        "/ablage/archiv/laufwerk", json={"freigabe_adresse": adresse}, headers=_auth(token)
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "invalid drive address"
    assert await _zeile(session_factory, uid) is None
