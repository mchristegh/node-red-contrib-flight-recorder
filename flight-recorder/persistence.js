// lib/persistence.js
//
// File persistence adapter for node-red-contrib-flight-recorder.
//
// Layout:   <userDir>/flight-recorder/<storeId>.json
// Strategy: synchronous, atomic (write temp file in the same directory,
//           then rename over the target). A crash mid-write can corrupt
//           only the temp file, never an existing recording.
//
// Contract with recorder-core:
//   read(storeId)         -> parsed state object, or null if no file.
//                            THROWS on unreadable/corrupt files — the core
//                            catches, warns and starts fresh.
//   write(storeId, state) -> undefined (throws on failure; core catches).
//   remove(storeId)       -> undefined; idempotent.
//
// Zero Node-RED imports; the caller supplies userDir (RED.settings.userDir).

"use strict";

const fs = require("fs");
const path = require("path");

const SUBDIR = "flight-recorder";

// Never trust a storeId as a filename. Node-RED ids are hex-and-dots, but
// sanitize defensively: allow [A-Za-z0-9._-], replace everything else,
// forbid traversal, cap length.
function sanitizeStoreId(storeId) {
  if (typeof storeId !== "string" || storeId.length === 0) {
    throw new Error("persistence: storeId must be a non-empty string");
  }
  let safe = storeId.replace(/[^A-Za-z0-9._-]/g, "_");
  // no purely-dot names, no leading dots (hidden files / traversal)
  safe = safe.replace(/^\.+/, "_");
  if (safe.length === 0) safe = "_";
  if (safe.length > 128) safe = safe.slice(0, 128);
  return safe;
}

function createFilePersistence(userDir) {
  if (typeof userDir !== "string" || userDir.length === 0) {
    throw new Error("persistence: userDir must be a non-empty string");
  }
  const dir = path.join(userDir, SUBDIR);

  function fileFor(storeId) {
    return path.join(dir, sanitizeStoreId(storeId) + ".json");
  }

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  return {
    read(storeId) {
      const file = fileFor(storeId);
      let raw;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch (e) {
        if (e.code === "ENOENT") return null; // no recording yet: normal
        throw e;                              // real I/O problem: surface it
      }
      return JSON.parse(raw);                 // corrupt JSON throws: surface it
    },

    write(storeId, state) {
      ensureDir();
      const file = fileFor(storeId);
      const tmp = file + ".tmp-" + process.pid + "-" +
        Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const json = JSON.stringify(state);
      try {
        fs.writeFileSync(tmp, json, "utf8");
        fs.renameSync(tmp, file);             // atomic on same filesystem
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* best effort */ }
        throw e;
      }
    },

    remove(storeId) {
      try {
        fs.unlinkSync(fileFor(storeId));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;     // missing file: already done
      }
    }
  };
}

module.exports = { createFilePersistence, sanitizeStoreId, SUBDIR };
