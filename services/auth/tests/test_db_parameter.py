"""Datenbank-Ausnahmen verraten keine gebundenen Parameter (Push-Bughunt
2026-10-20): ohne ``hide_parameters`` stünden sie in der Meldung — und die
landet im Log."""

from __future__ import annotations


def test_datenbank_fehler_verraten_keine_parameter():
    from dcc_auth.db import engine

    assert engine.sync_engine.hide_parameters is True
