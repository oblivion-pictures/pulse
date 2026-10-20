package com.howispulse.app;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.RemoteMessage;

import io.capawesome.capacitorjs.plugins.firebase.messaging.MessagingService;

import java.util.Map;

/**
 * FCM-Empfang der App — tritt im Manifest an die Stelle des Plugin-Dienstes
 * ({@link MessagingService}, dort per {@code tools:node="remove"} entfernt)
 * und fängt nur die Anruf-Pushes ab. Alles andere geht unverändert an das
 * Plugin weiter (Token, Chat-Pushes → WebView).
 *
 * Anruf-Pushes sind reine Datenpushes mit hoher Priorität; sie kommen auch
 * an, wenn die WebView getrennt ist oder der Prozess gar nicht lief. Ein
 * High-Priority-Push erlaubt den Start eines Foreground-Service aus dem
 * Hintergrund (Ausnahme von der Startsperre ab Android 12) — wird er vom
 * System herabgestuft, zeigt {@link CallForegroundService#ankommen} die
 * Meldung ohne Dienst.
 *
 * Felder (alle Strings): {@code type="anruf"}, {@code art="klingelt"} mit
 * {@code call_id, anruf_art, channel_id, einleiter_id, einleiter_name}, oder
 * {@code art="abbruch"} mit {@code call_id}.
 */
public class PushDienst extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage nachricht) {
        Map<String, String> daten = nachricht.getData();
        if (!"anruf".equals(daten.get("type"))) {
            super.onMessageReceived(nachricht);
            return;
        }
        // Ab hier bewusst NICHT an super: das Plugin reichte den Anruf sonst
        // als Chat-Meldung („notificationReceived") an die WebView.
        String callId = daten.get("call_id");
        if (callId == null || callId.isEmpty()) return;
        String art = daten.get("art");
        if ("klingelt".equals(art)) {
            // false: derselbe Anruf klingelt schon (WebSocket war schneller)
            // oder ist schon vorbei — dann auch keinen Zettel schreiben.
            if (CallForegroundService.ankommen(this, callId, daten.get("einleiter_name"))) {
                AnrufSpeicher.klingelt(this, daten);
            }
        } else if ("abbruch".equals(art)) {
            AnrufSpeicher.vergessen(this, callId, false);
            // Den Anrufmodus nur abschalten, wenn der Anruf hier noch klingelte.
            // Nach einer Annahme HIER klingelt nichts mehr, aber der Modus muss
            // bleiben, bis das Mikrofon läuft (wie GRUND_HIER_ANGENOMMEN in
            // AnrufPlugin.beenden) — sonst fällt die App hinter den
            // Sperrbildschirm, und der Mikrofon-Dienst darf nicht mehr starten.
            boolean klingelteHier = CallForegroundService.klingeltFuer(callId);
            if (CallForegroundService.beendenFuer(this, callId) && klingelteHier) {
                AnrufModus.beendenVonAussen();
            }
        }
    }
}
