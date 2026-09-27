package dev.raybanfreedom.ttstest;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.IBinder;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;
import java.util.List;
import java.util.Locale;

/** Headless Android TTS output to the selected Ray-Ban media route. */
public final class SpeechService extends Service implements TextToSpeech.OnInitListener {
    private static final String TAG = "RaybanSpeech";
    private static final String CHANNEL = "rayban-speech";
    private static final String UTTERANCE = "rayban-headless";
    private TextToSpeech speaker;
    private String pendingText;

    @Override public IBinder onBind(Intent intent) { return null; }

    private boolean glassesSelected() {
        AudioManager audio = (AudioManager) getSystemService(AUDIO_SERVICE);
        AudioAttributes route = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
        List<AudioDeviceInfo> devices = audio.getAudioDevicesForAttributes(route);
        for (AudioDeviceInfo device : devices) {
            String name = String.valueOf(device.getProductName()).toLowerCase(Locale.ROOT);
            if (device.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP &&
                    (name.contains("rb meta") || name.contains("ray-ban"))) return true;
        }
        return false;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager notifications = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL,
                "Glasses speech", NotificationManager.IMPORTANCE_LOW));
        Notification note = new Notification.Builder(this, CHANNEL)
                .setContentTitle("Speaking on glasses")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now).build();
        startForeground(47821, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        if (speaker != null) {
            Log.w(TAG, "speech already active");
            return START_NOT_STICKY;
        }
        pendingText = intent == null ? null : intent.getStringExtra("text");
        if (pendingText == null || pendingText.trim().isEmpty() ||
                pendingText.length() > 3000 || !glassesSelected()) {
            Log.w(TAG, "speech blocked: no valid text or glasses media route");
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        Log.i(TAG, "starting headless speech");
        speaker = new TextToSpeech(this, this);
        return START_NOT_STICKY;
    }

    @Override public void onInit(int result) {
        if (result != TextToSpeech.SUCCESS || speaker == null) {
            Log.w(TAG, "speech engine failed to initialize");
            stopSelf();
            return;
        }
        speaker.setLanguage(Locale.US);
        speaker.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
        speaker.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { Log.i(TAG, "speech started"); }
            @Override public void onDone(String id) {
                Log.i(TAG, "speech completed");
                stopSelf();
            }
            @Override public void onError(String id) {
                Log.w(TAG, "speech engine reported an error");
                stopSelf();
            }
        });
        int queued = speaker.speak(pendingText, TextToSpeech.QUEUE_FLUSH, null, UTTERANCE);
        pendingText = null;
        if (queued != TextToSpeech.SUCCESS) {
            Log.w(TAG, "speech could not be queued");
            stopSelf();
        }
    }

    @Override public void onDestroy() {
        if (speaker != null) speaker.shutdown();
        speaker = null;
        pendingText = null;
        super.onDestroy();
    }
}
