/*
 * ssl-unpin.js — TLS pinning bypass for stella's MITM (OTA/GraphQL capture)
 *
 * stella pins in NATIVE code (Tigon over BoringSSL: libtigon-*.so). A Java-only
 * unpin is insufficient. This does BOTH layers:
 *   (1) Java TrustManager / OkHttp CertificatePinner (covers any non-Tigon flow)
 *   (2) Native BoringSSL custom_verify callback override (the Tigon path)
 *
 * Run with a system CA (mitmproxy cert) installed + proxy set, then:
 *   frida -U -f com.facebook.stella -l ssl-unpin.js --no-pause
 *
 * NOTE: If OTA/KEK rides OHTTP (HPKE end-to-end inside TLS), unpinning reveals
 * the TLS layer but the payload stays HPKE-encrypted — see notes/protocol-crypto.md.
 * In that case hook the OHTTP encrypt/decrypt boundary instead (added post-RE).
 */
'use strict';

// ---------------- (1) Java layer ----------------
Java.perform(function () {
  // Custom X509TrustManager that trusts everything
  try {
    var X509TM = Java.registerClass({
      name: 'com.re.TrustAll',
      implements: [Java.use('javax.net.ssl.X509TrustManager')],
      methods: {
        checkClientTrusted: function () {},
        checkServerTrusted: function () {},
        getAcceptedIssuers: function () { return []; }
      }
    });
    var SSLContext = Java.use('javax.net.ssl.SSLContext');
    var TMArr = [X509TM.$new()];
    SSLContext.init.overload(
      '[Ljavax.net.ssl.KeyManager;', '[Ljavax.net.ssl.TrustManager;', 'java.security.SecureRandom'
    ).implementation = function (km, tm, sr) {
      console.log('[java] SSLContext.init -> injecting TrustAll');
      this.init(km, TMArr, sr);
    };
    console.log('[+] java SSLContext patched');
  } catch (e) { console.log('[-] java SSLContext: ' + e); }

  // OkHttp CertificatePinner (if present)
  try {
    var CP = Java.use('okhttp3.CertificatePinner');
    CP.check.overload('java.lang.String', 'java.util.List').implementation = function () {
      console.log('[java] okhttp CertificatePinner.check bypassed: ' + arguments[0]);
    };
    console.log('[+] okhttp CertificatePinner patched');
  } catch (e) { /* not present */ }
});

// ---------------- (2) Native BoringSSL layer ----------------
// BoringSSL verify result: ssl_verify_ok = 0, ssl_verify_invalid = 1.
// custom_verify callback signature: enum ssl_verify_result_t (*)(SSL*, uint8_t* out_alert)
(function () {
  var VERIFY_OK = 0;
  var replaced = 0;

  function installOn(modName) {
    ['SSL_CTX_set_custom_verify', 'SSL_set_custom_verify'].forEach(function (sym) {
      var p = Module.findExportByName(modName, sym);
      if (!p) return;
      try {
        var orig = new NativeFunction(p, 'void', ['pointer', 'int', 'pointer']);
        var okCb = new NativeCallback(function (ssl, outAlert) {
          return VERIFY_OK;
        }, 'int', ['pointer', 'pointer']);
        Interceptor.replace(p, new NativeCallback(function (ctx, mode, cb) {
          // force our always-OK callback regardless of what the app passed
          orig(ctx, mode, okCb);
        }, 'void', ['pointer', 'int', 'pointer']));
        replaced++;
        console.log('[native] overrode ' + sym + ' in ' + (modName || 'ANY'));
      } catch (e) { console.log('[native] ' + sym + ' err: ' + e); }
    });

    // Fallback: force SSL_get_verify_result -> X509_V_OK (0)
    var gv = Module.findExportByName(modName, 'SSL_get_verify_result');
    if (gv) {
      try {
        Interceptor.attach(gv, { onLeave: function (r) { r.replace(ptr(0)); } });
        console.log('[native] SSL_get_verify_result forced OK in ' + modName);
      } catch (e) {}
    }
  }

  // Try each loaded module that looks like it carries BoringSSL / Tigon
  function sweep() {
    var mods = Process.enumerateModules();
    var hitAny = false;
    mods.forEach(function (m) {
      if (/tigon|boringssl|ssl|liger|mnemo|xplat|coldstart|fbjni|tls/i.test(m.name)) {
        if (Module.findExportByName(m.name, 'SSL_CTX_set_custom_verify') ||
            Module.findExportByName(m.name, 'SSL_set_custom_verify')) {
          installOn(m.name); hitAny = true;
        }
      }
    });
    // also try global resolution (statically linked into some other .so)
    installOn(null);
    console.log('[native] sweep done, replaced=' + replaced + (hitAny ? '' : ' (no named module matched; relied on global)'));
  }

  // Tigon libs load lazily; hook dlopen to re-sweep as they appear.
  try {
    var dlopen = Module.findExportByName(null, 'android_dlopen_ext') ||
                 Module.findExportByName(null, 'dlopen');
    Interceptor.attach(dlopen, {
      onEnter: function (a) { this.path = a[0].readCString(); },
      onLeave: function () {
        if (this.path && /tigon|ssl|liger|mnemo/i.test(this.path)) {
          console.log('[native] dlopen ' + this.path + ' -> re-sweep');
          sweep();
        }
      }
    });
  } catch (e) { console.log('[native] dlopen hook err: ' + e); }

  setTimeout(sweep, 800);   // initial sweep after startup libs load
})();
