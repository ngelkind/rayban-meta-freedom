"""
ota_capture.py — mitmproxy addon to archive the Ray-Ban Meta OTA transaction.

Fires the moment MITM works (needs ssl-unpin.js if stella pins — it does).
It captures the crown-jewel artifacts WITHOUT waiting for a real update: once we
see one OTA GraphQL response we have downloadUri+kekId and can pull the encrypted
blob straight from the CDN on demand.

Run:  mitmdump -s tools/mitm/ota_capture.py --set otadir=firmware/ota-capture
Point the phone's proxy at this host; install the mitm CA as a SYSTEM cert
(or bypass pinning with frida ssl-unpin.js). Then trigger an update CHECK in
stella (Settings > device > software update) — no need to press Install.

Honest caveat: if OTA/KEK ride OHTTP (HPKE inside TLS) the JSON markers won't
appear even with TLS decrypted — see notes/protocol-crypto.md. This addon flags
that case so we know to hook the OHTTP boundary in frida instead.
"""
import json, os, re, time
from mitmproxy import http, ctx

MARKERS = ("downloadUri", "otaArtifactId", "kekHash", "deviceEncryptedKek",
           "otaArtifactVersion", "baseFwVersion", "releaseChannelId")
CDN_HOSTS = ("lookaside.facebook.com", "fbcdn.net", "lookaside.ar.meta.com",
             "oculuscdn.com")

def load(loader):
    loader.add_option("otadir", str, "firmware/ota-capture",
                      "directory to archive OTA artifacts into")

def _dir():
    d = ctx.options.otadir
    os.makedirs(d, exist_ok=True)
    return d

def _save(name, data, mode="wb"):
    path = os.path.join(_dir(), name)
    with open(path, mode) as f:
        f.write(data)
    ctx.log.alert(f"[OTA] saved {path} ({len(data)} bytes)")
    return path

def response(flow: http.HTTPFlow):
    try:
        host = flow.request.pretty_host
        url = flow.request.pretty_url
        body = flow.response.content or b""

        # 1) OTA metadata / KEK — any JSON-ish body carrying the marker fields
        try:
            text = body.decode("utf-8", "ignore")
        except Exception:
            text = ""
        if any(m in text for m in MARKERS):
            stamp = time.strftime("%Y%m%d_%H%M%S")
            _save(f"ota_meta_{stamp}.json", body)
            # pretty-print the interesting fields to the console + a summary file
            found = {}
            for m in MARKERS:
                mm = re.search(r'"%s"\s*:\s*("?[^",}\]]+"?)' % re.escape(m), text)
                if mm:
                    found[m] = mm.group(1)
            ctx.log.alert(f"[OTA] metadata from {host}: {json.dumps(found, indent=2)}")
            with open(os.path.join(_dir(), "SUMMARY.txt"), "a") as f:
                f.write(f"{stamp} {url}\n{json.dumps(found, indent=2)}\n\n")

        # 2) The encrypted firmware container from the CDN
        if any(h in host for h in CDN_HOSTS) and len(body) > 256 * 1024:
            ct = flow.response.headers.get("content-type", "")
            if "image" in ct and "png" not in ct and "jpeg" not in ct or "octet" in ct or ct == "":
                stamp = time.strftime("%Y%m%d_%H%M%S")
                fn = f"blob_{stamp}_{host}_{len(body)}.bin"
                _save(fn, body)
                ctx.log.alert(f"[OTA] candidate firmware blob from {url}")

        # 3) OHTTP detection: encapsulated requests are opaque application/ohttp-*
        ct = flow.request.headers.get("content-type", "") + flow.response.headers.get("content-type", "")
        if "ohttp" in ct.lower() or "message/ohttp" in ct.lower():
            ctx.log.warn(f"[OTA] OHTTP traffic to {host} — payload HPKE-encrypted; "
                         f"TLS MITM won't reveal it. Hook OHTTP in frida instead.")
    except Exception as e:
        ctx.log.warn(f"[OTA] addon error on {flow.request.pretty_url}: {e}")
