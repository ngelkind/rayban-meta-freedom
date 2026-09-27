package dev.raybanfreedom.ttstest;

import android.app.Activity;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.widget.TextView;
import java.util.List;
import java.util.Locale;

/** A separate, fixed-phrase test. It never reads Stella data or the microphone. */
public final class TtsTestActivity extends Activity implements TextToSpeech.OnInitListener {
    private static final String PHRASE = "This is a test of the custom speaker.";
    private static final String UTTERANCE = "rayban-system-tts-test";
    private TextToSpeech speaker;
    private TextView status;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        status = new TextView(this);
        status.setTextSize(22);
        status.setPadding(30, 50, 30, 30);
        status.setText("Starting Android speech...\n" + outputRoute());
        setContentView(status);
        speaker = new TextToSpeech(this, this);
    }

    private String outputRoute() {
        try {
            AudioManager manager = (AudioManager) getSystemService(AUDIO_SERVICE);
            AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
            List<AudioDeviceInfo> devices = manager.getAudioDevicesForAttributes(attributes);
            if (devices.isEmpty()) return "Selected output: none reported";
            AudioDeviceInfo device = devices.get(0);
            return "Selected output: " + device.getProductName()
                    + " (type " + device.getType() + ")";
        } catch (Exception exception) {
            return "Selected output: unavailable";
        }
    }

    private void show(String message) {
        runOnUiThread(() -> status.setText(message + "\n" + outputRoute()));
    }

    @Override public void onInit(int result) {
        if (result != TextToSpeech.SUCCESS) {
            show("Speech engine did not initialize: " + result);
            return;
        }
        speaker.setLanguage(Locale.US);
        speaker.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
        speaker.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { show("Speaking test phrase..."); }
            @Override public void onDone(String id) { show("Speech engine finished."); }
            @Override public void onError(String id) { show("Speech engine reported an error."); }
        });
        int queued = speaker.speak(PHRASE, TextToSpeech.QUEUE_FLUSH, null, UTTERANCE);
        if (queued != TextToSpeech.SUCCESS) show("Could not queue speech: " + queued);
    }

    @Override public void onDestroy() {
        if (speaker != null) speaker.shutdown();
        super.onDestroy();
    }
}
