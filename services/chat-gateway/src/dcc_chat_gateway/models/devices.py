"""Standplatz-Geräte: ein Rechner, der in einem Kanal steht, ohne dort
Teilnehmer zu sein.

Entwurf und Begründungen:
``docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md``.

**Warum die Zeile überhaupt existiert.** Die Dauerfreigabe lebte in Stufe 1
vollständig auf dem Gerät und brauchte den Server nicht (seit 2026-08-20 liegt
sie als ``DeviceGrant`` hier). Was sie nicht leisten konnte, ist der zweite
Teil des Problems: ein Gerät braucht einen **Ort**, an dem
man es findet und an dem festgelegt ist, wer es benutzen darf. Diese Tabelle ist
dieser Ort.

**Der Kanal ist der Rechteanker, nicht Zierde.** An ihm hängt, wer das Gerät
überhaupt sieht (``VIEW_CHANNEL`` über ``resolve_permissions(user, guild_id,
channel_id)``), und die Rechte-Wache im 30-s-Takt (``remote_guard.py``) misst
dort nach. WER es wecken und steuern darf, legt seit 2026-10-16 allein die
Freigabeliste (``DeviceGrant`` unten) fest — und zwar nur für Leute, die den
Standplatz sehen (``geraete_freigabe.py``). ``REMOTE_CONTROL`` als
Kanal-Overwrite zählt für Geräte nicht mehr. Ein Gerät ohne Kanal hätte keine
Sicht-Schranke; deshalb ist ``channel_id`` nicht optional.

**Ein Standplatz je Gerät.** Sollen mehrere Teams zugreifen, regelt das eine
Rolle in der Freigabeliste. Mit mehreren Standplätzen bräuchte es eine
Zuordnungstabelle und eine Entscheidung, welcher Kanal gilt, wenn zwei Leute
aus verschiedenen Kanälen gleichzeitig wollen — dieselbe Frage wie bei
Kanal-Overwrites, nur ohne deren Rangfolge.

**``cert_id`` ist die Bindung an den Rechner**, nicht an das Konto: die Kennung
des Geräteausweises, mit dem sich dieser Rechner eingetragen hat
(``issued_credentials`` in der Cloud-Datenbank, siehe §6 des Entwurfs). Sie
steht hier als Zeichenkette und nicht als Fremdschlüssel — die Tabelle gehört
einem anderen Dienst, und Dienste teilen sich in Pulse keine Tabellen.
Nullable, weil der Ausweisbezug in der Cloud heute noch nicht im Zugangs-Token
steht (die ehrliche Lücke aus §6): dort trägt vorerst das Konto allein.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base

#: Längstmöglicher Gerätename. Grosszügig genug für „werkstatt-pc-hinten-links",
#: kurz genug, dass er in der Kanalliste nicht zur Wand wird.
DEVICE_NAME_MAX_LEN = 64


class Device(Base):
    """Ein eingetragenes Standplatz-Gerät."""

    __tablename__ = "devices"

    #: Snowflake (Worker 2 = chat), als String über die API.
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    guild_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("guilds.id", ondelete="CASCADE"), nullable=False
    )
    #: Der Standplatz. ``CASCADE``: verschwindet der Kanal, verschwindet der
    #: Ort, an dem die Rechte hingen — ein Gerät ohne Rechteanker darf nicht
    #: zurückbleiben (es wäre für niemanden mehr sichtbar und für jeden mit
    #: Guild-Zugriff erreichbar).
    channel_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    #: Wem das Gerät gehört — darf es umbenennen, umstellen und entfernen.
    owner_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    name: Mapped[str] = mapped_column(String(DEVICE_NAME_MAX_LEN), nullable=False)
    #: Geräteausweis, mit dem sich dieser Rechner eingetragen hat (s. Modulkopf).
    cert_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # Zwei Geräte gleichen Namens in einer Community wären in der Kanalliste
        # nicht auseinanderzuhalten — und genau dort trifft jemand die
        # Entscheidung, welchen fremden Rechner er übernimmt.
        UniqueConstraint("guild_id", "name", name="uq_devices_guild_name"),
        # Ein Rechner trägt sich in EINER Community je Konto genau einmal ein.
        # Ohne das entstünden bei einem doppelten Klick zwei Zeilen für denselben
        # Rechner, und beim Wecken wäre nicht entscheidbar, welche gemeint ist.
        # Nur wirksam, wo der Ausweis bekannt ist (s. Modulkopf).
        #
        # **Der Besitzer steht mit im Schlüssel** (Bughunt 2026-08-16), weil die
        # Kennung ungeprüft aus dem Request kommt: ohne ihn besetzt jeder, der
        # eine fremde Ausweiskennung kennt, deren Platz — und der echte Rechner
        # bekommt beim Eintragen für immer 409. Gegen den Unfall, für den die
        # Regel gedacht ist, wirkt sie unverändert (immer dasselbe Konto).
        UniqueConstraint(
            "guild_id", "owner_user_id", "cert_id", name="uq_devices_guild_cert"
        ),
        # Die Liste wird immer je Kanal gelesen (Kanalliste, Mitgliederliste).
        Index("ix_devices_channel", "channel_id"),
    )


#: Die drei Arten, auf die eine Freigabe jemanden meinen kann.
#:
#: ``everyone`` heisst seit 2026-10-16 „jeder, der den Standplatz-Kanal sehen
#: kann" (``VIEW_CHANNEL``; vorher: jeder mit ``REMOTE_CONTROL`` dort). Es ist
#: keine Abkürzung an der Sichtprüfung vorbei — die macht
#: ``geraete_freigabe.steuer_pruefung`` immer zuerst. Eine leere Liste heisst:
#: niemand darf wecken oder steuern.
SUBJECT_USER = "user"
SUBJECT_ROLE = "role"
SUBJECT_EVERYONE = "everyone"
SUBJECT_TYPES = (SUBJECT_USER, SUBJECT_ROLE, SUBJECT_EVERYONE)


class DeviceGrant(Base):
    """Eine Zeile der Freigabeliste eines Geräts — wer es wecken und steuern
    darf (seit 2026-10-16 die einzige Tür, ``geraete_freigabe.py``).

    **Warum die Zeile keinen Kanal trägt.** Die alte, gerätelokale Fassung
    speicherte zu jeder Freigabe den Kanal, in dem sie erteilt wurde — sonst
    stimmte sie einer Anfrage zu, die einen ganz anderen Kanal nannte, und der
    Standplatz samt seinem Overwrite war umgangen. Hier ist der Ort implizit der
    Standplatz des Geräts, und geprüft wird die Sicht genau dort
    (``geraete_freigabe.steuer_pruefung``). Das Loch kann damit nicht
    wiederkommen.

    **Abgelaufene Zeilen werden nicht gefegt**, sondern beim Auflösen ignoriert
    und beim nächsten Setzen derselben Freigabe überschrieben. Ein Fegelauf wäre
    ein Hintergrund-Task für Zeilen, die niemanden stören.
    """

    __tablename__ = "device_grants"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    device_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False
    )
    subject_type: Mapped[str] = mapped_column(String(16), nullable=False)
    #: Nutzer- oder Rollenkennung; NULL bei ``everyone``.
    subject_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    #: NULL = dauerhaft.
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    created_by_user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "device_id", "subject_type", "subject_id", name="uq_device_grants_subject"
        ),
        Index("ix_device_grants_device", "device_id"),
    )
