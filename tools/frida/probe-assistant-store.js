/* Verify private persistent store using a zero-cost reservation. No API key
 * is read or emitted, and no model request is sent.
 */
'use strict';

try {
  const budget = new RaybanAssistant.DailyBudget(RaybanAndroidAssistantStore.budgetStore, 1);
  budget.reserve(0);
  const record = RaybanAndroidAssistantStore.budgetStore.read();
  send({kind: 'assistant-store-proof', persisted: !!record &&
    record.day === new Date().toISOString().slice(0, 10) && record.reservedUsd === 0});
} catch (error) {
  send({kind: 'assistant-store-proof', error: String(error)});
}
