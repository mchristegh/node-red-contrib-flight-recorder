// test-scripts/persistence-harness.js
//
// Phase 3 harness for lib/persistence.js. Uses real temp directories on
// disk (like the timer-events harness), plus one end-to-end test wiring
// the real adapter into a real RecorderStore across a simulated restart.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");

const { createFilePersistence, sanitizeStoreId, SUBDIR } = require(
  path.join(__dirname, "..", "lib", "persistence.js"),
);
const { RecorderStore } = require(
  path.join(__dirname, "..", "lib", "recorder-core.js"),
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

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "flightrec-p3-"));
const storeDir = path.join(userDir, SUBDIR);
const quietLog = { warn: () => {}, error: () => {} };

// ===========================================================================
// P1: round-trip through real disk; directory created on demand
// ===========================================================================
{
  const p = createFilePersistence(userDir);
  check("P1 dir not pre-created", !fs.existsSync(storeDir));
  const state = {
    formatVersion: 1,
    storeId: "abc123.def",
    seqCounter: 7,
    state: "recording",
    records: [{ seq: 7, msg: { payload: "hi" } }],
  };
  p.write("abc123.def", state);
  check("P1 dir created on write", fs.existsSync(storeDir));
  check(
    "P1 file exists",
    fs.existsSync(path.join(storeDir, "abc123.def.json")),
  );
  const back = p.read("abc123.def");
  check("P1 round-trip", JSON.stringify(back) === JSON.stringify(state));
  const state2 = Object.assign({}, state, { seqCounter: 8 });
  p.write("abc123.def", state2);
  check("P1 overwrite", p.read("abc123.def").seqCounter === 8);
}

// ===========================================================================
// P2: missing file -> null; corrupt file -> throws
// ===========================================================================
{
  const p = createFilePersistence(userDir);
  check("P2 missing returns null", p.read("never-written") === null);

  fs.writeFileSync(
    path.join(storeDir, "corrupt1.json"),
    "{ not json !!",
    "utf8",
  );
  let threw = false;
  try {
    p.read("corrupt1");
  } catch {
    threw = true;
  }
  check("P2 corrupt json throws", threw);

  // and the core turns that throw into warn-and-fresh (contract seam check)
  let warned = 0;
  const s = new RecorderStore(
    "corrupt1",
    { persist: true },
    {
      persistence: p,
      log: { warn: () => warned++, error: () => {} },
    },
  );
  check(
    "P2 core starts fresh on corrupt",
    s.records.length === 0 && s.restoredFromPersist === false && warned === 1,
    warned,
  );
}

// ===========================================================================
// P3: storeId sanitization — hostile ids can't escape or collide unsafely
// ===========================================================================
{
  check(
    "P3 traversal neutralized",
    sanitizeStoreId("../../etc/passwd") === "_.._.._etc_passwd" ||
      sanitizeStoreId("../../etc/passwd").indexOf("/") === -1,
    sanitizeStoreId("../../etc/passwd"),
  );
  check("P3 no leading dots", !/^\./.test(sanitizeStoreId("...hidden")));
  check(
    "P3 normal id untouched",
    sanitizeStoreId("a1b2c3.d4e5f6") === "a1b2c3.d4e5f6",
  );
  check("P3 length capped", sanitizeStoreId("x".repeat(500)).length === 128);
  let bad = false;
  try {
    sanitizeStoreId("");
  } catch {
    bad = true;
  }
  check("P3 empty rejected", bad);

  const p = createFilePersistence(userDir);
  p.write("../escape", { formatVersion: 1 });
  check(
    "P3 hostile write stays inside dir",
    fs.existsSync(
      path.join(storeDir, sanitizeStoreId("../escape") + ".json"),
    ) &&
      !fs.existsSync(path.join(userDir, "escape.json")) &&
      !fs.existsSync(path.join(path.dirname(userDir), "escape.json")),
  );
  p.remove("../escape");
}

// ===========================================================================
// P4: remove — deletes, idempotent
// ===========================================================================
{
  const p = createFilePersistence(userDir);
  p.write("gone-soon", { formatVersion: 1 });
  check("P4 pre-remove exists", p.read("gone-soon") !== null);
  p.remove("gone-soon");
  check("P4 removed", p.read("gone-soon") === null);
  let threw = false;
  try {
    p.remove("gone-soon");
  } catch {
    threw = true;
  }
  check("P4 remove idempotent", !threw);
}

// ===========================================================================
// P5: atomicity hygiene — no temp files left behind after writes
// ===========================================================================
{
  const p = createFilePersistence(userDir);
  for (let i = 0; i < 20; i++)
    p.write("atomic-test", { formatVersion: 1, i: i });
  const leftovers = fs
    .readdirSync(storeDir)
    .filter((f) => f.indexOf(".tmp-") !== -1);
  check(
    "P5 no temp leftovers",
    leftovers.length === 0,
    JSON.stringify(leftovers),
  );
  check("P5 final content correct", p.read("atomic-test").i === 19);
}

// ===========================================================================
// P6: end-to-end — real store, real adapter, simulated restart
// ===========================================================================
(async function P6() {
  const p = createFilePersistence(userDir);
  const mk = () =>
    new RecorderStore(
      "e2e-node-1",
      {
        capacity: 10,
        persist: true,
        persistDebounce: { captures: 2, ms: 60000 },
      },
      { persistence: p, log: quietLog },
    );

  // phase A: run, capture, mark, close
  const a = mk();
  a.attach("ref");
  a.capture({
    msg: { payload: "first" },
    sourceId: "n1",
    sourceType: "inject",
  });
  a.capture({
    msg: { payload: "second" },
    sourceId: "n1",
    sourceType: "inject",
  }); // debounce-count write
  a.mark({ note: "before restart" }); // immediate write
  a.detach("ref", { removed: false }); // close write

  await new Promise((r) => setTimeout(r, 50)); // simulated downtime (real clock)

  // phase B: "restart"
  const b = mk();
  b.attach("ref");
  check("P6 restored", b.restoredFromPersist === true);
  check(
    "P6 records back",
    b.records.length === 3 && b.records.every((r) => r.restored === true),
  );
  check("P6 mark survived", b.records[2].annotation.note === "before restart");
  const r = b.capture({ msg: { payload: "post-restart" }, sourceId: "n1" });
  check("P6 seq monotonic across restart", r.seq === 4, r.seq);
  check(
    "P6 downtime visible in delta",
    b.records[3].deltaMs >= 50,
    b.records[3].deltaMs,
  );

  // phase C: node deleted -> file removed
  b.detach("ref", { removed: true });
  check("P6 removed on delete", p.read("e2e-node-1") === null);

  // ---- summary -------------------------------------------------------------
  console.log("");
  if (failures) {
    console.log(failures + " FAILURE(S)");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED");
  }
})();
