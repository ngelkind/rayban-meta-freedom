/* Synthetic connectivity check: a deliberately invalid key and no personal
 * text. A 401 proves transport reached the selected provider's API endpoint.
 */
'use strict';

RaybanAndroidHttp.post('https://integrate.api.nvidia.com/v1/chat/completions', {
  headers: {'Content-Type': 'application/json', Authorization: 'Bearer invalid-probe-key'},
  body: {model: 'nvidia/nemotron-3-super-120b-a12b',
    messages: [{role: 'user', content: 'ping'}], max_tokens: 1},
  timeoutMs: 10000
}).then(result => send({kind: 'model-http-probe', status: result.status}))
  .catch(error => send({kind: 'model-http-probe', error: String(error)}));
