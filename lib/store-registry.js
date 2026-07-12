// lib/store-registry.js
//
// Module-level registry mapping a capture node's id to its command handle.
// The flight-recorder-control node resolves its target through this map.
//
// A handle is { store, runCommand(command, arg) } — control nodes go through
// runCommand (so results route to the *capture* node's outputs), never the
// raw store. In v2 the flight-recorder-store config node registers here too,
// which is why this lives in lib/ rather than inside a node file.

"use strict";

const handles = new Map();

module.exports = {
  register(id, handle) {
    handles.set(id, handle);
  },
  deregister(id) {
    handles.delete(id);
  },
  get(id) {
    return handles.get(id) || null;
  },
  // test/introspection convenience
  size() {
    return handles.size;
  }
};
