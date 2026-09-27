package dev.raybanfreedom.ttstest;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ApplicationInfo;
import android.os.Process;
import android.util.Log;

/** Explicit entrypoint for the shell test or an app signed with our research key. */
public final class SpeechReceiver extends BroadcastReceiver {
    public static final String ACTION = "dev.raybanfreedom.ttstest.SPEAK";
    private static final String TAG = "RaybanSpeech";

    @Override public void onReceive(Context context, Intent intent) {
        int sender = getSentFromUid();
        PackageManager pm = context.getPackageManager();
        // `am broadcast` on this Android build reports INVALID_UID. Permit
        // that only in the disposable debuggable probe APK, never a release.
        boolean adbProbe = sender == -1 &&
                (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        boolean trusted = sender == 2000 ||
                adbProbe || pm.checkSignatures(sender, Process.myUid()) == PackageManager.SIGNATURE_MATCH;
        if (!trusted || intent == null || !ACTION.equals(intent.getAction())) {
            Log.w(TAG, "untrusted speech request ignored uid=" + sender);
            return;
        }
        String text = intent.getStringExtra("text");
        if (text == null || text.trim().isEmpty() || text.length() > 3000) {
            Log.w(TAG, "invalid speech request ignored");
            return;
        }
        Intent request = new Intent(context, SpeechService.class);
        request.putExtra("text", text);
        context.startForegroundService(request);
    }
}
