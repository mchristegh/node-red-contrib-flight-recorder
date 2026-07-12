// test-scripts/core-harness.js
//
// Phase 2 harness for lib/recorder-core.js. No Node-RED runtime, no real
// time: an injected fake clock and fake timers make delta, cooldown and
// debounce behavior fully deterministic, in the timer-events harness style.

"use strict";

const path = require("path");
const { RecorderStore, FORMAT_VERSION } =
  require(path.join(__dirname, "..", "lib", "recorder-core.js"));

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS  " + label); }
  else { failures++; console.log("FAIL  " + label + (detail !== undefined ? "  [" + detail + "]" : "")); }
}

// ---------------------------------------------------------------------------
// Fake environment: clock, timers, persistence
// ---------------------------------------------------------------------------
function makeEnv() {
  let t = 1000000;
  const timers = new Map();
  let timerId = 0;
  const env = {
    now: () => t,
    advance(ms) {
      const target = t + ms;
      // fire due timers in order
      let due;
      do {
        due = null;
        for (const [id, tm] of timers) {
          if (tm.at <= target && (due === null || tm.at < due.tm.at)) due = { id, tm };
        }
        if (due) {
          t = due.tm.at;
          timers.delete(due.id);
          due.tm.fn();
        }
      } while (due);
      t = target;
    },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pendingTimers: () => timers.size
  };
  return env;
}

function makePersistence() {
  const files = new Map();
  return {
    files,
    writes: 0, reads: 0, removes: 0,
    read(id) { this.reads++; return files.has(id) ? JSON.parse(JSON.stringify(files.get(id))) : null; },
    write(id, state) { this.writes++; files.set(id, JSON.parse(JSON.stringify(state))); },
    remove(id) { this.removes++; files.delete(id); }
  };
}

const quietLog = { warn: () => {}, error: () => {} };

function makeStore(id, cfg, env, persistence, log) {
  return new RecorderStore(id, cfg, {
    now: env.now,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout,
    persistence: persistence || null,
    log: log || quietLog
  });
}

function collect(store, event) {
  const out = [];
  store.on(event, (e) => out.push(e));
  return out;
}

// ===========================================================================
// C1: basic capture — seq, delta chain, record format, stats
// ===========================================================================
{
  const env = makeEnv();
  const s = makeStore("c1", { capacity: 10 }, env);
  const r1 = s.capture({ msg: { payload: 1 }, sourceId: "n1", sourceName: "inject", sourceType: "inject", sourcePort: 0 });
  env.advance(250);
  const r2 = s.capture({ msg: { payload: 2 }, sourceId: "n2" });

  check("C1 accepted", r1.accepted === true && r2.accepted === true);
  check("C1 seq increments", r1.seq === 1 && r2.seq === 2, r1.seq + "," + r2.seq);
  const rec1 = s.records[0], rec2 = s.records[1];
  check("C1 first delta null", rec1.deltaMs === null, rec1.deltaMs);
  check("C1 second delta 250", rec2.deltaMs === 250, rec2.deltaMs);
  check("C1 source fields", rec1.source.id === "n1" && rec1.source.name === "inject" &&
        rec1.source.type === "inject" && rec1.source.port === 0, JSON.stringify(rec1.source));
  check("C1 record shape", rec1.annotation === null && rec1.truncated === false &&
        Array.isArray(rec1.redacted) && rec1.msg.payload === 1);
  const st = s.query().stats;
  check("C1 stats", st.recordCount === 2 && st.firstSeq === 1 && st.lastSeq === 2 &&
        st.spanMs === 250 && st.wrapCount === 0, JSON.stringify(st));
}

// ===========================================================================
// C2: ring eviction at capacity — wrapCount, single wrapped event
// ===========================================================================
{
  const env = makeEnv();
  const s = makeStore("c2", { capacity: 3 }, env);
  const wrapped = collect(s, "wrapped");
  for (let i = 1; i <= 5; i++) { s.capture({ msg: { payload: i }, sourceId: "n" }); env.advance(10); }

  check("C2 count at capacity", s.records.length === 3);
  check("C2 oldest evicted", s.records[0].seq === 3 && s.records[2].seq === 5,
        s.records.map(r => r.seq).join(","));
  check("C2 wrapCount 2", s.query().stats.wrapCount === 2, s.query().stats.wrapCount);
  check("C2 wrapped emitted once", wrapped.length === 1 && wrapped[0].wrapCount === 1,
        JSON.stringify(wrapped));
  check("C2 seq monotonic despite wrap", s.seqCounter === 5);
}

// ===========================================================================
// C3: pause/resume — dropped counting, idempotency, rejection shape
// ===========================================================================
{
  const env = makeEnv();
  const s = makeStore("c3", { capacity: 10 }, env);
  const paused = collect(s, "paused");
  const resumed = collect(s, "resumed");

  s.capture({ msg: { payload: "a" }, sourceId: "n" });
  const p1 = s.pause();
  const p2 = s.pause();                       // redundant
  const rej = s.capture({ msg: { payload: "b" }, sourceId: "n" });
  s.capture({ msg: { payload: "c" }, sourceId: "n" });
  const r1 = s.resume();
  const r2 = s.resume();                      // redundant
  s.capture({ msg: { payload: "d" }, sourceId: "n" });

  check("C3 pause returns", p1.changed === true && p2.changed === false, JSON.stringify([p1, p2]));
  check("C3 resume returns", r1.changed === true && r2.changed === false);
  check("C3 events once each", paused.length === 1 && resumed.length === 1);
  check("C3 rejection shape", rej.accepted === false && rej.dropped === true && rej.seq === null,
        JSON.stringify(rej));
  check("C3 droppedWhilePaused 2", s.query().stats.droppedWhilePaused === 2,
        s.query().stats.droppedWhilePaused);
  check("C3 no records created while paused", s.records.length === 2);
  check("C3 rejected msgs consumed no seq", s.records[1].seq === 2, s.records[1].seq);
}

// ===========================================================================
// C4: mark — while recording and paused; delta chain not reset
// ===========================================================================
{
  const env = makeEnv();
  const s = makeStore("c4", { capacity: 3 }, env);
  const marked = collect(s, "marked");

  s.capture({ msg: { payload: 1 }, sourceId: "n" });     // seq 1, t0
  env.advance(100);
  const m1 = s.mark({ note: "about to test X" });        // seq 2, t0+100
  env.advance(100);
  s.capture({ msg: { payload: 2 }, sourceId: "n" });     // seq 3, t0+200

  const markRec = s.records[1];
  check("C4 mark record shape", markRec.msg === null && markRec.annotation.note === "about to test X"
        && markRec.seq === 2, JSON.stringify(markRec));
  check("C4 mark deltaMs informational", markRec.deltaMs === 100, markRec.deltaMs);
  check("C4 delta chain not reset by mark", s.records[2].deltaMs === 200, s.records[2].deltaMs);
  check("C4 marked event", marked.length === 1 && marked[0].seq === 2 && m1.seq === 2);

  s.pause();
  const m2 = s.mark("muted sensor-7");                   // seq 4, accepted while paused
  check("C4 mark while paused accepted", m2.seq === 4 && s.records.length === 3 /* capacity 3, wrapped */,
        JSON.stringify({ m2, len: s.records.length }));
  check("C4 mark counts toward capacity (wrap occurred)", s.query().stats.wrapCount === 1,
        s.query().stats.wrapCount);
  check("C4 string annotation encoded", s.records[2].annotation === "muted sensor-7");
}

// ===========================================================================
// C5: manual dump — incident format; empty-buffer incident legal
// ===========================================================================
{
  const env = makeEnv();
  const s = makeStore("c5", { capacity: 10 }, env);
  const incidents = collect(s, "incident");

  const empty = s.dump("manual", { requestedBy: "harness" });
  check("C5 empty incident legal", empty !== null && empty.stats.recordCount === 0 &&
        empty.records.length === 0, JSON.stringify(empty && empty.stats));

  s.capture({ msg: { payload: "x" }, sourceId: "n" });
  env.advance(50);
  s.capture({ msg: { payload: "y" }, sourceId: "n" });
  const inc = s.dump("manual", { requestedBy: "harness" });

  check("C5 incident fields", typeof inc.incidentId === "string" && inc.incidentId.length > 0 &&
        inc.storeId === "c5" && inc.trigger === "manual" && Number.isFinite(inc.triggeredAt),
        JSON.stringify({ id: inc.incidentId, t: inc.trigger }));
  check("C5 context carried", inc.context.requestedBy === "harness");
  check("C5 stats shape matches query", JSON.stringify(Object.keys(inc.stats)) ===
        JSON.stringify(Object.keys(s.query().stats)));
  check("C5 records copied", inc.records.length === 2 && inc.records !== s.records);
  check("C5 both incidents emitted", incidents.length === 2);
  check("C5 unique incidentIds", empty.incidentId !== inc.incidentId);
  check("C5 dump does not clear", s.records.length === 2);
}

// ===========================================================================
// C6: cooldown — auto suppressed, manual bypasses, expiry re-enables
// ===========================================================================
{
  const env = makeEnv();
  const s = makeStore("c6", { capacity: 10, incidentCooldownMs: 1000 }, env);
  const suppressed = collect(s, "incidentSuppressed");
  s.capture({ msg: { payload: 1 }, sourceId: "n" });

  const e1 = s.dump("error", { n: 1 });
  check("C6 first error fires", e1 !== null);

  env.advance(300);
  const e2 = s.dump("error", { n: 2 });
  check("C6 second error suppressed", e2 === null);
  check("C6 suppression event", suppressed.length === 1 && suppressed[0].trigger === "error" &&
        suppressed[0].remainingMs === 700, JSON.stringify(suppressed));

  const w1 = s.dump("watermark", { n: 3 });
  check("C6 watermark also suppressed", w1 === null && suppressed.length === 2);

  const m1 = s.dump("manual", { n: 4 });
  check("C6 manual bypasses cooldown", m1 !== null);

  env.advance(300); // t = +600 from e1; manual must NOT have reset the clock
  const e3 = s.dump("error", { n: 5 });
  check("C6 manual did not reset cooldown clock", e3 === null && suppressed.length === 3);

  env.advance(500); // t = +1100 from e1
  const e4 = s.dump("error", { n: 6 });
  check("C6 error fires after expiry", e4 !== null);

  env.advance(999);
  check("C6 cooldown re-applies from new auto", s.dump("error", {}) === null);
}

// ===========================================================================
// C7: incident context truncation
// ===========================================================================
{
  const env = makeEnv();
  const s = makeStore("c7", { capacity: 5, maxRecordBytes: 1024 }, env);
  const big = { error: "boom", attachedMsg: { payload: "z".repeat(10000) } };
  const inc = s.dump("error", big);
  check("C7 context truncated flag", inc.context.__contextTruncated === true,
        JSON.stringify(Object.keys(inc.context)));
  check("C7 preview capped 500", typeof inc.context.preview === "string" &&
        inc.context.preview.length <= 500, inc.context.preview && inc.context.preview.length);
  const small = s.dump("manual", { error: "boom" });
  check("C7 small context intact", small.context.error === "boom");
  check("C7 null context null", s.dump("manual").context === null);
}

// ===========================================================================
// C8: persistence debounce — by count, by time, reset behavior
// ===========================================================================
{
  const env = makeEnv();
  const p = makePersistence();
  const s = makeStore("c8", { capacity: 50, persist: true,
    persistDebounce: { captures: 3, ms: 10000 } }, env, p);
  const persisted = collect(s, "persisted");

  // by count
  s.capture({ msg: { payload: 1 }, sourceId: "n" });
  s.capture({ msg: { payload: 2 }, sourceId: "n" });
  check("C8 no write before threshold", p.writes === 0);
  check("C8 timer armed", env.pendingTimers() === 1);
  s.capture({ msg: { payload: 3 }, sourceId: "n" });
  check("C8 write on count", p.writes === 1 && persisted.length === 1 &&
        persisted[0].reason === "debounce-count", p.writes);
  check("C8 timer cancelled after write", env.pendingTimers() === 0);

  // by time
  s.capture({ msg: { payload: 4 }, sourceId: "n" });
  check("C8 timer re-armed lazily", env.pendingTimers() === 1);
  env.advance(10000);
  check("C8 write on time", p.writes === 2 && persisted[1].reason === "debounce-time");
  check("C8 timer consumed", env.pendingTimers() === 0);

  // counter reset: after time-write, need 3 fresh captures for a count-write
  s.capture({ msg: { payload: 5 }, sourceId: "n" });
  s.capture({ msg: { payload: 6 }, sourceId: "n" });
  check("C8 counter was reset", p.writes === 2);
  s.capture({ msg: { payload: 7 }, sourceId: "n" });
  check("C8 count write after reset", p.writes === 3);

  const file = p.files.get("c8");
  check("C8 file format", file.formatVersion === FORMAT_VERSION && file.storeId === "c8" &&
        file.seqCounter === 7 && Array.isArray(file.records), JSON.stringify(Object.keys(file)));
}

// ===========================================================================
// C9: immediate writes on state-changing commands
// ===========================================================================
{
  const env = makeEnv();
  const p = makePersistence();
  const s = makeStore("c9", { capacity: 10, persist: true }, env, p);

  s.pause();   check("C9 pause writes", p.writes === 1);
  s.resume();  check("C9 resume writes", p.writes === 2);
  s.mark("m"); check("C9 mark writes", p.writes === 3);
  s.clear();   check("C9 clear writes", p.writes === 4);
  check("C9 no pending debounce timers", env.pendingTimers() === 0);
}

// ===========================================================================
// C10: restore round-trip — records restored, seq monotonic, state back
// ===========================================================================
{
  const env = makeEnv();
  const p = makePersistence();
  const a = makeStore("c10", { capacity: 10, persist: true }, env, p);
  a.attach("nodeA");
  a.capture({ msg: { payload: "one" }, sourceId: "n1" });
  env.advance(100);
  a.capture({ msg: { payload: "two" }, sourceId: "n1" });
  a.pause();                          // immediate write; paused persisted
  a.detach("nodeA", { removed: false });  // final close write

  env.advance(5000);                  // simulated downtime

  const b = makeStore("c10", { capacity: 10, persist: true }, env, p);
  check("C10 restored flag on store", b.restoredFromPersist === true);
  check("C10 records restored", b.records.length === 2 &&
        b.records.every(r => r.restored === true), JSON.stringify(b.records.map(r => !!r.restored)));
  check("C10 content survives", b.records[0].msg.payload === "one");
  check("C10 state restored paused", b.state === "paused");
  check("C10 seq continues", (b.resume(), b.capture({ msg: { payload: "three" }, sourceId: "n1" }).seq === 3));
  check("C10 new record not marked restored", b.records[2].restored === undefined);
  const q = b.query();
  check("C10 query reflects restore", q.restoredFromPersist === true && q.stats.recordCount === 3);
}

// ===========================================================================
// C11: corrupt / wrong-version persist files never block construction
// ===========================================================================
{
  const env = makeEnv();
  let warned = 0;
  const log = { warn: () => warned++, error: () => {} };

  const p1 = makePersistence();
  p1.files.set("c11a", { formatVersion: 99, records: [{}] });
  const s1 = makeStore("c11a", { persist: true }, env, p1, log);
  check("C11 wrong version fresh", s1.records.length === 0 && s1.restoredFromPersist === false);

  const p2 = makePersistence();
  p2.read = () => { throw new Error("disk on fire"); };
  let threw = false;
  let s2;
  try { s2 = makeStore("c11b", { persist: true }, env, p2, log); } catch (e) { threw = true; }
  check("C11 read throw tolerated", !threw && s2.records.length === 0);

  const p3 = makePersistence();
  p3.files.set("c11c", { formatVersion: 1, records: "not-an-array", seqCounter: "nan" });
  const s3 = makeStore("c11c", { persist: true }, env, p3, log);
  check("C11 malformed fields tolerated", s3.records.length === 0 && s3.seqCounter === 0);
  check("C11 warnings logged", warned >= 2, warned);
}

// ===========================================================================
// C12: detach — removed:true removes file; removed:false final-writes
// ===========================================================================
{
  const env = makeEnv();
  const p = makePersistence();
  const s = makeStore("c12", { capacity: 10, persist: true }, env, p);
  s.attach("a"); s.attach("b");
  s.capture({ msg: { payload: 1 }, sourceId: "n" });

  s.detach("a", { removed: false });
  check("C12 not last: no close write yet", p.writes === 0, p.writes);
  s.detach("b", { removed: false });
  check("C12 last detach final write", p.writes === 1 && p.files.has("c12"));

  const p2 = makePersistence();
  const s2 = makeStore("c12b", { capacity: 10, persist: true }, env, p2);
  s2.attach("a");
  s2.capture({ msg: { payload: 1 }, sourceId: "n" });
  s2.detach("a", { removed: true });
  check("C12 removed deletes file", p2.removes === 1 && !p2.files.has("c12b"));
}

// ===========================================================================
// C13: clear semantics — seq preserved, counters reset, wrap re-armed
// ===========================================================================
{
  const env = makeEnv();
  const s = makeStore("c13", { capacity: 2 }, env);
  const wrapped = collect(s, "wrapped");
  const cleared = collect(s, "cleared");

  for (let i = 0; i < 3; i++) s.capture({ msg: { payload: i }, sourceId: "n" }); // 1 wrap
  s.pause(); s.capture({ msg: {}, sourceId: "n" }); s.resume();                  // 1 dropped
  check("C13 pre-clear state", s.query().stats.wrapCount === 1 &&
        s.query().stats.droppedWhilePaused === 1 && wrapped.length === 1);

  const res = s.clear();
  check("C13 cleared count", res.cleared === 2 && cleared.length === 1 && cleared[0].cleared === 2);
  const st = s.query().stats;
  check("C13 counters reset", st.recordCount === 0 && st.wrapCount === 0 &&
        st.droppedWhilePaused === 0 && st.firstSeq === null && st.spanMs === null, JSON.stringify(st));
  check("C13 seq preserved", s.capture({ msg: {}, sourceId: "n" }).seq === 4);

  for (let i = 0; i < 2; i++) s.capture({ msg: { payload: i }, sourceId: "n" });
  check("C13 wrap re-armed after clear", wrapped.length === 2, wrapped.length);
}

// ===========================================================================
// C14: persistence write failure — error surfaced, recording continues
// ===========================================================================
{
  const env = makeEnv();
  const p = makePersistence();
  p.write = () => { throw new Error("EACCES"); };
  let logged = 0;
  const s = makeStore("c14", { capacity: 10, persist: true,
    persistDebounce: { captures: 1, ms: 1000 } }, env, p, { warn: () => {}, error: () => logged++ });
  const errors = collect(s, "error");

  const r = s.capture({ msg: { payload: 1 }, sourceId: "n" });
  check("C14 capture still accepted", r.accepted === true);
  check("C14 error surfaced", errors.length === 1 && logged === 1);
  check("C14 recording intact", s.records.length === 1);
  // and with NO error listener attached, must not crash:
  const s2 = makeStore("c14b", { capacity: 10, persist: true,
    persistDebounce: { captures: 1, ms: 1000 } }, env, p, quietLog);
  let crashed = false;
  try { s2.capture({ msg: { payload: 1 }, sourceId: "n" }); } catch (e) { crashed = true; }
  check("C14 listenerless error safe", !crashed);
}

// ===========================================================================
// C15: query snapshot shape + config echo; construction validation
// ===========================================================================
{
  const env = makeEnv();
  const s = makeStore("c15", { capacity: 7, captureMode: "summary",
    maxRecordBytes: 4096, incidentCooldownMs: 250 }, env);
  const q = s.query();
  check("C15 snapshot shape",
        q.storeId === "c15" && q.state === "recording" && q.capacity === 7 &&
        q.restoredFromPersist === false &&
        q.config.captureMode === "summary" && q.config.maxRecordBytes === 4096 &&
        q.config.incidentCooldownMs === 250 && q.config.persist === false &&
        typeof q.stats === "object", JSON.stringify(q));

  let bad = 0;
  try { new RecorderStore("", {}, {}); } catch (e) { bad++; }
  try { new RecorderStore("x", { capacity: 0 }, {}); } catch (e) { bad++; }
  try { new RecorderStore("x", { incidentCooldownMs: -5 }, {}); } catch (e) { bad++; }
  check("C15 construction validation", bad === 3, bad);

  // summary mode flows through to captured records
  s.capture({ msg: { payload: "hello" }, sourceId: "n" });
  check("C15 summary capture", s.records[0].msg.payloadType === "string" &&
        s.records[0].msg.payloadPreview === "hello", JSON.stringify(s.records[0].msg));
}

// ---------------------------------------------------------------------------
console.log("");
if (failures) {
  console.log(failures + " FAILURE(S)");
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED");
}
