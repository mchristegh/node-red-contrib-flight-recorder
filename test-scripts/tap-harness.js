// test-scripts/tap-harness.js
//
// Phase 6 harness for nodes/flight-recorder-tap.js. Extends the makeRED
// stub with a fake RED.hooks implementation (add / pattern remove / event
// dispatch) and a fake population of runtime nodes, then exercises scope
// compilation, fan-out dedupe, family self-exclusion, mute/unmute, auto
// error dumps, payload commands, and control-node-to-tap integration.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");

const registry = require(path.join(__dirname, "..", "lib", "store-registry.js"));

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS  " + label); }
  else { failures++; console.log("FAIL  " + label + (detail !== undefined ? "  [" + detail + "]" : "")); }
}

// ---------------------------------------------------------------------------
// fake RED.hooks: add(name, fn), remove("*.suffix"|name), dispatchers
// ---------------------------------------------------------------------------
function makeHooks() {
  const handlers = new Map();
  return {
    add(name, fn) { handlers.set(name, fn); },
    remove(pattern) {
      if (pattern.startsWith("*.")) {
        const suffix = pattern.slice(1); // ".flight-recorder-tap-<id>"
        for (const k of [...handlers.keys()]) if (k.endsWith(suffix)) handlers.delete(k);
      } else {
        handlers.delete(pattern);
      }
    },
    dispatchSend(sendEvents) {
      for (const [k, fn] of handlers) if (k.startsWith("onSend.")) fn(sendEvents);
    },
    dispatchComplete(ev) {
      for (const [k, fn] of handlers) if (k.startsWith("onComplete.")) fn(ev);
    },
    count() { return handlers.size; },
    names() { return [...handlers.keys()]; }
  };
}

function makeRED(userDir) {
  const registered = {};
  return {
    nodes: {
      registerType(name, ctor) { registered[name] = ctor; },
      createNode(node, n) {
        node.id = n.id;
        node._handlers = {};
        node.on = function (evt, fn) { node._handlers[evt] = fn; };
        node.receive = function (msg) { node._handlers["input"](msg); };
        node.close = function (removed) {
          return new Promise(res => node._handlers["close"](removed, res));
        };
        node.sent = [];
        node.send = function (out) { node.sent.push(out); };
        node.statusCalls = [];
        node.status = function (s) { node.statusCalls.push(s); };
        node.warned = [];
        node.warn = function (m) { node.warned.push(m); };
        node.error = function (e) { console.log("NODE ERROR:", e); };
      },
      get(name) { return registered[name]; }
    },
    util: { cloneMessage(m) { return JSON.parse(JSON.stringify(m || {})); } },
    hooks: makeHooks(),
    settings: { userDir: userDir }
  };
}

function makeTap(RED, cfg) {
  const Ctor = RED.nodes.get("flight-recorder-tap");
  const node = {};
  Ctor.call(node, Object.assign({
    id: "tap" + Math.random().toString(36).slice(2),
    name: "", capacity: "20", captureMode: "full", maxRecordBytes: "16384",
    redactPaths: "", persist: false, incidentCooldownMs: "0",
    watermarkProperty: "", watermarkOperator: "none", watermarkValue: "",
    scopeAllFlows: false, scopeFlows: "", scopeNodes: "", scopeTypes: "",
    excludeNodes: "", excludeTypes: "", autoErrorDump: false
  }, cfg));
  return node;
}

function makeControl(RED, cfg) {
  const Ctor = RED.nodes.get("flight-recorder-control");
  const node = {};
  Ctor.call(node, Object.assign({
    id: "ctl" + Math.random().toString(36).slice(2), name: "", target: ""
  }, cfg));
  return node;
}

// fake runtime nodes and hook events
function src(id, type, name, z) { return { id, type, name, z }; }
let msgSeq = 0;
function sendEv(source, msg, port, destId) {
  if (msg._msgid === undefined) msg._msgid = "mid" + (++msgSeq);
  return { msg: msg, source: { id: source.id, node: source, port: port || 0 },
           destination: { id: destId || "dest" } };
}
function emit(RED, source, msg, port) { RED.hooks.dispatchSend([sendEv(source, msg, port)]); }

// tap outputs: [incidents, query, events]
function tapOut(node, idx) { return node.sent.map(a => Array.isArray(a) ? a[idx] : null).filter(Boolean); }
function events(node, type) { return tapOut(node, 2).filter(m => m.recorderEvent === type); }
function lastStatus(node) { return node.statusCalls[node.statusCalls.length - 1]; }

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "flightrec-p6-"));

(async function main() {
  const RED = makeRED(userDir);
  require(path.join(__dirname, "..", "nodes", "flight-recorder.js"))(RED);
  require(path.join(__dirname, "..", "nodes", "flight-recorder-tap.js"))(RED);
  require(path.join(__dirname, "..", "nodes", "flight-recorder-control.js"))(RED);

  // fake population
  const mqtt1 = src("m1", "mqtt in", "sensor A", "flow1");
  const mqtt2 = src("m2", "mqtt in", "sensor B", "flow2");
  const func1 = src("f1", "function", "transform", "flow1");
  const http1 = src("h1", "http request", "poller", "flow2");
  const famIn = src("fr1", "flight-recorder", "inline rec", "flow1");
  const famTp = src("fr2", "flight-recorder-tap", "other tap", "flow1");

  // =========================================================================
  // S1: construction — hooks registered, onComplete only with autoErrorDump
  // =========================================================================
  {
    const t1 = makeTap(RED, { id: "s1a", scopeFlows: "flow1" });
    check("S1 onSend hook registered", RED.hooks.names().some(k => k === "onSend.flight-recorder-tap-s1a"));
    check("S1 no onComplete without autoError", !RED.hooks.names().some(k => k.startsWith("onComplete.")));
    check("S1 registry kind tap", registry.get("s1a").kind === "tap");
    await t1.close(false);

    const t2 = makeTap(RED, { id: "s1b", scopeFlows: "flow1", autoErrorDump: true });
    check("S1 onComplete with autoError", RED.hooks.names().some(k => k === "onComplete.flight-recorder-tap-s1b"));
    await t2.close(false);
    check("S1 close removes all hooks", RED.hooks.count() === 0, RED.hooks.names().join(","));
  }

  // =========================================================================
  // S2: scope by flow — flow1 captured, flow2 not; lazy cache self-heals
  // =========================================================================
  {
    const tap = makeTap(RED, { scopeFlows: "flow1" });
    emit(RED, mqtt1, { payload: 1 });
    emit(RED, mqtt2, { payload: 2 });
    emit(RED, func1, { payload: 3 });
    check("S2 flow scope", tap.recorderStore.records.length === 2 &&
          tap.recorderStore.records.map(r => r.source.id).join(",") === "m1,f1");
    // a node never seen before (added by later deploy) is picked up on sight
    const late = src("late1", "inject", "newcomer", "flow1");
    emit(RED, late, { payload: 4 });
    check("S2 lazy pickup of new node", tap.recorderStore.records.length === 3 &&
          tap.recorderStore.records[2].source.id === "late1");
    await tap.close(false);
  }

  // =========================================================================
  // S3: node + type selectors; exclusions always win
  // =========================================================================
  {
    const tap = makeTap(RED, { scopeNodes: "h1", scopeTypes: "mqtt in", excludeNodes: "m2" });
    emit(RED, mqtt1, { payload: 1 });   // in via type
    emit(RED, mqtt2, { payload: 2 });   // type matches but excluded by id
    emit(RED, http1, { payload: 3 });   // in via node id
    emit(RED, func1, { payload: 4 });   // matches nothing
    check("S3 selection minus exclusions", tap.recorderStore.records.length === 2 &&
          tap.recorderStore.records.map(r => r.source.id).join(",") === "m1,h1");

    const tap2 = makeTap(RED, { scopeAllFlows: true, excludeTypes: "http request" });
    emit(RED, http1, { payload: 5 });
    emit(RED, func1, { payload: 6 });
    check("S3 all-flows minus excluded type", tap2.recorderStore.records.length === 1 &&
          tap2.recorderStore.records[0].source.id === "f1");
    await tap.close(false); await tap2.close(false);
  }

  // =========================================================================
  // S4: family self-exclusion — even in all-flows, even if explicitly named
  // =========================================================================
  {
    const tap = makeTap(RED, { scopeAllFlows: true, scopeNodes: "fr1,fr2" });
    emit(RED, famIn, { payload: "from inline recorder" });
    emit(RED, famTp, { payload: "from another tap" });
    emit(RED, func1, { payload: "civilian" });
    check("S4 recorders never record recorders", tap.recorderStore.records.length === 1 &&
          tap.recorderStore.records[0].source.id === "f1");
    await tap.close(false);
  }

  // =========================================================================
  // S5: fan-out dedupe — one send to 3 wires = one record, port kept
  // =========================================================================
  {
    const tap = makeTap(RED, { scopeAllFlows: true });
    const msg = { _msgid: "fan1", payload: "wide" };
    RED.hooks.dispatchSend([
      sendEv(func1, msg, 1, "d1"), sendEv(func1, msg, 1, "d2"), sendEv(func1, msg, 1, "d3")
    ]);
    check("S5 one record for fan-out", tap.recorderStore.records.length === 1);
    check("S5 port recorded", tap.recorderStore.records[0].source.port === 1);
    // distinct msgs in the same invocation are all captured
    RED.hooks.dispatchSend([
      sendEv(func1, { _msgid: "a", payload: 1 }), sendEv(func1, { _msgid: "b", payload: 2 })
    ]);
    check("S5 distinct msgs both captured", tap.recorderStore.records.length === 3);
    await tap.close(false);
  }

  // =========================================================================
  // S6: mute/unmute — suppression counted, tape marked, query reports
  // =========================================================================
  {
    const tap = makeTap(RED, { id: "s6-tap", scopeAllFlows: true });
    emit(RED, mqtt1, { payload: "pre" });                        // seq 1
    tap.receive({ payload: "mute", target: { node: "m1" } });    // mark seq 2
    emit(RED, mqtt1, { payload: "silenced 1" });
    emit(RED, mqtt1, { payload: "silenced 2" });
    emit(RED, func1, { payload: "other channel rolls" });        // seq 3
    tap.receive({ payload: "unmute", target: { node: "m1" } });  // mark seq 4
    emit(RED, mqtt1, { payload: "post" });                       // seq 5

    const recs = tap.recorderStore.records;
    check("S6 suppressed not captured", recs.length === 5 &&
          recs.map(r => r.seq).join(",") === "1,2,3,4,5");
    check("S6 mute mark on tape", recs[1].annotation.muted.value === "m1");
    check("S6 unmute mark carries count", recs[3].annotation.unmuted.value === "m1" &&
          recs[3].annotation.suppressedCount === 2, JSON.stringify(recs[3].annotation));
    check("S6 muted/unmuted events", events(tap, "muted").length === 1 &&
          events(tap, "unmuted").length === 1 &&
          events(tap, "unmuted")[0].payload.suppressedCount === 2);
    check("S6 status showed mute", tap.statusCalls.some(s => /1 muted/.test(s.text)));

    tap.receive({ payload: "mute", target: { type: "mqtt in" } });
    emit(RED, mqtt1, { payload: "type-muted" });
    emit(RED, mqtt2, { payload: "type-muted too" });
    const q = registry.get("s6-tap").runCommand("query");
    check("S6 type mute suppresses", tap.recorderStore.records.length === 6 /* 5 prior + mute mark */ &&
          q.tap.mutes.length === 1 && q.tap.mutes[0].kind === "type" &&
          q.tap.mutes[0].suppressedCount === 2, JSON.stringify(q.tap.mutes));
    check("S6 scopeSeen in query", q.tap.scopeSeen.inScope >= 2, JSON.stringify(q.tap.scopeSeen));
    check("S6 redundant mute ignored", (tap.receive({ payload: "mute", target: { type: "mqtt in" } }),
          events(tap, "commandIgnored").some(m => m.payload.reason === "already muted")));
    await tap.close(false);
  }

  // =========================================================================
  // S7: mute verifiably outside scope — refused loudly
  // =========================================================================
  {
    const tap = makeTap(RED, { scopeFlows: "flow1" });
    emit(RED, mqtt2, { payload: "x" });  // flow2: seen and rejected -> cached false
    tap.receive({ payload: "mute", target: { node: "m2" } });
    check("S7 muteIgnored event", events(tap, "muteIgnored").length === 1 &&
          /outside/.test(events(tap, "muteIgnored")[0].payload.reason));
    check("S7 not added", tap.recorderStore.records.length === 0); // no mark laid
    await tap.close(false);
  }

  // =========================================================================
  // S8: auto error dump — in scope dumps, out doesn't, mutes don't gate,
  //     cooldown suppresses
  // =========================================================================
  {
    const tap = makeTap(RED, { scopeFlows: "flow1", autoErrorDump: true,
      incidentCooldownMs: "60000" });
    emit(RED, mqtt1, { payload: "context traffic" });
    const boom = new Error("division by cucumber");

    RED.hooks.dispatchComplete({ msg: { payload: "bad" }, node: { id: "f1", node: func1 }, error: boom });
    const incs = tapOut(tap, 0);
    check("S8 error incident", incs.length === 1 && incs[0].payload.trigger === "error");
    check("S8 context structured", incs[0].payload.context.error.__type === "error" &&
          incs[0].payload.context.error.message === "division by cucumber" &&
          incs[0].payload.context.source.id === "f1", JSON.stringify(incs[0].payload.context.error));
    check("S8 tape attached", incs[0].payload.records.length === 1);

    RED.hooks.dispatchComplete({ msg: {}, node: { id: "h1", node: http1 }, error: boom });
    check("S8 out of scope ignored", tapOut(tap, 0).length === 1);

    RED.hooks.dispatchComplete({ msg: {}, node: { id: "f1", node: func1 }, error: boom });
    check("S8 cooldown suppresses", tapOut(tap, 0).length === 1 &&
          events(tap, "incidentSuppressed").length === 1);

    // muted source's ERRORS still dump: mute f1... but cooldown is active, so
    // verify on a fresh tap with no cooldown
    await tap.close(false);
    const tap2 = makeTap(RED, { scopeFlows: "flow1", autoErrorDump: true });
    tap2.receive({ payload: "mute", target: { node: "f1" } });
    emit(RED, func1, { payload: "chatter" });          // suppressed
    RED.hooks.dispatchComplete({ msg: {}, node: { id: "f1", node: func1 }, error: boom });
    check("S8 muted failures still dump", tapOut(tap2, 0).length === 1 &&
          tapOut(tap2, 0)[0].payload.trigger === "error");
    check("S8 muted chatter still suppressed",
          tap2.recorderStore.records.filter(r => r.annotation === null).length === 0);
    await tap2.close(false);
  }

  // =========================================================================
  // S9: no completion events processed when autoErrorDump off
  // =========================================================================
  {
    const tap = makeTap(RED, { scopeFlows: "flow1", autoErrorDump: false });
    RED.hooks.dispatchComplete({ msg: {}, node: { id: "f1", node: func1 }, error: new Error("x") });
    check("S9 no incident", tapOut(tap, 0).length === 0);
    await tap.close(false);
  }

  // =========================================================================
  // S10: watermark on tapped traffic
  // =========================================================================
  {
    const tap = makeTap(RED, { scopeAllFlows: true,
      watermarkProperty: "payload.temp", watermarkOperator: "gte", watermarkValue: "100" });
    emit(RED, mqtt1, { payload: { temp: 50 } });
    check("S10 quiet below", tapOut(tap, 0).length === 0);
    emit(RED, mqtt1, { payload: { temp: 100 } });
    check("S10 watermark fires", tapOut(tap, 0).length === 1 &&
          tapOut(tap, 0)[0].payload.trigger === "watermark" &&
          tapOut(tap, 0)[0].payload.context.matchedSeq === 2);
    await tap.close(false);
  }

  // =========================================================================
  // S11: payload commands on the tap input; bad payload tolerated
  // =========================================================================
  {
    const tap = makeTap(RED, { scopeAllFlows: true });
    emit(RED, func1, { payload: "x" });
    tap.receive({ payload: "  DUMP ", context: { via: "input" } });
    check("S11 dump via input", tapOut(tap, 0).length === 1 &&
          tapOut(tap, 0)[0].payload.context.via === "input");
    tap.receive({ payload: "query" });
    check("S11 query via input", tapOut(tap, 1).length === 1);
    tap.receive({ payload: 42 });
    check("S11 non-string tolerated", events(tap, "commandIgnored").some(m =>
          /string payload/.test(m.payload.reason)));
    check("S11 commands not captured as traffic",
          tap.recorderStore.records.filter(r => r.annotation === null).length === 1);
    await tap.close(false);
  }

  // =========================================================================
  // S12: control node drives a tap — mute forwarded with msg.target
  // =========================================================================
  {
    const tap = makeTap(RED, { id: "s12-tap", scopeAllFlows: true });
    const ctl = makeControl(RED, { target: "s12-tap" });
    ctl.receive({ payload: "mute", target: { node: "m1" } });
    check("S12 mute via control ack", ctl.sent[0].payload.ok === true &&
          ctl.sent[0].payload.result.muted === true && ctl.sent[0].payload.result.changed === true,
          JSON.stringify(ctl.sent[0] && ctl.sent[0].payload));
    emit(RED, mqtt1, { payload: "silenced" });
    emit(RED, func1, { payload: "recorded" });
    check("S12 mute effective", tap.recorderStore.records.filter(r => r.annotation === null).length === 1);
    ctl.receive({ payload: "unmute", target: { node: "m1" } });
    check("S12 unmute via control", ctl.sent[1].payload.result.suppressedCount === 1);
    await tap.close(false); await ctl.close(false);
  }

  // =========================================================================
  // S13: tap incidents carry environment meta
  // =========================================================================
  {
    const tap = makeTap(RED, { id: "s13-tap", scopeAllFlows: true });
    emit(RED, func1, { payload: 1 });
    const inc = registry.get("s13-tap").runCommand("dump");
    check("S13 meta present", inc.meta &&
          /^node-red-contrib-flight-recorder@\d+\.\d+\.\d+$/.test(inc.meta.package),
          JSON.stringify(inc.meta));
    await tap.close(false);
  }

  // ---------------------------------------------------------------------------
  console.log("");
  if (failures) {
    console.log(failures + " FAILURE(S)");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED");
  }
})().catch((e) => { console.log("HARNESS CRASH:", e); process.exit(1); });
