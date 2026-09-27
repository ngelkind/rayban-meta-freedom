/* Put phone-side feature code here. Only explicitly registered handlers run.
 * A complete photo import and assistant request binding must be verified before
 * either can be replaced. The service-18 capture notice is metadata, not media.
 */
'use strict';

function registerRaybanExtensions(router) {
  // Example: observing a capture notification without changing app behavior.
  // router.register({
  //   id: 'capture-notice', feature: 'datax', operation: 'in:18:6',
  //   mode: 'observe', enabled: true,
  //   handle: function (event) { console.log('capture notice bytes=' + event.payloadBytes); }
  // });
}

// Return a destination with async deliver({captureId,capturedAt,mime,bytes})
// after configuring one. This is deliberately absent in the stock build.
function createPhotoDestination() { return null; }
