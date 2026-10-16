// Runs the canvas server without the Copilot SDK so the UI can be developed in a normal browser.
//   node dev.mjs            -> prints the panel URL
//   POST http://127.0.0.1:<control>/focus {"by":"model","name":"..."} simulates the agent's focus action.

import { createServer } from "node:http";
import { startServer, refresh } from "./server.mjs";

const entry = await startServer({ onAsk: async (prompt) => console.log(`[ask] ${prompt}`) });
refresh().catch((e) => console.error("[build]", e.message));

const control = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    entry.push("focus", JSON.parse(b || "{}"));
    res.end("ok");
  });
});
control.listen(Number(process.env.CONTROL_PORT || 0), "127.0.0.1", () => {
  console.log(`panel   ${entry.url}`);
  console.log(`control http://127.0.0.1:${control.address().port}/focus`);
});
