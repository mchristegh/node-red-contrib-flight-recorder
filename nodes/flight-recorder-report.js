// nodes/flight-recorder-report.js
//
// The post-mortem archiver: consumes incidents, query snapshots and
// recorder events, renders human-readable reports (text / markdown / html),
// and optionally lands them as files — with a raw-JSON evidence companion
// sharing the same filename stem.
//
// Stateless: no store, no registry, no persistence of its own. Two
// independent artifacts per incident/snapshot:
//   report   -> message and/or file, in the configured format
//   raw JSON -> file only (requires a directory), paired by stem
//
// Protective behaviors (agreed in design):
//   - collisions get -2/-3... suffixes: an archiver never destroys evidence
//   - retention prunes by stem PAIR, only files matching this node's own
//     template pattern, keeping the newest N incidents
//   - file configuration problems degrade gracefully at construction with
//     a warn, mirroring the persist-without-userDir posture

"use strict";

const fs = require("fs");
const path = require("path");
const { render } = require(path.join(__dirname, "..", "lib", "report.js"));
const { _internal: reportInternal } = require(path.join(__dirname, "..", "lib", "report.js"));

const EXT = { text: ".txt", markdown: ".md", html: ".html" };
const DEFAULT_TEMPLATE = "{date}_{time}_{trigger}_{storeId}";

function toPosInt(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function toNonNegInt(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}
function sanitizeToken(v) {
  let s = String(v === undefined || v === null ? "" : v).replace(/[^A-Za-z0-9._-]/g, "_");
  s = s.replace(/^\.+/, "_");
  if (s.length === 0) s = "_";
  if (s.length > 64) s = s.slice(0, 64);
  return s;
}

// resolve the filename template against a payload
function resolveTokens(template, payload, kind, format) {
  const at = kind === "incident" && Number.isFinite(payload.triggeredAt)
    ? payload.triggeredAt : Date.now();
  const parts = reportInternal.fmtDateParts(at);
  const tokens = {
    date: parts.date,
    time: parts.timeFile,
    trigger: kind === "incident" ? (payload.trigger || "manual") : "status",
    storeId: payload.storeId || "unknown",
    incidentId: kind === "incident" ? String(payload.incidentId || "").slice(0, 8) : "status",
    format: format
  };
  return template.replace(/\{(date|time|trigger|storeId|incidentId|format)\}/g,
    (m, name) => sanitizeToken(tokens[name]));
}

// regex matching files THIS template could have produced (with collision
// suffixes), so retention can never touch anything it didn't create
function templateRegex(template) {
  const TOKEN_PATTERNS = {
    date: "\\d{4}-\\d{2}-\\d{2}",
    time: "\\d{2}-\\d{2}-\\d{2}",
    trigger: "[A-Za-z0-9._-]+",
    storeId: "[A-Za-z0-9._-]+",
    incidentId: "[A-Za-z0-9._-]+",
    format: "[a-z]+"
  };
  let out = "^";
  let rest = template;
  const tokenRe = /\{(date|time|trigger|storeId|incidentId|format)\}/;
  while (rest.length) {
    const m = rest.match(tokenRe);
    if (!m) { out += rest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); break; }
    out += rest.slice(0, m.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out += TOKEN_PATTERNS[m[1]];
    rest = rest.slice(m.index + m[0].length);
  }
  out += "(?:-\\d+)?\\.(?:txt|md|html|json)$";
  return new RegExp(out);
}

function writeAtomic(file, content) {
  const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* best effort */ }
    throw e;
  }
}

module.exports = function (RED) {

  function FlightRecorderReportNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.name = n.name;

    const format = (n.format === "markdown" || n.format === "html") ? n.format : "text";
    const destination = (n.destination === "file" || n.destination === "both")
      ? n.destination : "message";
    const directory = typeof n.directory === "string" ? n.directory.trim() : "";
    const template = (typeof n.filenameTemplate === "string" && n.filenameTemplate.trim().length)
      ? n.filenameTemplate.trim() : DEFAULT_TEMPLATE;
    const retention = toNonNegInt(n.retention, 100);
    const previewChars = toPosInt(n.previewChars, 60);

    // --- graceful degradation at construction --------------------------------
    let fileEnabled = destination !== "message";
    let rawEnabled = n.rawJson === true || n.rawJson === "true";
    if (destination === "message" && rawEnabled) {
      node.warn("flight-recorder-report: raw JSON requires file output; disabled");
      rawEnabled = false;
    }
    if ((fileEnabled || rawEnabled) && !directory) {
      node.warn("flight-recorder-report: file output requested but no directory configured; file output disabled");
      fileEnabled = false;
      rawEnabled = false;
    }

    const matchOwn = templateRegex(template);
    const ext = EXT[format];

    node.status({});

    // --- file landing --------------------------------------------------------
    function landFiles(payload, kind, rendered) {
      const files = [];
      fs.mkdirSync(directory, { recursive: true });

      // collision-safe shared stem: neither the report ext nor .json may exist
      const base = resolveTokens(template, payload, kind, format);
      let stem = base;
      let i = 2;
      while (fs.existsSync(path.join(directory, stem + ext)) ||
             fs.existsSync(path.join(directory, stem + ".json"))) {
        stem = base + "-" + i++;
      }

      if (fileEnabled) {
        const file = path.join(directory, stem + ext);
        try {
          writeAtomic(file, rendered);
          files.push({ kind: "report", path: file, bytes: Buffer.byteLength(rendered, "utf8"), ok: true });
        } catch (e) {
          files.push({ kind: "report", path: file, bytes: 0, ok: false, reason: e.message });
        }
      }
      if (rawEnabled) {
        const file = path.join(directory, stem + ".json");
        const json = JSON.stringify(payload, null, 2);
        try {
          writeAtomic(file, json);
          files.push({ kind: "raw", path: file, bytes: Buffer.byteLength(json, "utf8"), ok: true });
        } catch (e) {
          files.push({ kind: "raw", path: file, bytes: 0, ok: false, reason: e.message });
        }
      }

      if (retention > 0 && files.some(f => f.ok)) applyRetention();
      return files;
    }

    // newest N incidents (stem pairs) kept; only files matching our template
    function applyRetention() {
      let entries;
      try { entries = fs.readdirSync(directory); } catch (e) { return; }
      const stems = new Map(); // stem -> { mtime, files[] }
      for (const name of entries) {
        if (!matchOwn.test(name)) continue;
        const stem = name.replace(/\.(txt|md|html|json)$/, "");
        const full = path.join(directory, name);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch (e) { continue; }
        const g = stems.get(stem) || { mtime: 0, files: [] };
        g.mtime = Math.max(g.mtime, mtime);
        g.files.push(full);
        stems.set(stem, g);
      }
      if (stems.size <= retention) return;
      const ordered = [...stems.entries()]
        .sort((a, b) => b[1].mtime - a[1].mtime || (a[0] < b[0] ? 1 : -1));
      for (const [, group] of ordered.slice(retention)) {
        for (const f of group.files) {
          try { fs.unlinkSync(f); } catch (e) { node.warn("flight-recorder-report: retention could not remove " + f); }
        }
      }
    }

    // --- input -----------------------------------------------------------------
    node.on("input", function (msg) {
      let r;
      try {
        r = render(msg, { format: format, previewChars: previewChars });
      } catch (e) {
        node.error(e, msg);
        return;
      }

      const originalPayload = msg.payload;
      let files = [];

      if ((r.kind === "incident" || r.kind === "snapshot") && (fileEnabled || rawEnabled)) {
        try {
          files = landFiles(originalPayload, r.kind, r.output);
        } catch (e) { // mkdir failure etc.
          files = [{ kind: "report", path: directory, bytes: 0, ok: false, reason: e.message }];
        }
      }

      msg.report = { kind: r.kind, format: format, source: originalPayload, files: files };

      const failed = files.filter(f => !f.ok);
      if (destination === "file" && (r.kind === "incident" || r.kind === "snapshot")) {
        msg.payload = files.length === 0
          ? "report not saved: file output disabled (no directory configured)"
          : files.map(f => f.ok
              ? (f.kind === "raw" ? "raw JSON saved: " : "report saved: ") + f.path
              : f.kind + " failed: " + f.reason).join("\n");
      } else {
        msg.payload = r.output;
      }

      if (failed.length) {
        node.status({ fill: "red", shape: "ring", text: "write failed" });
      } else if (r.kind === "incident" || r.kind === "snapshot") {
        node.status({ fill: "green", shape: "dot",
          text: r.kind + " ✓" + (files.length ? " · saved" + (files.length > 1 ? " ×" + files.length : "") : "") });
      }

      node.send(msg);
    });

    node.on("close", function (removed, done) {
      if (typeof removed === "function") { done = removed; }
      if (done) done();
    });
  }

  RED.nodes.registerType("flight-recorder-report", FlightRecorderReportNode);
};

module.exports._internal = { resolveTokens, templateRegex, sanitizeToken, DEFAULT_TEMPLATE, EXT };
