"""Die Adresse einer gelöschten Instanz: frei oder weiter gesperrt.

Löscht der Besitzer eine Instanz (``routes_instance_delete.soft_delete_instance``),
benennt die Löschung ihren Hostnamen auf den Platzhalter ``deleted-<id>.invalid``
um — die Adresse ist frei. **Die Ausnahme:** war die Instanz beim Löschen
gesperrt, behält die gelöschte Zeile ihren echten Hostnamen. Sonst käme der
Besitzer um die Sperre herum: löschen, unter derselben Adresse neu verbinden.
Die Adresse bleibt gesperrt, bis ein Admin sie freigibt
(``POST /admin/instances/{id}/unsuspend``) — die Freigabe setzt den Platzhalter.

Eine gelöschte Zeile mit echtem Hostnamen gibt es daher nur, wenn sie beim
Löschen gesperrt war: ``soft_delete_instance`` ist die einzige Stelle, die
``status`` auf ``deleted`` setzt. Löschen, Verbinden, Admin-Liste und Freigabe
stellen dieselbe Frage; sie steht deshalb hier.
"""

from __future__ import annotations

from sqlalchemy import String, cast
from sqlalchemy.sql.elements import ColumnElement

from dcc_auth.models_instances import RegisteredInstance


def platzhalter_hostname(instanz_id: int) -> str:
    """Der Hostname einer gelöschten Instanz, deren Adresse frei ist.

    ``.invalid`` ist reserviert (RFC 2606) und löst nie auf; die Kennung macht
    ihn eindeutig, ohne mit einem echten Hostnamen zu kollidieren.
    """
    return f"deleted-{instanz_id}.invalid"


def haelt_gesperrte_adresse(instanz: RegisteredInstance) -> bool:
    """Ist die Instanz gelöscht und trägt trotzdem noch ihre echte Adresse?"""
    return instanz.status == "deleted" and instanz.hostname != platzhalter_hostname(instanz.id)


def haelt_gesperrte_adresse_sql() -> ColumnElement[bool]:
    """Dieselbe Frage als Filter, für die Admin-Liste."""
    platzhalter = "deleted-" + cast(RegisteredInstance.id, String) + ".invalid"
    return (RegisteredInstance.status == "deleted") & (RegisteredInstance.hostname != platzhalter)
