// nodes/flight-recorder-tap.js
//
// The ambient observer: records messages flowing through OTHER nodes via
// the RED.hooks messaging API, without touching their wires.
//
// Outputs: [1] incidents  [2] query  [3] events
// Input:   commands only (payload-addressed convenience alias; the
//          flight-recorder-control node is the canonical path).
//
// Scope (static membership, decided at design):
//   selection = (flows ∪ nodes ∪ types) − exclusions
//   plus a HARD-CODED exclusion of the whole flight-recorder family —
//   recorders never record recorders, in any mode, ever.
//   Membership is evaluated lazily per source node and cached, so nodes
//   added by partial deploys are picked up on first sight (self-healing).
//
// Mute (ephemeral, operational):
//   mute/unmute silence one channel (node, type, or flow) while the tape
//   rolls. Suppressed messages are counted, mute/unmute drop annotation
//   marks onto the tape, and query reports active mutes — a muted gap is
//   never invisible. Mutes reset on deploy/restart by design.
//
// Auto error dump: an onComplete hook fires store.dump("error", ...) for
// errors reported by in-scope nodes. Errors from MUTED sources still dump
// (you muted their chatter, not their failures). Cooldown applies.

"use strict";

const path = require("path");
const { RecorderStore } = require(path.join(__dirname, "..", "lib", "recorder-core.js"));
const registry = require(path.join(__dirname, "..", "lib", "store-registry.js"));
const inlineInternals = require(path.join(__dirname, "flight-recorder.js"))._internal;
const { buildStoreConfig, makeWatermark, makePersistenceAdapter, buildMeta } = inlineInternals;

const FAMILY_TYPES = [
  "flight-recorder", "flight-recorder-tap",
  "flight-recorder-control", "flight-recorder-store"
];

function parseList(raw) {
  if (typeof raw !== "string") return [];
  return raw.split(/[\n,]/).map(s => s.trim()).filter(s => s.length > 0);
}

// normalize a mute target into { kind, value, key } or null
function parseMuteTarget(target) {
  if (typeof target === "string" && target.trim().length > 0) {
    return { kind: "node", value: target.trim(), key: "node:" + target.trim() };
  }
  if (target && typeof target === "object") {
    const kinds = ["node", "type", "flow"].filter(k => typeof target[k] === "string" && target[k].length > 0);
    if (kinds.length === 1) {
      const kind = kinds[0];
      return { kind: kind, value: target[kind], key: kind + ":" + target[kind] };
    }
  }
  return null;
}

module.exports = function (RED) {

  function FlightRecorderTapNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.name = n.name;

    // --- store -------------------------------------------------------------
    const cfg = buildStoreConfig(n);
    const persistence = makePersistenceAdapter(RED, node, cfg.persist);
    if (cfg.persist && !persistence) cfg.persist = false;

    const store = new RecorderStore(node.id, cfg, {
      persistence: persistence,
      meta: buildMeta(RED),
      log: { warn: (m) => node.warn(m), error: (e) => node.error(e) }
    });
    store.attach(node);
    node.recorderStore = store;

    const watermark = makeWatermark(n.watermarkProperty, n.watermarkOperator, n.watermarkValue);
    const autoErrorDump = n.autoErrorDump === true || n.autoErrorDump === "true";

    // --- scope --------------------------------------------------------------
    const scopeAllFlows = n.scopeAllFlows === true || n.scopeAllFlows === "true";
    const flowSet = new Set(parseList(n.scopeFlows));
    const nodeSet = new Set(parseList(n.scopeNodes));
    const typeSet = new Set(parseList(n.scopeTypes));
    const exclNodeSet = new Set(parseList(n.excludeNodes));
    const exclTypeSet = new Set(parseList(n.excludeTypes));
    const familySet = new Set(FAMILY_TYPES);

    const scopeCache = new Map(); // sourceNodeId -> boolean (lazy, self-healing)

    function computeInScope(src) {
      if (!src || typeof src.id !== "string") return false;
      if (familySet.has(src.type)) return false;           // hard-coded, always
      if (exclNodeSet.has(src.id)) return false;
      if (exclTypeSet.has(src.type)) return false;
      if (nodeSet.has(src.id)) return true;
      if (typeSet.has(src.type)) return true;
      if (scopeAllFlows) return true;
      if (src.z !== undefined && flowSet.has(src.z)) return true;
      return false;
    }
    function inScope(src) {
      if (!src || typeof src.id !== "string") return false;
      let v = scopeCache.get(src.id);
      if (v === undefined) {
        v = computeInScope(src);
        scopeCache.set(src.id, v);
      }
      return v;
    }

    // --- mutes (ephemeral) ---------------------------------------------------
    const mutedNodes = new Set();
    const mutedTypes = new Set();
    const mutedFlows = new Set();
    const muteCounts = new Map(); // key -> suppressed count

    function activeMuteKey(src) {
      if (mutedNodes.has(src.id)) return "node:" + src.id;
      if (mutedTypes.has(src.type)) return "type:" + src.type;
      if (src.z !== undefined && mutedFlows.has(src.z)) return "flow:" + src.z;
      return null;
    }
    function muteSetFor(kind) {
      return kind === "node" ? mutedNodes : kind === "type" ? mutedTypes : mutedFlows;
    }
    function totalMutes() { return mutedNodes.size + mutedTypes.size + mutedFlows.size; }

    // --- outputs: [incidents, query, events] ---------------------------------
    function envelope(event, payload) {
      return {
        topic: node.name || "flight-recorder-tap",
        recorderEvent: event,
        recorderState: store.state,
        storeId: store.storeId,
        payload: payload
      };
    }
    function sendIncident(incident) {
      node.send([envelope("incident", incident), null, envelope("incident", incident)]);
    }
    function sendQuery(snapshot) {
      node.send([null, envelope("query", snapshot), null]);
    }
    function sendEvent(event, payload) {
      node.send([null, null, envelope(event, payload)]);
    }

    // --- status ---------------------------------------------------------------
    let persistTrouble = false;
    function showStatus() {
      if (persistTrouble) {
        node.status({ fill: "red", shape: "ring", text: "persist error" });
        return;
      }
      const muted = totalMutes();
      const suffix = muted > 0 ? " (" + muted + " muted)" : "";
      if (store.state === "paused") {
        node.status({ fill: "yellow", shape: "ring",
          text: "paused (" + store.droppedWhilePaused + " dropped)" + suffix });
      } else {
        node.status({ fill: "green", shape: "dot",
          text: store.records.length + "/" + store.config.capacity + suffix });
      }
    }
    showStatus();

    // --- store events -> outputs -----------------------------------------------
    store.on("incident", (inc) => sendIncident(inc));
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

    // --- capture path (hooks) ----------------------------------------------------
    const hookName = "flight-recorder-tap-" + node.id;

    function onSendHook(sendEvents) {
      const events = Array.isArray(sendEvents) ? sendEvents : [sendEvents];
      const seen = new Set(); // fan-out dedupe by _msgid within one invocation
      for (const ev of events) {
        try {
          const src = ev && ev.source && ev.source.node;
          if (!src || !inScope(src)) continue;

          const mk = activeMuteKey(src);
          if (mk !== null) {
            muteCounts.set(mk, (muteCounts.get(mk) || 0) + 1);
            continue;
          }

          const msgid = ev.msg && ev.msg._msgid;
          if (msgid !== undefined) {
            if (seen.has(msgid)) continue;
            seen.add(msgid);
          }

          const result = store.capture({
            msg: ev.msg,
            sourceId: src.id,
            sourceName: src.name || null,
            sourceType: src.type || null,
            sourcePort: ev.source.port !== undefined ? ev.source.port : null
          });
          if (result.accepted && watermark && watermark(ev.msg)) {
            store.dump("watermark", {
              condition: {
                property: n.watermarkProperty,
                operator: n.watermarkOperator,
                value: n.watermarkValue
              },
              matchedSeq: result.seq
            });
          }
        } catch (e) {
          // the tap must never become a hazard to the runtime it observes
          sendEvent("recorderError", { message: e && e.message });
        }
      }
      if (store.state === "recording") showStatus();
    }

    function onCompleteHook(ev) {
      try {
        if (!ev || !ev.error) return;
        const src = (ev.node && ev.node.node) ? ev.node.node : null;
        if (!src || !inScope(src)) return;
        // deliberately NOT mute-gated: muted chatter, not muted failures
        store.dump("error", {
          error: ev.error,
          source: { id: src.id, name: src.name || null, type: src.type || null },
          msg: ev.msg
        });
      } catch (e) {
        sendEvent("recorderError", { message: e && e.message });
      }
    }

    RED.hooks.add("onSend." + hookName, onSendHook);
    if (autoErrorDump) RED.hooks.add("onComplete." + hookName, onCompleteHook);

    // --- mute / unmute --------------------------------------------------------------
    function muteCmd(target) {
      const t = parseMuteTarget(target);
      if (!t) {
        sendEvent("commandIgnored", { command: "mute", reason: "invalid target" });
        return { error: "invalid mute target" };
      }
      // verifiably out of scope (node previously seen and rejected) -> refuse loudly
      if (t.kind === "node" && scopeCache.get(t.value) === false) {
        sendEvent("muteIgnored", { target: t, reason: "outside configured scope" });
        return { error: "target outside scope" };
      }
      const set = muteSetFor(t.kind);
      if (set.has(t.value)) {
        sendEvent("commandIgnored", { command: "mute", reason: "already muted", target: t });
        return { muted: true, changed: false };
      }
      set.add(t.value);
      if (!muteCounts.has(t.key)) muteCounts.set(t.key, 0);
      store.mark({ muted: { kind: t.kind, value: t.value } });
      sendEvent("muted", { target: t });
      showStatus();
      return { muted: true, changed: true };
    }

    function unmuteCmd(target) {
      const t = parseMuteTarget(target);
      if (!t) {
        sendEvent("commandIgnored", { command: "unmute", reason: "invalid target" });
        return { error: "invalid unmute target" };
      }
      const set = muteSetFor(t.kind);
      if (!set.has(t.value)) {
        sendEvent("commandIgnored", { command: "unmute", reason: "not muted", target: t });
        return { muted: false, changed: false };
      }
      set.delete(t.value);
      const suppressed = muteCounts.get(t.key) || 0;
      store.mark({ unmuted: { kind: t.kind, value: t.value }, suppressedCount: suppressed });
      sendEvent("unmuted", { target: t, suppressedCount: suppressed });
      showStatus();
      return { muted: false, changed: true, suppressedCount: suppressed };
    }

    // --- command surface ---------------------------------------------------------------
    function enrichedQuery() {
      const snapshot = store.query();
      snapshot.tap = {
        autoErrorDump: autoErrorDump,
        mutes: [].concat(
          [...mutedNodes].map(v => ({ kind: "node", value: v, suppressedCount: muteCounts.get("node:" + v) || 0 })),
          [...mutedTypes].map(v => ({ kind: "type", value: v, suppressedCount: muteCounts.get("type:" + v) || 0 })),
          [...mutedFlows].map(v => ({ kind: "flow", value: v, suppressedCount: muteCounts.get("flow:" + v) || 0 }))
        ),
        scopeSeen: {
          inScope: [...scopeCache.values()].filter(Boolean).length,
          outOfScope: [...scopeCache.values()].filter(v => !v).length
        }
      };
      return snapshot;
    }

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
          const snapshot = enrichedQuery();
          sendQuery(snapshot);
          return snapshot;
        }
        case "mute":   return muteCmd(arg);
        case "unmute": return unmuteCmd(arg);
        default:
          sendEvent("commandIgnored", { command: command, reason: "unknown command" });
          return { error: "unknown command: " + command };
      }
    }
    registry.register(node.id, { store: store, runCommand: runCommand, kind: "tap" });

    // --- input: command port (convenience alias) ------------------------------------------
    node.on("input", function (msg) {
      if (!msg || typeof msg.payload !== "string") {
        sendEvent("commandIgnored", { command: null, reason: "command must be a string payload" });
        return;
      }
      const command = msg.payload.trim().toLowerCase();
      let arg;
      if (command === "dump") arg = msg.context;
      else if (command === "mark") arg = msg.annotation;
      else if (command === "mute" || command === "unmute") arg = msg.target;
      runCommand(command, arg);
    });

    // --- close ---------------------------------------------------------------------------
    node.on("close", function (removed, done) {
      if (typeof removed === "function") { done = removed; removed = false; }
      RED.hooks.remove("*." + hookName);
      registry.deregister(node.id);
      store.detach(node, { removed: !!removed });
      store.removeAllListeners();
      if (done) done();
    });
  }

  RED.nodes.registerType("flight-recorder-tap", FlightRecorderTapNode);
};

module.exports._internal = { parseList, parseMuteTarget, FAMILY_TYPES };
