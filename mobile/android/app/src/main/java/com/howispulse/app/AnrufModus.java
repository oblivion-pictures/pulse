package com.howispulse.app;

import android.app.Activity;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;

import java.lang.ref.WeakReference;

/**
 * Anrufmodus der {@link MainActivity}: über dem Sperrbildschirm zeigen und den
 * Bildschirm einschalten, solange ein Anruf aus der Klingel-Meldung klingelt
 * bzw. angenommen wird — und NUR so lange, denn solange sieht man die GANZE
 * App ohne Entsperren. Deshalb dynamisch statt als Manifest-Attribut.
 *
 * Endet mit {@link #aus}: Web beendet ohne Annahme (AnrufPlugin.beenden),
 * Mikrofon-Dienst läuft bzw. stoppt (MainActivity.setMicServiceActive),
 * Abbruch-Push, Ablehnen, Klingel-Wecker — spätestens nach
 * {@link #HOECHSTENS_MS}.
 */
final class AnrufModus {
    /** Höchstdauer, falls kein Ende-Signal kommt (Web tot, Annahme hängt):
     *  danach wieder hinter dem Sperrbildschirm. */
    private static final long HOECHSTENS_MS = 90_000;

    /** Der Modus der laufenden Activity — für Ende-Signale aus Push,
     *  Broadcast und Wecker, die keine Activity in der Hand haben. */
    private static volatile WeakReference<AnrufModus> aktuell = new WeakReference<>(null);

    private final Activity activity;
    private final Handler haupt = new Handler(Looper.getMainLooper());
    private final Runnable ablauf = this::aus;
    private boolean an = false;

    AnrufModus(Activity activity) {
        this.activity = activity;
        aktuell = new WeakReference<>(this);
    }

    boolean istAn() {
        return an;
    }

    /** Einschalten (bzw. die Höchstdauer neu beginnen). Nur auf dem UI-Thread. */
    void an() {
        an = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            activity.setShowWhenLocked(true);
            activity.setTurnScreenOn(true);
        } else {
            activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        haupt.removeCallbacks(ablauf);
        haupt.postDelayed(ablauf, HOECHSTENS_MS);
    }

    /** Zurücknehmen (No-op, wenn er nicht an ist). Nur auf dem UI-Thread. */
    void aus() {
        haupt.removeCallbacks(ablauf);
        if (!an) return;
        an = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            activity.setShowWhenLocked(false);
            activity.setTurnScreenOn(false);
        } else {
            activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
    }

    /** Aus Activity.onDestroy: Wecker weg, keinen Verweis stehen lassen. */
    void freigeben() {
        haupt.removeCallbacks(ablauf);
        if (aktuell.get() == this) aktuell = new WeakReference<>(null);
    }

    /** {@link #aus} von einem beliebigen Thread, ohne Activity in der Hand. */
    static void beendenVonAussen() {
        AnrufModus m = aktuell.get();
        if (m != null) m.activity.runOnUiThread(m::aus);
    }
}
