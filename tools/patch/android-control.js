/* Local phone control for the embedded proxy. The receiver is not exported;
 * only PendingIntents created by this app can invoke it from the notification.
 */
'use strict';

(function (root) {
  const CHANNEL = 'rayban-proxy-control';
  const NOTIFICATION_ID = 47820;
  const PAUSE = 'com.facebook.stella.raybanproxy.PAUSE';
  const RESUME = 'com.facebook.stella.raybanproxy.RESUME';
  const PREFS = 'rayban-proxy';
  const KEY = 'disabledV1';
  // registerClass stores the native callbacks on the class wrapper; if the
  // wrapper is collected, a later broadcast would call freed memory.
  const retained = [];

  function install(onPause, onResume, onFault) {
    const app = Java.use('android.app.ActivityThread').currentApplication();
    if (app === null) throw new Error('control needs application context');
    const prefs = app.getSharedPreferences(PREFS, 0);
    const IntentFilter = Java.use('android.content.IntentFilter');
    const BroadcastReceiver = Java.use('android.content.BroadcastReceiver');
    // Frida infers signatures from interfaces only. A superclass method needs
    // explicit types, otherwise it declares onReceive()V and the abstract
    // BroadcastReceiver.onReceive(Context, Intent) stays unimplemented.
    const Receiver = Java.registerClass({
      name: 'com.facebook.stella.RaybanProxyControlReceiver',
      superClass: BroadcastReceiver,
      methods: {onReceive: {
        returnType: 'void',
        argumentTypes: ['android.content.Context', 'android.content.Intent'],
        implementation: function (_context, intent) {
          // An exception escaping here would crash the companion app.
          try {
            const action = String(intent.getAction());
            if (action === PAUSE) {
              if (prefs.edit().putBoolean(KEY, true).commit()) onPause();
            } else if (action === RESUME) {
              if (prefs.edit().putBoolean(KEY, false).commit()) onResume();
            }
            show(app, prefs.getBoolean(KEY, false));
          } catch (error) {
            if (typeof onFault === 'function') onFault(error);
          }
        }
      }}
    });
    const receiver = Receiver.$new();
    retained.push(Receiver, receiver);
    const filter = IntentFilter.$new();
    filter.addAction(PAUSE);
    filter.addAction(RESUME);
    app.registerReceiver.overload('android.content.BroadcastReceiver',
      'android.content.IntentFilter', 'int').call(app, receiver, filter, 4);
    const disabled = prefs.getBoolean(KEY, false);
    if (disabled) onPause();
    try { show(app, disabled); }
    catch (error) { app.unregisterReceiver(receiver); throw error; }
    return {disabled,
      setDisabled: value => {
        if (!prefs.edit().putBoolean(KEY, !!value).commit()) throw new Error('control write failed');
        if (value) onPause(); else onResume();
        show(app, !!value);
      },
      dispose: () => app.unregisterReceiver(receiver)};
  }

  function show(app, disabled) {
    const NotificationChannel = Java.use('android.app.NotificationChannel');
    const Builder = Java.use('android.app.Notification$Builder');
    const ActionBuilder = Java.use('android.app.Notification$Action$Builder');
    const Intent = Java.use('android.content.Intent');
    const PendingIntent = Java.use('android.app.PendingIntent');
    const jstr = value => Java.use('java.lang.String').$new(value);
    const manager = Java.cast(app.getSystemService('notification'),
      Java.use('android.app.NotificationManager'));
    manager.createNotificationChannel(NotificationChannel.$new(CHANNEL, jstr('Rayban proxy'), 3));
    const action = disabled ? RESUME : PAUSE;
    const intent = Intent.$new(action);
    intent.setPackage(app.getPackageName());
    const pending = PendingIntent.getBroadcast(app, disabled ? 2 : 1, intent,
      0x08000000 | 0x04000000); // FLAG_UPDATE_CURRENT | FLAG_IMMUTABLE
    const button = ActionBuilder.$new(0, jstr(disabled ? 'Resume proxy' : 'Pause proxy'), pending).build();
    const icon = app.getApplicationInfo().icon.value;
    const notification = Builder.$new(app, CHANNEL)
      .setContentTitle(jstr('Rayban proxy'))
      .setContentText(jstr(disabled ? 'Paused' : 'Running'))
      .setSmallIcon(icon)
      .setOngoing(true)
      .addAction(button)
      .build();
    manager.notify(NOTIFICATION_ID, notification);
  }

  const api = {install};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAndroidControl = api;
})(globalThis);
