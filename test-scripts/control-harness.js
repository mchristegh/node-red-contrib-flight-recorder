// test-scripts/control-harness.js
//
// Phase 5 harness: instantiates a REAL inline flight-recorder and drives it
// through a flight-recorder-control node — the registry seam exercised end
// to end, plus every failure path (bad payloads, unknown commands, missing
// or undeployed targets).

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");

const registry = require(
  path.join(__dirname, "..", "lib", "store-registry.js"),
);

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log("PASS  " + label);
  } else {
    failures++;
    console.log(
      "FAIL  " + label + (detail !== undefined ? "  [" + detail + "]" : ""),
    );
  }
}

// ---------------------------------------------------------------------------
// RED stub (same shape as inline-harness)
// ---------------------------------------------------------------------------
function makeRED(userDir) {
  const registered = {};
  return {
    nodes: {
      registerType(name, ctor) {
        registered[name] = ctor;
      },
      createNode(node, n) {
        node.id = n.id;
        node._handlers = {};
        node.on = function (evt, fn) {
          node._handlers[evt] = fn;
        };
        node.receive = function (msg) {
          node._handlers["input"](msg);
        };
        node.close = function (removed) {
          return new Promise((res) => node._handlers["close"](removed, res));
        };
        node.sent = [];
        node.send = function (out) {
          node.sent.push(out);
        };
        node.statusCalls = [];
        node.status = function (s) {
          node.statusCalls.push(s);
        };
        node.warned = [];
        node.warn = function (m) {
          node.warned.push(m);
        };
        node.error = function (e) {
          console.log("NODE ERROR:", e);
        };
      },
      get(name) {
        return registered[name];
      },
    },
    util: {
      cloneMessage(m) {
        return JSON.parse(JSON.stringify(m || {}));
      },
    },
    settings: { userDir: userDir },
  };
}

function makeRecorder(RED, cfg) {
  const Ctor = RED.nodes.get("flight-recorder");
  const node = {};
  Ctor.call(
    node,
    Object.assign(
      {
        id: "rec" + Math.random().toString(36).slice(2),
        name: "",
        capacity: "10",
        captureMode: "full",
        maxRecordBytes: "16384",
        redactPaths: "",
        persist: false,
        incidentCooldownMs: "0",
        watermarkProperty: "",
        watermarkOperator: "none",
        watermarkValue: "",
      },
      cfg,
    ),
  );
  return node;
}

function makeControl(RED, cfg) {
  const Ctor = RED.nodes.get("flight-recorder-control");
  const node = {};
  Ctor.call(
    node,
    Object.assign(
      {
        id: "ctl" + Math.random().toString(36).slice(2),
        name: "",
        target: "",
      },
      cfg,
    ),
  );
  return node;
}

// recorder outputs: [passthrough, incidents, query, events]
function recOut(node, idx) {
  return node.sent.map((a) => a[idx]).filter(Boolean);
}
// control output: single ack msgs
function acks(node) {
  return node.sent;
}
function lastAck(node) {
  return node.sent[node.sent.length - 1];
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "flightrec-p5-"));

(async function main() {
  const RED = makeRED(userDir);
  require(path.join(__dirname, "..", "nodes", "flight-recorder.js"))(RED);
  require(path.join(__dirname, "..", "nodes", "flight-recorder-control.js"))(
    RED,
  );

  // =========================================================================
  // X1: dump — incident on the RECORDER's outputs, receipt on the control
  // =========================================================================
  {
    const rec = makeRecorder(RED, { id: "x1-rec" });
    const ctl = makeControl(RED, { target: "x1-rec" });
    rec.receive({ payload: "traffic" });
    ctl.receive({
      _msgid: "cmd1",
      payload: "dump",
      context: { requestedBy: "ops" },
    });

    const incs = recOut(rec, 1);
    check(
      "X1 incident on recorder",
      incs.length === 1 &&
        incs[0].payload.trigger === "manual" &&
        incs[0].payload.context.requestedBy === "ops",
    );
    const a = lastAck(ctl);
    check(
      "X1 ack ok",
      a.payload.ok === true &&
        a.payload.command === "dump" &&
        a.payload.targetId === "x1-rec",
      JSON.stringify(a.payload),
    );
    check(
      "X1 ack carries result",
      a.payload.result.incidentId === incs[0].payload.incidentId,
    );
    check("X1 ack correlated", a.inReplyTo === "cmd1");
    check(
      "X1 status success",
      ctl.statusCalls.some((s) => s.fill === "green" && s.text === "dump ✓"),
    );
    await rec.close(false);
    await ctl.close(false);
  }

  // =========================================================================
  // X2: case-insensitive, whitespace-tolerant commands
  // =========================================================================
  {
    const rec = makeRecorder(RED, { id: "x2-rec" });
    const ctl = makeControl(RED, { target: "x2-rec" });
    ctl.receive({ payload: "  PAUSE  " });
    check("X2 PAUSE landed", rec.recorderStore.state === "paused");
    check(
      "X2 ack",
      lastAck(ctl).payload.ok === true &&
        lastAck(ctl).payload.command === "pause",
    );
    ctl.receive({ payload: "Resume" });
    check("X2 Resume landed", rec.recorderStore.state === "recording");
    await rec.close(false);
    await ctl.close(false);
  }

  // =========================================================================
  // X3: mark with msg.annotation; clear
  // =========================================================================
  {
    const rec = makeRecorder(RED, { id: "x3-rec" });
    const ctl = makeControl(RED, { target: "x3-rec" });
    rec.receive({ payload: 1 });
    ctl.receive({ payload: "mark", annotation: { note: "about to test X" } });
    check(
      "X3 mark on tape",
      rec.recorderStore.records.length === 2 &&
        rec.recorderStore.records[1].annotation.note === "about to test X",
    );
    check("X3 mark ack seq", lastAck(ctl).payload.result.seq === 2);
    ctl.receive({ payload: "clear" });
    check(
      "X3 cleared",
      rec.recorderStore.records.length === 0 &&
        lastAck(ctl).payload.result.cleared === 2,
    );
    check(
      "X3 recorder emitted cleared event",
      recOut(rec, 3).some((m) => m.recorderEvent === "cleared"),
    );
    await rec.close(false);
    await ctl.close(false);
  }

  // =========================================================================
  // X4: query — snapshot on RECORDER output 3, receipt carries snapshot
  // =========================================================================
  {
    const rec = makeRecorder(RED, { id: "x4-rec" });
    const ctl = makeControl(RED, { target: "x4-rec" });
    rec.receive({ payload: 1 });
    rec.receive({ payload: 2 });
    ctl.receive({ payload: "query" });
    const q = recOut(rec, 2);
    check(
      "X4 snapshot on recorder query output",
      q.length === 1 && q[0].payload.stats.recordCount === 2,
    );
    check(
      "X4 ack carries snapshot",
      lastAck(ctl).payload.result.stats.recordCount === 2,
    );
    await rec.close(false);
    await ctl.close(false);
  }

  // =========================================================================
  // X5: unknown command — warn, red status, ok:false ack, recorder untouched
  // =========================================================================
  {
    const rec = makeRecorder(RED, { id: "x5-rec" });
    const ctl = makeControl(RED, { target: "x5-rec" });
    ctl.receive({ payload: "explode" });
    const a = lastAck(ctl);
    check(
      "X5 nack",
      a.payload.ok === false && /unknown command/.test(a.payload.reason),
      JSON.stringify(a.payload),
    );
    check("X5 warned", ctl.warned.length === 1);
    check(
      "X5 red status",
      ctl.statusCalls.some((s) => s.fill === "red"),
    );
    check(
      "X5 recorder untouched",
      rec.recorderStore.records.length === 0 &&
        rec.recorderStore.state === "recording",
    );
    await rec.close(false);
    await ctl.close(false);
  }

  // =========================================================================
  // X6: bad payload types — nack, never throw
  // =========================================================================
  {
    const ctl = makeControl(RED, { target: "whatever" });
    let threw = false;
    try {
      ctl.receive({ payload: 42 });
      ctl.receive({ payload: { command: "dump" } });
      ctl.receive({});
    } catch {
      threw = true;
    }
    check("X6 no throw", !threw);
    check(
      "X6 three nacks",
      acks(ctl).length === 3 &&
        acks(ctl).every(
          (a) =>
            a.payload.ok === false && /string payload/.test(a.payload.reason),
        ),
    );
    await ctl.close(false);
  }

  // =========================================================================
  // X7: unconfigured target and undeployed target
  // =========================================================================
  {
    const ctl1 = makeControl(RED, { target: "" });
    ctl1.receive({ payload: "dump" });
    check(
      "X7 unconfigured nack",
      lastAck(ctl1).payload.ok === false &&
        /no target/.test(lastAck(ctl1).payload.reason),
    );

    const ctl2 = makeControl(RED, { target: "ghost-node" });
    ctl2.receive({ payload: "dump" });
    check(
      "X7 undeployed nack",
      lastAck(ctl2).payload.ok === false &&
        /not deployed/.test(lastAck(ctl2).payload.reason),
    );
    await ctl1.close(false);
    await ctl2.close(false);
  }

  // =========================================================================
  // X8: target closed after control deployed — lazy resolution degrades
  // =========================================================================
  {
    const rec = makeRecorder(RED, { id: "x8-rec" });
    const ctl = makeControl(RED, { target: "x8-rec" });
    ctl.receive({ payload: "query" });
    check("X8 worked while deployed", lastAck(ctl).payload.ok === true);
    await rec.close(false); // recorder redeployed/removed
    ctl.receive({ payload: "query" });
    check(
      "X8 graceful after target close",
      lastAck(ctl).payload.ok === false &&
        /not deployed/.test(lastAck(ctl).payload.reason),
    );
    check("X8 registry clean", registry.get("x8-rec") === null);
    await ctl.close(false);
  }

  // ---------------------------------------------------------------------------
  console.log("");
  if (failures) {
    console.log(failures + " FAILURE(S)");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED");
  }
})().catch((e) => {
  console.log("HARNESS CRASH:", e);
  process.exit(1);
});
