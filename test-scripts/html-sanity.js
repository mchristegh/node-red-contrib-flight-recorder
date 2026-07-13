// test-scripts/html-sanity.js
//
// Phase 7 sanity harness. Editor .html files can't run in the node
// harnesses, but their structure is checkable: each must contain a
// registration script that PARSES as JavaScript, a config template, and a
// help panel, with data-* names matching the node type; every form field
// id must correspond to a declared default (and vice versa); and the
// defaults must exactly match the config keys the runtime consumes (as
// pinned by the runtime harnesses).

"use strict";

const fs = require("fs");
const path = require("path");

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("PASS  " + label); }
  else { failures++; console.log("FAIL  " + label + (detail !== undefined ? "  [" + detail + "]" : "")); }
}

const NODES_DIR = path.join(__dirname, "..", "nodes");

// the config keys each runtime file actually reads from `n` (ground truth,
// mirrored from the runtime harness configs)
const RUNTIME_KEYS = {
  "flight-recorder": [
    "name", "capacity", "captureMode", "maxRecordBytes", "redactPaths",
    "persist", "incidentCooldownMs",
    "watermarkProperty", "watermarkOperator", "watermarkValue"
  ],
  "flight-recorder-tap": [
    "name", "scopeAllFlows", "scopeFlows", "scopeNodes", "scopeTypes",
    "excludeNodes", "excludeTypes", "autoErrorDump",
    "capacity", "captureMode", "maxRecordBytes", "redactPaths",
    "persist", "incidentCooldownMs",
    "watermarkProperty", "watermarkOperator", "watermarkValue"
  ],
  "flight-recorder-control": ["name", "target"]
};

const EXPECTED_PORTS = {
  "flight-recorder":         { inputs: 1, outputs: 4 },
  "flight-recorder-tap":     { inputs: 1, outputs: 3 },
  "flight-recorder-control": { inputs: 1, outputs: 1 }
};

function extract(html, openTagRe) {
  const m = html.match(openTagRe);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = html.indexOf("</script>", start);
  return end === -1 ? null : html.slice(start, end);
}

for (const type of Object.keys(RUNTIME_KEYS)) {
  const file = path.join(NODES_DIR, type + ".html");
  const label = type + ".html";

  check(label + " exists", fs.existsSync(file));
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, "utf8");

  // --- three blocks present, names matching --------------------------------
  const js = extract(html, /<script type="text\/javascript">/);
  const template = extract(html,
    new RegExp('<script type="text/html" data-template-name="' + type + '">'));
  const help = extract(html,
    new RegExp('<script type="text/html" data-help-name="' + type + '">'));
  check(label + " registration block", js !== null);
  check(label + " template block named " + type, template !== null);
  check(label + " help block named " + type, help !== null);
  if (js === null || template === null || help === null) continue;

  // --- registration JS parses (not executed) --------------------------------
  let parses = true, parseErr = "";
  try { new Function(js); } catch (e) { parses = false; parseErr = e.message; }
  check(label + " registration JS parses", parses, parseErr);

  // --- registers the right type ----------------------------------------------
  check(label + " registers correct type",
        js.indexOf('registerType("' + type + '"') !== -1 ||
        js.indexOf("registerType('" + type + "'") !== -1);

  // --- ports -------------------------------------------------------------------
  const exp = EXPECTED_PORTS[type];
  const inputs = js.match(/inputs:\s*(\d+)/);
  const outputs = js.match(/outputs:\s*(\d+)/);
  check(label + " ports " + exp.inputs + "/" + exp.outputs,
        inputs && Number(inputs[1]) === exp.inputs &&
        outputs && Number(outputs[1]) === exp.outputs,
        JSON.stringify({ inputs: inputs && inputs[1], outputs: outputs && outputs[1] }));

  // --- family color consistency ---------------------------------------------------
  check(label + " family orange", /#F0954F/i.test(js));

  // --- defaults vs runtime keys ------------------------------------------------------
  const declared = [...js.matchAll(/^\s*([A-Za-z0-9_]+)\s*:\s*\{\s*value:/gm)].map(m => m[1]);
  const runtime = RUNTIME_KEYS[type];
  const missing = runtime.filter(k => declared.indexOf(k) === -1);
  const extra = declared.filter(k => runtime.indexOf(k) === -1);
  check(label + " defaults cover runtime keys", missing.length === 0, "missing: " + missing.join(","));
  check(label + " no orphan defaults", extra.length === 0, "extra: " + extra.join(","));

  // --- form fields vs defaults ----------------------------------------------------------
  const fieldIds = [...template.matchAll(/id="node-input-([A-Za-z0-9_]+)"/g)].map(m => m[1]);
  const fieldsWithoutDefault = fieldIds.filter(f => declared.indexOf(f) === -1);
  check(label + " every form field has a default", fieldsWithoutDefault.length === 0,
        fieldsWithoutDefault.join(","));
  const defaultsWithoutField = declared.filter(d => fieldIds.indexOf(d) === -1);
  check(label + " every default has a form field", defaultsWithoutField.length === 0,
        defaultsWithoutField.join(","));
}

// --- cross-file: command vocabulary in control help matches runtime ------------
{
  const help = fs.readFileSync(path.join(NODES_DIR, "flight-recorder-control.html"), "utf8");
  const runtimeSrc = fs.readFileSync(path.join(NODES_DIR, "flight-recorder-control.js"), "utf8");
  const m = runtimeSrc.match(/const COMMANDS = \[([^\]]+)\]/);
  const commands = m[1].match(/"([a-z]+)"/g).map(s => s.replace(/"/g, ""));
  const undocumented = commands.filter(c => help.indexOf("<code>" + c + "</code>") === -1);
  check("control help documents all runtime commands", undocumented.length === 0,
        "undocumented: " + undocumented.join(","));
}

console.log("");
if (failures) {
  console.log(failures + " FAILURE(S)");
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED");
}
