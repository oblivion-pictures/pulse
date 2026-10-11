"""Anfrage- und Antwortmodelle der Verbinden-Routen (``routes_verbinden.py``).

Ausgelagert, damit die Routen-Datei unter der Größengrenze bleibt.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from dcc_auth.zugangsdaten import ZugangsdatenOut


class StartEin(BaseModel):
    hostname: str = Field(..., min_length=1, max_length=253)
    #: Die geheime Abholkennung des Servers. Die Cloud bildet daraus den
    #: Nachweis und vergisst sie wieder — gespeichert wird nur der Hash.
    kennung: str = Field(..., min_length=32, max_length=128)


class StartAus(BaseModel):
    code: str
    link: str
    gueltig_s: int
    abstand_s: int


class AbholenEin(BaseModel):
    kennung: str = Field(..., min_length=32, max_length=128)


class VerbindenZugangOut(ZugangsdatenOut):
    #: Der Name, den ``pulse-connect`` im Terminal nennt („Connected to …“) —
    #: so sieht der Betreiber, wessen Klick den Server bekommen hat.
    owner_name: str


class VorgangAus(BaseModel):
    hostname: str
    gueltig_bis: str
    #: Die Adresse ist für ein anderes Konto eingetragen: „Verbinden“ stellt
    #: dann nur einen Übernahme-Antrag (``verbinden_uebernahme.py``). Kein
    #: Name, keine Nummer — die Seite warnt nur.
    adresse_vergeben: bool = False


class VorgangEin(BaseModel):
    #: Wie getippt oder aus dem Link übernommen; ``code_normalisieren`` macht
    #: daraus die Speicherform.
    code: str = Field(..., min_length=1, max_length=32)


class EntscheidungEin(VorgangEin):
    aktion: Literal["verbinden", "ablehnen"]


class EntscheidungAus(BaseModel):
    status: Literal["verbunden", "abgelehnt", "uebernahme_beantragt"]
    hostname: str | None = None
    instance_id: str | None = None
    #: Nur bei ``uebernahme_beantragt``: ab wann der Antrag vollzogen werden
    #: kann (ISO 8601).
    frist_bis: str | None = None
