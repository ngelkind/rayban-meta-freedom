# tools/ — capture & control rig for rayban-meta-freedom

Everything here is **pre-built so it fires the instant we have root (frida) or a
working MITM**. Nothing here needs the glasses to be poked by hand.

## Layout
- `frida/ble-capture.js` — framework-level BLE/BT capture. Hooks the Java
  `BluetoothGatt` / `BluetoothGattCallback` / socket APIs, which the app (even
  native Positron) MUST use — so it captures every control frame (on-air,
  airshield-encrypted). Guaranteed capture point.
- `frida/ssl-unpin.js` — Java + **native BoringSSL** TLS-pinning bypass for
  stella's Tigon stack (Java-only unpin is insufficient here).
- `mitm/ota_capture.py` — mitmproxy addon: auto-archives the OTA GraphQL
  response (downloadUri/kekId), the encrypted KEK, and the CDN firmware blob.
  Detects OHTTP and warns if payloads are HPKE-wrapped.
- `driver/scan_glasses.py` — Mac-side passive BLE scan (bleak/CoreBluetooth),
  runnable NOW, read-only recon of the glasses advert. No connect/pair.
- `frida/bluthlink-capture.js` — captures outbound RPCs and inbound RPC/topic
  frames above Airshield, including photo, wake, assistant audio, and state.
- `frida/dump-airshield-secrets.js` — exports the provisioned owned-device
  identity from Stella's in-process LightSharedPreferences objects.
- `frida/stella-control.js` — exposes Frida RPC methods `photo`, `startvideo`,
  `stopvideo`, and `status` through Stella's own authenticated device client.

## Prereqs
- Mac venv already has: frida-tools, mitmproxy, bleak, protobuf, unblob.
- Root path (best): rooted command-center phone + matching `frida-server`
  pushed and running; `frida-ps -U` should list `com.facebook.stella`.

## Run — BLE control-channel capture (needs frida-server/root)
```bash
frida -U -f com.facebook.stella -l tools/frida/ble-capture.js --no-pause \
  | tee captures/ble/frida_ble_$(date +%Y%m%d_%H%M%S).log
# then, on the glasses: say "Hey Meta", take a photo, etc. Watch the GATT/STREAM lines.
```

## Run — OTA / firmware archive (needs MITM + unpin)
```bash
# terminal 1: proxy + unpin (frida) so stella accepts our CA
frida -U -f com.facebook.stella -l tools/frida/ssl-unpin.js --no-pause
# terminal 2: capture
mitmdump -s tools/mitm/ota_capture.py --set otadir=firmware/ota-capture
# point the phone's Wi-Fi proxy at this Mac:8080, then trigger a software-update
# CHECK in stella (do NOT press Install). Artifacts land in firmware/ota-capture/.
```

## Run — live BLE recon (now, no root)
```bash
.venv/bin/python tools/driver/scan_glasses.py 20   # glasses out of case, phone BT off
```

## The protocol-capture tools (built from static RE — see notes/protocol-*.md)
- `frida/datax-capture.js` — **THE key script.** Hooks the un-obfuscated
  `com.facebook.wearable.datax.{LocalChannel,RemoteChannel,Service}` wrappers to
  log every DataX message as **plaintext protobuf + serviceId + opcode**, ABOVE
  the native airshield encryption and datax framing. Recovers the service/opcode
  map that static RE couldn't (only cam=151/op1 and video-demo=7011 were static).
  ```bash
  frida -U -f com.facebook.stella -l tools/frida/datax-capture.js --no-pause \
    | tee captures/ble/datax_$(date +%Y%m%d_%H%M%S).log
  # then exercise glasses features; each command/event prints svc/op/payload.
  ```
- `driver/pb_decode.py` — generic protobuf wire decoder (no .proto needed).
  Turns captured `payload=<hex>` into structured fields:
  ```bash
  .venv/bin/python tools/driver/pb_decode.py captures/ble/datax_*.log   # decodes all
  .venv/bin/python tools/driver/pb_decode.py 08021001                    # one payload
  ```

## Still to build (needs root/live captures in hand)
- `driver/glasses.py` — host client: open the L2CAP CoC (service 0xFD5F → PSM
  char 05ACBE9F-…), then reuse the Airshield/DataX components merged into
  `libstartup.so` with the extracted identity to complete the handshake.

## Run — BluthLink capture (needs frida-server/root or a Frida Gadget build)
```bash
frida -U -f com.facebook.stella -l tools/frida/bluthlink-capture.js --no-pause \
  | tee captures/ble/bluthlink_$(date +%Y%m%d_%H%M%S).log
```

## Build — no-root Frida Gadget test APK
`repack-stella.sh` injects Gadget into a copy of the saved base APK, signs the
base and ARM64 split with one local research key, and writes everything under
gitignored `captures/repack/`. Installing it replaces any existing official
Stella install and therefore must only be done on a designated research phone.
```bash
tools/repack-stella.sh
adb install-multiple captures/repack/base.frida.apk \
  captures/repack/split_config.arm64_v8a.apk
```
The Gadget waits during app startup. Forward its local port, launch Stella, then
attach the runner from another terminal:
```bash
adb forward tcp:27042 tcp:27042
adb shell monkey -p com.facebook.stella 1
.venv/bin/python tools/frida/run_capture.py --remote 127.0.0.1:27042 --attach \
  --package Gadget --output captures/ble/gadget_session.jsonl \
  tools/frida/datax-capture.js tools/frida/bluthlink-capture.js
```

## Run — owned-device identity export
Use the host runner so the payload goes directly to a mode-0600 file under the
gitignored `captures/` directory. The payload contains a private key.
```bash
.venv/bin/python tools/frida/run_capture.py --attach --output \
  captures/airshield_identity_$(date +%Y%m%d_%H%M%S).jsonl \
  tools/frida/dump-airshield-secrets.js
```

The same runner can launch Stella with both protocol capture scripts:
```bash
.venv/bin/python tools/frida/run_capture.py --output \
  captures/ble/session_$(date +%Y%m%d_%H%M%S).jsonl \
  tools/frida/datax-capture.js tools/frida/bluthlink-capture.js
```

Once Stella is paired and connected, the control bridge can invoke a photo or
video through the app's authenticated device client:
```bash
.venv/bin/python tools/frida/control.py --remote 127.0.0.1:27042 \
  --package Gadget status
.venv/bin/python tools/frida/control.py --remote 127.0.0.1:27042 \
  --package Gadget photo
```
