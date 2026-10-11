"""Die Nachricht „Anmelde-Kette zu Ende" (iOS-Bughunt 2, C2) — hin und zurück."""

import uuid

from dcc_shared.anmeldeketten import (
    KettenEnde,
    KettenStand,
    lesen,
    nachricht,
    stand_anfrage,
    stand_lesen,
)


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


# --- Abgleich (STAND_PFAD) -------------------------------------------------


def test_stand_anfrage_traegt_paare_als_text():
    assert stand_anfrage([(7, "b"), (7, "a"), (7, "a")]) == {
        "ketten": [{"user_id": "7", "kette": "a"}, {"user_id": "7", "kette": "b"}]
    }


def test_stand_zaehlt_nur_gefragte_paare():
    """Nennt auth-svc ein Paar, nach dem niemand gefragt hat, fällt dafür
    keine Zeile — die Antwort beendet nur, was hier gefragt wurde."""
    antwort = {
        "beendet": [{"user_id": "7", "kette": "a"}, {"user_id": "8", "kette": "a"}],
        "unbekannt": 2,
    }
    assert stand_lesen(antwort, [(7, "a"), (7, "b")]) == KettenStand(frozenset({(7, "a")}), 2)


def test_ein_unlesbarer_eintrag_verwirft_die_ganze_antwort():
    gefragt = [(7, "a")]
    ok = {"user_id": "7", "kette": "a"}
    for kaputt in (
        None,
        "kein objekt",
        {"beendet": [ok]},
        {"beendet": [ok], "unbekannt": -1},
        {"beendet": [ok], "unbekannt": True},
        {"beendet": [ok, {"user_id": 7, "kette": "a"}], "unbekannt": 0},
        {"beendet": [ok, {"user_id": "-7", "kette": "a"}], "unbekannt": 0},
        {"beendet": [ok, {"user_id": "7"}], "unbekannt": 0},
        {"beendet": "a", "unbekannt": 0},
    ):
        assert stand_lesen(kaputt, gefragt) is None, kaputt
    assert stand_lesen({"beendet": [ok], "unbekannt": 0}, gefragt) == KettenStand(
        frozenset({(7, "a")}), 0
    )
