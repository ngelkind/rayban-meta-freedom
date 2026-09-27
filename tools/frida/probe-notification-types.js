/* Constructor compatibility check. Creates Java objects only; does not post a
 * notification, register a receiver, or change the provisioned app.
 */
'use strict';

Java.perform(() => {
  try {
    const app = Java.use('android.app.ActivityThread').currentApplication();
    const JString = Java.use('java.lang.String');
    const Channel = Java.use('android.app.NotificationChannel');
    const Builder = Java.use('android.app.Notification$Builder');
    const ActionBuilder = Java.use('android.app.Notification$Action$Builder');
    const Intent = Java.use('android.content.Intent');
    const PendingIntent = Java.use('android.app.PendingIntent');
    const manager = Java.cast(app.getSystemService('notification'),
      Java.use('android.app.NotificationManager'));
    if (typeof manager.createNotificationChannel !== 'function' ||
        typeof manager.notify !== 'function') throw new Error('notification manager methods unavailable');
    const jstr = value => JString.$new(value);
    Channel.$new('rayban-proxy-type-probe', jstr('Rayban proxy'), 3);
    const intent = Intent.$new('com.facebook.stella.raybanproxy.TYPE_PROBE');
    intent.setPackage(app.getPackageName());
    const pending = PendingIntent.getBroadcast(app, 99, intent, 0x08000000 | 0x04000000);
    const action = ActionBuilder.$new(0, jstr('Pause proxy'), pending).build();
    Builder.$new(app, 'rayban-proxy-type-probe')
      .setContentTitle(jstr('Rayban proxy'))
      .setContentText(jstr('Running'))
      .setSmallIcon(app.getApplicationInfo().icon.value)
      .addAction(action)
      .build();
    send({kind: 'notification-types', ok: true});
  } catch (error) {
    send({kind: 'notification-types', error: String(error)});
  }
});
