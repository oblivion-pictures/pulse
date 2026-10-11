"""Nachweis, dass unter einer Adresse wirklich der anfragende Server läuft.

Die Cloud ruft ``https://<adresse>/.well-known/pulse-verbinden`` ab und
erwartet dort den SHA-256 der Abholkennung (Spec 2026-10-09, E2). Jeder
Befund führt beim Betreiber zu einem anderen Handgriff — deshalb trennen die
Tests sie einzeln.
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import inspect
import ssl
import tracemalloc

import httpx
import pytest

from dcc_auth import verbinden_nachweis as vn
from dcc_auth.selfhost_probe import Schritt
from dcc_auth.selfhost_probe_dienst import Ziel

_ERWARTET = hashlib.sha256(b"kennung").hexdigest()


def _ziel() -> Ziel:
    return Ziel("pulse.example.com", "203.0.113.7")


class _Stuecke(httpx.AsyncByteStream):
    """Antwortkörper in festen Stücken, so wie httpcore ihn vom Netz liest;
    zählt mit, wie viel davon die Cloud tatsächlich abgeholt hat."""

    def __init__(self, stuecke: list[bytes]) -> None:
        self._stuecke = stuecke
        self.abgeholt = 0

    async def __aiter__(self):
        for stueck in self._stuecke:
            self.abgeholt += len(stueck)
            yield stueck


def _klient(handler) -> httpx.AsyncClient:
    async def als_strom(request: httpx.Request) -> httpx.Response:
        antwort = handler(request)
        if inspect.isawaitable(antwort):
            antwort = await antwort
        if not antwort.is_stream_consumed:
            return antwort
        # ``httpx.Response(content=…)`` liest den Körper schon im Konstruktor;
        # ein echter Transport liefert ihn dagegen als ungelesenen Strom, und
        # genau den liest ``nachweis_lesen`` roh. Also wie das Netz ausliefern.
        return httpx.Response(
            antwort.status_code, headers=antwort.headers, stream=_Stuecke([antwort.content])
        )

    return httpx.AsyncClient(transport=httpx.MockTransport(als_strom))


def _antwort(antwort: httpx.Response):
    def handler(_request: httpx.Request) -> httpx.Response:
        return antwort

    return handler


async def _lesen(handler) -> str | None:
    async with _klient(handler) as klient:
        return await vn.nachweis_lesen(klient, _ziel(), _ERWARTET)


async def test_passender_nachweis_ist_in_ordnung():
    gesehen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        gesehen.append(request)
        return httpx.Response(200, json={"nachweis": _ERWARTET})

    assert await _lesen(handler) is None
    # Die Anfrage geht an die geprüfte IP, der Name reist im Host-Kopf: sonst
    # löste httpx den Namen ein zweites Mal auf (selfhost_probe_dienst.Ziel).
    (anfrage,) = gesehen
    assert str(anfrage.url) == "https://203.0.113.7/.well-known/pulse-verbinden"
    assert anfrage.headers["host"] == "pulse.example.com"


async def test_grossbuchstaben_und_leerraum_stoeren_nicht():
    handler = _antwort(httpx.Response(200, json={"nachweis": f" {_ERWARTET.upper()}\n"}))
    assert await _lesen(handler) is None


async def test_anderer_wert():
    andere = hashlib.sha256(b"andere").hexdigest()
    assert await _lesen(_antwort(httpx.Response(200, json={"nachweis": andere}))) == (
        "falscher_wert"
    )


@pytest.mark.parametrize(
    "antwort",
    [
        httpx.Response(404, json={"detail": "Not Found"}),
        httpx.Response(301, headers={"Location": "https://anderswo.example.com/"}),
        # Der SPA-Rückfall eines fremden Proxys: 200, aber HTML.
        httpx.Response(200, text="<!doctype html><title>Pulse</title>"),
        httpx.Response(200, json=["kein", "objekt"]),
        httpx.Response(200, json={"nachweis": 42}),
        httpx.Response(200, json={"nachweis": "zu-kurz"}),
        httpx.Response(200, content=b'{"nachweis": "' + b"a" * 5000 + b'"}'),
        # Ein sonst gültiger Nachweis zählt nicht, wenn der Status nicht 200 ist
        # oder die Antwort über der Grössengrenze liegt: beide Schranken sind
        # nur sichtbar, wenn der Rest der Antwort in Ordnung wäre.
        httpx.Response(404, json={"nachweis": _ERWARTET}),
        httpx.Response(200, json={"nachweis": _ERWARTET, "fuellung": "x" * 5000}),
    ],
)
async def test_kein_nachweis(antwort):
    assert await _lesen(_antwort(antwort)) == "kein_nachweis"


def test_klient_folgt_keinen_weiterleitungen():
    # Eine Weiterleitung ins Innere der Cloud umginge die geprüfte Adresse.
    assert vn._klient().follow_redirects is False


async def test_anfrage_verbittet_sich_jede_kompression():
    gesehen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        gesehen.append(request)
        return httpx.Response(200, json={"nachweis": _ERWARTET})

    assert await _lesen(handler) is None
    # httpx schickt von sich aus "gzip, deflate"; der Unbekannte soll gar nicht
    # erst die Wahl haben, die Grössengrenze durch Entpacken zu umgehen.
    (anfrage,) = gesehen
    assert anfrage.headers["accept-encoding"] == "identity"


async def test_komprimierte_antwort_gilt_nicht():
    # Auch wenn der Server trotz "identity" komprimiert: gelesen wird, was auf
    # der Leitung liegt, und das ist kein JSON.
    gepackt = gzip.compress(b'{"nachweis": "' + _ERWARTET.encode() + b'"}')
    antwort = httpx.Response(200, headers={"Content-Encoding": "gzip"}, stream=_Stuecke([gepackt]))
    assert await _lesen(_antwort(antwort)) == "kein_nachweis"


async def test_gzip_bombe_wird_nicht_entpackt():
    # 64 MiB Nullen packen auf rund 64 KiB. Entpackte die Cloud jedes Stück,
    # das sie liest, hätte das erste (16 KiB gepackt, rund 16 MiB entpackt)
    # den Speicher schon gefüllt, ehe die Grössengrenze greift.
    gepackt = gzip.compress(bytes(64 * 1024 * 1024), compresslevel=9)
    stuecke = [gepackt[i : i + 16384] for i in range(0, len(gepackt), 16384)]
    koerper = _Stuecke(stuecke)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"Content-Encoding": "gzip"}, stream=koerper)

    tracemalloc.start()
    try:
        befund = await _lesen(handler)
        _, spitze = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert befund == "kein_nachweis"
    # Gelesen wird bis über die Grenze und dann nicht weiter: höchstens die
    # 4 KiB plus das Stück, das sie überschritten hat.
    assert koerper.abgeholt <= vn._HOECHSTENS_BYTES + 16384
    assert spitze < 1024 * 1024, f"Speicherspitze {spitze / 1024 / 1024:.1f} MiB"


async def test_zertifikat_wird_erkannt():
    def handler(request: httpx.Request) -> httpx.Response:
        try:
            raise ssl.SSLCertVerificationError(1, "certificate verify failed")
        except ssl.SSLCertVerificationError as exc:
            raise httpx.ConnectError(
                "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed",
                request=request,
            ) from exc

    assert await _lesen(handler) == "zertifikat"


async def test_verbindungsfehler_heisst_nicht_erreichbar():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=request)

    assert await _lesen(handler) == "nicht_erreichbar"


async def test_frist(monkeypatch):
    monkeypatch.setattr(vn, "FRIST_S", 0.05)

    async def handler(_request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(1)
        return httpx.Response(200, json={"nachweis": _ERWARTET})

    assert await _lesen(handler) == "nicht_erreichbar"


async def test_adresse_im_privaten_netz_wird_nie_abgefragt(monkeypatch):
    async def dns(_host, *, ausfuehrer):
        return Schritt("dns", False, "zeigt_ins_private_netz", "10.0.0.5")

    def darf_nicht():
        raise AssertionError("kein HTTP-Aufruf ohne geprüfte Adresse")

    monkeypatch.setattr(vn, "pruefe_dns", dns)
    monkeypatch.setattr(vn, "_klient", darf_nicht)
    assert await vn.nachweis_pruefen("pulse.example.com", _ERWARTET) == "nicht_erreichbar"


async def test_ganzer_weg_ueber_die_aufgeloeste_adresse(monkeypatch):
    async def dns(_host, *, ausfuehrer):
        return Schritt("dns", True, "aufgeloest", adressen=["203.0.113.7"])

    gesehen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        gesehen.append(str(request.url))
        return httpx.Response(200, json={"nachweis": _ERWARTET})

    monkeypatch.setattr(vn, "pruefe_dns", dns)
    monkeypatch.setattr(vn, "_klient", lambda: _klient(handler))
    assert await vn.nachweis_pruefen("pulse.example.com", _ERWARTET) is None
    assert gesehen == ["https://203.0.113.7/.well-known/pulse-verbinden"]


# ---------------------------------------------------------------------------
# server_info_instanz — wer antwortet unter der Adresse? (Widerspruchsfrist, E2)
# ---------------------------------------------------------------------------


async def _instanz_unter(monkeypatch, handler) -> str | None:
    async def dns(_host, *, ausfuehrer):
        return Schritt("dns", True, "aufgeloest", adressen=["203.0.113.7"])

    monkeypatch.setattr(vn, "pruefe_dns", dns)
    monkeypatch.setattr(vn, "_klient", lambda: _klient(handler))
    return await vn.server_info_instanz("pulse.example.com")


async def test_server_info_meldet_die_nummer(monkeypatch):
    gesehen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        gesehen.append(request)
        return httpx.Response(
            200,
            json={"server_version": "0.8.0", "instance_id": "961000", "capabilities": []},
        )

    assert await _instanz_unter(monkeypatch, handler) == "961000"
    # Derselbe abgesicherte Weg wie beim Nachweis: an die geprüfte IP, der Name
    # im Host-Kopf, ohne Kompression.
    (anfrage,) = gesehen
    assert str(anfrage.url) == "https://203.0.113.7/.well-known/pulse-server-info"
    assert anfrage.headers["host"] == "pulse.example.com"
    assert anfrage.headers["accept-encoding"] == "identity"


@pytest.mark.parametrize(
    "antwort",
    [
        # Ein unverbundener Server oder die Cloud selbst.
        httpx.Response(200, json={"instance_id": None}),
        httpx.Response(200, json={"instance_id": 961000}),
        httpx.Response(200, json={"server_version": "0.8.0"}),
        httpx.Response(200, json=["961000"]),
        httpx.Response(301, headers={"Location": "https://anderswo.example.com/"}),
        httpx.Response(404, json={"instance_id": "961000"}),
        httpx.Response(200, text="<!doctype html><title>Pulse</title>"),
        httpx.Response(200, json={"instance_id": "961000", "fuellung": "x" * 5000}),
        httpx.Response(
            200,
            headers={"Content-Encoding": "gzip"},
            stream=_Stuecke([gzip.compress(b'{"instance_id": "961000"}')]),
        ),
    ],
)
async def test_server_info_ohne_beleg(monkeypatch, antwort):
    assert await _instanz_unter(monkeypatch, _antwort(antwort)) is None


async def test_server_info_nicht_erreichbar(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=request)

    assert await _instanz_unter(monkeypatch, handler) is None


async def test_server_info_frist(monkeypatch):
    monkeypatch.setattr(vn, "FRIST_S", 0.05)

    async def handler(_request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(1)
        return httpx.Response(200, json={"instance_id": "961000"})

    assert await _instanz_unter(monkeypatch, handler) is None


async def test_server_info_im_privaten_netz_wird_nie_abgefragt(monkeypatch):
    async def dns(_host, *, ausfuehrer):
        return Schritt("dns", False, "zeigt_ins_private_netz", "10.0.0.5")

    def darf_nicht():
        raise AssertionError("kein HTTP-Aufruf ohne geprüfte Adresse")

    monkeypatch.setattr(vn, "pruefe_dns", dns)
    monkeypatch.setattr(vn, "_klient", darf_nicht)
    assert await vn.server_info_instanz("pulse.example.com") is None
