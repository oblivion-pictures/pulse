"""User-facing Self-Hoster endpoints — Phase 2.2.

POST   /me/instances                          -- eigenen Heim-Server anlegen
GET    /me/instances                          -- eigene registrierte Instanzen
POST   /me/instances/{id}/bootstrap-token     -- One-Time-Token (Server-App)

Antrag (``/me/instance-applications``) und ``.env``-Download sind seit Oktober
2026 entfernt (Spec E11) — ein gemieteter Server verbindet sich per Gerätecode
selbst (``routes_verbinden.py``). Beitritt, Austritt und die Server-Präferenzen
liegen in ``routes_instance_membership.py`` (Größen-Policy).
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select

from dcc_auth.bootstrap import (
    bootstrap_redeemed,
    drop_unredeemed_tokens,
    generate_bootstrap_token,
    hash_bootstrap_token,
)
from dcc_auth.browser_sessions import user_and_session_from_cookie
from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.instance_provisioning import (
    eigene_instanz_oder_404,
    provision_app_host_instance,
    user_has_active_owner_instance,
)
from dcc_auth.instance_status import online_aussage
from dcc_auth.models import User
from dcc_auth.models_instances import (
    InstanceBootstrapToken,
    RegisteredInstance,
    UserInstanceMembership,
)
from dcc_auth.routes import _check_rate
from dcc_auth.snowflake import next_id

router = APIRouter(tags=["self-host"])

# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------


async def _require_user(request: Request, db) -> User:
    """Validate session cookie → User.  Raises HTTP 401 on failure."""
    user, _ = await _require_user_mit_sitzung(request, db)
    return user


async def _require_user_mit_sitzung(request: Request, db):
    """Wie ``_require_user``, gibt aber auch die Sitzungszeile zurück.

    Die Zeile trägt ``amr``/``acr`` — wie sich der Nutzer bei UNS ausgewiesen
    hat. Das Serverticket reicht das an den Self-Host weiter, damit der für
    heikle Aktionen einen zweiten Faktor verlangen kann. Wer nur den ``User``
    hat, kann das nicht wissen und schriebe stillschweigend „Passwort" hin.
    """
    return await user_and_session_from_cookie(request, db)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class InstanceOut(BaseModel):
    id: str  # Snowflake-String-API
    hostname: str
    client_id: str
    # ``None`` für Einträge ab Migration 0056 (verbundene und neue Heim-Server).
    worker_id_chat: int | None
    worker_id_voice: int | None
    worker_id_media: int | None
    status: Literal["active", "suspended"]
    # vps = gemieteter Server mit eigener Adresse, app_host = Heim-Server
    # (Server-App). „Meine Server“ führt beide und beschriftet die Heim-Server.
    origin: Literal["vps", "app_host"] = "vps"
    registered_at: datetime
    # Per-User-Präferenzen aus user_instance_memberships (account-basiert →
    # geräteübergreifend). NULL/Default, wenn keine Membership im Kontext.
    user_label: str | None = None
    notification_mode: Literal["all", "mentions", "none"] = "mentions"
    # Eigene Rolle auf DIESER Instanz. Die Liste beantwortet „mit welchen
    # Servern habe ich zu tun", nicht „welche gehören mir" — ein per Einladung
    # beigetretener Server steht mit ``member`` darin, damit er auf allen
    # Geräten in der Server-Leiste erscheint. Ohne dieses Feld kann die
    # Oberfläche Besitz und Mitgliedschaft nicht unterscheiden.
    role: Literal["owner", "member"]
    # „Sind die Zugangsdaten dieses Servers schon abgeholt worden?" — der
    # Installer wurde eingelöst ODER (bis Oktober 2026) die ``.env``
    # heruntergeladen (dieselbe Frage wie ``bootstrap_redeemed``, s.
    # ``_versorgte_instanzen``).
    #
    # Der Klient nimmt einen Server erst DANN in seine Leiste auf. Vorher steht
    # er nur unter „Eigener Server", wo auch der Knopf sitzt, mit dem man ihn
    # einrichtet. Ohne das Feld erschien er in der Sekunde der Freigabe — mit
    # totem Status-Punkt und einer Erklärung, die nur im Tooltip stand.
    #
    # Vorgabe ``False``: ein Feld, das im Zweifel „eingerichtet" behauptet,
    # brächte genau den Zustand zurück, den es abstellen soll.
    set_up: bool = False
    # Name, den der Betreiber dem Server gegeben hat (Migration 0055) — die
    # Leiste zeigt ihn statt der Adresse. NULL = keiner gesetzt.
    anzeigename: str | None = None
    # Nur App-Hosts (Heim-Server): läuft er gerade? Die Leiste blendet einen
    # gestoppten aus. VPS-Instanzen melden sich nicht beim Telefonbuch —
    # dort bleibt das Feld ``None`` (= unbekannt, NICHT ausblenden).
    online: bool | None = None
    # Eintrag aus dem Verbinden per Gerätecode statt aus einem Antrag.
    ohne_freigabe: bool = False
    # Ein anderes Konto will diesen eigenen Server übernehmen: Fristende des
    # lebendigen Antrags (ISO 8601), sonst NULL (verbinden_uebernahme.py).
    uebernahme_frist_bis: str | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _instance_to_out(
    inst: RegisteredInstance,
    viewer_id: int,
    membership: UserInstanceMembership | None = None,
    *,
    set_up: bool = False,
    uebernahme_frist_bis: str | None = None,
) -> InstanceOut:
    return InstanceOut(
        id=str(inst.id),
        # App-Host-Instanzen tragen als ``hostname`` nur einen synthetischen
        # Platzhalter (``app-<id>.…``, bei der Approval vergeben, existiert im
        # DNS nicht). Erreichbar sind sie unter der Relay-Subdomain, die erst
        # beim Pairing entsteht. Der Client baut aus diesem Feld seine
        # Server-URL — ohne den Fallback zeigt er auf einen toten Host und der
        # Cert-Login scheitert mit 401 (``cert_invalid``).
        #
        # NUR für App-Hosts: ein VPS hat eine echte Adresse; eine (fälschlich
        # oder historisch) vergebene Relay-Subdomain darf sie NIE verdrängen —
        # Clients synchronisieren dieses Feld in ihre Server-Liste und
        # verbänden sich sonst gegen einen toten Tunnel (Vorfall 2026-07-14).
        hostname=(
            (inst.relay_subdomain or inst.hostname)
            if inst.origin == "app_host"
            else inst.hostname
        ),
        client_id=inst.client_id,
        worker_id_chat=inst.worker_id_chat,
        worker_id_voice=inst.worker_id_voice,
        worker_id_media=inst.worker_id_media,
        status=inst.status,  # type: ignore[arg-type]
        origin=inst.origin,  # type: ignore[arg-type]
        registered_at=inst.registered_at,
        user_label=membership.user_label if membership else None,
        notification_mode=(
            membership.notification_mode if membership else "mentions"  # type: ignore[arg-type]
        ),
        # BEWUSST aus ``registered_by``, nicht aus ``membership.role``: die
        # Verwaltungs-Routen (bootstrap-token, DELETE) verriegeln
        # genau gegen dieses Feld. Eine Rollen-Spalte, die davon abwiche, ließe
        # die Oberfläche Knöpfe zeigen, die anschließend 404 laufen.
        role="owner" if inst.registered_by == viewer_id else "member",
        set_up=set_up,
        anzeigename=inst.anzeigename,
        online=online_aussage(inst),
        ohne_freigabe=inst.ohne_freigabe,
        uebernahme_frist_bis=uebernahme_frist_bis,
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


async def _versorgte_instanzen(db, instanz_ids: list[int]) -> set[int]:
    """Welche dieser Instanzen haben ihre Zugangsdaten schon bekommen?

    Dieselbe Frage wie ``bootstrap_redeemed`` — nur für viele Instanzen auf
    einmal, weil die Liste sie sonst einzeln stellen müsste (N+1). Es zählen
    DREI Wege: das eingelöste Installer-Token, der frühere ``.env``-Download
    (entfernt im Oktober 2026; sein Zeitstempel ``env_file_downloaded_at``
    zählt für Bestandsserver weiter, sonst fielen sie aus der Leiste ihrer
    Mitglieder) und seit Migration 0056 das Abholen beim Verbinden per
    Gerätecode (``verbunden_at``). Ein bloss ausgestelltes Token oder ein
    bestätigter, aber nie abgeholter Code zählt nicht; dort läuft noch kein
    Server.

    Der Klient hängt daran, ob er den Server in seine Leiste aufnimmt: bis
    2026-08-27 tat er das, sobald die Instanz genehmigt war — der Nutzer sah
    dort einen Server, den es noch nirgends gab, samt totem Status-Punkt.
    """
    if not instanz_ids:
        return set()
    eingeloest = (
        await db.execute(
            select(InstanceBootstrapToken.instance_id)
            .where(
                InstanceBootstrapToken.instance_id.in_(instanz_ids),
                InstanceBootstrapToken.consumed_at.is_not(None),
            )
            .distinct()
        )
    ).scalars().all()
    geladen = (
        await db.execute(
            select(RegisteredInstance.id).where(
                RegisteredInstance.id.in_(instanz_ids),
                RegisteredInstance.env_file_downloaded_at.is_not(None)
                | RegisteredInstance.verbunden_at.is_not(None),
            )
        )
    ).scalars().all()
    return set(eingeloest) | set(geladen)


class InstanceSelfServiceCreated(BaseModel):
    """Antwort der Selbstbedienungs-Registrierung. ``client_secret`` wird
    EINMAL im Klartext geliefert (in der DB liegt nur der Hash) — die
    Server-App stopft es in die Container-Env-Datei, danach ist es weg."""

    instance: InstanceOut
    client_secret: str


@router.post(
    "/me/instances",
    response_model=InstanceSelfServiceCreated,
    status_code=status.HTTP_201_CREATED,
)
async def create_my_instance(request: Request, db: SessionDep) -> InstanceSelfServiceCreated:
    """Selbstbedienung: den eigenen Heim-Server registrieren (Heim-Server-
    Entscheidung 2026-09-27). Ersetzt die alte Antrags+Freischalt-Strecke:
    wer eingeloggt ist, bekommt sofort seine Instanz — kein Admin-Blick.

    Hart limitiert auf EINE aktive Owner-Instanz pro Konto (409 sonst);
    ``self_host_enabled`` setzt der Endpoint selbst. ``client_secret`` kommt
    einmalig im Klartext zurück, danach nur noch Rotations-Wege (Pairing/
    Bootstrap-Reset)."""
    user = await _require_user(request, db)
    settings = get_settings()
    await _check_rate(request, "instance_create", settings.rate_limit_instance_create)

    if await user_has_active_owner_instance(db, user.id):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="diesem Konto ist bereits ein eigener Server zugeordnet",
        )

    secret = secrets.token_urlsafe(32)
    user.self_host_enabled = True
    instance_id = await provision_app_host_instance(db, user.id, plain_secret=secret)
    await db.commit()

    inst = await db.get(RegisteredInstance, instance_id)
    assert inst is not None  # soeben geschrieben
    membership = (
        await db.execute(
            select(UserInstanceMembership).where(
                UserInstanceMembership.instance_id == instance_id,
                UserInstanceMembership.user_id == user.id,
            )
        )
    ).scalars().first()
    return InstanceSelfServiceCreated(
        instance=_instance_to_out(inst, user.id, membership),
        client_secret=secret,
    )


@router.get(
    "/me/instances",
    response_model=list[InstanceOut],
)
async def list_my_instances(
    request: Request,
    db: SessionDep,
) -> list[InstanceOut]:
    """Eigene registrierte Instanzen abrufen. client_secret wird NIE zurückgegeben."""
    user = await _require_user(request, db)

    # Liest aus ``user_instance_memberships`` (= Account-basierte Server-Liste).
    # Vor dem Vault-Drop (Migration 0026 → 0037) war das ein Filter über
    # ``registered_by`` — die neue Tabelle ist die Quelle der Wahrheit und
    # erlaubt später auch eingeladene Nicht-Owner-User (Phase 4-6).
    # Soft-delete (routes_instance_delete) ausblenden.
    stmt = (
        select(RegisteredInstance, UserInstanceMembership)
        .join(
            UserInstanceMembership,
            UserInstanceMembership.instance_id == RegisteredInstance.id,
        )
        .where(
            UserInstanceMembership.user_id == user.id,
            RegisteredInstance.status != "deleted",
        )
        .order_by(RegisteredInstance.registered_at.desc())
    )
    rows = (await db.execute(stmt)).all()
    versorgt = await _versorgte_instanzen(db, [inst.id for inst, _ in rows])
    # Spät importiert: verbinden_uebernahme → verbinden_eintrag →
    # routes_instance_delete importiert dieses Modul.
    from dcc_auth.verbinden_uebernahme import uebernahme_fristen

    # Nur am eigenen Eintrag — widersprechen kann nur der Besitzer.
    eigene = [inst.id for inst, _ in rows if inst.registered_by == user.id]
    fristen = await uebernahme_fristen(db, eigene)
    return [
        _instance_to_out(
            inst,
            user.id,
            membership,
            set_up=inst.id in versorgt,
            uebernahme_frist_bis=fristen.get(inst.id),
        )
        for inst, membership in rows
    ]


class ReissueIn(BaseModel):
    """Optionaler Body des „Zugang neu ausstellen"-Pfads am Bootstrap-Mint.

    ``reset=true`` hebt die One-Shot-Sperre auf — der bewusste Recovery-Weg
    nach Geräteverlust (Server-App). Das Einlösen rotiert die Credentials,
    alte sterben sofort. Bis Oktober 2026 teilte sich der ``.env``-Download
    dasselbe Modell; der Download ist entfernt (Spec E11).
    """

    reset: bool = False


# ---------------------------------------------------------------------------
# Server-App (Heim-Server) — Mint eines One-Time-Bootstrap-Tokens
# ---------------------------------------------------------------------------


class BootstrapTokenOut(BaseModel):
    token: str
    expires_at: datetime
    ttl_seconds: int


@router.post(
    "/me/instances/{instance_id}/bootstrap-token",
    response_model=BootstrapTokenOut,
    status_code=status.HTTP_201_CREATED,
)
async def mint_bootstrap_token(
    instance_id: str,
    request: Request,
    db: SessionDep,
    payload: ReissueIn | None = None,
) -> BootstrapTokenOut:
    """Mintet einen One-Time-Bootstrap-Token für die Server-App (Heim-Server).

    Nur der Owner der Instanz und nur für ``origin="app_host"`` (404 statt 403
    gegen Existence-Leak). Räumt alle
    vorherigen, nicht-eingelösten Tokens dieser Instanz weg — ein „neu
    generieren" entwertet den alten sofort. Nach erfolgreichem Redeem sind
    weitere Mints geblockt (Hijack-Härtung: eine gekaperte Session kann keine
    laufende Instanz still übernehmen) — AUSSER der Owner setzt explizit
    ``reset=true``: der bewusste Recovery-Pfad nach Gerätewechsel/Creds-Verlust.
    Das Einlösen rotiert client_secret + Tunnel-Token, ein alter Server verliert
    damit sofort seinen Cloud-Zugang — es entstehen nie zwei lebende Server aus
    einer Instanz. Token-Verlust vor Redeem (TTL abgelaufen) erlaubt weiteres
    Mint.
    """
    user = await _require_user(request, db)
    settings = get_settings()
    await _check_rate(request, "bootstrap_mint", settings.rate_limit_bootstrap_mint)

    inst = await eigene_instanz_oder_404(db, user.id, instance_id)
    iid = inst.id
    # Einen Bootstrap-Token löst nur noch die Server-App ein (Heim-Server,
    # ``app_host``). Ein gemieteter Server verbindet sich per ``pulse-connect``,
    # und der Installer nimmt seit Oktober 2026 keinen Token mehr an. Ein Mint
    # wäre hier nur ein zweiter Weg zu frischen Zugangsdaten, an Gerätecode und
    # Widerspruchsfrist vorbei. 404 wie für eine fremde Instanz.
    if inst.origin != "app_host":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Instanz nicht gefunden")

    # One-shot nach erfolgreichem Setup: ein bereits eingelöstes Token
    # blockiert weitere Mints — außer beim expliziten Reset (s. Docstring).
    # Audit-Spur bleibt in der Token-Tabelle (Redeem setzt nur consumed_at,
    # löscht nicht; auch der Reset löscht nur uneingelöste Tokens).
    if await bootstrap_redeemed(db, iid) and not (payload and payload.reset):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="Bootstrap bereits eingelöst — neu ausstellen nur mit reset=true",
        )

    await drop_unredeemed_tokens(db, iid)

    token = generate_bootstrap_token()
    ttl = settings.bootstrap_token_ttl_seconds
    expires_at = datetime.now(UTC) + timedelta(seconds=ttl)
    db.add(
        InstanceBootstrapToken(
            id=next_id(),
            instance_id=iid,
            token_hash=hash_bootstrap_token(token),
            expires_at=expires_at,
        )
    )
    await db.commit()
    return BootstrapTokenOut(token=token, expires_at=expires_at, ttl_seconds=ttl)
