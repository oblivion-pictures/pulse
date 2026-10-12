"""Gerätecode und Redis-Vorgang des Verbindens (``dcc_auth/verbinden.py``).

Der Vorgang lebt 15 Minuten in Redis und ist der einzige Ort, an dem Cloud,
Browser und Server sich treffen: Der Server kennt seine Abholkennung, der
Browser den Code, die Cloud nur den Hash der Kennung.
"""

from __future__ import annotations

import asyncio
import hashlib

import pytest

from dcc_auth import verbinden as v

_NACHWEIS = hashlib.sha256(b"kennung-fuer-den-test").hexdigest()


class _GleichzeitigLesen:
    """Erzwingt die Verschränkung, die ``asyncio.gather`` von selbst nicht liefert.

    Gegen einen echten Redis laufen gleichzeitig gestartete Aufrufe praktisch
    nacheinander durch; eine Lese-Schreib-Lücke bliebe dabei unsichtbar. Dieser
    Mantel hält deshalb jeden Aufrufer nach seinem ``get`` (am Klienten wie in
    einer Pipeline) an, bis ``parteien`` Aufrufer gelesen haben. Erst dann geht
    es ans Schreiben. Ohne WATCH/MULTI läsen dadurch alle denselben Zustand
    ``wartet`` und alle gewännen.
    """

    def __init__(self, redis, parteien: int) -> None:
        self._redis = redis
        self._offen = parteien
        self._alle_da = asyncio.Event()

    @property
    def alle_haben_gelesen(self) -> bool:
        return self._alle_da.is_set()

    async def nach_dem_lesen(self) -> None:
        self._offen -= 1
        if self._offen <= 0:
            self._alle_da.set()
        # Die Frist verhindert ein Hängen, falls weniger Aufrufer lesen als gedacht;
        # ``alle_haben_gelesen`` zeigt dann, dass die Verschränkung nicht griff.
        try:
            await asyncio.wait_for(self._alle_da.wait(), timeout=2)
        except TimeoutError:
            pass

    async def get(self, schluessel):
        wert = await self._redis.get(schluessel)
        await self.nach_dem_lesen()
        return wert

    def pipeline(self, *args, **kwargs):
        return _GleichzeitigLesenPipeline(self._redis.pipeline(*args, **kwargs), self)

    def __getattr__(self, name):
        return getattr(self._redis, name)


class _GleichzeitigLesenPipeline:
    def __init__(self, pipe, haltepunkt: _GleichzeitigLesen) -> None:
        self._pipe = pipe
        self._haltepunkt = haltepunkt

    async def __aenter__(self):
        await self._pipe.__aenter__()
        return self

    async def __aexit__(self, *ausnahme):
        return await self._pipe.__aexit__(*ausnahme)

    async def get(self, schluessel):
        wert = await self._pipe.get(schluessel)
        await self._haltepunkt.nach_dem_lesen()
        return wert

    def __getattr__(self, name):
        return getattr(self._pipe, name)


def test_code_hat_acht_zeichen_aus_dem_crockford_alphabet():
    codes = {v.neuer_code() for _ in range(200)}
    assert len(codes) > 190
    for code in codes:
        assert len(code) == 8
        assert set(code) <= set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")


def test_code_wird_mit_bindestrich_angezeigt():
    assert v.code_anzeigen("K7QM2XDP") == "K7QM-2XDP"


@pytest.mark.parametrize(
    ("roh", "erwartet"),
    [
        ("K7QM-2XDP", "K7QM2XDP"),
        ("k7qm2xdp", "K7QM2XDP"),
        ("  k7qm - 2xdp ", "K7QM2XDP"),
        ("O0IL-1234", "00111234"),
        ("abcd-efgh", "ABCDEFGH"),
    ],
)
def test_eingabe_wird_normalisiert(roh, erwartet):
    assert v.code_normalisieren(roh) == erwartet


@pytest.mark.parametrize("roh", ["", "K7QM-2XD", "K7QM-2XDPP", "K7QM-2XDU", "K7QM_2XDP"])
def test_unbrauchbare_eingabe_ist_none(roh):
    assert v.code_normalisieren(roh) is None


def test_nachweis_ist_der_sha256_der_kennung():
    assert v.nachweis_aus_kennung("kennung-fuer-den-test") == _NACHWEIS


async def test_anlegen_und_finden(redis_echt):
    vorgang = await v.vorgang_anlegen(redis_echt, "neu.example.org", _NACHWEIS)
    assert vorgang.status == "wartet"
    assert vorgang.hostname == "neu.example.org"
    assert vorgang.instance_id is None and vorgang.user_id is None

    treffer = await v.vorgang_per_code(redis_echt, vorgang.code)
    assert treffer is not None
    assert treffer[0] == _NACHWEIS
    assert treffer[1] == vorgang
    assert await v.vorgang_per_nachweis(redis_echt, _NACHWEIS) == vorgang


async def test_beide_schluessel_laufen_nach_15_minuten_ab(redis_echt):
    assert v.GUELTIG_S == 900
    vorgang = await v.vorgang_anlegen(redis_echt, "frist.example.org", _NACHWEIS)
    for schluessel in (
        f"auth:verbinden:vorgang:{_NACHWEIS}",
        f"auth:verbinden:code:{vorgang.code}",
    ):
        # Gerade angelegt: die Restlaufzeit liegt knapp unter der vollen Frist.
        assert v.GUELTIG_S - 5 < await redis_echt.ttl(schluessel) <= v.GUELTIG_S


async def test_zweites_anlegen_derselben_kennung_liefert_denselben_code(redis_echt):
    """Ein wiederholter Start (Netzfehler beim ersten) verbraucht keinen
    zweiten Code."""
    erster = await v.vorgang_anlegen(redis_echt, "wieder.example.org", _NACHWEIS)
    zweiter = await v.vorgang_anlegen(redis_echt, "wieder.example.org", _NACHWEIS)
    assert zweiter.code == erster.code


async def test_dieselbe_kennung_fuer_eine_andere_adresse_wird_abgelehnt(redis_echt):
    await v.vorgang_anlegen(redis_echt, "eins.example.org", _NACHWEIS)
    with pytest.raises(v.VorgangLaeuft):
        await v.vorgang_anlegen(redis_echt, "zwei.example.org", _NACHWEIS)


async def test_entschiedener_vorgang_wird_nicht_neu_ausgegeben(redis_echt):
    await v.vorgang_anlegen(redis_echt, "fertig.example.org", _NACHWEIS)
    await v.vorgang_entscheiden(redis_echt, _NACHWEIS, "abgelehnt", instance_id=None, user_id="1")
    with pytest.raises(v.VorgangLaeuft):
        await v.vorgang_anlegen(redis_echt, "fertig.example.org", _NACHWEIS)


async def test_entscheiden_geht_genau_einmal(redis_echt):
    await v.vorgang_anlegen(redis_echt, "einmal.example.org", _NACHWEIS)
    # Die Restfrist künstlich verkürzen: nur so ist sichtbar, ob die Entscheidung
    # sie unangetastet lässt oder auf die volle Frist zurücksetzt.
    schluessel = f"auth:verbinden:vorgang:{_NACHWEIS}"
    assert await redis_echt.expire(schluessel, 100)
    assert await v.vorgang_entscheiden(
        redis_echt, _NACHWEIS, "bestaetigt", instance_id="42", user_id="7"
    )
    assert not await v.vorgang_entscheiden(
        redis_echt, _NACHWEIS, "abgelehnt", instance_id=None, user_id="8"
    )
    vorgang = await v.vorgang_per_nachweis(redis_echt, _NACHWEIS)
    assert (vorgang.status, vorgang.instance_id, vorgang.user_id) == ("bestaetigt", "42", "7")
    # Eine Entscheidung verlängert die Frist nicht.
    assert 0 < await redis_echt.ttl(schluessel) <= 100


async def test_entscheiden_ohne_vorgang_ist_false(redis_echt):
    assert not await v.vorgang_entscheiden(
        redis_echt, _NACHWEIS, "bestaetigt", instance_id="1", user_id="1"
    )


class _HinweisDazwischen:
    """Schreibt nach dem ersten Lesen in der Pipeline einen Hinweis, wie ein
    zweiter Tab, dessen Bestätigen gerade an ``zu_viele_server`` scheitert."""

    def __init__(self, redis) -> None:
        self.redis = redis
        self.geschrieben = False

    def pipeline(self, *args, **kwargs):
        return _HinweisPipeline(self.redis.pipeline(*args, **kwargs), self)

    def __getattr__(self, name):
        return getattr(self.redis, name)


class _HinweisPipeline:
    def __init__(self, pipe, aussen: _HinweisDazwischen) -> None:
        self._pipe = pipe
        self._aussen = aussen

    async def __aenter__(self):
        await self._pipe.__aenter__()
        return self

    async def __aexit__(self, *ausnahme):
        return await self._pipe.__aexit__(*ausnahme)

    async def get(self, schluessel):
        wert = await self._pipe.get(schluessel)
        if not self._aussen.geschrieben:
            self._aussen.geschrieben = True
            assert await v.vorgang_hinweis_setzen(self._aussen.redis, _NACHWEIS, "zu_viele_server")
        return wert

    def __getattr__(self, name):
        return getattr(self._pipe, name)


async def test_ein_hinweis_zwischen_lesen_und_schreiben_kostet_den_klick_nicht(redis_echt):
    """Der Hinweis ändert den beobachteten Schlüssel (WatchError), der Vorgang wartet
    aber noch — der zweite Durchgang entscheidet ihn."""
    await v.vorgang_anlegen(redis_echt, "hinweis.example.org", _NACHWEIS)
    dazwischen = _HinweisDazwischen(redis_echt)
    assert await v.vorgang_entscheiden(
        dazwischen, _NACHWEIS, "bestaetigt", instance_id="9", user_id="9"
    )
    assert dazwischen.geschrieben
    vorgang = await v.vorgang_per_nachweis(redis_echt, _NACHWEIS)
    assert (vorgang.status, vorgang.instance_id) == ("bestaetigt", "9")


async def test_gleichzeitiges_entscheiden_hat_genau_einen_gewinner(redis_echt):
    """Alle fünf lesen ``wartet``, bevor einer schreibt — nur WATCH/MULTI trennt sie."""
    await v.vorgang_anlegen(redis_echt, "rennen.example.org", _NACHWEIS)
    verschraenkt = _GleichzeitigLesen(redis_echt, parteien=5)
    ergebnisse = await asyncio.gather(
        *(
            v.vorgang_entscheiden(
                verschraenkt, _NACHWEIS, "bestaetigt", instance_id=str(i), user_id=str(i)
            )
            for i in range(5)
        )
    )
    assert verschraenkt.alle_haben_gelesen
    assert sorted(ergebnisse) == [False, False, False, False, True]
    # Gespeichert ist die Entscheidung des Gewinners, keine Mischung.
    gewinner = str(ergebnisse.index(True))
    vorgang = await v.vorgang_per_nachweis(redis_echt, _NACHWEIS)
    assert (vorgang.status, vorgang.instance_id, vorgang.user_id) == (
        "bestaetigt",
        gewinner,
        gewinner,
    )


async def test_entnehmen_raeumt_beide_schluessel_und_geht_nur_einmal(redis_echt):
    """Beide Aufrufer würden denselben Vorgang lesen — nur ``GETDEL`` gibt ihn einmal her."""
    vorgang = await v.vorgang_anlegen(redis_echt, "weg.example.org", _NACHWEIS)
    verschraenkt = _GleichzeitigLesen(redis_echt, parteien=2)
    entnommen, nochmal = await asyncio.gather(
        v.vorgang_entnehmen(verschraenkt, _NACHWEIS),
        v.vorgang_entnehmen(verschraenkt, _NACHWEIS),
    )
    assert [entnommen, nochmal].count(None) == 1
    assert (entnommen or nochmal) == vorgang
    assert await v.vorgang_per_code(redis_echt, vorgang.code) is None
    assert await redis_echt.exists(f"auth:verbinden:code:{vorgang.code}") == 0
    assert await redis_echt.exists(f"auth:verbinden:vorgang:{_NACHWEIS}") == 0


async def test_fremder_code_trifft_keinen_vorgang(redis_echt):
    await v.vorgang_anlegen(redis_echt, "fremd.example.org", _NACHWEIS)
    assert await v.vorgang_per_code(redis_echt, "ZZZZZZZZ") is None
