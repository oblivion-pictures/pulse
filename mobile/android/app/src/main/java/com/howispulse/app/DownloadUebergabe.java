package com.howispulse.app;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.webkit.DownloadListener;

/**
 * Download-Weiche der WebView an den System-{@link DownloadManager}.
 *
 * Bughunt Runde 45: Capacitor setzt KEINEN DownloadListener — ein
 * Android-WebView wirft Downloads STILLWEGE weg (Blob-URLs aus
 * `URL.createObjectURL` inklusive). Jeder Download-Knopf in der App
 * (2FA-Backup-Codes, Anhänge, Ablage, .env-Export) tat auf Android
 * schlicht nichts. Umweg über DownloadManager: Blob-URLs kann er
 * nicht laden — dafür ist der Ersatzweg verantwortlich, alles andere
 * (https-Presigns etc.) geht an den System-Download.
 */
final class DownloadUebergabe implements DownloadListener {
    private final Context context;

    DownloadUebergabe(Context context) {
        this.context = context;
    }

    @Override
    public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                String mimeType, long length) {
        if (url == null || url.startsWith("blob:")) return;
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            if (userAgent != null) req.addRequestHeader("User-Agent", userAgent);
            if (mimeType != null) req.setMimeType(mimeType);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "pulse-download");
            DownloadManager dm = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) dm.enqueue(req);
        } catch (Exception ignored) {
            // Nicht abfangbar ohne Toast-Infrastruktur — besser als ein
            // App-Crash; der Web-Seitige Fehlerpfad greift via Download-Feed.
        }
    }
}
