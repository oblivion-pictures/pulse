"""Das Ende einer Anmelde-Kette — von auth-svc an den chat-gateway (iOS-Bughunt 2, C2).

**Warum es diese Nachricht gibt.** Ein Telefon meldet beim chat-gateway zwei
Gerätetoken an: den FCM-Token für Nachrichten-Banner und den PushKit-Token
fürs Klingeln. Bis zum 2026-10-11 lebten beide unabhängig von der Anmeldung
weiter: wurde die Sitzung eines verlorenen Telefons unter „Sitzungen beenden"
widerrufen, das Passwort zurückgesetzt oder das Konto gesperrt, zeigte das
Telefon weiter Banner mit Absendernamen und klingelte mit dem Namen des
Anrufers. Das Abmelden im Klienten half nicht — es läuft auf dem Gerät, das
gerade verloren ist.

**Woran sich ein Token einer Kette zuordnen lässt.** auth-svc stempelt die
Anmelde-Kette (``refresh_tokens.family_id``, Migration 0050) als Claim
``kette`` ins Zugriffs-Token; der chat-gateway legt ihn neben den Gerätetoken
ab, wenn das Telefon sie anmeldet. Die Kette überlebt jede Rotation und
beschreibt damit das Gerät, nicht den einzelnen Ausweis.

**Der Weg ist Redis Pub/Sub** (Dienste teilen keine Tabellen). Ein Ereignis,
das ankommt, während kein chat-gateway zuhört (Neustart beim Ausrollen), geht
verloren — die Token bleiben dann stehen, bis das Gerät sich das nächste Mal
anmeldet oder abmeldet. Das ist der Stand von vorher, nicht schlechter.

Zwei Formen:

* ``ketten`` — genau diese Ketten sind zu Ende (Abmelden, Sitzung beenden,
  Diebstahlsverdacht, Passwortwechsel für die übrigen Geräte).
* ``alle`` — jede Kette des Kontos ist zu Ende (Passwort-Reset, Sperre). Dann
  fallen auch Token ohne Kettenvermerk, die vor dieser Änderung angemeldet
  wurden.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass

#: Redis-Kanal. auth-svc veröffentlicht, chat-gateway hört zu.
KANAL = "auth:ketten_ende"

#: Name des Claims im Zugriffs-Token.
CLAIM = "kette"


@dataclass(frozen=True)
class KettenEnde:
    user_id: int
    ketten: frozenset[str]
    alle: bool = False


def nachricht(*, user_id: int, ketten: Iterable[object] = (), alle: bool = False) -> str | None:
    """Die Nachricht als JSON — oder ``None``, wenn sie nichts besagt.

    ``ketten`` nimmt, was die Zeilen tragen (``uuid.UUID`` oder Text); ``None``
    fällt heraus (Zeilen von vor Migration 0050 haben keine Kette).
    """
    namen = sorted({str(k) for k in ketten if k is not None})
    if not alle and not namen:
        return None
    return json.dumps({"user_id": str(user_id), "ketten": namen, "alle": alle})


def lesen(daten: object) -> KettenEnde | None:
    """Die Nachricht wieder auspacken; ``None`` für alles, was nicht passt."""
    if isinstance(daten, bytes | str):
        try:
            daten = json.loads(daten)
        except ValueError:
            return None
    if not isinstance(daten, dict):
        return None
    try:
        user_id = int(daten["user_id"])
    except (KeyError, TypeError, ValueError):
        return None
    ketten = daten.get("ketten", [])
    if not isinstance(ketten, list) or not all(isinstance(k, str) for k in ketten):
        return None
    return KettenEnde(user_id=user_id, ketten=frozenset(ketten), alle=daten.get("alle") is True)


__all__ = ["CLAIM", "KANAL", "KettenEnde", "lesen", "nachricht"]
