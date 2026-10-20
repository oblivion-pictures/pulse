package com.howispulse.app;

import android.content.Context;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS↔nativ-Brücke für eingehende Anrufe (Anrufe-Epic E). Das Web signalisiert
 * „klingelt" (WS call_klingelt im Anruf-Store angekommen) und „beendet"
 * (angenommen/abgelehnt/beendet); wir halten bzw. nehmen die Sperrbildschirm-
 * Notification über {@link CallForegroundService}. Annehmen/Ablehnen aus der
 * Notification kommen als „aktion"-Event zurück in die WebView — die
 * Signalisierung (anrufAnnehmen/anrufAblehnen-POSTs) lebt im Klienten. Hört
 * keine WebView zu (App wird erst durch Annehmen gestartet, Ablehnen ohne
 * laufende App), liegt die Entscheidung im {@link AnrufSpeicher}, bis das Web
 * sie mit {@code ausstehendeAktion()} abholt.
 */
@CapacitorPlugin(name = "Anruf")
public class AnrufPlugin extends Plugin {

    /** Grund, mit dem das Web nach einer Annahme auf DIESEM Gerät beendet
     *  (anruf.svelte.ts, annehmen). */
    private static final String GRUND_HIER_ANGENOMMEN = "anderswo-angenommen";

    private static volatile AnrufPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
    }

    /** Web → nativ: eingehender Anruf klingelt → Sperrbildschirm-Notification zeigen.
     *  Klingelt derselbe Anruf schon (Anruf-Push war schneller), bleibt es
     *  bei der einen Meldung. */
    @PluginMethod
    public void ankommen(PluginCall call) {
        String callId = call.getString("callId", "");
        CallForegroundService.ankommen(getContext(), callId, call.getString("gegenstelle", ""));
        // Das Web kennt den Anruf jetzt — ein unentschiedener Push-Zettel
        // dazu würde ihn nur ein zweites Mal melden.
        AnrufSpeicher.vergessen(getContext(), callId, true);
        call.resolve();
    }

    /** Web → nativ: angenommen/abgelehnt/beendet → Notification entfernen.
     *  {@code callId} (optional): nur diesen Anruf. {@code grund}: nach einer
     *  Annahme hier bleibt die App über dem Sperrbildschirm, bis das Mikrofon
     *  läuft (MainActivity.setMicServiceActive). */
    @PluginMethod
    public void beenden(PluginCall call) {
        String callId = call.getString("callId");
        String grund = call.getString("grund");
        boolean betroffen = CallForegroundService.beendenFuer(getContext(), callId);
        AnrufSpeicher.vergessen(getContext(), callId, false);
        if (betroffen && !GRUND_HIER_ANGENOMMEN.equals(grund)) AnrufModus.beendenVonAussen();
        call.resolve();
    }

    /** Was diese Hülle kann — das Web schaltet danach um (z. B. ob der
     *  Server Anrufe per Push schicken soll). */
    @PluginMethod
    public void faehigkeiten(PluginCall call) {
        JSObject r = new JSObject();
        r.put("faehigkeiten", new JSArray().put("anruf_push").put("texte_lokal"));
        call.resolve(r);
    }

    /** Einmal abholen, was die Hülle ohne zuhörende WebView gesammelt hat:
     *  eine Entscheidung aus der Meldung und/oder einen per Push klingelnden
     *  Anruf ({@code aktion} fehlt dann). Leeres Objekt, wenn nichts da ist. */
    @PluginMethod
    public void ausstehendeAktion(PluginCall call) {
        call.resolve(AnrufSpeicher.abholen(getContext()));
    }

    /**
     * Nativ → Web: Entscheidung aus der Notification, {@code aktion} ist
     * „annehmen" oder „ablehnen". Hört eine WebView zu, geht sie sofort als
     * „aktion"-Ereignis hinaus (mit dem Push-Kontext in den Feldnamen des
     * iOS-Ereignisses, falls bekannt); sonst bleibt sie im
     * {@link AnrufSpeicher} liegen.
     */
    static void entscheidung(Context ctx, String aktion, String callId) {
        AnrufPlugin p = instance;
        if (p == null || !p.hasListeners("aktion")) {
            AnrufSpeicher.entschieden(ctx, aktion, callId);
            return;
        }
        JSObject d = new JSObject();
        d.put("aktion", aktion);
        d.put("callId", callId);
        AnrufSpeicher.kontextAnhaengen(ctx, callId, d);
        AnrufSpeicher.vergessen(ctx, callId, false);
        p.notifyListeners("aktion", d);
    }
}
