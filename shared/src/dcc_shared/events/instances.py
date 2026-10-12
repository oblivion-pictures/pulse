"""Ereignisse rund um die Server einer Person — an genau ein Konto.

Publiziert von auth-svc auf ``user:events`` (Routing über
``_target_user_id``):

* ``instance_status`` (``instance_status.py``, je Mitglied): Heim-Server läuft
  / läuft nicht / heißt jetzt so. Die Server-Leiste blendet einen gestoppten
  Heim-Server aus und zeigt den Anzeigenamen statt der Relay-Adresse.
* ``instanz_verbunden`` (``routes_verbinden.py``, an den Besitzer): ein
  Server wurde per Gerätecode mit dem Konto verbunden und hat seine
  Zugangsdaten abgeholt (Spec 2026-10-09, E3). Die Geräte laden
  ``/me/instances`` neu und nehmen ihn in die Leiste.

Ohne diese Ereignisse sähe die Leiste beides erst beim nächsten Laden von
``/me/instances``.
"""

from __future__ import annotations

from typing import Literal

from dcc_shared.events._base import _EventBase


class InstanceStatusData(_EventBase):
    instance_id: str
    # ``None`` = die Cloud weiß es nicht: nur ein Heim-Server meldet sich beim
    # Telefonbuch, ein per Gerätecode verbundener Server nie (s.
    # ``instance_status.online_aussage``). Kein ``false`` erfinden — die
    # Oberfläche blendet bei ``false`` aus und wechselt den aktiven Server.
    online: bool | None = None
    anzeigename: str | None = None


class InstanceStatusEvent(_EventBase):
    """``op="instance_status"`` — Online-Zustand oder Name hat sich geändert."""

    op: Literal["instance_status"] = "instance_status"
    data: InstanceStatusData


class InstanzVerbundenData(_EventBase):
    # Nur die Nummer: die Geräte holen alles Weitere über ``/me/instances``,
    # das dieselben Rechte prüft wie jede andere Abfrage der Liste.
    instance_id: str


class InstanzVerbundenEvent(_EventBase):
    """``op="instanz_verbunden"`` — ein Server ist mit deinem Konto verbunden."""

    op: Literal["instanz_verbunden"] = "instanz_verbunden"
    data: InstanzVerbundenData
