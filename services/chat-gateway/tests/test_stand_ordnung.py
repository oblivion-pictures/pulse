"""Ordnung und Plausibilität der Stände (``stand_ordnung.py``)."""

from __future__ import annotations

from dcc_shared.snowflake import DEFAULT_EPOCH_MS, TIME_SHIFT

from dcc_chat_gateway.stand_ordnung import ZUKUNFT_TOLERANZ_MS, plausibel, zeit_ms

JETZT = 1_793_900_000_000  # 2026-11-05


def test_zeit_einer_lokalen_id_sind_ihre_ersten_13_stellen():
    assert zeit_ms(1_790_000_000_000_123_456) == 1_790_000_000_000


def test_zeit_einer_snowflake_kommt_aus_dem_zeitanteil():
    ms = 1_791_000_000_000
    assert zeit_ms(((ms - DEFAULT_EPOCH_MS) << TIME_SHIFT) | 0x3FFFFF) == ms


def test_plausibel_mit_toleranz():
    assert plausibel(1_793_900_000_000_000_001, jetzt_ms=JETZT)
    assert plausibel((JETZT + ZUKUNFT_TOLERANZ_MS) * 10**6, jetzt_ms=JETZT)
    assert not plausibel((JETZT + ZUKUNFT_TOLERANZ_MS + 1) * 10**6, jetzt_ms=JETZT)


def test_die_int64_grenze_ist_nicht_plausibel():
    assert not plausibel(9_223_372_036_854_775_807, jetzt_ms=JETZT)
