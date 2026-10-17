"""FastAPI factory for the chat-gateway."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Annotated

import httpx
from fastapi import FastAPI, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from dcc_chat_gateway import fcm_abarbeiten, s3
from dcc_chat_gateway.cleanup import cleanup_loop as push_cleanup_loop
from dcc_chat_gateway.cloud_policy_poller import cloud_policy_poller_loop
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.geraetetoken_abgleich import abgleich_loop as geraetetoken_abgleich_loop
from dcc_chat_gateway.jwks_poller import jwks_poller_loop
from dcc_chat_gateway.db import engine
from dcc_chat_gateway.jwks_pinning import jwks_retry_loop
from dcc_chat_gateway.plugin_start import plugins_laden
from dcc_chat_gateway.plugins.permissions import log_startup_mode_warning
from dcc_chat_gateway.presence_status import idle_sweeper_loop
from dcc_chat_gateway.pubsub import ConnectionManager
from dcc_chat_gateway.remote_guard import remote_perm_audit_loop
from dcc_chat_gateway.push import ensure_vapid
from dcc_chat_gateway.push_konfig_pruefung import pruefe_push_konfiguration
from dcc_chat_gateway.routes import router
from dcc_chat_gateway.routes.attachments import reaper_loop as attachments_reaper
from dcc_chat_gateway.start_riegel import pruefe_startbedingungen
from dcc_chat_gateway.suspend_poller import suspend_poller_loop
from dcc_chat_gateway.validierungs_log import registriere_422_log
from dcc_chat_gateway.verbindung import melde_verbindungsstand
from dcc_chat_gateway.voice_pull_cleanup import voice_pull_reaper_loop
from dcc_shared.logging_setup import konfiguriere_logging
from dcc_shared.singleworker import assert_single_worker

log = logging.getLogger(__name__)

# Sichtbarkeit der Meldungen festlegen, BEVOR irgendetwas loggt. Ohne diesen
# Aufruf steht der Wurzel-Logger auf WARNING ohne Handler (uvicorn richtet nur
# seine eigenen drei ein) — jedes `log.info` im Dienst waere unsichtbar.
# Volle Begruendung samt Messung: dcc_shared/logging_setup.py
konfiguriere_logging()


# How long a background task gets to act on its cancel before shutdown abandons
# it. Fits inside Docker's 10s SIGTERM→SIGKILL window; every loop here cancels
# within a tick, so hitting this means the task is genuinely wedged.
_SHUTDOWN_TASK_TIMEOUT_S = 5

# Backoff used by the pubsub supervisor between restart attempts.
_SUPERVISOR_BACKOFF = [1.0, 2.0, 5.0, 10.0, 30.0]
_SUPERVISOR_POLL_SECONDS = 5.0

async def _supervise_pubsub(manager: ConnectionManager) -> None:
    """Restart the ConnectionManager's listener if it dies.

    `ConnectionManager._listen` resets `_started` on a fatal error but cannot
    re-spawn itself; without this watchdog the gateway would silently stop
    fanning out messages until the next request happened to call `start()`.
    """
    attempt = 0
    while True:
        await asyncio.sleep(_SUPERVISOR_POLL_SECONDS)
        if manager.listener_alive():
            attempt = 0
            continue
        wait = _SUPERVISOR_BACKOFF[min(attempt, len(_SUPERVISOR_BACKOFF) - 1)]
        attempt += 1
        log.warning("pubsub listener not alive; restarting in %.0fs (attempt %d)", wait, attempt)
        await asyncio.sleep(wait)
        try:
            await manager.start()
        except Exception:  # noqa: BLE001
            log.exception("pubsub restart failed; will retry")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Security-Scan 2026-09-18: s. dcc_shared/singleworker.py — der chat-gateway
    # trägt die meisten In-Prozess-Limiter (messages, invites, ablage …).
    assert_single_worker("chat-gateway")
    settings = get_settings()
    # Ohne PULSE_INSTANCE_ID startet ein Self-Host seit 2026-10 trotzdem (s.
    # ``start_riegel``). Startverweigerungen (Altbestand, Platzhalter-Secret,
    # MinIO-Default):
    await pruefe_startbedingungen(settings, skip_redis=getattr(app.state, "skip_redis", False))
    # Fehlende Handy-Push-Konfiguration in der Cloud sichtbar machen (warning).
    pruefe_push_konfiguration(settings)
    # Resolve / auto-generate the Web-Push VAPID keypair. Logs the
    # *public* half (the browser needs it; not secret) on first call;
    # NEVER logs the private PEM. ``ensure_vapid`` is idempotent so
    # tests + repeated startups are safe.
    vapid = ensure_vapid(settings)
    if vapid is not None:
        log.info("web-push VAPID public key: %s", vapid.public_b64url)
    else:
        log.warning("web-push disabled: VAPID key unavailable")
    redis: Redis | None = None
    manager: ConnectionManager | None = None
    media_svc_http: httpx.AsyncClient | None = None
    supervisor: asyncio.Task | None = None
    reaper: asyncio.Task | None = None
    push_cleanup: asyncio.Task | None = None
    idle_sweeper: asyncio.Task | None = None
    stale_ws_reaper: asyncio.Task | None = None
    voice_pull_reaper: asyncio.Task | None = None
    jwks_poller: asyncio.Task | None = None
    suspend_poller: asyncio.Task | None = None
    cloud_policy_task: asyncio.Task | None = None
    jwks_retry: asyncio.Task | None = None
    remote_audit: asyncio.Task | None = None
    anzeigename_task: asyncio.Task | None = None
    token_abgleich: asyncio.Task | None = None
    push_warteschlange: asyncio.Task | None = None
    owns_manager = False
    if getattr(app.state, "skip_redis", False):
        # Tests pre-wire connection_manager onto the app — leave it alone.
        pass
    else:
        redis = Redis.from_url(settings.redis_url, decode_responses=False)
        manager = ConnectionManager(redis)
        # Wire the permission filter's DB access through ``routes.ws_ops`` —
        # tests rebind ``routes.ws_ops.SessionLocal`` to a file-backed DB
        # (that module owns the WS op-loop's DB access since Phase B), and
        # this indirection lets the manager pick up the same factory the
        # WS endpoint already uses. Late import dodges the routes ↔ pubsub
        # circular dependency at module load.
        from dcc_chat_gateway.routes import ws_ops as _routes_ws_ops
        manager.set_session_factory(lambda: _routes_ws_ops.SessionLocal())
        await manager.start()
        app.state.redis = redis
        app.state.connection_manager = manager
        # media-svc HTTP client: shared across all stream-token and WHEP requests
        # to reuse TCP connections instead of creating one per request.
        media_svc_http = httpx.AsyncClient(timeout=settings.media_svc_timeout_s)
        app.state.media_svc_http = media_svc_http
        owns_manager = True
        supervisor = asyncio.create_task(_supervise_pubsub(manager), name="dcc-pubsub-supervisor")
        # Orphan-attachment reaper — sweeps pending uploads >1 h old.
        reaper = asyncio.create_task(attachments_reaper(), name="dcc-attachments-reaper")
        # Web-Push subscription cleanup — drops subs idle >N days.
        push_cleanup = asyncio.create_task(
            push_cleanup_loop(settings, engine), name="dcc-push-subscription-cleanup"
        )
        # Stale-WebSocket-Reaper — schließt halboffene mobile Sockets, die
        # sonst FCM-Pushes minuteslang unterdrücken (Etappe 2, 2026-10-06).
        stale_ws_reaper = asyncio.create_task(
            manager.stale_socket_reaper_loop(), name="dcc-stale-ws-reaper"
        )
        # Presence idle sweeper — demotes ``online`` users with stale
        # activity to ``idle`` (Etappe 3).
        idle_sweeper = asyncio.create_task(
            idle_sweeper_loop(redis), name="dcc-presence-idle-sweeper"
        )
        # Voice-pull reaper — backstop that revokes temporary visibility
        # grants the participant_left webhook missed (or that the target
        # never connected to). See voice_pull_cleanup.voice_pull_reaper_loop.
        voice_pull_reaper = asyncio.create_task(
            voice_pull_reaper_loop(settings, engine, redis, manager), name="dcc-voice-pull-reaper"
        )
        # Rechte-Wache der Fernsteuerung — prueft laufende Sitzungen im Takt
        # nach. Ohne sie ueberlebt eine Sitzung Rollenentzug und Overwrite bis
        # der Zugangstoken ablaeuft (15 Minuten Tastatur auf fremdem Rechner);
        # Rauswurf/Bann trennen zusaetzlich sofort (remote_guard).
        remote_audit = asyncio.create_task(
            remote_perm_audit_loop(manager), name="dcc-remote-perm-audit"
        )
        # Gerätetoken gegen die lebenden Anmelde-Ketten — holt nach, was die
        # Meldung auf ``auth:ketten_ende`` verpasst (geraetetoken_abgleich.py).
        token_abgleich = asyncio.create_task(
            geraetetoken_abgleich_loop(lambda: _routes_ws_ops.SessionLocal()),
            name="dcc-geraetetoken-abgleich",
        )
        # Zurückgehaltene DM-Pushes ans Handy (fcm_abarbeiten.py) — in Redis,
        # damit ein Neustart keinen verliert; beim Start Fälliges sofort.
        push_warteschlange = asyncio.create_task(
            fcm_abarbeiten.abarbeiter_loop(manager), name="dcc-fcm-push-warteschlange"
        )
        # JWKS-Poller — holt die oeffentlichen Cloud-Schluessel alle 30 s.
        # Ohne sie kann ein Self-Host kein Serverticket pruefen; faellt der
        # Abruf aus, bleibt der letzte bekannte Stand stehen (fail-open).
        jwks_poller = asyncio.create_task(
            jwks_poller_loop(redis, settings.pulse_cloud_origin),
            name="dcc-jwks-poller",
        )
        # Sperr-Poller — erfaehrt, wenn die Cloud DIESE Instanz gesperrt oder
        # geloescht hat. Nur im Self-Host-Modus: in der Cloud gibt es niemanden,
        # der uns sperren koennte. Ohne diese Aufgabe war "Server loeschen" fuer
        # den Betreiber wirkungslos — die Instanz lief unbeirrt weiter
        # (beobachtet 2026-07-27, s. suspend_poller.py). Ein unverbundener
        # Server (Instanz-Nummer 0) hat noch keinen Eintrag, den man sperren
        # könnte, und deshalb auch keinen Poller.
        if settings.pulse_instance_mode == "self-host" and settings.pulse_instance_id:
            # Server-Name an die Cloud — beim Start und alle 6 h (instance_name.py).
            from dcc_chat_gateway.instance_name import abgleich_loop

            anzeigename_task = asyncio.create_task(
                abgleich_loop(_routes_ws_ops.SessionLocal), name="dcc-anzeigename-abgleich"
            )
            suspend_poller = asyncio.create_task(
                suspend_poller_loop(
                    redis, settings.pulse_cloud_origin, settings.pulse_instance_id
                ),
                name="dcc-suspend-poller",
            )
        # Cloud policy poller — fetches the version-policy document every 6 h
        # (configurable via ``cloud_policy_poll_interval``). Persists to Redis
        # so Phase-4 frontend and the WS hello-frame can surface update banners.
        cloud_policy_task = asyncio.create_task(
            cloud_policy_poller_loop(
                redis,
                settings.pulse_cloud_origin,
                settings.cloud_policy_poll_interval,
            ),
            name="dcc-cloud-policy-poller",
        )
        # Dropbox / Ablage trash-retention sweep — fires once an hour to
        # purge entries that have been in the trash longer than each
        # guild's configured retention window. Best-effort: skips the
        # row if MinIO delete fails (next pass retries).
        from dcc_chat_gateway.routes.dropbox_admin import schedule_sweep

        dropbox_sweep_task = schedule_sweep(
            asyncio.get_event_loop(), manager
        )
        # JWKS cold-start handling (Phase 3.1 Punkt 12): if Redis has no
        # cached JWKS at startup (cold cache + auth-svc not answering yet),
        # mark jwks_ready=False and launch a retry loop that polls every 30 s.
        # WS connections return 4046 while jwks_ready is False.
        raw_jwks = await redis.get("auth:jwks:cached")
        if raw_jwks:
            app.state.jwks_ready = True
        else:
            app.state.jwks_ready = False
            log.warning(
                "jwks_cold_start: Redis JWKS cache empty at startup — "
                "WS connections will be rejected (4046) until JWKS is available"
            )
            jwks_retry = asyncio.create_task(
                jwks_retry_loop(redis, settings, app.state),
                name="dcc-jwks-retry",
            )
        app.state.jwks_changed_unexpectedly = False
        # Wem gehört diese Instanz — oder noch niemandem? Einmal je Start, damit
        # die Antwort auch dann im Protokoll steht, wenn sich noch niemand
        # angemeldet hat (verbindung.py).
        melde_verbindungsstand(settings)
        # Plugin-System: log startup warning if permission mode is not 'strict'.
        log_startup_mode_warning()
        # Plugin-System: Allowlist-gegateter Load (Details in ``plugin_start``).
        await plugins_laden(app, manager, lambda: _routes_ws_ops.SessionLocal())
    try:
        yield
    finally:
        if owns_manager:
            # `stale_ws_reaper` fehlte hier bis zum 2026-10-11: gestartet, aber
            # beim Herunterfahren nie abgebrochen (eine Endlosschleife mit
            # `sleep(30)`), also bis zum Schliessen des Loops offen.
            bg_tasks = (
                supervisor, reaper, push_cleanup, idle_sweeper, stale_ws_reaper,
                voice_pull_reaper, jwks_poller, suspend_poller, cloud_policy_task,
                jwks_retry, dropbox_sweep_task, remote_audit, anzeigename_task,
                token_abgleich, push_warteschlange,
            )
            for task in bg_tasks:
                if task is None:
                    continue
                task.cancel()
                # `asyncio.wait`, not `wait_for`: on timeout wait_for cancels the
                # task and then awaits it — against a task that ignores cancels
                # (the case this deadline exists for) it wedges just as hard as a
                # bare await. `wait` only observes.
                done, _pending = await asyncio.wait({task}, timeout=_SHUTDOWN_TASK_TIMEOUT_S)
                if not done:
                    # Log the name: a wedge here is otherwise invisible from outside.
                    log.warning(
                        "shutdown: background task %s ignored cancel for %ss — abandoning it",
                        task.get_name(),
                        _SHUTDOWN_TASK_TIMEOUT_S,
                    )
                    continue
                # Retrieve the outcome so a crashed task doesn't surface as
                # "exception was never retrieved" noise at loop close.
                exc = None if task.cancelled() else task.exception()
                if exc is not None:
                    log.debug("shutdown: background task %s ended with %r", task.get_name(), exc)
            if manager is not None:
                await manager.stop()
            if redis is not None:
                try:
                    await redis.aclose()
                except Exception:  # noqa: BLE001
                    pass
            if media_svc_http is not None:
                try:
                    await media_svc_http.aclose()
                except Exception:  # noqa: BLE001
                    pass
        # Close the lazily-initialised S3 clients regardless of which branch
        # we took above — they may have been created from a non-Redis test
        # path too.
        await s3.shutdown_clients()
        # Same for the voice-evict httpx singleton (kick/ban → voice-signaling).
        from dcc_chat_gateway import voice_evict

        await voice_evict.shutdown_client()
        # VoIP-Pushes, die noch unterwegs sind (Hintergrund-Sendungen aus
        # ``anruf_push``), dürfen ausfliegen — kurz; dann der gemeinsame
        # HTTP/2-Klient zu Apple.
        from dcc_chat_gateway import anruf_push, apns_voip

        await anruf_push.hintergrund_abwarten(frist_s=2.0)
        await apns_voip.schliessen()


def create_app(*, skip_redis: bool = False) -> FastAPI:
    settings = get_settings()
    # Scrub ``token=…`` (WS query-param auth) from uvicorn access logs before
    # any request is served. Idempotent — safe across repeated create_app calls.
    from dcc_chat_gateway.log_filters import install_access_log_redaction
    install_access_log_redaction()
    app = FastAPI(title="dcc-chat-gateway", version="0.1.0", lifespan=lifespan)

    registriere_422_log(app)
    app.state.skip_redis = skip_redis
    # Default-Snapshot, damit Tests ohne Lifespan (REST-only-Fixture)
    # ein definiertes ``plugin_allowlist`` lesen können. Die Lifespan
    # überschreibt das mit dem DB-Snapshot.
    app.state.plugin_allowlist = frozenset()
    # Phase 3.1 defaults — overwritten by lifespan when Redis is live.
    # Tests that set skip_redis=True get jwks_ready=True (no JWKS gate in unit tests).
    app.state.jwks_ready = True
    app.state.jwks_changed_unexpectedly = False
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)

    @app.get("/internal/jwks-status")
    async def jwks_status(
        request: Request,
        x_pulse_internal_secret: Annotated[str | None, Header()] = None,
    ) -> dict:
        """Internal JWKS-pin status healthcheck (Phase 3.1 stub).

        Returns the current pin-flag states.  Gated behind the same
        INTERNAL_SERVICE_SECRET header used by /internal/health-probe so
        that the nginx proxy does not need an explicit deny block.
        Phase 4 will add a full admin UI banner driven by this.
        """
        # Reuse the same constant-time secret-check pattern as health-probe.
        from dcc_chat_gateway.routes.health import _check_internal_secret  # noqa: PLC0415
        _check_internal_secret(request, x_pulse_internal_secret)
        return {
            "jwks_ready": getattr(app.state, "jwks_ready", True),
            "jwks_changed_unexpectedly": getattr(
                app.state, "jwks_changed_unexpectedly", False
            ),
        }

    return app


app = create_app()
