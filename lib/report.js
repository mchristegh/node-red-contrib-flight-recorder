// lib/report.js
//
// The report engine for flight-recorder-report: turns incidents, query
// snapshots and recorder events into human-readable documents.
//
// Pure and stateless: detect(msg) classifies a recorder payload, and
// render(msg, opts) produces the document string. One intermediate report
// model feeds all three renderers (text, markdown, html), so formats are
// skins, not implementations. The model is internal and free to evolve;
// only the rendered output and the raw incident JSON are public contracts.
//
// Zero Node-RED imports, zero dependencies beyond the Node stdlib.

"use strict";

const ANOMALY_FACTOR = 3;       // gap >= 3x median gap earns a warning flag
const SOURCE_COL = 29;

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------
function detect(msg) {
  const p = msg ? msg.payload : undefined;
  if (p && typeof p === "object") {
    if (typeof p.incidentId === "string" && Array.isArray(p.records)) return "incident";
    if (p.stats && p.config && typeof p.state === "string" &&
        typeof p.storeId === "string") return "snapshot";
  }
  if (msg && typeof msg.recorderEvent === "string") return "event";
  return "unknown";
}

// ---------------------------------------------------------------------------
// small formatting helpers
// ---------------------------------------------------------------------------
function pad2(n) { return String(n).padStart(2, "0"); }
function fmtDateParts(ms) {
  const d = new Date(ms);
  return {
    date: d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()),
    timeFile: pad2(d.getHours()) + "-" + pad2(d.getMinutes()) + "-" + pad2(d.getSeconds()),
    at: d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
        pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds())
  };
}
function humanize(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  if (ms < 3600000) {
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return m + "m " + pad2(s) + "s";
  }
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h + "h " + pad2(m) + "m";
}
function gapText(ms) {
  if (ms === null || ms === undefined) return "—";
  return ms < 60000 ? (ms / 1000).toFixed(1) + "s" : humanize(ms);
}
function relText(ms) { return (ms / 1000).toFixed(1) + "s"; }
function compactJson(v, max) {
  let s;
  try { s = JSON.stringify(v); } catch (e) { s = String(v); }
  if (s === undefined) s = "";
  return max && s.length > max ? s.slice(0, max - 1) + "…" : s;
}
function median(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// source label: "name [type]" fitted to the source column
// ---------------------------------------------------------------------------
function sourceLabel(source, width) {
  const type = " [" + ((source && source.type) || "?") + "]";
  let name = (source && (source.name || source.id)) || "?";
  const nameMax = Math.max(1, width - type.length);
  if (name.length > nameMax) name = name.slice(0, nameMax);
  return name + type;
}

// ---------------------------------------------------------------------------
// record preview
// ---------------------------------------------------------------------------
function recordPreview(record, previewChars) {
  const m = record.msg;
  if (m === null || m === undefined) return "";
  let base;
  if (m.payloadType !== undefined) {           // summary form (config or truncation)
    base = m.payloadPreview !== undefined ? String(m.payloadPreview) : "(" + m.payloadType + ")";
  } else if (Object.prototype.hasOwnProperty.call(m, "payload")) {
    base = typeof m.payload === "string" ? m.payload : compactJson(m.payload);
  } else {
    base = "(no payload)";
  }
  if (record.truncated) base = "✂ " + base;
  return base.length > previewChars ? base.slice(0, previewChars - 1) + "…" : base;
}

// ---------------------------------------------------------------------------
// incident model
// ---------------------------------------------------------------------------
function buildIncidentModel(inc, previewChars) {
  const records = inc.records || [];
  const firstAt = records.length ? records[0].capturedAt : inc.triggeredAt;

  const gaps = records.filter(r => r.annotation === null || r.annotation === undefined)
    .map(r => r.deltaMs).filter(v => Number.isFinite(v));
  const med = median(gaps);

  const rows = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.annotation !== null && r.annotation !== undefined) {
      let label = "MARK";
      if (r.annotation && typeof r.annotation === "object") {
        if (r.annotation.muted) label = "MUTED";
        else if (r.annotation.unmuted) label = "UNMUTED";
      }
      rows.push({ kind: "mark", label: label, text: compactJson(r.annotation, previewChars + 20), seq: r.seq });
    } else {
      rows.push({
        kind: "record",
        seq: r.seq,
        rel: relText(r.capturedAt - firstAt),
        gap: gapText(r.deltaMs),
        anom: med > 0 && Number.isFinite(r.deltaMs) && r.deltaMs >= ANOMALY_FACTOR * med,
        src: sourceLabel(r.source, SOURCE_COL),
        preview: recordPreview(r, previewChars),
        truncated: !!r.truncated
      });
    }
    const next = records[i + 1];
    if (r.restored === true && next && next.restored !== true) {
      rows.push({ kind: "restart" });
    }
  }

  // cause: error triggers put the failure front and center
  let cause = null;
  let contextText = null;
  const ctx = inc.context;
  if (inc.trigger === "error" && ctx && typeof ctx === "object" && ctx.error) {
    const e = ctx.error;
    cause = {
      message: (e && typeof e === "object" && e.message !== undefined) ? String(e.message) : compactJson(e, 120),
      source: ctx.source ? sourceLabel(ctx.source, 60) : null
    };
  } else if (ctx !== null && ctx !== undefined) {
    contextText = compactJson(ctx, 200);
  }

  const s = inc.stats || {};
  return {
    trigger: inc.trigger || "manual",
    storeId: inc.storeId,
    idShort: String(inc.incidentId || "").slice(0, 8),
    at: fmtDateParts(inc.triggeredAt).at,
    cause: cause,
    contextText: contextText,
    stats: {
      recordCount: s.recordCount || 0,
      spanText: humanize(s.spanMs === null || s.spanMs === undefined ? NaN : s.spanMs),
      medianText: med > 0 ? gapText(med) : "—",
      wraps: s.wrapCount || 0,
      truncated: s.truncatedCount || 0,
      dropped: s.droppedWhilePaused || 0
    },
    rows: rows
  };
}

// ---------------------------------------------------------------------------
// snapshot model
// ---------------------------------------------------------------------------
function buildSnapshotModel(q) {
  const s = q.stats || {};
  const c = q.config || {};
  const model = {
    storeId: q.storeId,
    state: q.state,
    restored: q.restoredFromPersist === true,
    recording: s.recordCount + "/" + q.capacity + " records · span " +
      humanize(s.spanMs === null || s.spanMs === undefined ? NaN : s.spanMs),
    counters: "wraps " + (s.wrapCount || 0) + " · truncated " + (s.truncatedCount || 0) +
      " · dropped " + (s.droppedWhilePaused || 0),
    configLine: (c.captureMode === "summary" ? "summary" : "full") + " capture · " +
      c.maxRecordBytes + " B max · cooldown " +
      (c.incidentCooldownMs ? humanize(c.incidentCooldownMs) : "off") +
      " · persist " + (c.persist ? "on" : "off"),
    tapLine: null
  };
  if (q.tap && typeof q.tap === "object") {
    const mutes = (q.tap.mutes || []).map(m =>
      m.kind + ":" + m.value + " (" + (m.suppressedCount || 0) + " suppressed)");
    const seen = q.tap.scopeSeen || {};
    model.tapLine = "auto-error " + (q.tap.autoErrorDump ? "ON" : "off") +
      " · mutes: " + (mutes.length ? mutes.join(", ") : "none") +
      " · seen " + (seen.inScope || 0) + " in / " + (seen.outOfScope || 0) + " out of scope";
  }
  return model;
}

// ---------------------------------------------------------------------------
// text renderer
// ---------------------------------------------------------------------------
function textIncident(m, previewChars) {
  const W = 55 + previewChars;
  const L = [];
  L.push("═".repeat(W));
  L.push(" FLIGHT RECORDER INCIDENT · " + m.trigger.toUpperCase());
  L.push("═".repeat(W));
  L.push(" store      " + m.storeId);
  L.push(" incident   " + m.idShort);
  L.push(" at         " + m.at);
  if (m.cause) {
    L.push(" cause      " + JSON.stringify(m.cause.message));
    if (m.cause.source) L.push("            from: " + m.cause.source);
  } else if (m.contextText) {
    L.push(" context    " + m.contextText);
  }
  L.push("");
  L.push(" " + m.stats.recordCount + " records · span " + m.stats.spanText +
    " · median gap " + m.stats.medianText);
  L.push(" wraps " + m.stats.wraps + " · truncated " + m.stats.truncated +
    " · dropped while paused " + m.stats.dropped);
  L.push("─".repeat(W));
  if (m.rows.length === 0) {
    L.push(" (recording was empty)");
  } else {
    L.push("SEQ".padStart(5) + " " + "+TIME".padStart(8) + " " + "GAP".padStart(7) +
      "   " + "SOURCE".padEnd(SOURCE_COL) + " " + "PAYLOAD");
    L.push("─".repeat(W));
    for (const row of m.rows) {
      if (row.kind === "record") {
        L.push(String(row.seq).padStart(5) + " " + row.rel.padStart(8) + " " +
          row.gap.padStart(7) + (row.anom ? " ⚠" : "  ") + " " +
          row.src.padEnd(SOURCE_COL) + " " + row.preview);
      } else if (row.kind === "mark") {
        const line = "─── " + row.label + " · " + row.text + " ";
        L.push(line + "─".repeat(Math.max(0, W - line.length)));
      } else if (row.kind === "restart") {
        const line = "─── RESTART ";
        L.push(line + "─".repeat(Math.max(0, W - line.length)));
      }
    }
  }
  L.push("─".repeat(W));
  L.push(" ⚠ gap ≥ " + ANOMALY_FACTOR + "× median · times relative to first record");
  return L.join("\n");
}

function textSnapshot(m) {
  const W = 46;
  const L = [];
  L.push("─".repeat(W));
  L.push(" FLIGHT RECORDER STATUS · " + m.storeId);
  L.push("─".repeat(W));
  L.push(" state      " + m.state.padEnd(18) + " restored: " + (m.restored ? "yes" : "no"));
  L.push(" recording  " + m.recording);
  L.push(" counters   " + m.counters);
  L.push(" config     " + m.configLine);
  if (m.tapLine) L.push(" tap        " + m.tapLine);
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// markdown renderer
// ---------------------------------------------------------------------------
function mdIncident(m, previewChars) {
  const L = [];
  L.push("## Flight Recorder Incident · " + m.trigger.toUpperCase());
  L.push("");
  L.push("**store** `" + m.storeId + "` · **incident** `" + m.idShort + "` · **at** " + m.at);
  L.push("");
  if (m.cause) {
    L.push("> **cause** " + m.cause.message +
      (m.cause.source ? " — from " + m.cause.source : ""));
    L.push("");
  } else if (m.contextText) {
    L.push("> **context** `" + m.contextText + "`");
    L.push("");
  }
  L.push(m.stats.recordCount + " records · span " + m.stats.spanText +
    " · median gap " + m.stats.medianText + " · wraps " + m.stats.wraps +
    " · truncated " + m.stats.truncated + " · dropped while paused " + m.stats.dropped);
  L.push("");
  if (m.rows.length === 0) {
    L.push("*(recording was empty)*");
  } else {
    L.push("| seq | +time | gap | source | payload |");
    L.push("|---:|---:|---:|:--|:--|");
    for (const row of m.rows) {
      if (row.kind === "record") {
        L.push("| " + row.seq + " | " + row.rel + " | " +
          (row.anom ? "**" + row.gap + "** ⚠" : row.gap) + " | " +
          row.src + " | `" + row.preview.replace(/`/g, "'") + "` |");
      } else if (row.kind === "mark") {
        L.push("| | | | **── " + row.label + " ──** | `" + row.text.replace(/`/g, "'") + "` |");
      } else if (row.kind === "restart") {
        L.push("| | | | **── RESTART ──** | |");
      }
    }
  }
  L.push("");
  L.push("*⚠ gap ≥ " + ANOMALY_FACTOR + "× median · times relative to first record*");
  return L.join("\n");
}

function mdSnapshot(m) {
  const L = [];
  L.push("## Flight Recorder Status · " + m.storeId);
  L.push("");
  L.push("- **state**: " + m.state + " (restored: " + (m.restored ? "yes" : "no") + ")");
  L.push("- **recording**: " + m.recording);
  L.push("- **counters**: " + m.counters);
  L.push("- **config**: " + m.configLine);
  if (m.tapLine) L.push("- **tap**: " + m.tapLine);
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// html renderer (single self-contained file, inline CSS only, no CDN)
// ---------------------------------------------------------------------------
const HTML_CSS = [
  "body{font-family:Segoe UI,Helvetica,Arial,sans-serif;margin:24px;color:#222;background:#fafafa}",
  ".accent{border-left:6px solid #F0954F;padding-left:14px}",
  "h1{font-size:20px;margin:0 0 2px 0}",
  ".meta{color:#666;font-size:13px;margin-bottom:12px}",
  ".cause{background:#fdeeee;border:1px solid #e8b4b4;padding:8px 12px;border-radius:4px;margin:10px 0;font-size:14px}",
  ".ctx{background:#f3f3f3;border:1px solid #ddd;padding:8px 12px;border-radius:4px;margin:10px 0;font-size:13px;font-family:monospace}",
  ".stats{font-size:13px;color:#444;margin:10px 0}",
  "table{border-collapse:collapse;font-family:Consolas,Menlo,monospace;font-size:12px;background:#fff}",
  "th,td{border:1px solid #e0e0e0;padding:3px 8px;text-align:left;white-space:pre}",
  "th{background:#f0e6da}",
  "td.num{text-align:right}",
  "tr.anom td{background:#fdf3e7}",
  "tr.mark td{background:#eef3f8;font-weight:bold}",
  "tr.restart td{background:#e8e8e8;font-weight:bold;text-align:center}",
  ".foot{color:#888;font-size:12px;margin-top:10px}"
].join("");

function htmlDoc(title, body) {
  return "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<title>" +
    escapeHtml(title) + "</title>\n<style>" + HTML_CSS + "</style>\n</head>\n<body>\n" +
    body + "\n</body>\n</html>\n";
}

function htmlIncident(m) {
  const B = [];
  B.push("<div class=\"accent\">");
  B.push("<h1>Flight Recorder Incident · " + escapeHtml(m.trigger.toUpperCase()) + "</h1>");
  B.push("<div class=\"meta\">store <b>" + escapeHtml(m.storeId) + "</b> · incident <b>" +
    escapeHtml(m.idShort) + "</b> · " + escapeHtml(m.at) + "</div>");
  B.push("</div>");
  if (m.cause) {
    B.push("<div class=\"cause\"><b>cause:</b> " + escapeHtml(m.cause.message) +
      (m.cause.source ? "<br><b>from:</b> " + escapeHtml(m.cause.source) : "") + "</div>");
  } else if (m.contextText) {
    B.push("<div class=\"ctx\">" + escapeHtml(m.contextText) + "</div>");
  }
  B.push("<div class=\"stats\">" + m.stats.recordCount + " records · span " +
    escapeHtml(m.stats.spanText) + " · median gap " + escapeHtml(m.stats.medianText) +
    " · wraps " + m.stats.wraps + " · truncated " + m.stats.truncated +
    " · dropped while paused " + m.stats.dropped + "</div>");
  if (m.rows.length === 0) {
    B.push("<p><i>(recording was empty)</i></p>");
  } else {
    B.push("<table><tr><th>seq</th><th>+time</th><th>gap</th><th>source</th><th>payload</th></tr>");
    for (const row of m.rows) {
      if (row.kind === "record") {
        B.push("<tr" + (row.anom ? " class=\"anom\"" : "") + "><td class=\"num\">" + row.seq +
          "</td><td class=\"num\">" + escapeHtml(row.rel) + "</td><td class=\"num\">" +
          escapeHtml(row.gap) + (row.anom ? " ⚠" : "") + "</td><td>" + escapeHtml(row.src) +
          "</td><td>" + escapeHtml(row.preview) + "</td></tr>");
      } else if (row.kind === "mark") {
        B.push("<tr class=\"mark\"><td colspan=\"5\">── " + escapeHtml(row.label) + " · " +
          escapeHtml(row.text) + " ──</td></tr>");
      } else if (row.kind === "restart") {
        B.push("<tr class=\"restart\"><td colspan=\"5\">── RESTART ──</td></tr>");
      }
    }
    B.push("</table>");
  }
  B.push("<div class=\"foot\">⚠ gap ≥ " + ANOMALY_FACTOR +
    "× median · times relative to first record</div>");
  return htmlDoc("Incident " + m.idShort + " · " + m.storeId, B.join("\n"));
}

function htmlSnapshot(m) {
  const B = [];
  B.push("<div class=\"accent\"><h1>Flight Recorder Status</h1>");
  B.push("<div class=\"meta\">store <b>" + escapeHtml(m.storeId) + "</b></div></div>");
  B.push("<div class=\"stats\">state <b>" + escapeHtml(m.state) + "</b> · restored " +
    (m.restored ? "yes" : "no") + "<br>" + escapeHtml(m.recording) + "<br>" +
    escapeHtml(m.counters) + "<br>" + escapeHtml(m.configLine) +
    (m.tapLine ? "<br>tap: " + escapeHtml(m.tapLine) : "") + "</div>");
  return htmlDoc("Status · " + m.storeId, B.join("\n"));
}

// ---------------------------------------------------------------------------
// event one-liner (identical across formats: events are message-only)
// ---------------------------------------------------------------------------
function eventLine(msg) {
  return "[recorder event] " + msg.recorderEvent +
    " · " + compactJson(msg.payload, 120) +
    (msg.storeId ? " · store " + msg.storeId : "");
}

const UNKNOWN_LINE =
  "flight-recorder-report: not a recorder payload (original preserved under msg.report.source)";

// ---------------------------------------------------------------------------
// public surface
// ---------------------------------------------------------------------------
function render(msg, opts) {
  const o = opts || {};
  const format = o.format === "markdown" || o.format === "html" ? o.format : "text";
  const previewChars = Number.isFinite(o.previewChars) && o.previewChars > 0
    ? Math.floor(o.previewChars) : 60;

  const kind = detect(msg);
  if (kind === "incident") {
    const m = buildIncidentModel(msg.payload, previewChars);
    const output = format === "html" ? htmlIncident(m)
      : format === "markdown" ? mdIncident(m, previewChars)
      : textIncident(m, previewChars);
    return { kind, output, model: m };
  }
  if (kind === "snapshot") {
    const m = buildSnapshotModel(msg.payload);
    const output = format === "html" ? htmlSnapshot(m)
      : format === "markdown" ? mdSnapshot(m)
      : textSnapshot(m);
    return { kind, output, model: m };
  }
  if (kind === "event") return { kind, output: eventLine(msg) };
  return { kind, output: UNKNOWN_LINE };
}

module.exports = {
  render, detect,
  _internal: {
    buildIncidentModel, buildSnapshotModel, humanize, gapText, median,
    fmtDateParts, sourceLabel, recordPreview, ANOMALY_FACTOR, UNKNOWN_LINE
  }
};
