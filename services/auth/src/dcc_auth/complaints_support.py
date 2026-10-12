"""Schemas + helpers for the complaint (abuse report) endpoints.

Split out of ``routes_complaints.py`` to keep that module under the size policy.
Holds the Pydantic request/response models, the operator-email lookup (a
RegisteredInstance carries no contact address itself — it is the contact email of
the approved InstanceApplication or, for servers connected without one, the
owner's account email), and the per-page list enrichment.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select

from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.models_instances import Complaint, InstanceApplication, RegisteredInstance

VALID_STATUSES = {"new", "acknowledged", "forwarded", "resolved"}


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ComplaintCreate(BaseModel):
    body: Annotated[str, Field(min_length=10, max_length=5000)]
    target_url: Annotated[str | None, Field(default=None, max_length=500)] = None
    target_instance_id: int | None = None
    target_user_id: int | None = None
    submitter_email: EmailStr | None = None
    # NOTE: the reporter's user-id is NEVER accepted from the request body — a
    # spoofed value would let anyone inject an automated "Pulse" DM to an
    # arbitrary user on resolve. It is derived server-side from the caller's
    # access token in ``submit_report`` instead.


class ComplaintOut(BaseModel):
    id: str
    status: str
    submitted_at: datetime
    body: str
    target_url: str | None = None
    target_instance_id: str | None = None
    target_user_id: str | None = None
    submitter_email: str | None = None
    resolution_note: str | None = None
    resolved_at: datetime | None = None
    # Forward audit trail.
    forwarded_at: datetime | None = None
    forwarded_to_email: str | None = None
    forward_notice: str | None = None
    # Enrichment (admin-only context, resolved per page — never persisted here).
    target_instance_hostname: str | None = None
    operator_email: str | None = None
    target_username: str | None = None

    @classmethod
    def from_row(
        cls,
        row: Complaint,
        *,
        instance_hostname: str | None = None,
        operator_email: str | None = None,
        target_username: str | None = None,
    ) -> ComplaintOut:
        return cls(
            id=str(row.id),
            status=row.status,
            submitted_at=row.submitted_at,
            body=row.body,
            target_url=row.target_url,
            target_instance_id=(
                str(row.target_instance_id) if row.target_instance_id is not None else None
            ),
            target_user_id=(
                str(row.target_user_id) if row.target_user_id is not None else None
            ),
            submitter_email=row.submitter_email,
            resolution_note=row.resolution_note,
            resolved_at=row.resolved_at,
            forwarded_at=row.forwarded_at,
            forwarded_to_email=row.forwarded_to_email,
            forward_notice=row.forward_notice,
            target_instance_hostname=instance_hostname,
            operator_email=operator_email,
            target_username=target_username,
        )


class ForwardIn(BaseModel):
    notice_text: Annotated[str, Field(min_length=1, max_length=5000)]


class ForwardResult(BaseModel):
    id: str
    status: str
    # Whether a notice email was actually dispatched to the operator. False when
    # no operator contact is on file or SMTP isn't configured — the status is
    # still advanced so the admin's decision is recorded, but the UI can warn.
    email_sent: bool
    email_error: str | None = None
    forwarded_to_email: str | None = None


class ResolveIn(BaseModel):
    # max_length wie body/notice_text (5000) — sonst kann ein Admin via
    # /admin/complaints/{id}/resolve einen unbegrenzten resolution_note schreiben
    # (Storage-Abuse / DB-Bloat). Großzügig genug für jede echte Notiz.
    resolution_note: Annotated[str, Field(max_length=5000)]


# ---------------------------------------------------------------------------
# Operator lookup + list enrichment
# ---------------------------------------------------------------------------


def _bestaetigte_mail(user: User | None) -> str | None:
    """Die Konto-Mail nur, wenn sie bestätigt ist. Verbinden geht auch mit einem
    unbestätigten Konto, und die Weiterleitung schickt den Text der Beschwerde
    mit — an eine nie bestätigte Adresse soll er nicht gehen."""
    if user is None or user.email_verified_at is None:
        return None
    return user.email


async def resolve_operator(
    session: SessionDep, instance_id: int | None
) -> tuple[str | None, str | None]:
    """Return ``(hostname, operator_email)`` for a registered instance.

    Either element is ``None`` when unavailable. The operator address is the
    contact email of the approved ``InstanceApplication`` — set by servers that
    were approved before October 2026 — or else the owner's account email, if
    it is verified: a server connected via ``pulse-connect`` has no application
    row at all.
    """
    if instance_id is None:
        return None, None
    instance = await session.get(RegisteredInstance, instance_id)
    hostname = instance.hostname if instance is not None else None
    app = (
        await session.execute(
            select(InstanceApplication)
            .where(InstanceApplication.approved_instance_id == instance_id)
            .order_by(InstanceApplication.created_at.desc())
        )
    ).scalars().first()
    operator_email = app.contact_email if app is not None else None
    if not operator_email and instance is not None and instance.registered_by is not None:
        owner = await session.get(User, instance.registered_by)
        operator_email = _bestaetigte_mail(owner)
    return hostname, operator_email


async def enrich_complaints(
    session: SessionDep, rows: list[Complaint]
) -> list[ComplaintOut]:
    """Map a page of complaints to enriched output.

    Adds human-readable context — instance hostname, the operator's contact
    email (so the admin sees whether forwarding is possible), and the reported
    user's name. Batched per page via ``IN`` queries — no N+1.
    """
    instance_ids = {r.target_instance_id for r in rows if r.target_instance_id is not None}
    user_ids = {r.target_user_id for r in rows if r.target_user_id is not None}

    hostnames: dict[int, str] = {}
    operator_emails: dict[int, str] = {}
    owner_ids: dict[int, int] = {}
    usernames: dict[int, str] = {}

    if instance_ids:
        for inst in (
            await session.execute(
                select(RegisteredInstance).where(RegisteredInstance.id.in_(instance_ids))
            )
        ).scalars():
            hostnames[inst.id] = inst.hostname
            if inst.registered_by is not None:
                owner_ids[inst.id] = inst.registered_by
        for app in (
            await session.execute(
                select(InstanceApplication).where(
                    InstanceApplication.approved_instance_id.in_(instance_ids)
                )
            )
        ).scalars():
            # First seen wins; multiple approved apps per instance is not expected.
            if app.contact_email:
                operator_emails.setdefault(app.approved_instance_id, app.contact_email)
        # Without an application (connected via pulse-connect) the owner's
        # account email is the contact, same rule as ``resolve_operator``.
        fehlend = {iid: uid for iid, uid in owner_ids.items() if iid not in operator_emails}
        if fehlend:
            emails = {
                u.id: _bestaetigte_mail(u)
                for u in (
                    await session.execute(select(User).where(User.id.in_(set(fehlend.values()))))
                ).scalars()
            }
            for iid, uid in fehlend.items():
                if emails.get(uid):
                    operator_emails[iid] = emails[uid]
    if user_ids:
        for u in (
            await session.execute(select(User).where(User.id.in_(user_ids)))
        ).scalars():
            usernames[u.id] = u.username

    return [
        ComplaintOut.from_row(
            r,
            instance_hostname=hostnames.get(r.target_instance_id),
            operator_email=operator_emails.get(r.target_instance_id),
            target_username=usernames.get(r.target_user_id),
        )
        for r in rows
    ]
