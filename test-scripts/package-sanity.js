// test-scripts/package-sanity.js
//
// Package-level sanity harness (formalizing what was previously run ad hoc):
//   - package.json registers node files that exist, and its npm test script
//     names every harness in test-scripts/ (a new harness can't silently
//     go unrun)
//   - EVERY example flow in examples/ is valid: parseable JSON, exactly one
//     tab, all wires resolve to nodes in the flow, all nodes belong to the
//     tab, and every flight-recorder-family node uses a registered type
//   - control-node targets and tap flow-scopes reference real ids
//   - example tab labels are unique (they share one import menu)

"use strict";

const fs = require("fs");
const path = require("path");

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

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
);

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------
{
  const nodeFiles = Object.values(pkg["node-red"].nodes);
  check(
    "pkg registered node files exist",
    nodeFiles.every((f) => fs.existsSync(path.join(ROOT, f))),
    nodeFiles.join(","),
  );

  const registeredTypes = Object.keys(pkg["node-red"].nodes);
  check(
    "pkg registers 4 node types",
    registeredTypes.length === 4,
    registeredTypes.join(","),
  );

  const harnesses = fs
    .readdirSync(path.join(ROOT, "test-scripts"))
    .filter((f) => f.endsWith(".js"));
  const unlisted = harnesses.filter((h) => pkg.scripts.test.indexOf(h) === -1);
  check(
    "pkg npm test covers every harness",
    unlisted.length === 0,
    unlisted.join(","),
  );

  for (const dir of ["nodes", "lib", "examples"]) {
    check("pkg files ships " + dir, pkg.files.indexOf(dir) !== -1);
  }
}

// ---------------------------------------------------------------------------
// example flows
// ---------------------------------------------------------------------------
const exampleDir = path.join(ROOT, "examples");
const exampleFiles = fs
  .readdirSync(exampleDir)
  .filter((f) => f.endsWith(".json"));
check("examples present", exampleFiles.length >= 3, exampleFiles.join(","));

const familyTypes = new Set(Object.keys(pkg["node-red"].nodes));
const tabLabels = [];

for (const file of exampleFiles) {
  const label = "example " + file;
  let flow;
  try {
    flow = JSON.parse(fs.readFileSync(path.join(exampleDir, file), "utf8"));
  } catch (e) {
    check(label + " parses", false, e.message);
    continue;
  }
  check(label + " parses", Array.isArray(flow));

  const tabs = flow.filter((n) => n.type === "tab");
  check(label + " exactly one tab", tabs.length === 1);
  if (tabs.length !== 1) continue;
  const tabId = tabs[0].id;
  tabLabels.push(tabs[0].label);
  check(
    label + " tab has info text",
    typeof tabs[0].info === "string" && tabs[0].info.length > 50,
  );

  const ids = new Set(flow.map((n) => n.id));
  const bad = [];
  for (const n of flow) {
    if (n.type === "tab") continue;
    if (n.z !== tabId) bad.push(n.id + " z=" + n.z);
    if (n.wires) {
      for (const port of n.wires) {
        for (const w of port) if (!ids.has(w)) bad.push(n.id + " -> " + w);
      }
    }
    if (n.type.indexOf("flight-recorder") === 0 && !familyTypes.has(n.type)) {
      bad.push(n.id + " unregistered type " + n.type);
    }
    if (n.type === "flight-recorder-control" && !ids.has(n.target)) {
      bad.push(n.id + " target " + n.target + " missing");
    }
    if (
      n.type === "flight-recorder-tap" &&
      n.scopeFlows &&
      n.scopeFlows !== tabId
    ) {
      bad.push(n.id + " scopeFlows " + n.scopeFlows + " is not this tab");
    }
    if (n.type === "flight-recorder-report" && n.destination !== "message") {
      bad.push(
        n.id + " example report must be message-only (zero-setup imports)",
      );
    }
  }
  check(label + " integrity", bad.length === 0, bad.join("; "));
}

check(
  "example tab labels unique",
  new Set(tabLabels).size === tabLabels.length,
  tabLabels.join(" | "),
);

// ---------------------------------------------------------------------------
console.log("");
if (failures) {
  console.log(failures + " FAILURE(S)");
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED");
}
