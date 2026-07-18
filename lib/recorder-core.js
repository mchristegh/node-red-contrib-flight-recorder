// lib/recorder-core.js
//
// RecorderStore — the shared engine for node-red-contrib-flight-recorder.
// One instance = one recording. In v1 each capture node constructs a
// private store; in v2 the flight-recorder-store config node constructs
// one and capture nodes attach to it. The store never knows who feeds it
// and never calls send() — wrappers subscribe to its events.
//
// Behavioral contract highlights (agreed in design):
//   - seq is monotonic forever: survives wrap, clear and restarts.
//   - Paused captures are rejected and counted (droppedWhilePaused).
//   - mark() works while paused and counts toward capacity.
//   - Cooldown applies to "error"/"watermark" dumps only; "manual" always
//     fires. Suppressed auto-dumps emit "incidentSuppressed".
//   - "wrapped" emits only on the first wrap after construction, restore
//     or clear; wrapCount in stats tells the rest.
//   - Captures persist via debounce (count OR time, whichever first);
//     state-changing commands (clear/pause/resume/mark) write immediately.
//   - Persistence failures never stop recording.
//
// Zero Node-RED imports. All environment access is injected via deps.

"use strict";

const { EventEmitter } = require("events");
const path = require("path");
const normalizeMod = require(path.join(__dirname, "normalize.js"));
const { createNormalizer, _internal } = normalizeMod;

const FORMAT_VERSION = 1;
const CONTEXT_PREVIEW_CHARS = 500;

const CONFIG_DEFAULTS = {
  capacity: 100,
  maxRecordBytes: 16384,
  captureMode: "full",
  redactPaths: [],
  persist: false,
  persistDebounce: { captures: 20, ms: 5000 },
  incidentCooldownMs: 0, // 0 = no cooldown
};

function makeIncidentId() {
  try {
    const crypto = require("crypto");
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return (
    "inc-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

class RecorderStore extends EventEmitter {
  constructor(storeId, config, deps) {
    super();
    if (typeof storeId !== "string" || storeId.length === 0) {
      throw new Error("RecorderStore: storeId must be a non-empty string");
    }
    this.storeId = storeId;

    const cfg = Object.assign({}, CONFIG_DEFAULTS, config || {});
    cfg.persistDebounce = Object.assign(
      {},
      CONFIG_DEFAULTS.persistDebounce,
      (config && config.persistDebounce) || {},
    );
    if (!(Number.isInteger(cfg.capacity) && cfg.capacity > 0)) {
      throw new Error("RecorderStore: capacity must be a positive integer");
    }
    if (!(
      Number.isFinite(cfg.incidentCooldownMs) && cfg.incidentCooldownMs >= 0
    )) {
      throw new Error("RecorderStore: incidentCooldownMs must be >= 0");
    }
    this.config = cfg;

    const d = deps || {};
    this._now = typeof d.now === "function" ? d.now : Date.now;
    this._setTimeout =
      typeof d.setTimeout === "function" ? d.setTimeout : setTimeout;
    this._clearTimeout =
      typeof d.clearTimeout === "function" ? d.clearTimeout : clearTimeout;
    this._persistence = d.persistence || null;
    this._log = d.log || { warn: () => {}, error: () => {} };
    this._encode =
      typeof d.encode === "function" ? d.encode : _internal.fallbackEncode;
    this._meta = d.meta && typeof d.meta === "object" ? d.meta : null;

    this._normalizer = createNormalizer(
      {
        captureMode: cfg.captureMode,
        maxRecordBytes: cfg.maxRecordBytes,
        redactPaths: cfg.redactPaths,
      },
      { clone: d.clone, encode: d.encode },
    );

    // --- recording state -------------------------------------------------
    this.records = [];
    this.seqCounter = 0; // last issued seq; next record gets +1
    this.state = "recording"; // "recording" | "paused"
    this.droppedWhilePaused = 0;
    this.wrapCount = 0;
    this.truncatedCount = 0;
    this.restoredFromPersist = false;
    this._wrapEventArmed = true;
    this._lastAutoIncidentAt = null;
    this._lastCaptureAt = null; // drives deltaMs; marks do not update it

    // --- persistence bookkeeping -----------------------------------------
    this._unsavedCaptures = 0;
    this._debounceTimer = null;

    // --- attachment -------------------------------------------------------
    this._refs = new Set();

    if (this.config.persist) this._restoreState(); // once, at construction
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================
  attach(ref) {
    this._refs.add(ref);
    return this._refs.size;
  }

  detach(ref, opts) {
    this._refs.delete(ref);
    if (this._refs.size > 0) return this._refs.size;

    // last ref gone: quiesce
    this._cancelDebounce();
    if (this.config.persist && this._persistence) {
      if (opts && opts.removed) {
        try {
          this._persistence.remove(this.storeId);
        } catch (e) {
          this._error(e);
        }
      } else {
        this._writeState("close");
      }
    }
    return 0;
  }

  // =========================================================================
  // Capture
  // =========================================================================
  capture(input) {
    const at =
      input && Number.isFinite(input.capturedAt)
        ? input.capturedAt
        : this._now();

    if (this.state === "paused") {
      this.droppedWhilePaused++;
      return { accepted: false, seq: null, dropped: true, truncated: false };
    }

    let normalized;
    try {
      normalized = this._normalizer.normalize(input ? input.msg : undefined);
    } catch (e) {
      // normalize is built never to throw, but the recorder must never be
      // a point of failure regardless.
      this._error(e);
      return { accepted: false, seq: null, dropped: true, truncated: false };
    }

    const seq = ++this.seqCounter;
    const record = {
      seq: seq,
      capturedAt: at,
      deltaMs: this._lastCaptureAt === null ? null : at - this._lastCaptureAt,
      source: {
        id: input && input.sourceId !== undefined ? input.sourceId : null,
        name: input && input.sourceName !== undefined ? input.sourceName : null,
        type: input && input.sourceType !== undefined ? input.sourceType : null,
        port: input && input.sourcePort !== undefined ? input.sourcePort : null,
      },
      truncated: normalized.truncated,
      redacted: normalized.redacted,
      annotation: null,
      msg: normalized.msg,
    };
    this._lastCaptureAt = at;

    this._push(record);

    if (normalized.truncated) {
      this.truncatedCount++;
      this.emit("truncatedMessage", { seq: seq, sourceId: record.source.id });
    }

    this._noteUnsavedCapture();
    return {
      accepted: true,
      seq: seq,
      dropped: false,
      truncated: normalized.truncated,
    };
  }

  _push(record) {
    this.records.push(record);
    while (this.records.length > this.config.capacity) {
      this.records.shift();
      this.wrapCount++;
      if (this._wrapEventArmed) {
        this._wrapEventArmed = false;
        this.emit("wrapped", { wrapCount: this.wrapCount });
      }
    }
  }

  // =========================================================================
  // Commands
  // =========================================================================
  dump(trigger, context) {
    trigger = trigger || "manual";
    const at = this._now();

    if (
      trigger !== "manual" &&
      this.config.incidentCooldownMs > 0 &&
      this._lastAutoIncidentAt !== null
    ) {
      const elapsed = at - this._lastAutoIncidentAt;
      if (elapsed < this.config.incidentCooldownMs) {
        this.emit("incidentSuppressed", {
          trigger: trigger,
          remainingMs: this.config.incidentCooldownMs - elapsed,
        });
        return null;
      }
    }

    const incident = {
      incidentId: makeIncidentId(),
      storeId: this.storeId,
      trigger: trigger,
      triggeredAt: at,
      context: this._encodeContext(context),
      stats: this._buildStats(),
      records: this.records.slice(),
    };
    if (this._meta) incident.meta = this._meta;

    if (trigger !== "manual") this._lastAutoIncidentAt = at;
    this.emit("incident", incident);
    return incident;
  }

  clear() {
    const cleared = this.records.length;
    this.records = [];
    this.droppedWhilePaused = 0;
    this.wrapCount = 0;
    this.truncatedCount = 0;
    this._wrapEventArmed = true; // re-arm wrap notification
    // seqCounter deliberately preserved: monotonicity is forever.
    this.emit("cleared", { cleared: cleared });
    this._writeState("clear");
    return { cleared: cleared };
  }

  pause() {
    if (this.state === "paused") return { state: "paused", changed: false };
    this.state = "paused";
    this.emit("paused", { state: "paused" });
    this._writeState("pause");
    return { state: "paused", changed: true };
  }

  resume() {
    if (this.state === "recording")
      return { state: "recording", changed: false };
    this.state = "recording";
    this.emit("resumed", { state: "recording" });
    this._writeState("resume");
    return { state: "recording", changed: true };
  }

  mark(annotation) {
    // Marks are metadata about the recording, not traffic: accepted even
    // while paused, and they do not reset the capture delta chain.
    const at = this._now();
    const seq = ++this.seqCounter;
    const record = {
      seq: seq,
      capturedAt: at,
      deltaMs: this._lastCaptureAt === null ? null : at - this._lastCaptureAt,
      source: { id: null, name: null, type: null, port: null },
      truncated: false,
      redacted: [],
      annotation: this._encodeContext(annotation),
      msg: null,
    };
    this._push(record);
    this.emit("marked", { seq: seq, annotation: record.annotation });
    this._writeState("mark");
    return { seq: seq };
  }

  query() {
    return {
      storeId: this.storeId,
      state: this.state,
      capacity: this.config.capacity,
      restoredFromPersist: this.restoredFromPersist,
      config: {
        capacity: this.config.capacity,
        captureMode: this.config.captureMode,
        maxRecordBytes: this.config.maxRecordBytes,
        persist: this.config.persist,
        incidentCooldownMs: this.config.incidentCooldownMs,
      },
      stats: this._buildStats(),
    };
  }

  // =========================================================================
  // Stats (shared shape between query() and incidents)
  // =========================================================================
  _buildStats() {
    const n = this.records.length;
    const first = n ? this.records[0] : null;
    const last = n ? this.records[n - 1] : null;
    return {
      recordCount: n,
      firstSeq: first ? first.seq : null,
      lastSeq: last ? last.seq : null,
      spanMs: n >= 2 ? last.capturedAt - first.capturedAt : n === 1 ? 0 : null,
      droppedWhilePaused: this.droppedWhilePaused,
      wrapCount: this.wrapCount,
      truncatedCount: this.truncatedCount,
    };
  }

  // =========================================================================
  // Context encoding (incidents, marks): circular-safe, size-capped
  // =========================================================================
  _encodeContext(context) {
    if (context === undefined || context === null) return null;
    let encoded;
    try {
      encoded = this._encode(context);
    } catch (e) {
      this._error(e);
      return { __contextTruncated: true, preview: "[context encoding failed]" };
    }
    const bytes = _internal.measureBytes(encoded);
    if (bytes > this.config.maxRecordBytes) {
      const s = JSON.stringify(encoded);
      return {
        __contextTruncated: true,
        preview: (s === undefined ? "" : s).slice(0, CONTEXT_PREVIEW_CHARS),
      };
    }
    return encoded;
  }

  // =========================================================================
  // Persistence
  // =========================================================================
  _noteUnsavedCapture() {
    if (!this.config.persist || !this._persistence) return;
    this._unsavedCaptures++;
    if (this._unsavedCaptures >= this.config.persistDebounce.captures) {
      this._writeState("debounce-count");
      return;
    }
    if (this._debounceTimer === null) {
      this._debounceTimer = this._setTimeout(() => {
        this._debounceTimer = null;
        this._writeState("debounce-time");
      }, this.config.persistDebounce.ms);
    }
  }

  _cancelDebounce() {
    if (this._debounceTimer !== null) {
      this._clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  _writeState(reason) {
    if (!this.config.persist || !this._persistence) return;
    this._cancelDebounce();
    this._unsavedCaptures = 0;

    const state = {
      formatVersion: FORMAT_VERSION,
      storeId: this.storeId,
      savedAt: this._now(),
      seqCounter: this.seqCounter,
      state: this.state,
      stats: this._buildStats(),
      records: this.records,
    };

    try {
      const result = this._persistence.write(this.storeId, state);
      const done = () =>
        this.emit("persisted", {
          at: state.savedAt,
          recordCount: this.records.length,
          reason: reason,
        });
      if (result && typeof result.then === "function") {
        result.then(done).catch((e) => this._error(e));
      } else {
        done();
      }
    } catch (e) {
      this._error(e); // recording continues regardless
    }
  }

  _restoreState() {
    if (!this._persistence) return;
    let saved;
    try {
      saved = this._persistence.read(this.storeId);
    } catch (e) {
      this._log.warn(
        "flight-recorder: persist file unreadable for '" +
          this.storeId +
          "', starting fresh (" +
          e.message +
          ")",
      );
      return;
    }
    if (saved === null || saved === undefined) return;

    try {
      if (saved.formatVersion !== FORMAT_VERSION) {
        this._log.warn(
          "flight-recorder: persist formatVersion " +
            saved.formatVersion +
            " unsupported for '" +
            this.storeId +
            "', starting fresh",
        );
        return;
      }
      const records = Array.isArray(saved.records) ? saved.records : [];
      this.records = records.map((r) =>
        Object.assign({}, r, { restored: true }),
      );
      this.seqCounter = Number.isFinite(saved.seqCounter)
        ? Math.max(saved.seqCounter, 0)
        : 0;
      this.state = saved.state === "paused" ? "paused" : "recording";
      if (saved.stats && typeof saved.stats === "object") {
        if (Number.isFinite(saved.stats.droppedWhilePaused))
          this.droppedWhilePaused = saved.stats.droppedWhilePaused;
        if (Number.isFinite(saved.stats.wrapCount))
          this.wrapCount = saved.stats.wrapCount;
        if (Number.isFinite(saved.stats.truncatedCount))
          this.truncatedCount = saved.stats.truncatedCount;
      }
      const n = this.records.length;
      this._lastCaptureAt = n ? this.records[n - 1].capturedAt : null;
      this._wrapEventArmed = true; // re-arm after restore
      this.restoredFromPersist = true;
    } catch (e) {
      this._log.warn(
        "flight-recorder: persist file corrupt for '" +
          this.storeId +
          "', starting fresh (" +
          e.message +
          ")",
      );
      this.records = [];
      this.restoredFromPersist = false;
    }
  }

  // =========================================================================
  // Error surfacing: never crash on a listenerless 'error' event
  // =========================================================================
  _error(err) {
    this._log.error(err);
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }
}

module.exports = { RecorderStore, FORMAT_VERSION };
