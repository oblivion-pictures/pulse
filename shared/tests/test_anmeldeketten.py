"""Die Nachricht „Anmelde-Kette zu Ende" (iOS-Bughunt 2, C2) — hin und zurück."""

import uuid

from dcc_shared.anmeldeketten import KettenEnde, lesen, nachricht


def test_ketten_reisen_als_text_und_ohne_leere_eintraege():
    k = uuid.uuid4()
    text = nachricht(user_id=7, ketten=[k, None, str(k)])
    assert lesen(text) == KettenEnde(user_id=7, ketten=frozenset({str(k)}))


def test_alle_ketten():
    assert lesen(nachricht(user_id=7, alle=True)) == KettenEnde(7, frozenset(), alle=True)


def test_nichts_zu_melden_ergibt_keine_nachricht():
    assert nachricht(user_id=7, ketten=[None]) is None


def test_unlesbares_wird_verworfen():
    assert lesen(b"kein json") is None
    assert lesen('{"ketten": ["a"]}') is None
    assert lesen('{"user_id": "x", "ketten": []}') is None
    assert lesen('{"user_id": "7", "ketten": [1]}') is None
    assert lesen(b'{"user_id": "7", "ketten": ["a"]}') == KettenEnde(7, frozenset({"a"}))
