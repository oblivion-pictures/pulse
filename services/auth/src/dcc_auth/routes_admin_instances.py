"""Admin endpoints for Self-Host instance management (Phase 2.3).

Endpoints
---------
GET  /admin/instances                      -- list registered instances
DELETE /admin/instances/{id}               -- suspend (soft)
POST /admin/instances/{id}/unsuspend       -- Sperre aufheben / Adresse freigeben
POST /admin/instances/{id}/rotate-secret

Antrag und Freigabe (``/admin/instance-applications``) sind seit Oktober 2026
entfernt (Spec E11); Server verbinden sich per Gerätecode selbst
(``routes_verbinden.py``).
"""

from __future__ import annotations

import asyncio
import secrets
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.orm import selectinload

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.geloeschte_adresse import (
    haelt_gesperrte_adresse,
    haelt_gesperrte_adresse_sql,
    platzhalter_hostname,
)
from dcc_auth.models import User
from dcc_auth.models_instances import (
    InstanceDirectEndpoint,
    RegisteredInstance,
    SuspendedInstance,
)
from dcc_auth.routes import _require_admin
from dcc_auth.routes_admin import _audit
from dcc_auth.routes_suspended_instances import (
    _get_redis,
    suspended_list_add,
    suspended_list_remove,
)
from dcc_auth.security import hash_password


def _require_cloud() -> None:
    """Gate the whole Self-Host-instance admin surface to the Cloud.

    Suspending Self-Host instances (and releasing a held address) is a
    cloud-only privilege — the Cloud (howispulse.com) is the single authority
    over the instance registry. On any non-cloud deployment (``PULSE_INSTANCE_MODE`` defaults to
    ``self-host``) these routes 403, so a self-host admin can't authorise
    further instances. Defense-in-depth alongside the frontend hiding the tab.
    """
    if get_settings().pulse_instance_mode != "cloud":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="self-host instance management is cloud-only",
        )


# Router-level dependency → every route here is cloud-gated (and still
# admin-gated per-route via ``_require_admin``).
router = APIRouter(prefix="/admin", dependencies=[Depends(_require_cloud)])

# --------------------------------------------------------------------------- #
# Pydantic schemas                                                              #
# --------------------------------------------------------------------------- #


_SECRET_WARNING = "Speichere das client_secret jetzt — es wird nicht mehr angezeigt."


class InstanceOut(BaseModel):
    model_config = {"from_attributes": True}

    id: str  # Snowflake-String-API
    hostname: str
    client_id: str
    # ``None`` für Einträge ab Migration 0056 (verbundene und neue Heim-Server).
    worker_id_chat: int | None
    worker_id_voice: int | None
    worker_id_media: int | None
    status: str
    registered_at: datetime
    registrar_username: str
    # 'app_host' = Heim-Server, angelegt von der Server-App selbst
    # (``POST /me/instances``); die Admin-Liste zeigt die Herkunft als Chip.
    # Ohne das Feld könnte sie die beiden nicht unterscheiden.
    origin: str = "vps"
    # Eintrag aus dem Verbinden per Gerätecode (Migration 0056). Das Feld ist
    # für die Admin-Oberfläche da; deren Anzeige (Vermerk „ohne Freigabe“,
    # „Secret rotieren“ nur für freigegebene Einträge) folgt in Etappe 5.
    ohne_freigabe: bool = False


class RotateSecretOut(BaseModel):
    instance_id: str  # Snowflake-String-API
    client_secret: str
    warning: str = _SECRET_WARNING


# --------------------------------------------------------------------------- #
# 4. GET /admin/instances                                                       #
# --------------------------------------------------------------------------- #


@router.get("/instances", response_model=list[InstanceOut])
async def list_instances(
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
    status_filter: Annotated[str, Query(alias="status")] = "all",
):
    """List registered instances. Never exposes client_secret.

    ``status=suspended`` zählt auch gelöschte Einträge, die noch ihre echte
    Adresse halten (``geloeschte_adresse.py``); ihr ``status`` bleibt ``deleted``.
    """
    if status_filter not in ("active", "suspended", "deleted", "all"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="status must be active, suspended, deleted or all",
        )
    stmt = (
        select(RegisteredInstance)
        .order_by(RegisteredInstance.registered_at.desc())
        .options(selectinload(RegisteredInstance.registrar))
    )
    if status_filter == "suspended":
        stmt = stmt.where(
            (RegisteredInstance.status == "suspended") | haelt_gesperrte_adresse_sql()
        )
    elif status_filter != "all":
        stmt = stmt.where(RegisteredInstance.status == status_filter)

    rows = (await session.execute(stmt)).scalars().all()
    return [
        InstanceOut(
            id=str(row.id),
            hostname=row.hostname,
            client_id=row.client_id,
            worker_id_chat=row.worker_id_chat,
            worker_id_voice=row.worker_id_voice,
            worker_id_media=row.worker_id_media,
            status=row.status,
            registered_at=row.registered_at,
            # registrar ist NULL, wenn der Owner sein Konto gelöscht hat
            # (Migration 0043: SET NULL statt FK-Blockade).
            registrar_username=row.registrar.username if row.registrar else "(Konto gelöscht)",
            origin=row.origin,
            ohne_freigabe=row.ohne_freigabe,
        )
        for row in rows
    ]


# --------------------------------------------------------------------------- #
# 5. DELETE /admin/instances/{id}  (soft-suspend)                              #
# --------------------------------------------------------------------------- #


@router.delete("/instances/{instance_id}", status_code=status.HTTP_204_NO_CONTENT)
async def suspend_instance(
    instance_id: int,
    request: Request,
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
    reason: Annotated[str | None, Query(max_length=500)] = None,
):
    """Soft-suspend: sets status='suspended', inserts into suspended_instances."""
    instance = await session.get(RegisteredInstance, instance_id, with_for_update=True)
    if instance is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="instance not found")
    if instance.status == "deleted":
        # Vom Owner gelöscht (routes_instance_delete) — Kill-Switch besteht schon.
        raise HTTPException(status.HTTP_409_CONFLICT, detail="instance was deleted by its owner")
    if instance.status == "suspended":
        return  # idempotent

    instance.status = "suspended"
    # Telefonbuch-Eintrag mitlöschen (Muster routes_instance_delete): der
    # Kill-Switch stoppt den Container — die letzte bekannte Heimadresse des
    # Betreibers darf er trotzdem nicht weiter aussprechen.
    await session.execute(
        delete(InstanceDirectEndpoint).where(
            InstanceDirectEndpoint.instance_id == instance_id
        )
    )
    session.add(
        SuspendedInstance(
            instance_id=instance_id,
            suspended_at=datetime.now(UTC),
            reason=reason,
        )
    )
    # Bughunt Runde 21: Kill-Switch-Aktionen ohne jede Akteurs-Spur — der
    # app_host-revoke-Pfad auditiert dieselbe Suspension, diese Routen nicht.
    _audit(
        session,
        actor_id=_actor.id,
        action="instance.suspend",
        target_id=instance_id,
        payload={"reason": reason},
    )
    await session.commit()

    # Bust the public suspended-instances cache so the next poll sees the change.
    redis = await _get_redis(request)
    if redis is not None:
        await suspended_list_add(redis, instance_id, reason)


# --------------------------------------------------------------------------- #
# 6. POST /admin/instances/{id}/unsuspend                                       #
# --------------------------------------------------------------------------- #


@router.post("/instances/{instance_id}/unsuspend", status_code=status.HTTP_204_NO_CONTENT)
async def unsuspend_instance(
    instance_id: int,
    request: Request,
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
):
    """Unsuspend: sets status='active', removes suspended_instances row.

    Eine gelöschte Instanz wird nie wieder aktiv. Hält sie noch ihre echte
    Adresse (``geloeschte_adresse.py``), gibt dieser Aufruf die ADRESSE frei:
    Hostname → Platzhalter, Status und Sperrlisten-Eintrag bleiben. Sonst 409.
    """
    instance = await session.get(RegisteredInstance, instance_id, with_for_update=True)
    if instance is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="instance not found")
    if instance.status == "deleted":
        if not haelt_gesperrte_adresse(instance):
            # Owner-Löschung ist endgültig — der Platzhalter-Hostname
            # (deleted-*.invalid) darf nie wieder aktiv werden.
            raise HTTPException(
                status.HTTP_409_CONFLICT, detail="instance was deleted by its owner"
            )
        freigegeben = instance.hostname
        instance.hostname = platzhalter_hostname(instance.id)
        _audit(
            session,
            actor_id=_actor.id,
            action="instance.release_address",
            target_id=instance_id,
            payload={"hostname": freigegeben},
        )
        await session.commit()
        return  # Sperrliste (Kennungen) unverändert, ihr Cache stimmt weiter
    if instance.status == "active":
        return  # idempotent

    instance.status = "active"
    # Remove from suspended_instances via the relationship
    await session.refresh(instance, ["suspended_entry"])
    if instance.suspended_entry is not None:
        await session.delete(instance.suspended_entry)
    _audit(session, actor_id=_actor.id, action="instance.unsuspend", target_id=instance_id)
    await session.commit()

    # Bust the public suspended-instances cache so the next poll sees the change.
    redis = await _get_redis(request)
    if redis is not None:
        await suspended_list_remove(redis, instance_id)


# --------------------------------------------------------------------------- #
# 7. POST /admin/instances/{id}/rotate-secret                                   #
# --------------------------------------------------------------------------- #


@router.post("/instances/{instance_id}/rotate-secret", response_model=RotateSecretOut)
async def rotate_secret(
    instance_id: int,
    session: SessionDep,
    _actor: Annotated[User, Depends(_require_admin)],
):
    """Generate a new client_secret. Returns plaintext once; old secret invalidated."""
    instance = await session.get(RegisteredInstance, instance_id, with_for_update=True)
    if instance is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="instance not found")
    if instance.status == "deleted":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="instance was deleted by its owner")

    new_secret_plain = secrets.token_urlsafe(32)
    instance.client_secret = await asyncio.to_thread(hash_password, new_secret_plain)
    # Bughunt Runde 21: Secret-Rotation bricht eine laufende Instanz sofort —
    # ohne Audit-Zeile war der einzige Hinweis die dunkel gewordene Instanz.
    _audit(session, actor_id=_actor.id, action="instance.rotate_secret", target_id=instance_id)
    await session.commit()

    return RotateSecretOut(
        instance_id=str(instance_id),
        client_secret=new_secret_plain,
    )
