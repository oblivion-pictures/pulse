#!/usr/bin/env python3
"""Stellt den Mehrfenster-Absturz unter NVIDIA/Wayland nach (s. `src/render/instanz.rs`).

    python3 scripts/mehrfenster-absturz.py target/release/pulse-player [fenster] [laeufe]

Öffnet `fenster` Player-Fenster (Vorgabe 2) gegen einen eingebauten Schein-WHEP-
Server, der jede Verbindung nach 1,5 s abbricht. Die Sitzungen scheitern dadurch
von selbst, während alle Fenster offen sind — genau der Ablauf, der vor dem Fix
6 von 6 Mal mit SIGSEGV endete. Danach wird geprüft, ob ein NEUES Fenster noch
aufgeht (die Instanz wird über alle Fenster weiterverwendet).

Braucht eine laufende grafische Sitzung: es öffnen sich kurz echte Fenster.
Ergebnis je Lauf: `ok` oder `ABSTURZ rc=-11`. Rückgabewert 1, wenn einer abstürzt.
"""

import json
import os
import socket
import subprocess
import sys
import threading
import time


def schein_server() -> int:
    """Nimmt Verbindungen an und bricht jede nach 1,5 s ab. Liefert den Port."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(16)

    def spaeter(c: socket.socket) -> None:
        time.sleep(1.5)
        c.close()

    def annehmen() -> None:
        while True:
            c, _ = s.accept()
            threading.Thread(target=spaeter, args=(c,), daemon=True).start()

    threading.Thread(target=annehmen, daemon=True).start()
    return s.getsockname()[1]


def lauf(player: str, fenster: int, port: int) -> str:
    lib = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ffmpeg-dist", "n8.1-lgpl-shared", "lib")
    env = dict(os.environ, LD_LIBRARY_PATH=lib)
    p = subprocess.Popen([player], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, text=True, env=env)

    def oeffnen(i: int) -> None:
        url = f"http://127.0.0.1:{port}/whep"
        try:
            p.stdin.write(json.dumps({"op": "open", "id": i, "url": url, "title": f"Probe {i}"}) + "\n")
            p.stdin.flush()
        except BrokenPipeError:
            pass

    for i in range(fenster):
        oeffnen(i + 1)
        time.sleep(0.3)
    time.sleep(3.0)  # alle Sitzungen scheitern und werden abgebaut
    oeffnen(99)  # ein neues Fenster nach dem Abbau
    time.sleep(1.0)
    try:
        rc = p.wait(timeout=1.0)
        try:
            p.stdin.close()
        except BrokenPipeError:
            pass  # der Player ist weg — genau das wird hier gemeldet
        return f"ABSTURZ rc={rc}"
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
        return "ok"


def main() -> int:
    player = sys.argv[1]
    fenster = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    laeufe = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    port = schein_server()
    abstuerze = 0
    for n in range(laeufe):
        ergebnis = lauf(player, fenster, port)
        abstuerze += ergebnis != "ok"
        print(f"Lauf {n + 1}/{laeufe}, {fenster} Fenster: {ergebnis}", flush=True)
    return 1 if abstuerze else 0


if __name__ == "__main__":
    sys.exit(main())
