/* Deliver newly imported full photos. Per-item state tolerates imports that
 * become ready out of order; uncertain transfers are held for reconciliation.
 */
'use strict';

(function (root) {
  const PAGE_SIZE = 10;
  const MAX_PAGES_PER_POLL = 20;
  const QUERY = "SELECT mi.media_item_id,mi.capture_id,mi.originally_created_timestamp_ms," +
    "mf.uri,mf.current_file_size,mi.import_completed_timestamp_ms " +
    "FROM media_item mi " +
    "LEFT JOIN media_item_display mid ON mid.media_item_id=mi.media_item_id " +
    "AND mid.is_current_version=1 " +
    "LEFT JOIN media_file mf ON mf.media_file_id=mid.display_full_media_file_id " +
    "AND mf.is_ready=1 " +
    "WHERE mi.type='photo' AND mi.is_deleted=0 " +
    "AND mi.media_item_id>? AND mi.media_item_id>? " +
    "ORDER BY mi.media_item_id ASC LIMIT " + PAGE_SIZE;

  // Ledger states: sending, acknowledged, uncertain, failed and retry:N, where
  // N is the number of attempts that definitely did not reach the destination.
  function retryCount(state) {
    const match = /^retry:(\d{1,3})$/.exec(state || '');
    return match ? Number(match[1]) : null;
  }

  function outcomeOf(error) {
    const outcome = error && error.outcome;
    return ['retry', 'failed', 'uncertain', 'deferred'].includes(outcome) ? outcome : 'uncertain';
  }

  function deferred(message) {
    const error = new Error(message);
    error.outcome = 'deferred';
    return error;
  }

  class PhotoSource {
    constructor({database, files, ledger, destination, maxBytes = 30 * 1024 * 1024,
      maxAttempts = 5}) {
      if (!database?.query || !database?.maxPhotoId || !files?.read ||
          !ledger?.baseline || !ledger?.initialize || !ledger?.status ||
          !ledger?.transition || !destination?.deliver) {
        throw new Error('photo source adapters are incomplete');
      }
      this.database = database;
      this.files = files;
      this.ledger = ledger;
      this.destination = destination;
      this.maxBytes = maxBytes;
      this.maxAttempts = maxAttempts;
      this.running = false;
      this.scanAfter = null;
      this.stopped = false;
    }

    stop() { this.stopped = true; }

    async poll() {
      if (this.stopped) return {stopped: true};
      if (this.running) return {busy: true};
      this.running = true;
      try {
        let baseline = await this.ledger.baseline();
        if (baseline === null) {
          baseline = await this.database.maxPhotoId();
          await this.ledger.initialize(baseline);
          return {initialized: true, baseline};
        }
        if (!Number.isSafeInteger(baseline) || baseline < 0) throw new Error('invalid photo baseline');
        let cursor = this.scanAfter === null ? baseline : this.scanAfter;
        let delivered = 0;
        let held = 0;
        for (let page = 0; page < MAX_PAGES_PER_POLL && !this.stopped; page++) {
          const rows = await this.database.query(QUERY, [baseline, cursor]);
          for (const row of rows) {
            if (this.stopped) break;
            if (!Number.isSafeInteger(row.id) || row.id <= cursor) {
              throw new Error('invalid ready photo id');
            }
            cursor = row.id;
            if (!row.uri || !row.captureId || !Number.isFinite(row.capturedAt)) {
              held++;
              continue;
            }
            const state = await this.ledger.status(row.id);
            const attempts = state === null ? 0 : retryCount(state);
            if (attempts === null) { if (state !== 'acknowledged') held++; continue; }
            await this.ledger.transition(row.id, 'sending');
            let bytes;
            try {
              if (this.stopped) throw deferred('photo source stopped');
              try {
                bytes = await this.files.read(row.uri, this.maxBytes);
              } catch (error) {
                // Nothing left the phone; the file may still be finishing.
                if (error && !error.outcome) error.outcome = 'retry';
                throw error;
              }
              if (!(bytes instanceof Uint8Array) || bytes.length === 0 ||
                  bytes.length > this.maxBytes) {
                const error = new Error('photo file unavailable');
                error.outcome = 'retry';
                throw error;
              }
              if (this.stopped) throw deferred('photo source stopped');
              await this.destination.deliver({captureId: row.captureId,
                capturedAt: row.capturedAt, bytes});
              await this.ledger.transition(row.id, 'acknowledged');
              delivered++;
            } catch (error) {
              held++;
              const outcome = outcomeOf(error);
              // deferred: nothing was attempted, so the attempt is not counted.
              const next = outcome === 'deferred' ? 'retry:' + attempts :
                outcome === 'retry' ? (attempts + 1 >= this.maxAttempts ? 'failed' :
                  'retry:' + (attempts + 1)) : outcome;
              await this.ledger.transition(row.id, next);
              if (typeof this.ledger.note === 'function') this.ledger.note(row.id, String(error));
            } finally {
              if (bytes instanceof Uint8Array) bytes.fill(0);
            }
          }
          if (rows.length < PAGE_SIZE) { this.scanAfter = null; return {delivered, held}; }
        }
        this.scanAfter = cursor;
        return {delivered, held, more: !this.stopped};
      } finally {
        this.running = false;
      }
    }
  }

  const api = {PhotoSource, QUERY, retryCount};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanPhotoSource = api;
})(globalThis);
