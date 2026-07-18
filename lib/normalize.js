// lib/normalize.js
//
// The capture normalization pipeline for node-red-contrib-flight-recorder.
//
// Contract (agreed in design):
//   createNormalizer(config, deps) -> { normalize(msg) }
//   normalize(msg) -> { msg, bytes, truncated, redacted }
//
// Pipeline order: clone -> redact -> encode -> measure -> degrade.
// Redaction happens before any serialization or preview generation so a
// secret can never leak into a truncated preview or an error path.
// The live msg is never mutated.
//
// Degradation: if the full encoding exceeds maxRecordBytes the record falls
// back to summary form with truncated: true (no partial per-property
// truncation in v1).
//
// This module has zero Node-RED imports. RED.util functions are injected
// via deps; built-in fallbacks keep it fully testable in a bare harness.

"use strict";

const DEFAULTS = {
  captureMode: "full", // "full" | "summary"
  maxRecordBytes: 16384,
  redactPaths: [],
};

const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";
const FUNCTION_MARK = "[Function]";
const HTTP_REQ_MARK = "[HttpRequest]";
const HTTP_RES_MARK = "[HttpResponse]";
const PREVIEW_CHARS = 120;
const TOPIC_CHARS = 256;
const BUFFER_PREVIEW_BYTES = 32;
const STACK_CAP_CHARS = 2000;

// ---------------------------------------------------------------------------
// Fallback deep clone (used when deps.clone is not injected).
// Circular-safe; preserves Buffers, TypedArrays, Dates and Errors as their
// own types so the encoder can recognize them. Functions are kept by
// reference (the encoder replaces them with a marker).
// ---------------------------------------------------------------------------
function fallbackClone(value, seen) {
  seen = seen || new WeakMap();
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new value.constructor(value);
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value instanceof Error) {
    const e = new Error(value.message);
    e.name = value.name;
    e.stack = value.stack;
    return e;
  }
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (let i = 0; i < value.length; i++)
      out[i] = fallbackClone(value[i], seen);
    return out;
  }
  const out = {};
  seen.set(value, out);
  for (const key of Object.keys(value)) {
    out[key] = fallbackClone(value[key], seen);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Built-in circular-safe encoder (used when deps.encode is not injected).
// Produces a plain, JSON-serializable structure per the contract rules.
// ---------------------------------------------------------------------------
function encodeValue(value, seen) {
  if (value === null) return null;

  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "function") return FUNCTION_MARK;
  if (t === "bigint") return value.toString() + "n";
  if (t === "symbol") return value.toString();
  if (t === "undefined") return undefined; // parents drop undefined keys

  // objects from here on
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return {
      __type: "buffer",
      length: value.length,
      preview: value.slice(0, BUFFER_PREVIEW_BYTES).toString("hex"),
    };
  }
  if (ArrayBuffer.isView(value)) {
    const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return {
      __type: "buffer",
      length: value.byteLength,
      preview: buf.slice(0, BUFFER_PREVIEW_BYTES).toString("hex"),
    };
  }
  if (value instanceof Error) {
    return {
      __type: "error",
      name: value.name,
      message: value.message,
      stack:
        typeof value.stack === "string"
          ? value.stack.slice(0, STACK_CAP_CHARS)
          : undefined,
    };
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i++) {
        const enc = encodeValue(value[i], seen);
        out.push(enc === undefined ? null : enc); // JSON array semantics
      }
      return out;
    }
    const out = {};
    for (const key of Object.keys(value)) {
      const enc = encodeValue(value[key], seen);
      if (enc !== undefined) out[key] = enc; // drop undefined per contract
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function fallbackEncode(msg) {
  return encodeValue(msg, new WeakSet());
}

// ---------------------------------------------------------------------------
// Redaction. Dot-paths, no wildcards in v1. Operates on the clone, records
// the paths actually found and masked. Missing parents never throw.
// ---------------------------------------------------------------------------
function applyRedaction(cloned, redactPaths) {
  const found = [];
  for (const path of redactPaths) {
    const parts = path.split(".");
    let parent = cloned;
    let ok = true;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (
        parent !== null &&
        typeof parent === "object" &&
        Object.prototype.hasOwnProperty.call(parent, p)
      ) {
        parent = parent[p];
      } else {
        ok = false;
        break;
      }
    }
    const leaf = parts[parts.length - 1];
    if (
      ok &&
      parent !== null &&
      typeof parent === "object" &&
      Object.prototype.hasOwnProperty.call(parent, leaf)
    ) {
      parent[leaf] = REDACTED;
      found.push(path);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Byte measurement of an already-encoded (plain, JSON-safe) structure.
// ---------------------------------------------------------------------------
function measureBytes(encoded) {
  const s = JSON.stringify(encoded);
  return typeof Buffer !== "undefined"
    ? Buffer.byteLength(s === undefined ? "" : s, "utf8")
    : s === undefined
      ? 0
      : s.length;
}

// ---------------------------------------------------------------------------
// Summary form. Built from the *encoded, post-redaction* msg so nothing
// masked can reappear in a preview.
// ---------------------------------------------------------------------------
function payloadTypeOf(encodedMsg) {
  if (!Object.prototype.hasOwnProperty.call(encodedMsg, "payload"))
    return "undefined";
  const p = encodedMsg.payload;
  if (p === null) return "null";
  if (Array.isArray(p)) return "array";
  if (typeof p === "object") {
    if (p.__type === "buffer") return "buffer";
    return "object";
  }
  return typeof p; // "string" | "number" | "boolean"
}

function buildSummary(encodedMsg) {
  const type = payloadTypeOf(encodedMsg);
  const p = encodedMsg.payload;

  let payloadBytes;
  let previewSource;
  if (type === "buffer") {
    payloadBytes = p.length;
    previewSource = "buffer[" + p.length + "] " + p.preview;
  } else if (type === "string") {
    payloadBytes =
      typeof Buffer !== "undefined" ? Buffer.byteLength(p, "utf8") : p.length;
    previewSource = p;
  } else if (type === "undefined") {
    payloadBytes = 0;
    previewSource = "";
  } else {
    const s = JSON.stringify(p);
    payloadBytes =
      typeof Buffer !== "undefined"
        ? Buffer.byteLength(s === undefined ? "" : s, "utf8")
        : s === undefined
          ? 0
          : s.length;
    previewSource = s === undefined ? "" : s;
  }

  const summary = {
    payloadType: type,
    payloadBytes: payloadBytes,
    payloadPreview: previewSource.slice(0, PREVIEW_CHARS),
    msgKeys: Object.keys(encodedMsg),
  };
  if (typeof encodedMsg.topic === "string") {
    summary.topic = encodedMsg.topic.slice(0, TOPIC_CHARS);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Factory. Config validated once; normalize() is the hot path.
// ---------------------------------------------------------------------------
function createNormalizer(config, deps) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  if (cfg.captureMode !== "full" && cfg.captureMode !== "summary") {
    throw new Error(
      "normalize: captureMode must be 'full' or 'summary', got '" +
        cfg.captureMode +
        "'",
    );
  }
  if (!(Number.isFinite(cfg.maxRecordBytes) && cfg.maxRecordBytes > 0)) {
    throw new Error("normalize: maxRecordBytes must be a positive number");
  }
  if (
    !Array.isArray(cfg.redactPaths) ||
    cfg.redactPaths.some((p) => typeof p !== "string" || p.length === 0)
  ) {
    throw new Error(
      "normalize: redactPaths must be an array of non-empty strings",
    );
  }

  const d = deps || {};
  const clone = typeof d.clone === "function" ? d.clone : fallbackClone;
  const encode = typeof d.encode === "function" ? d.encode : fallbackEncode;

  function normalize(msg) {
    if (msg === null || typeof msg !== "object") {
      // Node-RED msgs are always objects, but never throw on hostile input.
      msg = { payload: msg };
    }

    // Swap req/res for shallow placeholders BEFORE cloning, on a shallow
    // copy (original untouched). HTTP req/res objects are the classic
    // circular / multi-MB trap and are never deep-encoded per contract.
    let source = msg;
    if (
      Object.prototype.hasOwnProperty.call(msg, "req") ||
      Object.prototype.hasOwnProperty.call(msg, "res")
    ) {
      source = Object.assign({}, msg);
      if (Object.prototype.hasOwnProperty.call(source, "req"))
        source.req = HTTP_REQ_MARK;
      if (Object.prototype.hasOwnProperty.call(source, "res"))
        source.res = HTTP_RES_MARK;
    }

    // 1. clone
    const cloned = clone(source);

    // 2. redact (pre-serialization, so previews can never leak secrets)
    const redacted = applyRedaction(cloned, cfg.redactPaths);

    // 3. encode
    const encodedMsg = encode(cloned);

    // 4. measure
    const fullBytes = measureBytes(encodedMsg);

    // 5. degrade / select form
    if (cfg.captureMode === "summary") {
      const summary = buildSummary(encodedMsg);
      return {
        msg: summary,
        bytes: measureBytes(summary),
        truncated: false, // summary-by-config is not truncation
        redacted: redacted,
      };
    }

    if (fullBytes > cfg.maxRecordBytes) {
      const summary = buildSummary(encodedMsg);
      return {
        msg: summary,
        bytes: measureBytes(summary),
        truncated: true,
        redacted: redacted,
      };
    }

    return {
      msg: encodedMsg,
      bytes: fullBytes,
      truncated: false,
      redacted: redacted,
    };
  }

  return { normalize: normalize };
}

module.exports = {
  createNormalizer: createNormalizer,
  // exported for reuse by recorder-core (incident context encoding) and tests
  _internal: {
    fallbackClone: fallbackClone,
    fallbackEncode: fallbackEncode,
    measureBytes: measureBytes,
    markers: {
      REDACTED,
      CIRCULAR,
      FUNCTION_MARK,
      HTTP_REQ_MARK,
      HTTP_RES_MARK,
    },
  },
};
