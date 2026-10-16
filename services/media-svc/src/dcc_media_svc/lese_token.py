"""WHEP-Lese-Token ausstellen — Zeiger und Datensatz in EINEM Schritt.

Herausgeloest aus ``routes.py`` (2026-10-16), als die Bindung an Geraet und
Platz dazukam: die Datei lag schon ueber der Groessen-Grenze, und die Regeln
hier haengen an genau einer Stelle — der Sperre in chat-gateway
(``stream_revoke.py``, ``geraete_zuschauen.py``).
"""

from __future__ import annotations

import json
import secrets
import time
from typing import Any

from dcc_shared.streaming import read_cache_key
from redis.asyncio import Redis

from dcc_media_svc.config import get_settings
from dcc_media_svc.streamkeys import TOKEN_KEY

#: Hoechstlaufzeit eines Lese-Tokens fuer den Strom eines Standplatz-Geraets.
#:
#: **Warum kurz:** wer einem Geraetestrom zusehen darf, haengt an fluechtigen
#: Zustaenden (Weckfrist von 60 s, laufende Steuersitzung — chat-gateway
#: ``geraete_zuschauen.py``). Der Widerruf dort loescht die Token, die beim
#: Sitzungsende oder Fristablauf existieren; ein Token, das ein Zuschauer im
#: selben Augenblick noch bekommt (Pruefung im Gateway kurz VOR dem Ende,
#: Ausstellung hier kurz DANACH), findet er nicht. Diese Laufzeit begrenzt
#: genau dieses Restfenster, statt es 10 min (``read_token_ttl_s``) offen zu
#: lassen.
#:
#: **Warum das keine laufende Wiedergabe abbricht:** der auth-hook prueft ein
#: Lese-Token nur beim Aufbau einer WHEP-Sitzung (OPTIONS + POST), nicht
#: waehrend sie laeuft. Eine Wiederverbindung holt im Browser jedes Mal eine
#: neue Adresse ueber ``GET /whep`` (``hqStreamManager.svelte.ts::#start``),
#: ebenso ein neu geoeffnetes Fenster des nativen Players
#: (``player/store.svelte.ts``) — und damit ein frisches Token.
GERAET_LESE_TOKEN_TTL_S = 120

#: Restlaufzeit, unter der ein gecachtes Geraete-Token nicht mehr ausgeliefert,
#: sondern ersetzt wird. Ohne sie bekaeme ein Zuschauer, der kurz vor Ablauf
#: neu verbindet, ein Token, das waehrend seines WHEP-Aufbaus verfaellt. Fuer
#: normale Stroeme (10 min Laufzeit) bleibt es beim alten Verhalten.
GERAET_LESE_TOKEN_MINDESTREST_S = 30


def _text(wert: bytes | str | None) -> str:
    """Redis-Antwort als Text (die Klienten liefern je nach Aufbau bytes)."""
    if wert is None:
        return ""
    return wert.decode() if isinstance(wert, bytes) else str(wert)


# Ein Lese-Token bestimmen — Zeiger und Datensatz in EINEM Schritt.
#
# **Warum Lua und nicht drei Redis-Rufe.** Der Bann in chat-gateway
# (``stream_revoke.py``) findet die Token eines Zuschauers AUSSCHLIESSLICH ueber
# die Nachschlage-Schluessel: ``scan_iter`` auf ``stream:read-cache:<viewer>:*``,
# dann ``mget``, dann beides loeschen. Ein ausgehaendigtes Token, auf das kein
# Zeiger zeigt, ist damit bis zu eine Stunde lang nicht sperrbar — es gibt
# keinen zweiten Weg zu ihm (der Datensatz kennt Kanal und Streamer, aber nicht
# den Zuschauer). Die Sperre baut also auf einer Zuordnung Zeiger→Token auf, und
# wer sie herstellt, muss sie auch unteilbar herstellen.
#
# Mit einzelnen Rufen ging das zweimal schief: ein Aufruf, der einen verwaisten
# Zeiger raeumt, loescht dabei womoeglich den frisch geschriebenen Zeiger eines
# anderen, dessen Token schon beim Zuschauer ist; und ein Zeiger, der ohne NX
# geschrieben wird, ueberschreibt den eines fremden Gewinners. Beide Male bleibt
# genau das zurueck, was der Bann nicht mehr findet. Im Skript gibt es diese
# Zwischenraeume nicht.
#
# Was das Skript zusagt:
#   * **Zeiger lebt mindestens so lange wie sein Datensatz.** Beim Wiederbeleben
#     wird die Laufzeit des Zeigers deshalb mitgezogen; ein Datensatz, der
#     seinen Zeiger ueberlebte, waere wieder unsperrbar.
#   * **Heil gefundene, passende Paare werden nicht angefasst** — sonst
#     verlaengerte jedes ``GET /whep`` die Laufzeit, und das Token eines
#     dauerhaft zuschauenden Zuschauers wechselte nie.
#   * **Ein verwaister Zeiger wird geheilt, nicht ausgeliefert.** Verwaist heisst
#     hier: Zeiger da, Datensatz weg (Speicherdruck hat ``stream:token:*``
#     verdraengt). Geheilt wird durch Wiederbeleben DESSELBEN Tokens statt durch
#     ein neues — es gehoert ohnehin diesem Zuschauer, und ein neues verlangte
#     wieder ein Loeschen des fremden Zeigers. Ein vom BANN geloeschtes Token
#     kann so nicht auferstehen: der Bann loescht Zeiger und Datensatz in einem
#     einzigen ``DELETE``, es gibt den Zwischenzustand nicht.
#   * **Ein unpassendes Token wird ersetzt, nicht ausgeliefert** (seit
#     2026-10-16). Der Zeiger haengt an (Zuschauer, Kanal, Streamer, Platz),
#     nicht an Geraet und Platzbindung: auf demselben Platz kann nach einem
#     normalen Go-Live ein Geraetestrom laufen (und umgekehrt). Ein gecachtes
#     Token ohne Bindung lehnte der auth-hook dann ab, und der Zuschauer saehe
#     schwarz, bis es ablaeuft. Passend heisst: fuer einen Geraetestrom genau
#     dieses ``device_id`` und dieser ``slot`` (ARGV[5]/ARGV[6]), fuer einen
#     normalen Strom gar kein ``device_id``; dazu, falls ARGV[7] > 0, noch
#     mindestens so viel Restlaufzeit. Sonst wird der alte Datensatz geloescht
#     und der Zeiger auf ein neues Token umgesetzt — im selben Schritt, also
#     bleibt kein lebendes Token ohne Zeiger zurueck. Die Schluesselform, ueber
#     die Bann und ``zuschauer_widerrufen`` suchen, bleibt dieselbe.
_LUA_LESE_TOKEN = """
local zeiger = redis.call('GET', KEYS[1])
if zeiger then
  local alt = redis.call('GET', ARGV[1] .. zeiger)
  if not alt then
    redis.call('SET', ARGV[1] .. zeiger, ARGV[2], 'EX', ARGV[3])
    redis.call('SET', KEYS[1], zeiger, 'EX', ARGV[3])
    return zeiger
  end
  local ok, rec = pcall(cjson.decode, alt)
  local passt = ok and type(rec) == 'table'
  if passt then
    local geraet = rec['device_id']
    if ARGV[5] == '' then
      passt = (geraet == nil or geraet == cjson.null)
    else
      passt = (tostring(geraet) == ARGV[5] and tostring(rec['slot']) == ARGV[6])
    end
  end
  local rest = tonumber(ARGV[7])
  if passt and rest > 0 then
    passt = redis.call('TTL', ARGV[1] .. zeiger) >= rest
  end
  if passt then
    return zeiger
  end
  redis.call('DEL', ARGV[1] .. zeiger)
end
redis.call('SET', ARGV[1] .. ARGV[4], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[3])
return ARGV[4]
"""

# Der Namensraum der Token-Schluessel, wie ihn das Skript zum Anhaengen braucht.
_TOKEN_PRAEFIX = TOKEN_KEY.format(token="")


async def read_token_fuer(
    redis: Redis,
    viewer_id: str,
    channel_id: str,
    user_id: str,
    slot: int,
    ttl_max_s: int | None = None,
    device_id: str | None = None,
) -> str:
    """Das WHEP-Lese-Token fuer genau ein (Zuschauer, Kanal, Streamer, Platz).

    Deterministisch statt je Anfrage frisch: ein Zuschauer in einer
    Wiederverbindungs-Schleife haeufte sonst pro Anlauf einen lebenden
    Redis-Schluessel an (TTL = ``read_token_ttl_s``, seit dem zweiten
    Bughunt-Lauf 2026-09-23 10 min), ohne dass sich am Umfang des Tokens
    etwas aenderte.

    Sicherheit: Lese-Token sind **nicht** einmalig — der auth-hook nimmt sie
    ueber die ganze TTL an und verbraucht sie nicht (WHEP macht OPTIONS +
    POST + Wiederverbindungen mit demselben Token).  Ein vorhandenes Token
    weiterzugeben ist deshalb gleichwertig damit, ein neues auszustellen;
    beide sind an Kanal und Streamer gebunden, nicht an den Zuschauer.

    ``device_id``: der Strom gehoert diesem Standplatz-Geraet — das Token wird
    dann an Geraet und Platz gebunden und lebt hoechstens
    :data:`GERAET_LESE_TOKEN_TTL_S`.

    Die Reihenfolge und die Unteilbarkeit begruendet ``_LUA_LESE_TOKEN``: was
    hier herauskommt, muss der Bann in chat-gateway finden koennen.
    """
    s = get_settings()
    ttl = s.read_token_ttl_s
    if ttl_max_s is not None:
        ttl = min(ttl, ttl_max_s)
    # Form in `dcc_shared.streaming` — chat-gateway loescht diese Schluessel
    # beim Bann, und zwei Fassungen davon waeren eine stille Fehlerquelle.
    cache_key = read_cache_key(viewer_id, channel_id, user_id, slot)
    lese: dict[str, Any] = {
        "channel_id": channel_id,
        "user_id": user_id,
        "scope": "read",
        "protocol": "webrtc",
        "created_at": int(time.time()),
    }
    mindestrest = 0
    # **Beim Strom eines Geraets an den Platz gebunden** (seit 2026-10-16):
    # sonst gilt ein Lese-Token fuer JEDEN Pfad dieses Streamers im Kanal, und
    # wer einmal waehrend einer Steuerung zusehen durfte, kaeme mit dem Token
    # seines normalen Go-Live-Stroms auch an einen spaeteren Geraetestrom,
    # dessen Pfad er kennt. Der auth-hook prueft ``slot`` nur, wenn es im
    # Datensatz steht — normale Stroeme bleiben byte-gleich.
    if device_id is not None:
        lese["slot"] = int(slot)
        lese["device_id"] = device_id
        ttl = min(ttl, GERAET_LESE_TOKEN_TTL_S)
        mindestrest = GERAET_LESE_TOKEN_MINDESTREST_S
    read_record = json.dumps(lese, separators=(",", ":"))
    return _text(
        await redis.eval(  # type: ignore[arg-type]
            _LUA_LESE_TOKEN,
            1,
            cache_key,
            _TOKEN_PRAEFIX,
            read_record,
            str(ttl),
            secrets.token_urlsafe(32),
            device_id or "",
            str(int(slot)),
            str(mindestrest),
        )
    )
