"""Wer einen Remote-Rechner (Standplatz-Gerät) wecken und steuern darf.

**Die Regel seit dem Eigentümer-Entscheid vom 2026-10-16:** Wecken
(``device_wake``) und eine Steuer-Anfrage an ein Gerät (``remote_request`` mit
``device_id``) verlangen zweierlei, beides am Standplatz des Geräts:

* ``VIEW_CHANNEL`` — wer den Kanal nicht sieht, sieht auch das Gerät nicht.
* Eine **nicht abgelaufene Zeile der Freigabeliste**, die den Anfragenden
  deckt (``device_grants.gedeckt``: Nutzer, eine seiner Rollen, oder
  ``everyone``). Eine leere Liste heisst: niemand.

``REMOTE_CONTROL`` spielt für Geräte **keine Rolle mehr** — weder nötig noch
hinreichend. Das Recht bleibt für die normale Fernsteuerung (Person bittet eine
streamende Person, die jedes Mal zustimmt); für einen Rechner, vor dem niemand
sitzt, entscheidet allein sein Besitzer über die Liste. Bis zum 2026-10-16 war
es umgekehrt: ``REMOTE_CONTROL`` am Standplatz genügte zum Wecken, und die Liste
sparte nur die Rückfrage am Gerät — ein Kanalrecht, das ein Admin vergibt, gab
damit Zugriff auf fremde Rechner.

``everyone`` heisst damit „jeder, der den Standplatz-Kanal sehen kann" — die
Sicht prüft diese Datei, die Liste nur die Person.

**Eine Stelle für alle Rufer**: Weckruf (``ws_device_handlers``), Anfrage
(``ws_remote_geraet``), Rechte-Wache (``remote_guard``), das Feld
``steuerbar`` der Geräteliste (``routes/devices.py``). Liefen die Latten
auseinander, beendete die Wache 30 s später, was der Aufbau gerade erlaubt hat
— oder die Liste böte einen Knopf an, der beim Klick 4062 bekommt.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select

from dcc_chat_gateway.device_grants import gedeckt
from dcc_chat_gateway.models import Device, DeviceGrant, MemberRole
from dcc_chat_gateway.permissions import Permissions, has_permission, resolve_permissions

#: Ergebnis von :func:`steuer_pruefung`. Drei Fälle statt eines ``bool``, weil
#: die Rufer sie verschieden beantworten: „unsichtbar" muss nach aussen wie „gibt
#: es nicht" klingen (4060/4051), „nicht freigegeben" darf es sagen (4062) —
#: wer den Kanal sieht, sieht das Gerät ohnehin in der Liste.
OK = "ok"
UNSICHTBAR = "unsichtbar"
NICHT_FREIGEGEBEN = "nicht_freigegeben"


async def rollen_von(session, guild_id: int, user_id: int) -> set[int]:
    """Die Rollenkennungen, die der Nutzer in dieser Community hält."""
    treffer = await session.execute(
        select(MemberRole.role_id).where(
            MemberRole.guild_id == guild_id,
            MemberRole.user_id == user_id,
        )
    )
    return set(treffer.scalars())


async def _freigaben(session, device_ids: Iterable[int]) -> dict[int, list[DeviceGrant]]:
    """Die Freigabezeilen mehrerer Geräte in EINER Abfrage."""
    kennungen = list(device_ids)
    je_geraet: dict[int, list[DeviceGrant]] = {d: [] for d in kennungen}
    if not kennungen:
        return je_geraet
    treffer = await session.execute(
        select(DeviceGrant).where(DeviceGrant.device_id.in_(kennungen))
    )
    for zeile in treffer.scalars():
        je_geraet.setdefault(zeile.device_id, []).append(zeile)
    return je_geraet


async def steuer_pruefung(session, user, device: Device) -> str:
    """Darf ``user`` dieses Gerät wecken und steuern? :data:`OK`,
    :data:`UNSICHTBAR` oder :data:`NICHT_FREIGEGEBEN`.

    Gemessen wird am Standplatz, den die ZEILE nennt — nie an einem Kanal, den
    der Rufer in seine Nachricht schreibt (Bughunt 2026-08-16, Kopf von
    ``routes/ws_remote_geraet.py``). Ein Nicht-Mitglied löst der Resolver auf
    null auf und landet damit bei „unsichtbar".
    """
    wert = await resolve_permissions(session, user, device.guild_id, device.channel_id)
    if not has_permission(wert, Permissions.VIEW_CHANNEL):
        return UNSICHTBAR
    zeilen = (await _freigaben(session, [device.id]))[device.id]
    # Ohne Zeilen gar nicht erst die Rollen lesen — der Regelfall einer leeren
    # Liste kostet so eine Abfrage weniger.
    if not zeilen:
        return NICHT_FREIGEGEBEN
    rollen = await rollen_von(session, device.guild_id, user.id)
    if gedeckt(zeilen, anfragender_id=user.id, rollen=rollen):
        return OK
    return NICHT_FREIGEGEBEN


async def steuerbar_je_geraet(session, user, devices: list[Device]) -> dict[int, bool]:
    """Das Feld ``steuerbar`` der Geräteliste, für jedes Gerät einmal.

    Dieselbe Regel wie :func:`steuer_pruefung`, nur gebündelt: Rechte je
    Standplatz einmal, Freigaben aller Geräte in einer Abfrage, Rollen je
    Community einmal. **Der Besitzer bekommt ``False``** — er kann sein eigenes
    Gerät nicht fernsteuern (die Anfrage nennt ihn selbst als Host, 4050), und
    ein Knopf, der garantiert scheitert, gehört nicht angeboten. Zusehen darf
    er trotzdem immer (``geraete_zuschauen.py``).

    Ein Schnappschuss zum Zeitpunkt des Abrufs: läuft eine Freigabe ab oder
    ändern sich Rollen/Kanalrechte, stimmt das Feld bis zum nächsten Abruf
    nicht mehr. Die Durchsetzung hängt daran nicht — Weckruf, Anfrage und Wache
    prüfen bei jeder Handlung frisch.
    """
    fremde = [d for d in devices if d.owner_user_id != user.id]
    ergebnis: dict[int, bool] = {d.id: False for d in devices}
    if not fremde:
        return ergebnis
    sicht: dict[int, bool] = {}
    for d in fremde:
        if d.channel_id not in sicht:
            wert = await resolve_permissions(session, user, d.guild_id, d.channel_id)
            sicht[d.channel_id] = has_permission(wert, Permissions.VIEW_CHANNEL)
    zeilen = await _freigaben(session, [d.id for d in fremde if sicht[d.channel_id]])
    rollen: dict[int, set[int]] = {}
    for d in fremde:
        if not sicht[d.channel_id] or not zeilen.get(d.id):
            continue
        if d.guild_id not in rollen:
            rollen[d.guild_id] = await rollen_von(session, d.guild_id, user.id)
        ergebnis[d.id] = gedeckt(zeilen[d.id], anfragender_id=user.id, rollen=rollen[d.guild_id])
    return ergebnis


async def sitzung_noch_gedeckt(session, controller, device_id: int, channel_id: int) -> bool:
    """Darf eine LAUFENDE Gerätesitzung weiterleben? (Rechte-Wache, R5.)

    Dieselbe Latte wie beim Aufbau, plus: die Zeile muss es noch geben, und sie
    muss noch im Kanal der Sitzung stehen. Ein verschwundenes oder umgestelltes
    Gerät beenden zwar schon ``delete_device``/``patch_device`` selbst — die
    Wache fängt hier, was zwischen zwei Prozessen oder durch einen
    Kaskaden-Pfad durchrutscht, und sie fängt es fail-closed.
    """
    device = await session.get(Device, device_id)
    if device is None or device.channel_id != channel_id:
        return False
    return await steuer_pruefung(session, controller, device) == OK


async def sitzungen_ohne_freigabe_beenden(session, manager, device_id: int) -> int:
    """Laufende Sitzungen dieses Geräts sofort nachprüfen und beenden, wo die
    Freigabe nicht mehr trägt. Gerufen nach dem Ersetzen der Liste.

    Die Wache (``remote_guard``) fängt dasselbe im 30-s-Takt; hier geht es um
    den ausdrücklichen Entzug, der wie Rauswurf und Bann sofort wirken soll.
    Ein Steuernder ohne bekannten Socket (Gnadenfrist) wird hier übergangen —
    über ihn entscheidet die Wache mit ihren eigenen Regeln, sobald er zurück
    ist oder die Frist endet. Gibt zurück, wie viele beendet wurden.
    """
    if manager is None:
        return 0
    beendet = 0
    for sess in manager.remote_sessions_snapshot():
        if sess.device_id != str(device_id):
            continue
        steuernder = manager.remote_socket_user(sess.controller_socket)
        if steuernder is None:
            continue
        try:
            kanal = int(sess.channel_id)
        except ValueError:
            kanal = -1
        if await sitzung_noch_gedeckt(session, steuernder, device_id, kanal):
            continue
        if await manager.remote_terminate(sess.session_id, "permission_revoked") is not None:
            beendet += 1
    return beendet
