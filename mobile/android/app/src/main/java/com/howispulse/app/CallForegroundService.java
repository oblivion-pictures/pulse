package com.howispulse.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import java.util.ArrayDeque;

/**
 * Klingelnder Anruf als Sperrbildschirm-Notification (Anrufe-Epic E). Kurz-
 * lebiger Foreground-Service vom Typ "phoneCall" — nur solange ein eingehender
 * Anruf klingelt, nie pausenlos. Er existiert in erster Linie, damit das System
 * die Notification als CallStyle-Call rendert (Sperrbildschirm-Karte mit
 * Annehmen/Ablehnen); ein Full-Screen-Intent startet bei gesperrtem Bildschirm
 * die MainActivity, wo das Web-Overlay (AnrufOverlay.svelte) übernimmt.
 *
 * Zwei Auslöser für „klingelt" ({@link #ankommen}): das Web über
 * {@link AnrufPlugin} (WS call_klingelt) und der Anruf-Push über
 * {@link PushDienst}, wenn die WebView getrennt ist. Kommt derselbe Anruf auf
 * beiden Wegen, bleibt es bei EINER Meldung (Kennung in {@link #klingelnd}
 * bzw. {@link #erledigt}). „Beendet" kommt aus dem Web
 * (angenommen/abgelehnt/call_ende), aus einem Abbruch-Push oder dem eigenen
 * Wecker ({@link #KLINGEL_HOECHSTENS_MS}).
 *
 * Annehmen öffnet die {@link MainActivity} (Activity-PendingIntent — aus dem
 * Hintergrund darf nur eine sichtbare Activity das Mikrofon holen), Ablehnen
 * läuft als Broadcast über {@link AktionsEmpfaenger}. Beide Entscheidungen
 * gehen über {@link #entscheiden} an die WebView oder, wenn keine zuhört, auf
 * den {@link AnrufSpeicher}.
 */
public class CallForegroundService extends Service {
    /** Seit Version 1.4 ein eigener Kanal mit Klingelton: der Ton eines
     *  bestehenden Kanals lässt sich nicht mehr ändern, der alte
     *  ({@link #ALTER_KANAL}, Standard-Meldeton) wird entfernt. */
    private static final String CHANNEL_ID = "pulse_anruf_klingel";
    private static final String ALTER_KANAL = "pulse_anrufe";
    private static final int NOTIF_ID = 4712;
    /** Längstens so lange klingelt die Meldung, falls weder Web noch
     *  Abbruch-Push sie beenden (Web-Wecker: 45 s, anruf.svelte.ts). */
    private static final long KLINGEL_HOECHSTENS_MS = 60_000;
    /** So viele beendete Kennungen genügen gegen verspätete Doppel-Auslöser. */
    private static final int ERLEDIGT_MERKEN = 16;
    private static final int PI_FLAGS =
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;

    static final String EXTRA_CALL_ID = "callId";
    static final String EXTRA_GEGENSTELLE = "gegenstelle";
    /** An den Intents auf {@link MainActivity}: kommt aus der Anruf-Meldung. */
    static final String EXTRA_ANRUF = "pulseAnruf";
    /** An den Intents auf {@link MainActivity}: die Entscheidung (nur Annehmen). */
    static final String EXTRA_AKTION = "pulseAnrufAktion";
    static final String AKTION_ANNEHMEN = "annehmen";
    static final String AKTION_ABLEHNEN = "ablehnen";

    private static final Object SPERRE = new Object();
    /** Kennung des klingelnden Anrufs ("" = Kennung unbekannt), null = keiner. */
    private static String klingelnd;
    /** Zuletzt beendete Kennungen — ein später eintreffender zweiter
     *  Auslöser für denselben Anruf klingelt nicht noch einmal. */
    private static final ArrayDeque<String> erledigt = new ArrayDeque<>();
    /** Läuft im Vordergrund (nach startForeground), sonst null. */
    private static CallForegroundService dienst;

    private static final Handler HAUPT = new Handler(Looper.getMainLooper());
    private static Context appKontext;
    private static final Runnable WECKER = () -> {
        Context ctx = appKontext;
        if (ctx == null) return;
        beenden(ctx);
        AnrufModus.beendenVonAussen();
    };

    /**
     * Eingehender Anruf klingelt. Rückgabe: {@code false}, wenn derselbe
     * Anruf schon klingelt oder schon beendet ist (dann geschieht nichts).
     */
    public static boolean ankommen(Context ctx, String callId, String gegenstelle) {
        String id = callId == null ? "" : callId;
        synchronized (SPERRE) {
            if (!id.isEmpty() && (id.equals(klingelnd) || erledigt.contains(id))) return false;
            klingelnd = id;
            appKontext = ctx.getApplicationContext();
            AnrufMarke.neu(ctx);
        }
        HAUPT.removeCallbacks(WECKER);
        HAUPT.postDelayed(WECKER, KLINGEL_HOECHSTENS_MS);
        Intent start = new Intent(ctx, CallForegroundService.class)
                .putExtra(EXTRA_CALL_ID, id)
                .putExtra(EXTRA_GEGENSTELLE, gegenstelle);
        try {
            ContextCompat.startForegroundService(ctx, start);
        } catch (Exception e) {
            // App länger im Hintergrund und kein (oder ein herabgestufter)
            // High-Priority-Push → FGS-Start verweigert (API 31+
            // ForegroundServiceStartNotAllowedException). Notification
            // trotzdem direkt posten — CallStyle wird dann notfalls zur
            // normalen High-Priority-Notification abgestuft, Full-Screen-Intent
            // und Annehmen/Ablehnen-Buttons bleiben.
            kanalAnlegen(ctx);
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(NOTIF_ID, baue(ctx, id, gegenstelle));
        }
        return true;
    }

    /** Klingelt gerade ein Anruf (gleich welcher)? */
    static boolean klingelt() {
        synchronized (SPERRE) {
            return klingelnd != null;
        }
    }

    /** Klingel-Meldung weg, egal für welchen Anruf — aus
     *  MainActivity.onResume (App im Vordergrund → Overlay übernimmt), dem
     *  Wecker und den Entscheidungen. */
    public static void beenden(Context ctx) {
        CallForegroundService d;
        synchronized (SPERRE) {
            if (klingelnd != null && !klingelnd.isEmpty()) erledigtMerken(klingelnd);
            klingelnd = null;
            d = dienst;
            dienst = null;
        }
        HAUPT.removeCallbacks(WECKER);
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(NOTIF_ID);
        // Kein stopService: stünde der Start noch aus (startForegroundService
        // gerufen, onStartCommand noch nicht gelaufen), wertete das System
        // das als „startForeground nie gerufen" und beendete die App.
        // onStartCommand sieht klingelnd == null und hält selbst an.
        if (d != null) d.anhalten();
    }

    /**
     * Den Anruf {@code callId} beenden (Web: angenommen/abgelehnt/beendet;
     * Abbruch-Push). Klingelt gerade ein ANDERER, bekannter Anruf, bleibt er
     * stehen — Rückgabe dann {@code false}, sonst {@code true}. Ohne Kennung
     * (ältere Web-App): wie {@link #beenden}.
     */
    static boolean beendenFuer(Context ctx, String callId) {
        if (callId == null || callId.isEmpty()) {
            beenden(ctx);
            return true;
        }
        synchronized (SPERRE) {
            erledigtMerken(callId);
            if (klingelnd != null && !klingelnd.isEmpty() && !klingelnd.equals(callId)) {
                return false;
            }
        }
        beenden(ctx);
        return true;
    }

    /** Entscheidung aus der Meldung: Klingeln aus, dann an die WebView bzw.
     *  auf den Merkzettel ({@link AnrufPlugin#entscheidung}). */
    static void entscheiden(Context ctx, String aktion, String callId) {
        beenden(ctx);
        AnrufPlugin.entscheidung(ctx, aktion, callId);
    }

    private static void erledigtMerken(String callId) {
        if (erledigt.contains(callId)) return;
        if (erledigt.size() >= ERLEDIGT_MERKEN) erledigt.removeFirst();
        erledigt.addLast(callId);
    }

    /** Start-Kennung des jüngsten Auftrags — {@link #anhalten} beendet den
     *  Dienst nur, wenn danach kein neuer Auftrag (nächster Anruf) kam. */
    private volatile int letzteStartId;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        letzteStartId = startId;
        // Neustart nach Kill ohne Auftrag (START_NOT_STICKY liefert null) —
        // ohne Anruf dahinter gibt es nichts zu zeigen.
        if (intent == null) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        String callId = intent.getStringExtra(EXTRA_CALL_ID);
        kanalAnlegen(this);
        Notification n = baue(this, callId, intent.getStringExtra(EXTRA_GEGENSTELLE));
        // startForeground ist Pflicht, sobald startForegroundService gerufen
        // wurde — auch wenn der Anruf inzwischen vorbei ist (siehe beenden).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL);
        } else {
            startForeground(NOTIF_ID, n);
        }
        boolean nochAktuell;
        synchronized (SPERRE) {
            nochAktuell = klingelnd != null && klingelnd.equals(callId == null ? "" : callId);
            if (nochAktuell) dienst = this;
        }
        if (!nochAktuell) anhalten();
        return START_NOT_STICKY;
    }

    private void anhalten() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf(letzteStartId);
    }

    private static Notification baue(Context ctx, String callId, String gegenstelle) {
        String name = (gegenstelle == null || gegenstelle.isEmpty())
                ? ctx.getString(R.string.anruf_unbekannt) : gegenstelle;
        // Full-Screen-Intent und Tipp auf die Meldung: MainActivity
        // (singleTask) nach vorn holen; EXTRA_ANRUF lässt sie über dem
        // Sperrbildschirm erscheinen (MainActivity.anrufAusIntent). Ab
        // Android 14 braucht der Full-Screen-Intent die Erlaubnis
        // NotificationManager.canUseFullScreenIntent(); fehlt sie, entfernt
        // das System ihn und zeigt eine Heads-up-Meldung (CallStyle bleibt
        // zulässig, das System merkt sich den verweigerten Wunsch).
        PendingIntent vollbild = PendingIntent.getActivity(ctx, 0,
                zurApp(ctx, callId), PI_FLAGS);
        PendingIntent annehmen = PendingIntent.getActivity(ctx, 1,
                zurApp(ctx, callId).putExtra(EXTRA_AKTION, AKTION_ANNEHMEN), PI_FLAGS);
        Person anrufer = new Person.Builder().setName(name).build();
        Notification n = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_pulse)
                .setColor(ContextCompat.getColor(ctx, R.color.push_akzent))
                .setContentTitle(ctx.getString(R.string.anruf_eingehend))
                .setContentText(name)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setTimeoutAfter(KLINGEL_HOECHSTENS_MS)
                .setContentIntent(vollbild)
                .setFullScreenIntent(vollbild, true)
                // CallStyle-Call-Karte (Android 12+): Plattform rendert eigene
                // Annehmen/Ablehnen-Flächen aus den beiden PendingIntents.
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(anrufer,
                        ablehnen(ctx, callId), annehmen))
                .build();
        // Klingelton wiederholen, bis die Meldung weg ist — wie ein Telefon.
        n.flags |= Notification.FLAG_INSISTENT;
        return n;
    }

    private static Intent zurApp(Context ctx, String callId) {
        return new Intent(ctx, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(EXTRA_ANRUF, true)
                .putExtra(EXTRA_CALL_ID, callId)
                .putExtra(AnrufMarke.EXTRA, AnrufMarke.wert(ctx));
    }

    private static PendingIntent ablehnen(Context ctx, String callId) {
        Intent i = new Intent(ctx, AktionsEmpfaenger.class)
                .setAction(AKTION_ABLEHNEN)
                .putExtra(EXTRA_CALL_ID, callId);
        return PendingIntent.getBroadcast(ctx, AKTION_ABLEHNEN.hashCode(), i, PI_FLAGS);
    }

    /** Ablehnen direkt aus der Notification — auch über dem Sperrbildschirm,
     *  ganz ohne Activity-Start (Broadcast, also auch kein Verstoß gegen das
     *  Notification-Trampoline-Verbot). Annehmen kommt seit Version 1.4 über
     *  die MainActivity; ein „annehmen" hier stammt nur noch aus einer
     *  Meldung, die vor dem Update gepostet wurde. */
    public static class AktionsEmpfaenger extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            String aktion = intent.getAction();
            if (AKTION_ANNEHMEN.equals(aktion) || AKTION_ABLEHNEN.equals(aktion)) {
                entscheiden(ctx, aktion, intent.getStringExtra(EXTRA_CALL_ID));
            } else {
                beenden(ctx);
            }
            if (AKTION_ABLEHNEN.equals(aktion)) AnrufModus.beendenVonAussen();
        }
    }

    private static void kanalAnlegen(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID,
                ctx.getString(R.string.kanal_anrufe), NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(ctx.getString(R.string.kanal_anrufe_info));
        ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
        ch.enableVibration(true);
        ch.setVibrationPattern(new long[]{0, 1000, 1000});
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
        try {
            if (nm.getNotificationChannel(ALTER_KANAL) != null) {
                nm.deleteNotificationChannel(ALTER_KANAL);
            }
        } catch (SecurityException ignored) {
            // Hängt noch eine Dienst-Meldung am alten Kanal (Update mitten im
            // Klingeln), verweigert das System das Löschen — beim nächsten
            // Anruf erneut.
        }
    }

    @Override
    public void onDestroy() {
        // Keinen Verweis auf einen beendeten Dienst stehen lassen.
        synchronized (SPERRE) {
            if (dienst == this) dienst = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
