"""Nachweis, dass unter einer Adresse wirklich der anfragende Server läuft.

Die Cloud ruft ``https://<adresse>/.well-known/pulse-verbinden`` ab und
erwartet dort den SHA-256 der Abholkennung (Spec 2026-10-09, E2). Jeder
Befund führt beim Betreiber zu einem anderen Handgriff — deshalb trennen die
Tests sie einzeln.
"""

from __future__ import annotations

import asyncio
import hashlib
import ssl

import httpx
import pytest

from dcc_auth import verbinden_nachweis as vn
from dcc_auth.selfhost_probe import Schritt
from dcc_auth.selfhost_probe_dienst import Ziel

_ERWARTET = hashlib.sha256(b"kennung").hexdigest()


def _ziel() -> Ziel:
    return Ziel("pulse.example.com", "203.0.113.7")


def _klient(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


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
    async def dns(_host):
        return Schritt("dns", False, "zeigt_ins_private_netz", "10.0.0.5")

    def darf_nicht():
        raise AssertionError("kein HTTP-Aufruf ohne geprüfte Adresse")

    monkeypatch.setattr(vn, "pruefe_dns", dns)
    monkeypatch.setattr(vn, "_klient", darf_nicht)
    assert await vn.nachweis_pruefen("pulse.example.com", _ERWARTET) == "nicht_erreichbar"


async def test_ganzer_weg_ueber_die_aufgeloeste_adresse(monkeypatch):
    async def dns(_host):
        return Schritt("dns", True, "aufgeloest", adressen=["203.0.113.7"])

    gesehen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        gesehen.append(str(request.url))
        return httpx.Response(200, json={"nachweis": _ERWARTET})

    monkeypatch.setattr(vn, "pruefe_dns", dns)
    monkeypatch.setattr(vn, "_klient", lambda: _klient(handler))
    assert await vn.nachweis_pruefen("pulse.example.com", _ERWARTET) is None
    assert gesehen == ["https://203.0.113.7/.well-known/pulse-verbinden"]
