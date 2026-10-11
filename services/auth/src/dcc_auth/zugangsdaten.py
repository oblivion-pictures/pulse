"""Zugangsdaten eines Servers ausgeben — ein Weg für zwei Eingänge.

Zwei Routen händigen einem Server seine Zugangsdaten aus: die Einlösung des
Installer-Tokens (``routes_selfhost_bootstrap.py``, Server-App und
freigegebene Server) und das Abholen nach dem Verbinden per Gerätecode
(``routes_verbinden.py``). Beide müssen dasselbe tun — Secret rotieren,
Besitzer als Mitglied eintragen, dieselben Felder liefern —, sonst bekäme ein
verbundener Server andere Werte als ein freigegebener, und
``07-render-env.sh`` müsste zwei Formen kennen.

Committet nicht: der Aufrufer hat jeweils eigenen Zustand, der in derselben
Transaktion landen muss (eingelöstes Token, ``verbunden_at``).
"""

from __future__ import annotations

import asyncio
import secrets

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.config import Settings
from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership
from dcc_auth.security import hash_password


class ZugangsdatenOut(BaseModel):
    instance_id: str
    owner_user_id: str
    hostname: str
    client_id: str
    client_secret: str
    cloud_origin: str
    admin_email: str | None = None


async def zugangsdaten_ausgeben(
    db: AsyncSession, instance: RegisteredInstance, settings: Settings
) -> ZugangsdatenOut:
    """Rotiert das Secret (Klartext nur in der Rückgabe) und stellt die
    Besitzer-Mitgliedschaft sicher. Secret wird NIE geloggt."""
    new_secret = secrets.token_urlsafe(32)
    instance.client_secret = await asyncio.to_thread(hash_password, new_secret)

    owner = await db.get(User, instance.registered_by)
    admin_email = owner.email if owner is not None else None

    # Owner-Membership in der Cloud tracken (= Account-basierte Server-Liste,
    # ersetzt den Zero-Knowledge-Vault). Genehmigung und Verbinden legen sie
    # bereits an; bei wiederholter Ausgabe (oder einem vor diesem Fix
    # genehmigten Antrag) existiert sie ggf. schon → nur einfügen, wenn noch
    # keine da ist (ein blindes INSERT würde am Composite-PK mit
    # IntegrityError crashen).
    existing_membership = await db.get(
        UserInstanceMembership, (instance.registered_by, instance.id)
    )
    if existing_membership is None:
        db.add(
            UserInstanceMembership(
                user_id=instance.registered_by,
                instance_id=instance.id,
                role="owner",
            )
        )

    return ZugangsdatenOut(
        instance_id=str(instance.id),
        owner_user_id=str(instance.registered_by),
        hostname=instance.hostname,
        client_id=instance.client_id,
        client_secret=new_secret,
        cloud_origin=settings.pulse_oidc_issuer,
        admin_email=admin_email,
    )
