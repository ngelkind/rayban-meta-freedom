package dev.raybanfreedom.ttstest;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.List;
import java.util.Locale;

/**
 * Framework TTS hosted inside the companion process; no Activity or IPC.
 * Speech is synthesized to a private WAV file, normalized (framework voices
 * are quiet next to Meta's own TTS) and played on the assistant route.
 */
public final class HeadlessSpeaker {
    private static final float TARGET_PEAK = 0.97f;
    private static final float MAX_GAIN = 4.0f; // +12 dB
    private static TextToSpeech engine;
    private static AudioTrack track;
    private static String activeId;
    private static String pendingText;
    private static File pendingFile;
    private static String state = "idle";

    private HeadlessSpeaker() {}

    private static AudioAttributes route() {
        return new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
    }

    public static boolean glassesSelected(Context context) {
        AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        List<AudioDeviceInfo> devices = audio.getAudioDevicesForAttributes(route());
        for (AudioDeviceInfo device : devices) {
            String name = String.valueOf(device.getProductName()).toLowerCase(Locale.ROOT);
            if (device.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP &&
                    (name.contains("rb meta") || name.contains("ray-ban"))) return true;
        }
        return false;
    }

    public static synchronized boolean start(Context context, String text, String id) {
        if (context == null || text == null || text.trim().isEmpty() || text.length() > 3000 ||
                id == null || id.isEmpty() || id.length() > 160 || !glassesSelected(context)) {
            return false;
        }
        if ("initializing".equals(state) || "speaking".equals(state)) return false;
        releaseTrack();
        if (engine != null) { engine.shutdown(); engine = null; }
        activeId = id;
        pendingText = text;
        Context app = context.getApplicationContext();
        pendingFile = new File(app.getCacheDir(), "rayban-speech.wav");
        state = "initializing";
        engine = new TextToSpeech(app, result -> initialized(result));
        return true;
    }

    private static synchronized void initialized(int result) {
        if (engine == null || !"initializing".equals(state)) return;
        if (result != TextToSpeech.SUCCESS) {
            pendingText = null;
            state = "failed";
            return;
        }
        engine.setLanguage(Locale.US);
        engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) {}
            @Override public void onDone(String id) { synthesized(id); }
            @Override public void onError(String id) { update(id, "failed"); }
        });
        String text = pendingText;
        pendingText = null;
        int queued = engine.synthesizeToFile(text, new Bundle(), pendingFile, activeId);
        if (queued != TextToSpeech.SUCCESS) state = "failed";
    }

    private static synchronized void synthesized(String id) {
        if (id == null || !id.equals(activeId) || !"initializing".equals(state)) return;
        try {
            play(pendingFile);
            state = "speaking";
        } catch (Exception error) {
            state = "failed";
        } finally {
            pendingFile.delete();
        }
    }

    /** Reads a PCM16 WAV, normalizes it and starts a static AudioTrack. */
    private static void play(File file) throws IOException {
        byte[] wav = new byte[(int) file.length()];
        try (FileInputStream in = new FileInputStream(file)) {
            int read = 0;
            while (read < wav.length) {
                int n = in.read(wav, read, wav.length - read);
                if (n < 0) break;
                read += n;
            }
        }
        ByteBuffer buffer = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        int rate = 0, channels = 0, bits = 0, dataStart = -1, dataLength = 0;
        int position = 12;
        while (position + 8 <= wav.length) {
            int id = buffer.getInt(position);
            int size = buffer.getInt(position + 4);
            if (id == 0x20746d66) { // "fmt "
                channels = buffer.getShort(position + 10);
                rate = buffer.getInt(position + 12);
                bits = buffer.getShort(position + 22);
            } else if (id == 0x61746164) { // "data"
                dataStart = position + 8;
                dataLength = Math.min(size, wav.length - dataStart);
                break;
            }
            position += 8 + size + (size & 1);
        }
        if (dataStart < 0 || bits != 16 || rate <= 0 || channels < 1 || channels > 2) {
            throw new IOException("unsupported speech audio");
        }
        int samples = dataLength / 2;
        int peak = 1;
        for (int i = 0; i < samples; i++) {
            peak = Math.max(peak, Math.abs((int) buffer.getShort(dataStart + i * 2)));
        }
        float gain = Math.min(MAX_GAIN, TARGET_PEAK * 32767f / peak);
        short[] pcm = new short[samples];
        for (int i = 0; i < samples; i++) {
            int value = Math.round(buffer.getShort(dataStart + i * 2) * gain);
            pcm[i] = (short) Math.max(-32768, Math.min(32767, value));
        }
        int frames = samples / channels;
        AudioTrack next = new AudioTrack.Builder()
                .setAudioAttributes(route())
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(rate)
                        .setChannelMask(channels == 1 ? AudioFormat.CHANNEL_OUT_MONO :
                                AudioFormat.CHANNEL_OUT_STEREO).build())
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(Math.max(samples * 2, 2))
                .build();
        next.write(pcm, 0, samples);
        final String id = activeId;
        next.setNotificationMarkerPosition(Math.max(1, frames - 1));
        next.setPlaybackPositionUpdateListener(new AudioTrack.OnPlaybackPositionUpdateListener() {
            @Override public void onMarkerReached(AudioTrack finished) { done(id, finished); }
            @Override public void onPeriodicNotification(AudioTrack ignored) {}
        });
        track = next;
        next.play();
    }

    private static synchronized void done(String id, AudioTrack finished) {
        update(id, "completed");
        if (finished == track) releaseTrack();
    }

    private static void releaseTrack() {
        if (track == null) return;
        try { track.stop(); } catch (IllegalStateException ignored) {}
        track.release();
        track = null;
    }

    private static synchronized void update(String id, String next) {
        if (id != null && id.equals(activeId)) state = next;
    }

    public static synchronized String status(String id) {
        return id != null && id.equals(activeId) ? state : "unknown";
    }

    public static synchronized void cancel(String id) {
        if (id == null || !id.equals(activeId)) return;
        if (engine != null) engine.stop();
        releaseTrack();
        pendingText = null;
        state = "cancelled";
    }
}
