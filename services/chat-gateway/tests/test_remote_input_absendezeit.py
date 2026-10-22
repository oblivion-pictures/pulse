"""Die Absendezeit ``t`` am ``remote_input`` (seit 2026-10-22): der Gateway
reicht sie nur weiter, wenn sie eine plausible Uhrzeit ist — sonst geht die
Eingabe ohne sie hinaus, statt abgewiesen zu werden."""

from __future__ import annotations

import math

from dcc_chat_gateway.routes.ws_remote_input import _absendezeit


def test_plausible_zeit_wird_ganze_millisekunden():
    assert _absendezeit(1_792_676_954_835) == 1_792_676_954_835
    assert _absendezeit(1_792_676_954_835.7) == 1_792_676_954_835


def test_unsinn_faellt_weg():
    for wert in (None, "123", True, 0, -5, math.nan, math.inf, 2**53, [1]):
        assert _absendezeit(wert) is None, wert
