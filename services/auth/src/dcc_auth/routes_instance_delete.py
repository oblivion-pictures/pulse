"""Owner-facing Self-Host-Instanz-Löschung.

DELETE /me/instances/{id} — Soft-Delete durch den Instanz-Besitzer.

Eigenes Modul (statt routes_instance_applications.py zu erweitern) wegen der
Größen-Policy; teilt sich den ``_require_user``-Helper mit den Nachbar-Routen.

Warum Soft-Delete statt Hard-Delete: Bis Oktober 2026 vergab die Cloud
Worker-IDs (chat/voice/media) per max+1 — eine hart gelöschte Zeile hätte ihre
IDs für die nächste Instanz freigegeben, deren Snowflakes dann mit denen der
gelöschten kollidiert wären. Bestandszeilen tragen diese IDs weiter; neue
Einträge bekommen keine mehr (Spec E7). Die Zeile bleibt deshalb bestehen
(``status='deleted'``), nur der Hostname wird auf einen Platzhalter unter
``.invalid`` (RFC 2606) umbenannt, damit die Adresse wieder verbunden werden
kann (außer bei einer gesperrten Instanz, s. unten).

**Ausnahme: eine gesperrte Instanz behält ihren echten Hostnamen.** Sonst
käme ihr Besitzer um die Sperre herum — löschen, unter derselben Adresse neu
verbinden. Die Adresse bleibt gesperrt, bis ein Admin sie freigibt
(``geloeschte_adresse.py``). Das gilt für die Löschung durch den Besitzer wie
für die Konto-Löschung.

Zusätzlich wird ein ``suspended_instances``-Eintrag angelegt (bei einer
gesperrten Instanz besteht der des Admins schon und bleibt): Ein noch
laufender Container findet sich damit auf der öffentlichen
``/.well-known/pulse-suspended-instances``-Liste und stellt den Betrieb ein —
der Kill-Switch greift also auch, wenn der Owner das Docker-Volume nie anfasst
(z.B. nach Server-Verkauf oder bei gestohlenen Pairing-Credentials).
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Request, status
from sqlalchemy import delete, update

from dcc_auth.db import SessionDep
from dcc_auth.geloeschte_adresse import platzhalter_hostname
from dcc_auth.instance_provisioning import eigene_instanz_oder_404
from dcc_auth.models_instances import (
    InstanceApplication,
    InstanceBootstrapToken,
    InstanceDirectEndpoint,
    RegisteredInstance,
    SuspendedInstance,
    UserInstanceMembership,
)
from dcc_auth.routes_instance_applications import _require_user
from dcc_auth.routes_suspended_instances import _get_redis, suspended_list_add

router = APIRouter(tags=["self-host"])

_DELETE_REASON = "Vom Besitzer gelöscht"


@router.delete("/me/instances/{instance_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_instance(
    instance_id: str,
    request: Request,
    db: SessionDep,
) -> None:
    """Eigene Instanz löschen (Soft-Delete, irreversibel für den Owner).

    Nur der Besitzer; 404 statt 403 gegen Existence-Leak (wie die
    Nachbar-Routen). Eine bereits gelöschte Instanz ist für den Owner
    unsichtbar → ebenfalls 404. Auch eine admin-suspendierte Instanz darf der
    Owner löschen (der Suspend-Eintrag und damit der Kill-Switch bleiben) —
    aber ihre Adresse wird dadurch NICHT frei: sie bleibt gesperrt, bis ein
    Admin sie freigibt. Bei jeder anderen Instanz wird die Adresse frei.
    """
    user = await _require_user(request, db)

    inst = await eigene_instanz_oder_404(db, user.id, instance_id, with_for_update=True)

    await soft_delete_instance(db, inst)
    await db.commit()

    # Cache der öffentlichen Suspend-Liste invalidieren, damit ein noch
    # laufender Container den Kill-Switch beim nächsten Poll sieht.
    redis = await _get_redis(request)
    if redis is not None:
        await suspended_list_add(redis, inst.id, _DELETE_REASON)


async def soft_delete_instance(db, inst: RegisteredInstance) -> None:
    """Instanz soft-deleten — Mutationen ohne Commit.

    Wird vom Owner-Endpoint oben und von der Konto-Löschung
    (routes_account.DELETE /me) geteilt. Der Aufrufer committet und ruft
    danach ``suspended_list_add`` (Kill-Switch-Cache) für ``inst.id`` auf.
    """
    iid = inst.id
    was_suspended = inst.status == "suspended"
    inst.status = "deleted"
    if not was_suspended:
        # Hostname freigeben — Unique-Constraint bleibt erfüllt, Kollision mit
        # echten Hostnames unmöglich (.invalid ist reserviert, RFC 2606).
        inst.hostname = platzhalter_hostname(iid)
    # War die Instanz gesperrt, bleibt der echte Hostname stehen: Er hält die
    # Adresse gesperrt (``instanz_verbinden`` weist einen gelöschten Eintrag
    # darunter ab), sonst entkäme der Besitzer der Sperre durch Löschen und
    # Neuverbinden. Der Admin gibt die Adresse frei (``unsuspend_instance``).

    # Offene Bootstrap-Tokens entwerten — es darf kein Installer-Lauf mehr
    # gegen die gelöschte Instanz einlösen.
    await db.execute(
        delete(InstanceBootstrapToken).where(InstanceBootstrapToken.instance_id == iid)
    )

    # Mitgliedschaften ALLER User + Telefonbuch-Eintrag mitnehmen: die Instanz
    # existiert für niemanden mehr. Ohne das behalten Mitglieder eine Server-
    # Kachel ohne Server, und das Telefonbuch nennt eine Adresse, hinter der
    # nichts mehr antwortet.
    await db.execute(
        delete(UserInstanceMembership).where(UserInstanceMembership.instance_id == iid)
    )
    await db.execute(
        delete(InstanceDirectEndpoint).where(InstanceDirectEndpoint.instance_id == iid)
    )

    # Ursprungs-Antrag schließen: Anträge sind seit Oktober 2026 nur noch
    # Historie (Spec E11), und die soll stimmen — eine gelöschte Instanz hat
    # keinen „genehmigten" Antrag mehr. 'closed' ist bewusst KEIN 'rejected':
    # abgelehnt wurde nichts.
    await db.execute(
        update(InstanceApplication)
        .where(
            InstanceApplication.approved_instance_id == iid,
            InstanceApplication.status == "approved",
        )
        .values(status="closed")
    )

    if not was_suspended:
        db.add(
            SuspendedInstance(
                instance_id=iid,
                suspended_at=datetime.now(UTC),
                reason=_DELETE_REASON,
            )
        )
