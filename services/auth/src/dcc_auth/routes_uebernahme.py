"""Widerspruch gegen einen Übernahme-Antrag.

``POST /me/instances/{instance_id}/uebernahme/widerspruch`` — der bisherige
Besitzer stoppt einen Antrag, mit dem ein anderes Konto seine Adresse
übernehmen will (Widerspruchsfrist, Spec 2026-10-09 E2, Nachtrag 2026-10-11;
``verbinden_uebernahme.py``). Danach kann 30 Tage lang kein fremdes Konto die
Adresse beanspruchen.

Widersprechen kann nur, wessen Server **beim Einlegen** noch unter der Adresse
antwortet (``/.well-known/pulse-server-info`` meldet die Nummer des Eintrags).
Das wehrt den gespiegelten Angriff ab: Wer eine freie fremde Adresse kurz
kontrolliert und als Erster eingetragen hat, könnte dem echten Domaininhaber
sonst immer wieder widersprechen. Verschwindet der Server nach dem Einlegen,
bleibt die Sperre bestehen.

Eigene Datei, weil ``routes_instance_applications.py`` schon über der harten
Größengrenze liegt.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status

from dcc_auth.db import SessionDep
from dcc_auth.dns_ausfuehrer import Ausgelastet
from dcc_auth.instance_provisioning import eigene_instanz_oder_404
from dcc_auth.routes_admin_instances import _require_cloud
from dcc_auth.routes_instance_applications import _require_user
from dcc_auth.routes_verbinden import _bremse_je_konto, verbinden_ausgelastet
from dcc_auth.verbinden_nachweis import server_info_instanz
from dcc_auth.verbinden_uebernahme import lebendige_uebernahme, widersprechen

log = logging.getLogger(__name__)

router = APIRouter(tags=["self-host"], dependencies=[Depends(_require_cloud)])

#: Dieselbe Antwort wie „Eintrag gehört dir nicht“ — kein Orakel dafür, ob
#: gegen eine fremde Instanz ein Antrag läuft.
_NICHT_GEFUNDEN = "Instanz nicht gefunden"


@router.post(
    "/me/instances/{instance_id}/uebernahme/widerspruch",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def widerspruch_einlegen(instance_id: str, request: Request, db: SessionDep) -> None:
    user = await _require_user(request, db)
    user_id = user.id
    # Die Route löst einen Abruf bei einem fremden Rechner aus.
    _bremse_je_konto(request, user_id)

    instanz = await eigene_instanz_oder_404(db, user_id, instance_id)
    if await lebendige_uebernahme(db, instanz.id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=_NICHT_GEFUNDEN)
    iid, hostname = instanz.id, instanz.hostname
    # Weder Transaktion noch Verbindung über den Abruf halten — er dauert bis
    # zu ``FRIST_S``.
    await db.rollback()
    try:
        gemeldet = await server_info_instanz(hostname)
    except Ausgelastet:
        raise verbinden_ausgelastet() from None
    if gemeldet != str(iid):
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "widerspruch_ohne_server"})

    # Dieselbe Zeile sperrt der Vollzug (``uebernahme_pruefen``): Widerspruch
    # und Übernahme kreuzen sich nicht. Ist der Antrag inzwischen vollzogen,
    # ist der Eintrag gelöscht, und es bleibt bei 404.
    instanz = await eigene_instanz_oder_404(db, user_id, instance_id, with_for_update=True)
    if not await widersprechen(db, instanz):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=_NICHT_GEFUNDEN)
    await db.commit()
    log.warning("verbinden_uebernahme_widerspruch alt=%s", iid)
