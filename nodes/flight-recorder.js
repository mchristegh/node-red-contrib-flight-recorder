// nodes/flight-recorder.js
//
// The inline flight-recorder node: a passthrough tap on a single wire.
//
// Outputs: [1] passthrough  [2] incidents  [3] query  [4] events
//
// Guarantees (agreed in design):
//   - Passthrough is sacred: the original msg object is forwarded untouched,
//     and no capture problem may ever block or mutate it.
//   - Commands arrive ONLY via the flight-recorder-control node (through the
//     store registry) — never in-band on the traffic wire.
//   - Pausing stops the tape, never the flow: traffic passes while paused.

"use strict";

const path = require("path");
const { RecorderStore } = require(path.join(__dirname, "..", "lib", "recorder-core.js"));
const { createFilePersistence } = require(path.join(__dirname, "..", "lib", "persistence.js"));
const registry = require(path.join(__dirname, "..", "lib", "store-registry.js"));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function toInt(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function toNonNegInt(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}
function parseRedactPaths(raw) {
  if (typeof raw !== "string") return [];
  return raw.split(/[\n,]/).map(s => s.trim()).filter(s => s.length > 0);
}
function getByPath(obj, dotPath) {
  const parts = dotPath.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object" ||
        !Object.prototype.hasOwnProperty.call(cur, p)) {
      return { found: false, value: undefined };
    }
    cur = cur[p];
  }
  return { found: true, value: cur };
}

function makeWatermark(property, operator, rawValue) {
  property = typeof property === "string" ? property.trim() : "";
  if (property.length === 0 || !operator || operator === "none") return null;

  return function evaluate(msg) {
    const got = getByPath(msg, property);
    if (operator === "exists") return got.found;
    if (operator === "notexists") return !got.found;
    if (!got.found) return false;

    const actual = got.value;
    const an = typeof actual === "number" ? actual : parseFloat(actual);
    const en = parseFloat(rawValue);
    const bothNumeric = Number.isFinite(an) && Number.isFinite(en);

    switch (operator) {
      case "eq":  return bothNumeric ? an === en : String(actual) === String(rawValue);
      case "neq": return bothNumeric ? an !== en : String(actual) !== String(rawValue);
      case "gt":  return bothNumeric && an >  en;
      case "gte": return bothNumeric && an >= en;
      case "lt":  return bothNumeric && an <  en;
      case "lte": return bothNumeric && an <= en;
      case "contains":
        try { return String(actual).indexOf(String(rawValue)) !== -1; }
        catch (e) { return false; }
      default: return false;
    }
  };
}

// ---------------------------------------------------------------------------
// shared wrapper plumbing (exported for reuse by the tap node in phase 6)
// ---------------------------------------------------------------------------
function buildStoreConfig(n) {
  return {
    capacity: toInt(n.capacity, 100),
    captureMode: n.captureMode === "summary" ? "summary" : "full",
    maxRecordBytes: toInt(n.maxRecordBytes, 16384),
    redactPaths: parseRedactPaths(n.redactPaths),
    persist: n.persist === true || n.persist === "true",
    incidentCooldownMs: toNonNegInt(n.incidentCooldownMs, 0)
  };
}

function makePersistenceAdapter(RED, node, wantPersist) {
  if (!wantPersist) return null;
  const userDir = RED.settings && RED.settings.userDir;
  if (!userDir) {
    node.warn("flight-recorder: persistence enabled but no userDir available; persistence disabled");
    return null;
  }
  return createFilePersistence(userDir);
}

// environment metadata attached to every incident: a post-mortem file read
// months later should say what produced it
function buildMeta(RED) {
  let pkgVersion = null;
  try {
    pkgVersion = require(path.join(__dirname, "..", "package.json")).version;
  } catch (e) { /* leave null */ }
  let redVersion = null;
  try {
    if (RED.settings && RED.settings.version) redVersion = RED.settings.version;
    else if (typeof RED.version === "function") redVersion = RED.version();
  } catch (e) { /* leave null */ }
  let hostname = null;
  try { hostname = require("os").hostname(); } catch (e) { /* leave null */ }
  return {
    package: "node-red-contrib-flight-recorder@" + (pkgVersion || "?"),
    nodeRed: redVersion,
    node: process.version,
    hostname: hostname
  };
}

module.exports = function (RED) {

  function FlightRecorderNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.name = n.name;

    // --- store construction ------------------------------------------------
    const cfg = buildStoreConfig(n);
    const persistence = makePersistenceAdapter(RED, node, cfg.persist);
    if (cfg.persist && !persistence) cfg.persist = false;

    const store = new RecorderStore(node.id, cfg, {
      persistence: persistence,
      meta: buildMeta(RED),
      log: { warn: (m) => node.warn(m), error: (e) => node.error(e) }
    });
    store.attach(node);
    node.recorderStore = store; // exposed for harnesses / advanced flows

    const watermark = makeWatermark(n.watermarkProperty, n.watermarkOperator, n.watermarkValue);

    // --- output helpers ----------------------------------------------------
    // outputs: [passthrough, incidents, query, events]
    function envelope(event, payload) {
      return {
        topic: node.name || "flight-recorder",
        recorderEvent: event,
        recorderState: store.state,
        storeId: store.storeId,
        payload: payload
      };
    }
    function sendIncident(incident) {
      node.send([null, envelope("incident", incident), null, envelope("incident", incident)]);
    }
    function sendQuery(snapshot) {
      node.send([null, null, envelope("query", snapshot), null]);
    }
    function sendEvent(event, payload) {
      node.send([null, null, null, envelope(event, payload)]);
    }

    // --- status ------------------------------------------------------------
    let persistTrouble = false;
    function showStatus() {
      if (persistTrouble) {
        node.status({ fill: "red", shape: "ring", text: "persist error" });
        return;
      }
      if (store.state === "paused") {
        node.status({
          fill: "yellow", shape: "ring",
          text: "paused (" + store.droppedWhilePaused + " dropped)"
        });
      } else {
        node.status({
          fill: "green", shape: "dot",
          text: store.records.length + "/" + store.config.capacity
        });
      }
    }
    showStatus();

    // --- store events -> outputs -------------------------------------------
    store.on("incident", (inc) => { sendIncident(inc); });
    store.on("incidentSuppressed", (e) => sendEvent("incidentSuppressed", e));
    store.on("marked", (e) => sendEvent("marked", e));
    store.on("wrapped", (e) => sendEvent("wrapped", e));
    store.on("truncatedMessage", (e) => sendEvent("truncatedMessage", e));
    store.on("paused", (e) => { sendEvent("paused", e); showStatus(); });
    store.on("resumed", (e) => { sendEvent("resumed", e); showStatus(); });
    store.on("cleared", (e) => { sendEvent("cleared", e); showStatus(); });
    store.on("persisted", (e) => { persistTrouble = false; sendEvent("persisted", e); });
    store.on("error", (err) => {
      persistTrouble = true;
      sendEvent("recorderError", { message: err && err.message });
      showStatus();
    });

    // --- command surface (used by flight-recorder-control via registry) -----
    function runCommand(command, arg) {
      switch (command) {
        case "dump":   return store.dump("manual", arg);
        case "clear":  return store.clear();
        case "pause": {
          const r = store.pause();
          if (!r.changed) sendEvent("commandIgnored", { command: "pause", state: r.state });
          return r;
        }
        case "resume": {
          const r = store.resume();
          if (!r.changed) sendEvent("commandIgnored", { command: "resume", state: r.state });
          return r;
        }
        case "mark":   return store.mark(arg);
        case "query": {
          const snapshot = store.query();
          sendQuery(snapshot);
          return snapshot;
        }
        default:
          sendEvent("commandIgnored", { command: command, reason: "unknown command" });
          return { error: "unknown command: " + command };
      }
    }
    registry.register(node.id, { store: store, runCommand: runCommand, kind: "inline" });

    // --- input: traffic only ------------------------------------------------
    node.on("input", function (msg) {
      // Capture, then watermark, then ALWAYS pass through. Nothing in the
      // capture path may throw its way into the flow.
      try {
        const result = store.capture({
          msg: msg,
          sourceId: node.id,
          sourceName: node.name || null,
          sourceType: "flight-recorder"
        });
        if (result.accepted && watermark && watermark(msg)) {
          store.dump("watermark", {
            condition: {
              property: n.watermarkProperty,
              operator: n.watermarkOperator,
              value: n.watermarkValue
            },
            matchedSeq: result.seq
          });
        }
        if (store.state === "recording") showStatus();
      } catch (e) {
        // belt and braces: surface, never block
        sendEvent("recorderError", { message: e && e.message });
      }
      node.send([msg, null, null, null]); // the original object, untouched
    });

    // --- close ---------------------------------------------------------------
    node.on("close", function (removed, done) {
      if (typeof removed === "function") { done = removed; removed = false; }
      registry.deregister(node.id);
      store.detach(node, { removed: !!removed });
      store.removeAllListeners();
      if (done) done();
    });
  }

  RED.nodes.registerType("flight-recorder", FlightRecorderNode);
};

// internals reused by the tap node (phase 6) and harnesses
module.exports._internal = {
  buildStoreConfig, parseRedactPaths, makeWatermark, getByPath, makePersistenceAdapter, buildMeta
};
