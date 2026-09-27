package dev.raybanfreedom.ttstest;

import android.content.Context;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Locale;

/**
 * Speech for Meta's own reply stream. Framework TTS is synthesized to a
 * private WAV, normalized, resampled to the stream rate and encoded with the
 * platform Opus encoder. The result uses the framing Stella's BleAudioStream
 * scans: repeated [uint32 little-endian length][Opus packet], length <= 960.
 */
public final class HeadlessSpeakerOpus {
    private static final int MAX_PACKET = 960;
    private static final float TARGET_PEAK = 0.9f;
    private static final float MAX_GAIN = 4.0f;
    private static TextToSpeech engine;
    private static String activeId;
    private static String pendingText;
    private static File pendingFile;
    private static int pendingRate;
    private static int pendingBitrate;
    private static byte[] encoded;
    private static String state = "idle";

    private HeadlessSpeakerOpus() {}

    public static synchronized boolean start(Context context, String text, String id,
            int sampleRate, int bitrate) {
        if (context == null || text == null || text.trim().isEmpty() || text.length() > 3000 ||
                id == null || id.isEmpty() || id.length() > 160 ||
                sampleRate < 8000 || sampleRate > 48000 || bitrate < 6000 || bitrate > 128000) {
            return false;
        }
        if ("initializing".equals(state) || "encoding".equals(state)) return false;
        if (engine != null) { engine.shutdown(); engine = null; }
        activeId = id;
        pendingText = text;
        pendingRate = sampleRate;
        pendingBitrate = bitrate;
        encoded = null;
        Context app = context.getApplicationContext();
        pendingFile = new File(app.getCacheDir(), "rayban-reply.wav");
        state = "initializing";
        engine = new TextToSpeech(app, result -> initialized(result));
        return true;
    }

    private static synchronized void initialized(int result) {
        if (engine == null || !"initializing".equals(state)) return;
        if (result != TextToSpeech.SUCCESS) { state = "failed"; return; }
        engine.setLanguage(Locale.US);
        engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) {}
            @Override public void onDone(String id) { synthesized(id); }
            @Override public void onError(String id) { fail(id); }
        });
        String text = pendingText;
        pendingText = null;
        if (engine.synthesizeToFile(text, new Bundle(), pendingFile, activeId) !=
                TextToSpeech.SUCCESS) state = "failed";
    }

    private static synchronized void fail(String id) {
        if (id != null && id.equals(activeId)) state = "failed";
    }

    private static synchronized void synthesized(String id) {
        if (id == null || !id.equals(activeId) || !"initializing".equals(state)) return;
        state = "encoding";
        final File file = pendingFile;
        final int rate = pendingRate;
        final int bitrate = pendingBitrate;
        new Thread(() -> {
            byte[] out = null;
            try { out = encode(readPcm(file, rate), rate, bitrate); }
            catch (Exception ignored) {}
            finally { file.delete(); }
            finish(id, out);
        }, "rayban-opus").start();
    }

    private static synchronized void finish(String id, byte[] out) {
        if (!id.equals(activeId)) return;
        encoded = out;
        state = out == null || out.length == 0 ? "failed" : "ready";
    }

    /** Mono PCM16 at {@code rate}, normalized. */
    static short[] readPcm(File file, int rate) throws IOException {
        byte[] wav = new byte[(int) file.length()];
        try (FileInputStream in = new FileInputStream(file)) {
            int read = 0;
            while (read < wav.length) {
                int n = in.read(wav, read, wav.length - read);
                if (n < 0) break;
                read += n;
            }
        }
        ByteBuffer b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        int srcRate = 0, channels = 0, bits = 0, start = -1, length = 0, pos = 12;
        while (pos + 8 <= wav.length) {
            int chunk = b.getInt(pos);
            int size = b.getInt(pos + 4);
            if (chunk == 0x20746d66) {
                channels = b.getShort(pos + 10);
                srcRate = b.getInt(pos + 12);
                bits = b.getShort(pos + 22);
            } else if (chunk == 0x61746164) {
                start = pos + 8;
                length = Math.min(size, wav.length - start);
                break;
            }
            pos += 8 + size + (size & 1);
        }
        if (start < 0 || bits != 16 || srcRate <= 0 || channels < 1 || channels > 2) {
            throw new IOException("unsupported speech audio");
        }
        int frames = length / 2 / channels;
        float[] mono = new float[frames];
        float peak = 1f;
        for (int i = 0; i < frames; i++) {
            float sum = 0;
            for (int c = 0; c < channels; c++) sum += b.getShort(start + (i * channels + c) * 2);
            mono[i] = sum / channels;
            peak = Math.max(peak, Math.abs(mono[i]));
        }
        float gain = Math.min(MAX_GAIN, TARGET_PEAK * 32767f / peak);
        int outFrames = (int) ((long) frames * rate / srcRate);
        short[] pcm = new short[outFrames];
        for (int i = 0; i < outFrames; i++) {
            double src = (double) i * srcRate / rate;
            int i0 = (int) src;
            int i1 = Math.min(i0 + 1, frames - 1);
            double t = src - i0;
            double v = (mono[i0] * (1 - t) + mono[i1] * t) * gain;
            pcm[i] = (short) Math.max(-32768, Math.min(32767, Math.round(v)));
        }
        return pcm;
    }

    static byte[] encode(short[] pcm, int rate, int bitrate) throws IOException {
        MediaCodec codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try {
            MediaFormat format = MediaFormat.createAudioFormat(
                    MediaFormat.MIMETYPE_AUDIO_OPUS, rate, 1);
            format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            codec.start();
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            int offset = 0;
            boolean inputDone = false;
            byte[] header = new byte[4];
            long deadline = System.currentTimeMillis() + 15000;
            while (System.currentTimeMillis() < deadline) {
                if (!inputDone) {
                    int in = codec.dequeueInputBuffer(5000);
                    if (in >= 0) {
                        ByteBuffer buffer = codec.getInputBuffer(in);
                        buffer.clear();
                        int count = Math.min(pcm.length - offset, buffer.remaining() / 2);
                        buffer.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                                .put(pcm, offset, count);
                        long timeUs = (long) offset * 1_000_000L / rate;
                        offset += count;
                        inputDone = offset >= pcm.length;
                        codec.queueInputBuffer(in, 0, count * 2, timeUs,
                                inputDone ? MediaCodec.BUFFER_FLAG_END_OF_STREAM : 0);
                    }
                }
                int index = codec.dequeueOutputBuffer(info, 5000);
                if (index < 0) continue;
                boolean end = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 &&
                        info.size > 0 && info.size <= MAX_PACKET) {
                    ByteBuffer packet = codec.getOutputBuffer(index);
                    packet.position(info.offset);
                    byte[] data = new byte[info.size];
                    packet.get(data);
                    ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN).putInt(0, data.length);
                    out.write(header);
                    out.write(data);
                }
                codec.releaseOutputBuffer(index, false);
                if (end) break;
            }
        } finally {
            try { codec.stop(); } catch (IllegalStateException ignored) {}
            codec.release();
        }
        return out.toByteArray();
    }

    public static synchronized String status(String id) {
        return id != null && id.equals(activeId) ? state : "unknown";
    }

    /** Encoded framed Opus for {@code id}, once; null otherwise. */
    public static synchronized byte[] take(String id) {
        if (id == null || !id.equals(activeId) || !"ready".equals(state)) return null;
        byte[] out = encoded;
        encoded = null;
        state = "taken";
        return out;
    }

    public static synchronized void cancel(String id) {
        if (id == null || !id.equals(activeId)) return;
        if (engine != null) engine.stop();
        encoded = null;
        state = "cancelled";
    }
}
