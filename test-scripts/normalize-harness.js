// test-scripts/normalize-harness.js
//
// Phase 1 harness for lib/normalize.js. Exercises the ten agreed pass
// criteria with no Node-RED runtime — the module's built-in clone/encode
// fallbacks are the units under test, exactly as the harness style used
// in node-red-contrib-timer-events.

"use strict";

const path = require("path");
const { createNormalizer, _internal } =
  require(path.join(__dirname, "..", "lib", "normalize.js"));
const M = _internal.markers;

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS  " + label); }
  else { failures++; console.log("FAIL  " + label + (detail !== undefined ? "  [" + detail + "]" : "")); }
}

// ---------------------------------------------------------------------------
// T1: plain msg round-trips deep-equal; truncated false, redacted empty
// ---------------------------------------------------------------------------
{
  const n = createNormalizer();
  const msg = { _msgid: "abc123", topic: "sensors/temp", payload: { temp: 21.5, ok: true, tags: ["a", "b"] } };
  const r = n.normalize(msg);
  check("T1 full round-trip deep-equal", JSON.stringify(r.msg) === JSON.stringify(msg), JSON.stringify(r.msg));
  check("T1 truncated false", r.truncated === false);
  check("T1 redacted empty", Array.isArray(r.redacted) && r.redacted.length === 0);
  check("T1 bytes positive finite", Number.isFinite(r.bytes) && r.bytes > 0, r.bytes);
  check("T1 _msgid kept", r.msg._msgid === "abc123");
}

// ---------------------------------------------------------------------------
// T2: redaction — present path masked+listed; absent path not listed;
//     nested path into missing parent: no throw, not listed
// ---------------------------------------------------------------------------
{
  const n = createNormalizer({ redactPaths: ["payload.password", "payload.apikey", "headers.auth.token"] });
  const msg = { payload: { user: "bob", password: "hunter2" } };
  let r, threw = false;
  try { r = n.normalize(msg); } catch (e) { threw = true; }
  check("T2 no throw", !threw);
  check("T2 present path masked", r.msg.payload.password === M.REDACTED, r.msg.payload.password);
  check("T2 present path listed", r.redacted.indexOf("payload.password") !== -1, JSON.stringify(r.redacted));
  check("T2 absent leaf not listed", r.redacted.indexOf("payload.apikey") === -1);
  check("T2 missing parent not listed", r.redacted.indexOf("headers.auth.token") === -1);
  check("T2 exactly one redaction", r.redacted.length === 1, JSON.stringify(r.redacted));
  check("T2 sibling value untouched", r.msg.payload.user === "bob");
}

// ---------------------------------------------------------------------------
// T3: original msg provably unmutated (redaction on the source object)
// ---------------------------------------------------------------------------
{
  const n = createNormalizer({ redactPaths: ["payload.secret"] });
  const msg = { topic: "t", payload: { secret: "s3cr3t", data: [1, 2, 3] } };
  const before = JSON.stringify(msg);
  n.normalize(msg);
  const after = JSON.stringify(msg);
  check("T3 original unmutated", before === after, after);
  check("T3 secret still intact on original", msg.payload.secret === "s3cr3t");
}

// ---------------------------------------------------------------------------
// T4: circular msg — no throw, marker present, bytes finite
// ---------------------------------------------------------------------------
{
  const n = createNormalizer();
  const msg = { topic: "loop", payload: { name: "a" } };
  msg.payload.self = msg.payload;          // direct cycle
  msg.backToMsg = msg;                     // cycle through the root
  let r, threw = false;
  try { r = n.normalize(msg); } catch (e) { threw = true; console.log("  err:", e.message); }
  check("T4 no throw", !threw);
  check("T4 inner circular marker", r.msg.payload.self === M.CIRCULAR, JSON.stringify(r.msg.payload.self));
  check("T4 root circular marker", r.msg.backToMsg === M.CIRCULAR);
  check("T4 bytes finite", Number.isFinite(r.bytes) && r.bytes > 0, r.bytes);
}

// ---------------------------------------------------------------------------
// T5: 1MB+ payload with 16KB cap — summary form, truncated true, and the
//     redacted secret must NOT appear anywhere in the output
// ---------------------------------------------------------------------------
{
  const n = createNormalizer({ maxRecordBytes: 16384, redactPaths: ["payload.password"] });
  const big = "x".repeat(1024 * 1024);
  const msg = { topic: "big/topic", payload: { password: "TOPSECRET99", blob: big } };
  const r = n.normalize(msg);
  check("T5 truncated true", r.truncated === true);
  check("T5 summary shape", r.msg.payloadType === "object" && typeof r.msg.payloadBytes === "number"
        && typeof r.msg.payloadPreview === "string" && Array.isArray(r.msg.msgKeys),
        JSON.stringify(Object.keys(r.msg)));
  check("T5 payloadBytes reflects original scale", r.msg.payloadBytes > 1024 * 1024, r.msg.payloadBytes);
  check("T5 preview capped at 120", r.msg.payloadPreview.length <= 120, r.msg.payloadPreview.length);
  const whole = JSON.stringify(r);
  check("T5 secret absent from entire output", whole.indexOf("TOPSECRET99") === -1);
  check("T5 redaction listed", r.redacted.indexOf("payload.password") !== -1);
  check("T5 stored bytes under cap", r.bytes <= 16384, r.bytes);
  check("T5 topic kept in summary", r.msg.topic === "big/topic");
}

// ---------------------------------------------------------------------------
// T6: Buffer payload — placeholder with correct length, small output
// ---------------------------------------------------------------------------
{
  const n = createNormalizer();
  const buf = Buffer.alloc(100000, 0xAB);
  const msg = { topic: "cam/frame", payload: buf };
  const r = n.normalize(msg);
  check("T6 buffer placeholder type", r.msg.payload && r.msg.payload.__type === "buffer",
        JSON.stringify(r.msg.payload));
  check("T6 length correct", r.msg.payload.length === 100000, r.msg.payload.length);
  check("T6 hex preview 32 bytes", r.msg.payload.preview === "ab".repeat(32), r.msg.payload.preview);
  check("T6 output small", r.bytes < 500, r.bytes);
  check("T6 not truncated", r.truncated === false);
}

// ---------------------------------------------------------------------------
// T7: captureMode summary — summary shape even for tiny msgs, truncated false
// ---------------------------------------------------------------------------
{
  const n = createNormalizer({ captureMode: "summary" });
  const msg = { _msgid: "m1", topic: "small", payload: "hello" };
  const r = n.normalize(msg);
  check("T7 summary shape", r.msg.payloadType === "string" && r.msg.payloadPreview === "hello",
        JSON.stringify(r.msg));
  check("T7 truncated false (summary-by-config)", r.truncated === false);
  check("T7 payloadBytes", r.msg.payloadBytes === 5, r.msg.payloadBytes);
  check("T7 msgKeys include _msgid", r.msg.msgKeys.indexOf("_msgid") !== -1, JSON.stringify(r.msg.msgKeys));
}

// ---------------------------------------------------------------------------
// T8: req-like circular HTTP object — placeholder, no throw
// ---------------------------------------------------------------------------
{
  const n = createNormalizer();
  // simulate an Express req/res pair: huge-ish, circular through socket
  const socket = { bytesRead: 1234 };
  const req = { method: "GET", url: "/api", headers: { host: "x" }, socket: socket, connection: socket };
  socket._httpMessage = req;               // circular, like real net sockets
  const res = { statusCode: 0, socket: socket, req: req };
  req.res = res;
  const msg = { _msgid: "h1", req: req, res: res, payload: "body" };
  let r, threw = false;
  try { r = n.normalize(msg); } catch (e) { threw = true; console.log("  err:", e.message); }
  check("T8 no throw", !threw);
  check("T8 req placeholder", r.msg.req === M.HTTP_REQ_MARK, JSON.stringify(r.msg.req));
  check("T8 res placeholder", r.msg.res === M.HTTP_RES_MARK, JSON.stringify(r.msg.res));
  check("T8 payload preserved", r.msg.payload === "body");
  check("T8 original req untouched", msg.req === req && msg.req.method === "GET");
  check("T8 output small", r.bytes < 500, r.bytes);
}

// ---------------------------------------------------------------------------
// T9: Error object in msg — structured encoding with capped stack
// ---------------------------------------------------------------------------
{
  const n = createNormalizer();
  const err = new Error("boom happened");
  err.stack = "Error: boom happened\n" + "    at fake (fake.js:1:1)\n".repeat(200); // > 2000 chars
  const msg = { payload: "p", error: err };
  const r = n.normalize(msg);
  check("T9 structured error", r.msg.error && r.msg.error.__type === "error", JSON.stringify(r.msg.error && r.msg.error.__type));
  check("T9 name/message", r.msg.error.name === "Error" && r.msg.error.message === "boom happened");
  check("T9 stack capped", typeof r.msg.error.stack === "string" && r.msg.error.stack.length <= 2000,
        r.msg.error.stack && r.msg.error.stack.length);
}

// ---------------------------------------------------------------------------
// T10: determinism — same input twice, byte-identical output
// ---------------------------------------------------------------------------
{
  const n = createNormalizer({ redactPaths: ["payload.key"] });
  const make = () => ({ _msgid: "d1", topic: "t", payload: { key: "k", arr: [1, "two", null], nested: { a: 1 } } });
  const r1 = n.normalize(make());
  const r2 = n.normalize(make());
  check("T10 deterministic", JSON.stringify(r1) === JSON.stringify(r2));
}

// ---------------------------------------------------------------------------
// Bonus edge assertions (cheap, cover contract fine print)
// ---------------------------------------------------------------------------
{
  const n = createNormalizer();

  // undefined payload -> payloadType "undefined" in summary
  const s = createNormalizer({ captureMode: "summary" }).normalize({ topic: "t" });
  check("E1 undefined payload type", s.msg.payloadType === "undefined", s.msg.payloadType);

  // undefined inside objects dropped (JSON semantics)
  const r = n.normalize({ payload: { a: 1, gone: undefined } });
  check("E2 undefined key dropped", !("gone" in r.msg.payload), JSON.stringify(r.msg.payload));

  // function -> marker
  const rf = n.normalize({ payload: { fn: function () {} } });
  check("E3 function marker", rf.msg.payload.fn === M.FUNCTION_MARK, JSON.stringify(rf.msg.payload.fn));

  // Date -> ISO string
  const rd = n.normalize({ payload: new Date("2026-07-12T00:00:00.000Z") });
  check("E4 date iso", rd.msg.payload === "2026-07-12T00:00:00.000Z", rd.msg.payload);

  // non-object msg never throws (hostile input)
  let threw = false; let rn;
  try { rn = n.normalize("just a string"); } catch (e) { threw = true; }
  check("E5 non-object msg tolerated", !threw && rn.msg.payload === "just a string");

  // topic truncated to 256 in summary
  const longTopic = "t".repeat(1000);
  const rt = createNormalizer({ captureMode: "summary" }).normalize({ topic: longTopic, payload: 1 });
  check("E6 topic capped 256", rt.msg.topic.length === 256, rt.msg.topic.length);

  // config validation
  let bad = false;
  try { createNormalizer({ captureMode: "verbose" }); } catch (e) { bad = true; }
  check("E7 invalid captureMode rejected", bad);
  bad = false;
  try { createNormalizer({ maxRecordBytes: -1 }); } catch (e) { bad = true; }
  check("E8 invalid maxRecordBytes rejected", bad);
}

// ---------------------------------------------------------------------------
console.log("");
if (failures) {
  console.log(failures + " FAILURE(S)");
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED");
}
