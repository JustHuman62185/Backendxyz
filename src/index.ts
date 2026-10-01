import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';

import { setupWsServer } from './wsServer';
import { setupMcpServer } from './mcpServer';
import { bridge } from './bridge';
import { analytics } from './analytics';
import { db } from './db';
import { tools } from './tools';

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  // Enable CORS for all origins and expose MCP + OAuth headers for web clients (e.g., Claude Web)
  app.use(
    cors({
      origin: '*',
      exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'mcp-session-id'],
    })
  );

  // Parse JSON body for MCP & API requests
  app.use(express.json({ limit: '10mb' }));

  // Setup MCP Streamable HTTP + OAuth 2.1 routes
  setupMcpServer(app);

  // API to list connected devices and VISION identity accounts
  app.get('/api/devices', (req, res) => {
    const users = db.getAllUsers();
    const accounts = users.map((u) => ({
      ...u,
      activeTokens: db.getActiveTokenCountForUser(u.id),
      devices: bridge.getDevicesForUser(u.id),
    }));

    res.json({
      devices: bridge.getConnectedDevices(),
      allDevices: bridge.getAllRegisteredDevices(),
      accounts,
    });
  });

  // API to inspect VISION Identity Hierarchy (users -> devices)
  app.get('/api/accounts', (req, res) => {
    const users = db.getAllUsers();
    const accounts = users.map((u) => ({
      ...u,
      activeTokens: db.getActiveTokenCountForUser(u.id),
      devices: bridge.getDevicesForUser(u.id),
    }));
    res.json({ accounts });
  });

  // Debug API to view raw tools schema
  app.get('/api/tools', (req, res) => {
    res.json({ tools });
  });

  // Analytics REST API
  app.get('/api/analytics', (req, res) => {
    res.json(analytics.getSummary());
  });

  // Vite middleware for development (client UI)
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
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

  server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`VISION Bridge Server running on port ${PORT}`);
  });
}

startServer();
