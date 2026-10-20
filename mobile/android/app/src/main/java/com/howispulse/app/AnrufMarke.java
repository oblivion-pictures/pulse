package com.howispulse.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * Marke des klingelnden Anrufs an den Intents der Anruf-Meldung auf die
 * {@link MainActivity}. Die Activity ist exportiert (Launcher, Teilen-Ziel) —
 * ohne Marke könnte jede andere App sie mit „annehmen" starten und damit einen
 * klingelnden Anruf samt Mikrofon annehmen. Die Marke steht nur in den eigenen
 * PendingIntents ({@link CallForegroundService}) und in privaten
 * SharedPreferences; jeder neue Anruf ersetzt sie.
 *
 * In SharedPreferences statt im Speicher: Android kann den Prozess beenden,
 * während die Meldung noch klingelt — der Tipp darauf startet ihn neu.
 */
final class AnrufMarke {
    static final String EXTRA = "pulseAnrufMarke";
    private static final String DATEI = "pulse_anruf_marke";
    private static final String MARKE = "marke";

    private AnrufMarke() {}

    /** Neue Zufallsmarke (128 Bit) für einen gerade ankommenden Anruf. */
    static void neu(Context ctx) {
        byte[] roh = new byte[16];
        new SecureRandom().nextBytes(roh);
        StringBuilder hex = new StringBuilder(32);
        for (byte b : roh) hex.append(String.format("%02x", b));
        prefs(ctx).edit().putString(MARKE, hex.toString()).apply();
    }

    static String wert(Context ctx) {
        return prefs(ctx).getString(MARKE, "");
    }

    /** Stammt der Intent aus einer eigenen Anruf-Meldung? Vergleich in
     *  konstanter Zeit, eine leere Marke gilt nie. */
    static boolean gilt(Context ctx, String vorgelegt) {
        String erwartet = wert(ctx);
        if (vorgelegt == null || erwartet.isEmpty()) return false;
        return MessageDigest.isEqual(vorgelegt.getBytes(StandardCharsets.UTF_8),
                erwartet.getBytes(StandardCharsets.UTF_8));
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(DATEI, Context.MODE_PRIVATE);
    }
}
