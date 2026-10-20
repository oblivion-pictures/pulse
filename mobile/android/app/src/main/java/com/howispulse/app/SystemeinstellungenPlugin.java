package com.howispulse.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Öffnet Seiten der Android-Einstellungen für diese App — etwa wenn der Nutzer
 * Mitteilungen abgeschaltet hat und die Web-App ihn dorthin schicken will.
 */
@CapacitorPlugin(name = "Systemeinstellungen")
public class SystemeinstellungenPlugin extends Plugin {

    /** Mitteilungs-Einstellungen der App (ab Android 8); darunter die
     *  App-Info-Seite, von der aus „Benachrichtigungen" einen Tipp entfernt ist. */
    @PluginMethod
    public void mitteilungenOeffnen(PluginCall call) {
        String paket = getContext().getPackageName();
        Intent i;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, paket);
        } else {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", paket, null));
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("notification settings unavailable", e);
        }
    }
}
