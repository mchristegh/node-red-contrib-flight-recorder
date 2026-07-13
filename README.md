# node-red-contrib-flight-recorder

A flight recorder for Node-RED flows. The debug sidebar shows you the present; this shows you the moments *leading up to* a failure — a rolling recording of recent messages, dumped as a structured **incident** on demand, automatically when a node in scope reports an error, or when a message matches a watermark condition. With persistence enabled, the recording survives crashes and restarts, which is the part that truly earns the name.

Like real flight recorders, the nodes are orange.

## The nodes

**recorder** (`flight-recorder`) — an inline recorder you drop onto a wire. Every message is captured onto the tape and forwarded untouched. Passthrough is sacred: the original message object, unmodified, always — no recording problem can ever block or alter traffic, and pausing the recorder stops the tape, never the flow. Its input carries traffic only; commands arrive exclusively through a control node.

**recorder tap** (`flight-recorder-tap`) — an ambient recorder that observes messages flowing through *other* nodes via the Node-RED messaging hooks, without touching their wires. Point its scope at flows, node ids, or node types (minus exclusions) and it records everything in scope. Drop one on a dedicated debug tab and you have a black box for the whole runtime. Supports automatic incident dumps when an in-scope node reports an error, and per-channel muting while the tape keeps rolling. Flight-recorder nodes themselves are always excluded from every scope — recorders never record recorders.

**recorder control** (`flight-recorder-control`) — the cockpit panel. An input-only node targeting one recorder; wire inject buttons into it to issue commands. Every command emits a receipt on its ack output, and results (incidents, query snapshots) appear on the *target recorder's* outputs, which stay the single source of truth for wiring.

## Quick start

Install into your Node-RED user directory (typically `~/.node-red`):

```
cd ~/.node-red
npm install node-red-contrib-flight-recorder
```

Restart Node-RED, then use **Import → Examples → node-red-contrib-flight-recorder** to load the demo flow: a simulated sensor that occasionally errors, an inline recorder with a watermark, a tap with auto-error dumps, and control panels for both. An incident will fire within seconds of deploying.

## Commands

Sent as `msg.payload` (string, case-insensitive) to a control node, or directly to a tap's input:

`dump` emits the recording as a manual incident (`msg.context` is attached as incident context). `clear` empties the recording (sequence numbers are preserved — they are monotonic forever, across wraps, clears, and restarts). `pause` / `resume` stop and restart the tape; messages arriving while paused are counted, never silently lost. `mark` lays an annotation (`msg.annotation`) onto the tape in sequence position. `query` emits a status snapshot on the recorder's query output. `mute` / `unmute` (tap only) silence one channel — `msg.target` is `{ "node": "<id>" }`, `{ "type": "mqtt in" }`, or `{ "flow": "<tab id>" }` — while everything else keeps recording; suppressed messages are counted, mute and unmute lay marks on the tape, and a muted source's *errors* still trigger auto-dump.

Manual dumps always fire. The configurable cooldown rate-limits only *automatic* incidents (error and watermark triggers), and every suppressed auto-dump is visible as an `incidentSuppressed` event — nothing is invisible.

## Incidents and records

An incident carries its trigger (`manual`, `error`, or `watermark`), an encoded context, summary stats, and the records. Each record has a monotonic `seq`, `capturedAt`, `deltaMs` since the previous capture (restarts show up honestly as delta gaps), the `source` node (id, name, type, output port), redaction and truncation flags, and the encoded message. Oversized messages fall back to a summary form flagged `truncated: true`. Redaction paths are masked *before* anything is stored or previewed, so a secret can never leak into a truncated preview. Records recovered from disk after a restart carry `restored: true`.

## Persistence

When enabled, recordings are written (debounced for captures, immediately for state changes) to `<userDir>/flight-recorder/<nodeId>.json` using atomic temp-file-and-rename writes — a crash mid-write can never corrupt an existing recording. Redeploys preserve the file; deleting the node removes it. Persistence failures are surfaced as events and never stop recording.

## What the tap can and cannot see

Hooks observe messages *between* nodes: each record is a message a node sent. The tap cannot see inside a function node's logic, nor messages a node swallows without sending. Automatic error dumps rely on nodes reporting errors properly (`node.error(err, msg)`); a hard runtime crash fires no hook — that is precisely what persistence is for.

## Tests

The package ships with its full harness suite (no framework, no Node-RED runtime required):

```
npm test
```

## License

Apache-2.0