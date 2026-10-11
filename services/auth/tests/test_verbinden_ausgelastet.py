"""Die Namensauflösung der anonym auslösbaren Prüfungen hat einen eigenen Pool.

``POST /selfhost/verbinden/start`` ist anonym und lässt die Cloud einen
beliebigen Namen auflösen. Im Standard-Ausführer des Loops, der auch Argon2
rechnet, könnte eine absichtlich langsame Zone ihn belegen — ``asyncio.timeout``
gibt nur das ``await`` frei, der Thread blockiert weiter. Darum: eigener,
kleiner Pool (``dns_ausfuehrer.py``), der bei Sättigung sofort abweist, und die
Routen antworten dann 503 ``verbinden_ausgelastet``.

Die Auflösung blockiert hier wirklich in einem Thread (``_getaddrinfo`` ist
ersetzt), statt dass ein ``await`` nur so täte.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import socket
import threading
import time
from types import SimpleNamespace

import httpx
import pytest

from dcc_auth import dns_ausfuehrer, selfhost_probe
from dcc_auth import verbinden_nachweis as vn
from dcc_auth.dns_ausfuehrer import Ausgelastet, BegrenzterAusfuehrer

_HOST = "mein.example.org"
_KENNUNG = "abholkennung-fuer-den-test-mit-genug-zeichen-0123"
_NACHWEIS = hashlib.sha256(_KENNUNG.encode()).hexdigest()
_OEFFENTLICH = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("203.0.113.7", 0))]
#: So viele Plätze hat der Pool der Prüfungen (``verbinden_nachweis._DNS``).
_PLAETZE = 4


async def _bis(bedingung, frist: float = 5.0) -> None:
    ende = time.monotonic() + frist
    while not bedingung():
        assert time.monotonic() < ende, "Bedingung wurde nicht wahr"
        await asyncio.sleep(0.01)


def _nichts() -> None:
    return None


async def _pool_frei() -> None:
    """Wartet, bis alle Plätze des echten Pools wieder frei sind — beobachtbar
    daran, dass vier Aufrufe gleichzeitig angenommen werden."""
    ende = time.monotonic() + 5
    while True:
        try:
            await asyncio.gather(*(vn._DNS.ausfuehren(_nichts) for _ in range(_PLAETZE)))
            return
        except Ausgelastet:
            assert time.monotonic() < ende, "Pool wird nicht frei"
            await asyncio.sleep(0.01)


@pytest.fixture
async def haengende_aufloesung(monkeypatch):
    """Jede Auflösung blockiert im Thread, bis ``stand.frei`` gesetzt wird.
    ``stand.threads`` hält die Namen der Threads, die schon drin sind."""
    stand = SimpleNamespace(frei=threading.Event(), threads=[])

    def haengt(_host: str):
        stand.threads.append(threading.current_thread().name)
        assert stand.frei.wait(10), "Der Test hat den Thread nicht freigegeben"
        return _OEFFENTLICH

    async def warten_bis_drin(anzahl: int, seit: int = 0) -> None:
        await _bis(lambda: len(stand.threads) - seit >= anzahl)

    stand.warten_bis_drin = warten_bis_drin
    monkeypatch.setattr(dns_ausfuehrer, "_getaddrinfo", haengt)
    yield stand
    stand.frei.set()
    await _pool_frei()


@pytest.fixture
async def pool_belegt(haengende_aufloesung):
    """Alle Plätze des echten Pools sind von blockierten Threads belegt."""
    laeufe = [
        asyncio.ensure_future(vn._DNS.getaddrinfo("traege.example.org")) for _ in range(_PLAETZE)
    ]
    await haengende_aufloesung.warten_bis_drin(_PLAETZE)
    yield haengende_aufloesung
    haengende_aufloesung.frei.set()
    await asyncio.gather(*laeufe)


class _Koerper(httpx.AsyncByteStream):
    """Ungelesener Antwortkörper, wie ihn ein echter Transport liefert —
    ``nachweis_lesen`` liest roh (``aiter_raw``)."""

    def __init__(self, daten: dict) -> None:
        self._roh = json.dumps(daten).encode()

    async def __aiter__(self):
        yield self._roh


def _nachweis_klient(erwartet: str = _NACHWEIS):
    def handler(request: httpx.Request) -> httpx.Response:
        daten = (
            {"instance_id": "961000"}
            if request.url.path.endswith("pulse-server-info")
            else {"nachweis": erwartet}
        )
        return httpx.Response(200, stream=_Koerper(daten))

    return lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))


# ---------------------------------------------------------------------------
# Der Pool selbst
# ---------------------------------------------------------------------------


async def test_aufloesung_laeuft_im_eigenen_pool_und_nicht_im_standard_ausfuehrer(monkeypatch):
    namen: list[str] = []

    def aufloesen(_host: str):
        namen.append(threading.current_thread().name)
        return _OEFFENTLICH

    monkeypatch.setattr(dns_ausfuehrer, "_getaddrinfo", aufloesen)
    monkeypatch.setattr(vn, "_klient", _nachweis_klient())

    assert await vn.nachweis_pruefen(_HOST, _NACHWEIS) is None
    assert await vn.server_info_instanz(_HOST) == "961000"

    assert len(namen) == 2
    # Der Standard-Ausführer des Loops heisst ``asyncio_<n>``.
    assert all(n.startswith("verbinden-dns") for n in namen), namen


async def test_ohne_ausfuehrer_bleibt_die_aufloesung_wie_sie_war(monkeypatch):
    """Die Erreichbarkeits-Diagnose ruft ``pruefe_dns`` ohne Ausführer auf und
    behält den Standard-Ausführer des Loops."""
    schleife = asyncio.get_running_loop()
    gesehen: list[tuple] = []

    async def getaddrinfo(*args, **kwargs):
        gesehen.append((args, kwargs))
        return _OEFFENTLICH

    monkeypatch.setattr(schleife, "getaddrinfo", getaddrinfo)
    schritt = await selfhost_probe.pruefe_dns("pulse.example.com")
    assert (schritt.ok, schritt.adressen) == (True, ["203.0.113.7"])
    assert gesehen == [(("pulse.example.com", None), {"type": socket.SOCK_STREAM})]


async def test_platz_haengt_am_thread_nicht_am_await(monkeypatch, haengende_aufloesung):
    """Der Timeout gibt das ``await`` frei, der Thread blockiert weiter — und
    mit ihm sein Platz. Ein Semaphor um das ``await`` hätte ihn schon wieder
    vergeben, und der Pool füllte sich unbemerkt über die Grenze hinaus."""
    monkeypatch.setattr(selfhost_probe, "FRIST_S", 0.5)

    befunde = await asyncio.gather(
        *(vn.nachweis_pruefen("traege.example.org", _NACHWEIS) for _ in range(_PLAETZE))
    )
    # Die Aufrufer sind freigegeben ...
    assert befunde == ["nicht_erreichbar"] * _PLAETZE
    # ... die Threads aber noch drin.
    await haengende_aufloesung.warten_bis_drin(_PLAETZE)

    angefangen = time.monotonic()
    with pytest.raises(Ausgelastet):
        await vn.nachweis_pruefen("traege.example.org", _NACHWEIS)
    with pytest.raises(Ausgelastet):
        await vn.server_info_instanz("traege.example.org")
    # Sofort, nicht erst nach der Frist.
    assert time.monotonic() - angefangen < 0.25

    # Ist der Thread zurück, ist auch der Platz wieder frei.
    haengende_aufloesung.frei.set()
    await _pool_frei()
    monkeypatch.setattr(vn, "_klient", _nachweis_klient())
    assert await vn.nachweis_pruefen(_HOST, _NACHWEIS) is None


async def test_ausgelastet_ist_keine_auskunft_ueber_den_namen(pool_belegt):
    """Nicht als ``OSError``/``TimeoutError`` getarnt: ``pruefe_dns`` machte
    daraus sonst „Name unbekannt“."""
    assert not issubclass(Ausgelastet, (OSError, TimeoutError))
    with pytest.raises(Ausgelastet):
        await selfhost_probe.pruefe_dns("irgendwas.example.org", vn._DNS)


async def test_pool_weist_ab_statt_einzureihen_und_gibt_den_platz_zurueck():
    pool = BegrenzterAusfuehrer(plaetze=1, name="probe")
    frei = threading.Event()
    drin = threading.Event()

    def blockiert() -> None:
        drin.set()
        frei.wait(10)

    erster = asyncio.ensure_future(pool.ausfuehren(blockiert))
    await _bis(drin.is_set)
    with pytest.raises(Ausgelastet):
        await pool.ausfuehren(_nichts)

    frei.set()
    await erster
    for _ in range(100):
        try:
            assert await pool.ausfuehren(lambda: 7) == 7
            break
        except Ausgelastet:
            await asyncio.sleep(0.01)
    else:
        pytest.fail("Der Platz wird nach dem Ende des Threads nicht frei")


# ---------------------------------------------------------------------------
# Die Routen
# ---------------------------------------------------------------------------


async def _start(client, kennung: str = _KENNUNG):
    return await client.post(
        "/selfhost/verbinden/start", json={"hostname": _HOST, "kennung": kennung}
    )


async def _konto(client, name: str) -> dict:
    reg = {
        "username": name,
        "email": f"{name}@dcc-test.example.com",
        "password": "correct horse battery staple",
        "display_name": name.capitalize(),
    }
    assert (await client.post("/register", json=reg)).status_code == 201
    r = await client.post(
        "/login", json={"email_or_username": reg["email"], "password": reg["password"]}
    )
    return {"cookie": f"pulse_session={r.cookies.get('pulse_session')}"}


async def _entscheiden(client, konto: dict, code: str):
    return await client.post(
        "/me/selfhost/verbinden/entscheidung",
        json={"code": code, "aktion": "verbinden"},
        headers={"Cookie": konto["cookie"]},
    )


@pytest.fixture
async def mit_redis(app, redis_echt):
    app.state.redis = redis_echt
    yield redis_echt
    app.state.redis = None


async def test_start_antwortet_503_solange_der_pool_voll_ist(
    client, mit_redis, pool_belegt, monkeypatch
):
    monkeypatch.setattr(vn, "_klient", _nachweis_klient())

    r = await _start(client)
    assert r.status_code == 503, r.text
    assert r.json()["detail"] == "verbinden_ausgelastet"
    # Es ist nichts entstanden: kein Code verbraucht, kein Vorgang angelegt.
    assert [k async for k in mit_redis.scan_iter(match="auth:verbinden:*")] == []

    # Nur vorübergehend: sind die Threads zurück, geht derselbe Aufruf durch.
    pool_belegt.frei.set()
    await _pool_frei()
    r = await _start(client)
    assert r.status_code == 201, r.text


async def test_bestaetigen_antwortet_503_und_laesst_den_code_offen(
    client, mit_redis, haengende_aufloesung, monkeypatch
):
    konto = await _konto(client, "ausgelastet")
    # Der Start ohne Pool-Druck: Auflösung und Abruf gelingen.
    haengende_aufloesung.frei.set()
    monkeypatch.setattr(vn, "_klient", _nachweis_klient())
    start = await _start(client)
    assert start.status_code == 201, start.text
    code = start.json()["code"]
    await _pool_frei()

    # Jetzt ist der Pool voll.
    haengende_aufloesung.frei.clear()
    vorher = len(haengende_aufloesung.threads)
    laeufe = [
        asyncio.ensure_future(vn._DNS.getaddrinfo("traege.example.org")) for _ in range(_PLAETZE)
    ]
    await haengende_aufloesung.warten_bis_drin(_PLAETZE, seit=vorher)
    r = await _entscheiden(client, konto, code)
    assert r.status_code == 503, r.text
    assert r.json()["detail"] == "verbinden_ausgelastet"

    # Der Code gilt weiter: nach dem Freiwerden lässt er sich bestätigen.
    haengende_aufloesung.frei.set()
    await asyncio.gather(*laeufe)
    await _pool_frei()
    r = await _entscheiden(client, konto, code)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "verbunden"
