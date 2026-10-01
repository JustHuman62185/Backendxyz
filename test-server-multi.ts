import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from 'express';
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json());

const server = new Server({ name: "test", version: "1" }, { capabilities: {} });
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID()
});
server.connect(transport).then(() => console.log('Connected transport'));

app.post("/mcp", async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});
app.get("/mcp", async (req, res) => {
  await transport.handleRequest(req, res);
});

app.listen(3002, () => console.log('Listening 3002'));
