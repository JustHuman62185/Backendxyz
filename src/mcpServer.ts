import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Express, NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { bridge } from "./bridge";
import { db, VisionUser } from "./db";
import { getBaseUrl, setupOAuthServer } from "./oauthServer";
import { tools } from "./tools";

export function setupMcpServer(app: Express) {
  // 1. Mount OAuth 2.1 + Google OpenID Connect (sub) endpoints
  setupOAuthServer(app);

  // Session store: sessionId -> transport & authenticated VISION user
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionUsers = new Map<string, VisionUser>();

  /**
   * Middleware that enforces MCP OAuth 2.1 Bearer authentication and resolves:
   * OAuth token -> VISION user -> user_id -> SELECT devices WHERE user_id = ?
   */
  const requireMcpOAuth = (req: Request, res: Response, next: NextFunction) => {
    const baseUrl = getBaseUrl(req);
    const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource/mcp`;

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer error="invalid_token", error_description="Missing Authorization Bearer token", resource_metadata="${resourceMetadataUrl}"`
      );
      res.status(401).json({
        error: "invalid_token",
        error_description: "Unauthorized: Please connect via VISION Google OAuth.",
      });
      return;
    }

    const token = authHeader.slice(7).trim();
    const verified = db.verifyAccessToken(token);

    if (!verified) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer error="invalid_token", error_description="Invalid or expired access token", resource_metadata="${resourceMetadataUrl}"`
      );
      res.status(401).json({
        error: "invalid_token",
        error_description: "Invalid or expired VISION OAuth access token.",
      });
      return;
    }

    (req as any).auth = {
      token,
      clientId: verified.clientId,
      scopes: verified.scope.split(" "),
      expiresAt: verified.expiresAt,
      extra: {
        user: verified.user,
        userId: verified.user.id,
        googleSubjectId: verified.user.google_subject_id,
        email: verified.user.email,
      },
    };

    next();
  };

  function createMcpServer(defaultUser: VisionUser) {
    const server = new Server(
      { name: "vision-mcp-bridge", version: "2.0.0" },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;

      // Resolve the authenticated VISION user from OAuth token / session:
      // OAuth token -> VISION user -> user_id -> SELECT devices WHERE user_id = ?
      const authUser =
        (extra?.authInfo?.extra?.user as VisionUser | undefined) ||
        (extra?.sessionId ? sessionUsers.get(extra.sessionId) : undefined) ||
        defaultUser;

      // Always refresh user record from DB by permanent google_subject_id
      const currentUser =
        db.getUserByGoogleSub(authUser.google_subject_id) ||
        db.getUserById(authUser.id) ||
        authUser;

      if (name === "device.list") {
        const userDevices = bridge.getDevicesForUser(currentUser.id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  account: {
                    userId: currentUser.id,
                    googleSubjectId: currentUser.google_subject_id,
                    email: currentUser.email,
                  },
                  devices: userDevices,
                },
                null,
                2
              ),
            },
          ],
          isError: false,
        };
      }

      try {
        const requestedDeviceId =
          args && typeof (args as any).deviceId === "string"
            ? ((args as any).deviceId as string)
            : undefined;

        const targetDevice = bridge.resolveTargetDeviceForUser(
          currentUser.id,
          requestedDeviceId
        );

        if (name === "phone.screenshot") {
          const result = await bridge.executeOnDevice(targetDevice.deviceId, name, args);
          return {
            content: [
              {
                type: "image",
                data: result,
                mimeType: "image/jpeg",
              },
            ],
            isError: false,
          };
        }

        const result = await bridge.executeOnDevice(targetDevice.deviceId, name, args);
        return {
          content: [
            {
              type: "text",
              text: typeof result === "string" ? result : JSON.stringify(result),
            },
          ],
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

  async function getOrCreateTransport(
    sessionId: string | undefined,
    authUser: VisionUser,
    isInitRequest: boolean
  ): Promise<StreamableHTTPServerTransport> {
    if (sessionId && transports.has(sessionId)) {
      sessionUsers.set(sessionId, authUser);
      return transports.get(sessionId)!;
    }

    const targetSessionId = sessionId && !isInitRequest ? sessionId : randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => targetSessionId,
    });

    // If a client sends an existing mcp-session-id after a Render server restart,
    // mark the transport initialized with that sessionId so the call succeeds seamlessly.
    if (sessionId && !isInitRequest) {
      const inner = (transport as any)._webStandardTransport;
      if (inner) {
        inner.sessionId = targetSessionId;
        inner._initialized = true;
      }
    }

    transports.set(targetSessionId, transport);
    sessionUsers.set(targetSessionId, authUser);

    transport.onclose = () => {
      transports.delete(targetSessionId);
      sessionUsers.delete(targetSessionId);
    };

    const server = createMcpServer(authUser);
    await server.connect(transport);
    return transport;
  }

  // POST /mcp — handles initialize AND tool calls (Protected by OAuth 2.1)
  app.post("/mcp", requireMcpOAuth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const authUser = (req as any).auth.extra.user as VisionUser;

    const isInitRequest = Boolean(
      req.body &&
        (Array.isArray(req.body)
          ? req.body.some((m: any) => m?.method === "initialize")
          : req.body.method === "initialize")
    );

    const transport = await getOrCreateTransport(sessionId, authUser, isInitRequest);
    await transport.handleRequest(req as any, res, req.body);
  });

  // GET /mcp — SSE stream for server-to-client notifications (Protected by OAuth 2.1)
  app.get("/mcp", requireMcpOAuth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const authUser = (req as any).auth.extra.user as VisionUser;

    if (!sessionId) {
      res.status(400).json({ error: "Mcp-Session-Id header is required" });
      return;
    }

    const transport = await getOrCreateTransport(sessionId, authUser, false);
    await transport.handleRequest(req as any, res);
  });

  // DELETE /mcp — session cleanup (Protected by OAuth 2.1)
  app.delete("/mcp", requireMcpOAuth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports.get(sessionId);

    if (transport) {
      await transport.close();
      transports.delete(sessionId);
      sessionUsers.delete(sessionId);
    }

    res.status(200).end();
  });

  console.log("MCP Streamable HTTP + OAuth 2.1 endpoints ready at /mcp");
}
