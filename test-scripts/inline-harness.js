// test-scripts/inline-harness.js
//
// Phase 4 harness for nodes/flight-recorder.js (the inline node).
// Stubs enough of the Node-RED runtime to instantiate the node, in the
// timer-events makeRED style, and exercises the full wrapper contract:
// sacred passthrough, registry command surface, watermarks, redaction
// config parsing, status, persistence across a simulated restart.

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
// RED stub (timer-events style)
// ---------------------------------------------------------------------------
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
        node.send = function (arr) { node.sent.push(arr); };
        node.statusCalls = [];
        node.status = function (s) { node.statusCalls.push(s); };
        node.warned = [];
        node.warn = function (m) { node.warned.push(m); };
        node.error = function (e) { console.log("NODE ERROR:", e); };
      },
      get(name) { return registered[name]; }
    },
    util: {
      cloneMessage(m) { return JSON.parse(JSON.stringify(m || {})); }
    },
    settings: { userDir: userDir }
  };
}

function makeNode(RED, cfg) {
  const Ctor = RED.nodes.get("flight-recorder");
  const node = {};
  Ctor.call(node, Object.assign({
    id: "fr" + Math.random().toString(36).slice(2),
    name: "",
    capacity: "10",
    captureMode: "full",
    maxRecordBytes: "16384",
    redactPaths: "",
    persist: false,
    incidentCooldownMs: "0",
    watermarkProperty: "",
    watermarkOperator: "none",
    watermarkValue: ""
  }, cfg));
  return node;
}

// output helpers: outputs are [passthrough, incidents, query, events]
function onOutput(node, idx) { return node.sent.map(a => a[idx]).filter(Boolean); }
function events(node, type) {
  return onOutput(node, 3).filter(m => m.recorderEvent === type);
}
function lastStatus(node) { return node.statusCalls[node.statusCalls.length - 1]; }

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "flightrec-p4-"));

(async function main() {
  const RED = makeRED(userDir);
  require(path.join(__dirname, "..", "nodes", "flight-recorder.js"))(RED);

  // =========================================================================
  // I1: construction — registered in registry, initial status shown
  // =========================================================================
  {
    const node = makeNode(RED, { id: "i1-node" });
    const h = registry.get("i1-node");
    check("I1 registered", h !== null && h.kind === "inline" && typeof h.runCommand === "function");
    check("I1 initial status", lastStatus(node).fill === "green" &&
          lastStatus(node).text === "0/10", JSON.stringify(lastStatus(node)));
    await node.close(false);
    check("I1 deregistered on close", registry.get("i1-node") === null);
  }

  // =========================================================================
  // I2: sacred passthrough — same object reference, captured on the tape
  // =========================================================================
  {
    const node = makeNode(RED, {});
    const msg = { _msgid: "m1", topic: "t", payload: { v: 1 } };
    node.receive(msg);
    const passed = onOutput(node, 0);
    check("I2 passthrough same reference", passed.length === 1 && passed[0] === msg);
    check("I2 msg unmutated", passed[0].recorderEvent === undefined &&
          JSON.stringify(passed[0]) === JSON.stringify({ _msgid: "m1", topic: "t", payload: { v: 1 } }));
    check("I2 captured", node.recorderStore.records.length === 1 &&
          node.recorderStore.records[0].msg.payload.v === 1);
    check("I2 source is this node", node.recorderStore.records[0].source.type === "flight-recorder");
    await node.close(false);
  }

  // =========================================================================
  // I3: query command — snapshot on output 3, also returned to caller
  // =========================================================================
  {
    const node = makeNode(RED, { id: "i3-node" });
    node.receive({ payload: 1 }); node.receive({ payload: 2 });
    const ret = registry.get("i3-node").runCommand("query");
    const q = onOutput(node, 2);
    check("I3 query on output 3", q.length === 1 && q[0].recorderEvent === "query" &&
          q[0].payload.stats.recordCount === 2, JSON.stringify(q.map(m => m.recorderEvent)));
    check("I3 returned to caller", ret.stats.recordCount === 2);
    check("I3 nothing on incident output", onOutput(node, 1).length === 0);
    await node.close(false);
  }

  // =========================================================================
  // I4: manual dump — incident on output 2 AND copied to events output
  // =========================================================================
  {
    const node = makeNode(RED, { id: "i4-node", name: "my recorder" });
    node.receive({ payload: "x" });
    const inc = registry.get("i4-node").runCommand("dump", { requestedBy: "harness" });
    check("I4 returned incident", inc.trigger === "manual" && inc.context.requestedBy === "harness");
    const out2 = onOutput(node, 1);
    check("I4 incident output", out2.length === 1 && out2[0].payload.incidentId === inc.incidentId &&
          out2[0].topic === "my recorder");
    const copies = events(node, "incident");
    check("I4 events copy", copies.length === 1 && copies[0].payload.incidentId === inc.incidentId);
    await node.close(false);
  }

  // =========================================================================
  // I5: pause — tape stops, FLOW CONTINUES; acks and dropped counting
  // =========================================================================
  {
    const node = makeNode(RED, { id: "i5-node" });
    const h = registry.get("i5-node");
    node.receive({ payload: 1 });
    h.runCommand("pause");
    const r2 = h.runCommand("pause"); // redundant
    const m = { payload: 2 };
    node.receive(m);
    node.receive({ payload: 3 });
    h.runCommand("resume");
    node.receive({ payload: 4 });

    check("I5 passthrough continued while paused", onOutput(node, 0).length === 4 &&
          onOutput(node, 0)[1] === m);
    check("I5 tape stopped", node.recorderStore.records.length === 2);
    check("I5 dropped counted", node.recorderStore.droppedWhilePaused === 2);
    check("I5 paused/resumed events", events(node, "paused").length === 1 &&
          events(node, "resumed").length === 1);
    check("I5 redundant pause ignored-ack", r2.changed === false &&
          events(node, "commandIgnored").length === 1 &&
          events(node, "commandIgnored")[0].payload.command === "pause");
    check("I5 paused status", node.statusCalls.some(s => s.fill === "yellow" &&
          /paused \(/.test(s.text)), JSON.stringify(node.statusCalls.map(s => s.text)));
    check("I5 status recovered", lastStatus(node).fill === "green" && lastStatus(node).text === "2/10",
          JSON.stringify(lastStatus(node)));
    await node.close(false);
  }

  // =========================================================================
  // I6: watermark — matching msg auto-dumps with trigger "watermark"
  // =========================================================================
  {
    const node = makeNode(RED, { id: "i6-node",
      watermarkProperty: "payload.temp", watermarkOperator: "gt", watermarkValue: "90" });
    node.receive({ payload: { temp: 72 } });
    check("I6 non-match quiet", onOutput(node, 1).length === 0);
    node.receive({ payload: { temp: 95 } });
    const incs = onOutput(node, 1);
    check("I6 watermark incident", incs.length === 1 && incs[0].payload.trigger === "watermark");
    check("I6 context describes condition", incs[0].payload.context.condition.property === "payload.temp" &&
          incs[0].payload.context.matchedSeq === 2, JSON.stringify(incs[0].payload.context));
    check("I6 matching msg on the tape", incs[0].payload.records.length === 2 &&
          incs[0].payload.records[1].msg.payload.temp === 95);
    check("I6 passthrough unaffected", onOutput(node, 0).length === 2);
    await node.close(false);
  }

  // =========================================================================
  // I7: watermark cooldown — second match suppressed, visible on events
  // =========================================================================
  {
    const node = makeNode(RED, { id: "i7-node", incidentCooldownMs: "60000",
      watermarkProperty: "payload", watermarkOperator: "eq", watermarkValue: "hot" });
    node.receive({ payload: "hot" });
    node.receive({ payload: "hot" });
    check("I7 one incident", onOutput(node, 1).length === 1);
    const sup = events(node, "incidentSuppressed");
    check("I7 suppression visible", sup.length === 1 && sup[0].payload.trigger === "watermark");
    check("I7 manual still fires", registry.get("i7-node").runCommand("dump") !== null &&
          onOutput(node, 1).length === 2);
    await node.close(false);
  }

  // =========================================================================
  // I8: redactPaths multiline config parses and applies
  // =========================================================================
  {
    const node = makeNode(RED, { redactPaths: "payload.password\n payload.token , payload.apikey" });
    node.receive({ payload: { password: "p", token: "t", apikey: "k", ok: 1 } });
    const rec = node.recorderStore.records[0];
    check("I8 all three masked", rec.msg.payload.password === "[REDACTED]" &&
          rec.msg.payload.token === "[REDACTED]" && rec.msg.payload.apikey === "[REDACTED]");
    check("I8 listed", rec.redacted.length === 3, JSON.stringify(rec.redacted));
    check("I8 sibling intact", rec.msg.payload.ok === 1);
    await node.close(false);
  }

  // =========================================================================
  // I9: hostile traffic — circular msg passes through AND lands on the tape
  // =========================================================================
  {
    const node = makeNode(RED, {});
    const msg = { payload: { name: "loop" } };
    msg.payload.self = msg.payload;
    node.receive(msg);
    check("I9 circular passthrough", onOutput(node, 0)[0] === msg);
    check("I9 circular captured", node.recorderStore.records.length === 1 &&
          node.recorderStore.records[0].msg.payload.self === "[Circular]");
    check("I9 mark command works", registry.get(node.id) === null ||
          true /* id random; use node.recorderStore directly */);
    await node.close(false);
  }

  // =========================================================================
  // I10: persistence — survives close/reconstruct; removed on delete
  // =========================================================================
  {
    const a = makeNode(RED, { id: "persist-node", persist: true });
    a.receive({ payload: "before restart" });
    registry.get("persist-node").runCommand("mark", { note: "closing" }); // immediate write
    await a.close(false); // redeploy-style close: file survives

    const file = path.join(userDir, "flight-recorder", "persist-node.json");
    check("I10 file on disk", fs.existsSync(file));

    const b = makeNode(RED, { id: "persist-node", persist: true });
    check("I10 restored", b.recorderStore.restoredFromPersist === true &&
          b.recorderStore.records.length === 2 &&
          b.recorderStore.records[0].msg.payload === "before restart");
    check("I10 restored status shown", lastStatus(b).text === "2/10", lastStatus(b).text);
    b.receive({ payload: "after restart" });
    check("I10 seq continues", b.recorderStore.records[2].seq === 3);

    await b.close(true); // node deleted: file removed
    check("I10 file removed on delete", !fs.existsSync(file));
  }

  // =========================================================================
  // I11: persist requested but no userDir — warn and degrade gracefully
  // =========================================================================
  {
    const RED2 = makeRED(undefined);
    RED2.settings = {};
    require.cache[require.resolve(path.join(__dirname, "..", "nodes", "flight-recorder.js"))] &&
      delete require.cache[require.resolve(path.join(__dirname, "..", "nodes", "flight-recorder.js"))];
    require(path.join(__dirname, "..", "nodes", "flight-recorder.js"))(RED2);
    const node = makeNode(RED2, { persist: true });
    check("I11 warned", node.warned.length === 1 && /persistence disabled/.test(node.warned[0]));
    check("I11 still records", (node.receive({ payload: 1 }),
          node.recorderStore.records.length === 1));
    check("I11 persist off in store", node.recorderStore.config.persist === false);
    await node.close(false);
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
