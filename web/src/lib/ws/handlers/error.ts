/**
 * Error op handler. The server emits `{op:'error', code, msg}` for
 * recoverable per-message rejects (e.g. watch_start with an unsupported
 * source). We intentionally swallow it at the dispatcher — every UI
 * caller that *cares* about a specific error subscribes via
 * `gateway.on()` directly (e.g. the watch-party start button surfaces
 * 4013/4014 from its own listener). Registering as a no-op here just
 * silences the "unknown op" warning. Fehler eines `subscribe` (mit
 * `ref_op`/`channel_id`) fängt die Verbindung selbst vorher ab und abonniert
 * neu (`GatewayConnection._aboFehlerPruefen`, `../aboWiederholung.ts`).
 */
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('error', () => undefined);
}
