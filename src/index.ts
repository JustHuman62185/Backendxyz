import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
import { createServer as createViteServer } from 'vite';

import { setupWsServer } from './wsServer';
import { setupMcpServer } from './mcpServer';
import { bridge } from './bridge';
import { analytics } from './analytics';

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  // Enable CORS for all origins (required for Claude Web MCP client)
  app.use(cors());

  // We need to parse JSON body for the /mcp/messages POST requests
  app.use(express.json());

  // Setup MCP HTTP routes
  setupMcpServer(app);

  // Simple API to list connected devices
  app.get("/api/devices", (req, res) => {
    res.json({ devices: bridge.getConnectedDevices() });
  });

  // Debug API to view raw tools schema
  app.get("/api/tools", async (req, res) => {
    const { tools } = await import('./tools');
    res.json({ tools });
  });

  // Analytics REST API
  app.get("/api/analytics", (req, res) => {
    res.json(analytics.getSummary());
  });

  // Vite middleware for development (client UI)
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = createServer(app);

  // Setup WebSocket Server
  setupWsServer(server);

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`VISION Bridge Server running on port ${PORT}`);
  });
}

startServer();
