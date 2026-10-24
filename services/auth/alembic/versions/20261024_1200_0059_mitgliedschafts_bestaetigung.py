"""mitgliedschafts_bestaetigung — wann der Heim-Server eine Mitgliedschaft
bestätigt hat.

Sicherheits-Scan 2026-10-24 (Heim-IP-Lücke): Bis dahin schaltete jede
Membership-Zeile den Direktpfad-Telefonbuch-Lookup frei — und „beitreten"
war eine nachweislose Selbst-Eintragung, die jedes Cloud-Konto bei jeder
Instanz vornehmen konnte (die Instanz-Kennung steht öffentlich lesbar in
``/.well-known/pulse-server-info``). Damit war die Heim-Adresse jedes
aktiven Heim-Servers für jedes Konto abrufbar.

Der Heim-Server-V1-Entscheid vom 2026-09-27 („Mitglieder dürfen den
Direktweg") bleibt — aber „Mitglied" heißt jetzt: vom SERVER bestätigt.
``POST /selfhost/directory/mitgliedschaft`` (Auth wie der Heartbeat: Tunnel-
Token oder Pairing-Creds) setzt ``bestaetigt_am``; der Gateway meldet dort
nach bestandenem Beitritts-Gate, getaktet. Die Bestätigung verfällt nach
``directory_membership_gueltigkeit_tage`` (7 Tage), damit ein Rauswurf oder
Bann wirksam wird, ohne dass der Server eine Abmeldung schicken müsste —
jede Anmeldung frischt auf.

``NULL`` (alle Bestandszeilen) heißt: Merkhilfe ohne Nachweis. Deren Lookup
fällt auf 404 zurück, bis der Betreffende sich das nächste Mal auf dem
Server anmeldet — die Meldung heilt dann selbst.

Rein additiv: eine nullbare Spalte, nichts Bestehendes ändert sich.

Revision ID: 0059_mitgliedschafts_bestaetigung
Revises: 0058_sitzung_nachfolger
Create Date: 2026-10-24 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# Revision-ID max. 32 Zeichen (``alembic_version.version_num`` ist varchar(32)).
revision: str = "0059_mitgliedschafts_bestaetigung"
down_revision: str | None = "0058_sitzung_nachfolger"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "user_instance_memberships",
        sa.Column("bestaetigt_am", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("user_instance_memberships", "bestaetigt_am", schema=SCHEMA)
