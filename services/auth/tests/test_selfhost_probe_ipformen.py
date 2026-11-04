"""Security-Scan 2026-11-04: ``::`` (unspezifiziert) verbindet Linux als ``::1``.

Gleiche Sperrliste wie ``dcc_chat_gateway.ablage_ssrf.PRIVATE_NETZE`` — beide
kannten ``::1/128``, aber nicht ``::/128``.
"""

from dcc_auth.selfhost_probe import ist_oeffentlich


def test_unspezifizierte_ipv6_adresse_ist_nicht_oeffentlich():
    assert not ist_oeffentlich("::")


def test_oeffentliche_adresse_bleibt_oeffentlich():
    assert ist_oeffentlich("2606:4700:4700::1111")
