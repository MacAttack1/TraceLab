// Minimal stand-in for the Messages API streaming endpoint, to exercise the tool loop.
import http from "node:http";
import fs from "node:fs";
const LOG = process.argv[2] || "/tmp/mock.log";
let n = 0;
const sse = (res, events) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end(); };
const toolUse = (id, name, input) => [
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name, input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input).slice(0, 5) } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input).slice(5) } },
  { type: "content_block_stop", index: 1 },
];
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    n++; const j = JSON.parse(body);
    const last = j.messages[j.messages.length - 1];
    const summary = { n, key: req.headers["x-api-key"], ver: req.headers["anthropic-version"], model: j.model, tools: j.tools.map((t) => t.name), nmsg: j.messages.length,
      lastRole: last.role, lastTypes: last.content.map((c) => c.type + (Array.isArray(c.content) ? "[" + c.content.map((x) => x.type).join(",") + "]" : "")),
      toolText: last.content.filter((c) => c.type === "tool_result").map((c) => (typeof c.content === "string" ? c.content : c.content.filter((x) => x.type === "text").map((x) => x.text).join(" ")).slice(0, 400)) };
    fs.appendFileSync(LOG, JSON.stringify(summary) + "\n");
    const start = [{ type: "message_start", message: { id: "m" + n, role: "assistant", content: [] } }];
    if (n === 1) sse(res, [...start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check the rail and its schematic page." } }, { type: "content_block_stop", index: 0 },
      ...toolUse("tu_1", "get_net", { name: "PP3V3_S5" }), { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" }]);
    else if (n === 2) sse(res, [...start, ...toolUse("tu_2", "view_schematic", { near: "PP3V3_S5" }).map((e) => ({ ...e, index: 0 })), ...toolUse("tu_3", "board_overview", {}), { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" }]);
    else sse(res, [...start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "## PP3V3_S5\n\nIt is made by **U1** through L1. Check:\n\n1. Resistance of PP3V3_S5 to ground at C4.\n2. Then lift R5 to split off PP3V3_EC.\n\n| Net | Pins |\n|---|---|\n| PP3V3_EC | 12 |" } },
      { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }]);
  });
}).listen(+process.argv[3] || 18999, "127.0.0.1", () => console.log("mock up"));
