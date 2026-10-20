package com.howispulse.app;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;

import java.util.Map;

/**
 * Merkzettel für einen Anruf, den die Web-App noch nicht kennt: ein per
 * FCM-Datenpush klingelnder Anruf ({@link PushDienst}) und/oder eine
 * Entscheidung aus der Klingel-Meldung, die ankam, während keine WebView
 * zuhörte ({@link AnrufPlugin#entscheidung}). Die Web-App holt ihn über
 * {@code Anruf.ausstehendeAktion()} genau einmal ab.
 *
 * In SharedPreferences statt im Speicher: „Ablehnen" kommt als Broadcast
 * auch ohne Activity an, und bis zum nächsten App-Start kann Android den
 * Prozess längst beendet haben. Höchstens EIN Eintrag — ein neuer Anruf
 * ersetzt den alten.
 */
final class AnrufSpeicher {
    private static final String DATEI = "pulse_anruf";

    /** Klingelt ein Anruf ohne Entscheidung länger, ist er vorbei: der
     *  Klingel-Wecker der Web-App legt nach 45 s auf (anruf.svelte.ts). */
    private static final long KLINGELN_GUELTIG_MS = 60_000;
    /** Eine Entscheidung darf etwas länger liegen (App-Start, Laden der
     *  Seite); der Server räumt klingelnde Anrufe nach 120 s weg
     *  (KLINGEL_MAX_ALTER_SEK, anruf_pflege.py). */
    private static final long ENTSCHEIDUNG_GUELTIG_MS = 120_000;

    private static final String CALL_ID = "callId";
    private static final String ANRUF_ART = "anrufArt";
    private static final String CHANNEL_ID = "channelId";
    private static final String EINLEITER_ID = "einleiterId";
    private static final String EINLEITER_NAME = "einleiterName";
    private static final String AKTION = "aktion";
    private static final String ZEIT = "zeit";

    private AnrufSpeicher() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(DATEI, Context.MODE_PRIVATE);
    }

    /** Klingel-Push (Datenfelder wie vom Server, snake_case) merken. */
    static synchronized void klingelt(Context ctx, Map<String, String> daten) {
        prefs(ctx).edit().clear()
                .putString(CALL_ID, daten.get("call_id"))
                .putString(ANRUF_ART, daten.get("anruf_art"))
                .putString(CHANNEL_ID, daten.get("channel_id"))
                .putString(EINLEITER_ID, daten.get("einleiter_id"))
                .putString(EINLEITER_NAME, daten.get("einleiter_name"))
                .putLong(ZEIT, System.currentTimeMillis())
                .apply();
    }

    /** Entscheidung aus der Meldung merken. Kennt der Zettel den Anruf (aus
     *  dem Push), bleibt der Kontext dabei; sonst steht nur die Kennung da. */
    static synchronized void entschieden(Context ctx, String aktion, String callId) {
        SharedPreferences p = prefs(ctx);
        SharedPreferences.Editor e = p.edit();
        if (callId == null || !callId.equals(p.getString(CALL_ID, null))) {
            e.clear().putString(CALL_ID, callId);
        }
        e.putString(AKTION, aktion).putLong(ZEIT, System.currentTimeMillis()).apply();
    }

    /** Den Zettel für {@code callId} wegwerfen (Anruf vorbei oder der Web-App
     *  schon bekannt). {@code nurUnentschieden}: eine gemerkte Entscheidung
     *  bleibt liegen. Ohne Kennung: nichts. */
    static synchronized void vergessen(Context ctx, String callId, boolean nurUnentschieden) {
        if (callId == null || callId.isEmpty()) return;
        SharedPreferences p = prefs(ctx);
        if (!callId.equals(p.getString(CALL_ID, null))) return;
        if (nurUnentschieden && p.getString(AKTION, null) != null) return;
        p.edit().clear().apply();
    }

    /** Kontext eines Anrufs für das Live-{@code aktion}-Ereignis — in den
     *  Feldnamen des iOS-Ereignisses (anrufNativ.ts, AnrufAktion). Leer,
     *  wenn der Zettel einen anderen (oder keinen) Anruf hält. */
    static synchronized void kontextAnhaengen(Context ctx, String callId, JSObject ziel) {
        SharedPreferences p = prefs(ctx);
        if (callId == null || !callId.equals(p.getString(CALL_ID, null))) return;
        setzeWennDa(ziel, "anruf_art", p.getString(ANRUF_ART, null));
        setzeWennDa(ziel, "channel_id", p.getString(CHANNEL_ID, null));
        setzeWennDa(ziel, "einleiter_id", p.getString(EINLEITER_ID, null));
        setzeWennDa(ziel, "einleiter_name", p.getString(EINLEITER_NAME, null));
    }

    /** Einmal abholen: liefert den Zettel (leer, wenn keiner da oder er
     *  abgelaufen ist) und löscht ihn. */
    static synchronized JSObject abholen(Context ctx) {
        SharedPreferences p = prefs(ctx);
        JSObject r = new JSObject();
        String callId = p.getString(CALL_ID, null);
        String aktion = p.getString(AKTION, null);
        long alter = System.currentTimeMillis() - p.getLong(ZEIT, 0);
        long gueltig = aktion == null ? KLINGELN_GUELTIG_MS : ENTSCHEIDUNG_GUELTIG_MS;
        if (callId != null && alter >= 0 && alter < gueltig) {
            setzeWennDa(r, AKTION, aktion);
            setzeWennDa(r, CALL_ID, callId);
            setzeWennDa(r, ANRUF_ART, p.getString(ANRUF_ART, null));
            setzeWennDa(r, CHANNEL_ID, p.getString(CHANNEL_ID, null));
            setzeWennDa(r, EINLEITER_ID, p.getString(EINLEITER_ID, null));
            setzeWennDa(r, EINLEITER_NAME, p.getString(EINLEITER_NAME, null));
        }
        p.edit().clear().apply();
        return r;
    }

    private static void setzeWennDa(JSObject ziel, String schluessel, String wert) {
        if (wert != null && !wert.isEmpty()) ziel.put(schluessel, wert);
    }
}
