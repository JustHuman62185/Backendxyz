import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { Express } from "express";
import { randomUUID } from "node:crypto";
import { bridge, activeDevices } from "./bridge";
import { tools } from "./tools";

export function setupMcpServer(app: Express) {

  // Tell Claude: no auth needed
  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    res.status(404).end();
  });

  // Session store: sessionId → transport
  const transports = new Map<string, StreamableHTTPServerTransport>();

  function createMcpServer() {
    const server = new Server(
      { name: "vision-mcp-bridge", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === "device.list") {
        const devices = bridge.getConnectedDevices();
        return {
          content: [{ type: "text", text: JSON.stringify(devices, null, 2) }],
          isError: false,
        };
      }

      const deviceId = activeDevices.size > 0
        ? activeDevices.keys().next().value
        : null;

      if (!deviceId) {
        throw new Error("No devices currently connected.");
      }

      try {
        if (name === "phone.screenshot") {
          const result = await bridge.executeOnDevice(deviceId, name, args);
          return {
            content: [{
              type: "image",
              data: result,
              mimeType: "image/jpeg",
            }],
            isError: false,
          };
        }

        const result = await bridge.executeOnDevice(deviceId, name, args);
        return {
          content: [{
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result),
          }],
          isError: false,
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        };
      }
    });

    return server;
  }

  // POST /mcp — handles initialize AND tool calls
  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      // Existing session — reuse transport
      transport = transports.get(sessionId)!;
    } else {
      // New session — create fresh transport + server
      const newSessionId = randomUUID();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
      });

      transports.set(newSessionId, transport);

      transport.onclose = () => {
        transports.delete(newSessionId);
      };

      const server = createMcpServer();
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  // GET /mcp — SSE stream for server-to-client notifications
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports.get(sessionId);

    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    await transport.handleRequest(req, res);
  });

  // DELETE /mcp — session cleanup
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports.get(sessionId);

    if (transport) {
      await transport.close();
      transports.delete(sessionId);
    }

    res.status(200).end();
  });

  console.log("MCP Streamable HTTP endpoints ready at /mcp");
}
