// nodes/flight-recorder-control.js
//
// The cockpit panel: an input-only command node targeting a flight-recorder
// (inline or tap) selected in its config. Its entire input is commands by
// definition — payload-addressed, case-insensitive, zero ambiguity.
//
//   commands: dump | clear | pause | resume | mark | query
//   msg.context    -> carried into dump() as incident context
//   msg.annotation -> carried into mark() as the annotation
//
// One optional ack output reports every command's result (ok / error), so
// command senders can confirm actions without polling — nothing invisible.
//
// Results themselves (incidents, query snapshots, event acks) route to the
// TARGET recorder's outputs via its runCommand handle; the control node's
// ack is a receipt, not a duplicate delivery channel.
//
// Target resolution happens per command, not at construction: deploy order
// between this node and its target is not guaranteed, and the registry is
// the source of truth for what is currently live.

"use strict";

const path = require("path");
const registry = require(
  path.join(__dirname, "..", "lib", "store-registry.js"),
);

const COMMANDS = [
  "dump",
  "clear",
  "pause",
  "resume",
  "mark",
  "query",
  "mute",
  "unmute",
];

module.exports = function (RED) {
  function FlightRecorderControlNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.name = n.name;
    const targetId = typeof n.target === "string" ? n.target : "";

    function ack(msg, ok, command, result, reason) {
      const out = {
        topic: node.name || "flight-recorder-control",
        payload: {
          ok: ok,
          command: command || null,
          targetId: targetId || null,
          result: ok ? result : null,
          reason: ok ? null : reason,
        },
      };
      // preserve correlation with the triggering msg where present
      if (msg && msg._msgid !== undefined) out.inReplyTo = msg._msgid;
      node.send(out);
    }

    function fail(msg, command, reason) {
      node.warn("flight-recorder-control: " + reason);
      node.status({ fill: "red", shape: "ring", text: reason });
      ack(msg, false, command, null, reason);
    }

    node.status({});

    node.on("input", function (msg) {
      if (!msg || typeof msg.payload !== "string") {
        fail(msg, null, "command must be a string payload");
        return;
      }
      const command = msg.payload.trim().toLowerCase();
      if (COMMANDS.indexOf(command) === -1) {
        fail(msg, command, "unknown command '" + command + "'");
        return;
      }

      if (!targetId) {
        fail(msg, command, "no target recorder configured");
        return;
      }
      const handle = registry.get(targetId);
      if (!handle) {
        fail(msg, command, "target recorder not deployed");
        return;
      }

      let arg;
      if (command === "dump") arg = msg.context;
      else if (command === "mark") arg = msg.annotation;
      else if (command === "mute" || command === "unmute") arg = msg.target;

      let result;
      try {
        result = handle.runCommand(command, arg);
      } catch (e) {
        fail(msg, command, "command failed: " + (e && e.message));
        return;
      }

      node.status({ fill: "green", shape: "dot", text: command + " ✓" });
      ack(msg, true, command, result);
    });

    node.on("close", function (removed, done) {
      if (typeof removed === "function") {
        done = removed;
      }
      if (done) done();
    });
  }

  RED.nodes.registerType("flight-recorder-control", FlightRecorderControlNode);
};
