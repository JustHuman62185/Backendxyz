import crypto from 'node:crypto';
import express, { Express, Request, Response } from 'express';
import { db, deriveVisionUserId, VisionUser } from './db';

/**
 * Resolves the public origin URL for OAuth metadata and callbacks,
 * respecting Cloud Run / Render / reverse proxy headers (`x-forwarded-proto`, `x-forwarded-host`).
 */
export function getBaseUrl(req: Request): string {
  const forwardedHost = req.headers['x-forwarded-host'] as string | undefined;
  const host =
    (forwardedHost ? forwardedHost.split(',')[0].trim() : req.get('host')) || 'localhost:3000';
  const forwardedProto = req.headers['x-forwarded-proto'] as string | undefined;

  let proto = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol || 'http';
  if (host.endsWith('.run.app') || host.endsWith('.onrender.com')) {
    proto = 'https';
  }

  return `${proto}://${host}`;
}

/**
 * Verifies PKCE code_verifier against code_challenge (RFC 7636).
 */
export function verifyPkceChallenge(
  codeVerifier: string,
  codeChallenge: string,
  method: string = 'S256'
): boolean {
  if (method.toUpperCase() === 'PLAIN') {
    return codeVerifier === codeChallenge;
  }
  const hash = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return hash === codeChallenge;
}

/**
 * Cryptographically verifies a Google OpenID Connect ID Token (`id_token`) using Google's
 * official tokeninfo endpoint and extracts the permanent `sub` (Google Subject ID) and `email`.
 */
export async function verifyGoogleIdToken(
  idToken: string
): Promise<{ sub: string; email?: string }> {
  const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken.trim())}`;
  const response = await fetch(url);
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google ID token verification failed: ${errText}`);
  }
  const payload = (await response.json()) as {
    sub?: string;
    email?: string;
    aud?: string;
  };
  if (!payload.sub) {
    throw new Error('Google ID token did not contain a valid "sub" identifier.');
  }

  // If GOOGLE_CLIENT_ID is configured, verify audience matches
  if (process.env.GOOGLE_CLIENT_ID && payload.aud && payload.aud !== process.env.GOOGLE_CLIENT_ID) {
    throw new Error('Google ID token audience (aud) mismatch.');
  }

  return { sub: payload.sub, email: payload.email };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function setupOAuthServer(app: Express) {
  app.use(express.urlencoded({ extended: false }));

  // ============================================================================
  // 1. OAUTH 2.0 PROTECTED RESOURCE METADATA (RFC 9728)
  // ============================================================================
  const protectedResourceHandler = (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req);
    res.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      scopes_supported: ['openid', 'profile', 'email', 'vision:devices'],
      bearer_methods_supported: ['header'],
      resource_name: 'VISION Bridge MCP Server',
    });
  };

  app.get('/.well-known/oauth-protected-resource', protectedResourceHandler);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceHandler);

  // ============================================================================
  // 2. OAUTH 2.0 AUTHORIZATION SERVER METADATA (RFC 8414 / OIDC Discovery)
  // ============================================================================
  const authServerMetadataHandler = (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req);
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      revocation_endpoint: `${baseUrl}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      code_challenge_methods_supported: ['S256', 'plain'],
      scopes_supported: ['openid', 'profile', 'email', 'vision:devices'],
    });
  };

  app.get('/.well-known/oauth-authorization-server', authServerMetadataHandler);
  app.get('/.well-known/openid-configuration', authServerMetadataHandler);

  // ============================================================================
  // 3. DYNAMIC CLIENT REGISTRATION (RFC 7591)
  // ============================================================================
  app.post('/register', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body || {};
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris
      : typeof body.redirect_uris === 'string'
      ? [body.redirect_uris]
      : [];

    if (redirectUris.length === 0) {
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris is required',
      });
      return;
    }

    const client = db.registerOAuthClient({
      client_name: body.client_name || 'Claude MCP Client',
      redirect_uris: redirectUris,
      grant_types: body.grant_types || ['authorization_code', 'refresh_token'],
      response_types: body.response_types || ['code'],
      token_endpoint_auth_method: body.token_endpoint_auth_method || 'none',
    });

    res.status(201).json(client);
  });

  // ============================================================================
  // 4. VISION OAUTH AUTHORIZATION ENDPOINT (GET & POST /authorize)
  // ============================================================================
  app.all('/authorize', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const paramsSource = req.method === 'POST' ? { ...req.query, ...req.body } : req.query;

    const clientId = (paramsSource.client_id as string) || 'claude-mcp-client';
    const redirectUri = (paramsSource.redirect_uri as string) || '';
    const codeChallenge = (paramsSource.code_challenge as string) || '';
    const codeChallengeMethod = (paramsSource.code_challenge_method as string) || 'S256';
    const state = paramsSource.state as string | undefined;
    const scope = (paramsSource.scope as string) || 'openid profile email vision:devices';
    const resource = paramsSource.resource as string | undefined;

    if (!redirectUri) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Missing required parameter: redirect_uri',
      });
      return;
    }

    let client = db.getOAuthClient(clientId);
    if (!client) {
      client = db.registerOAuthClient({
        client_id: clientId,
        client_name: 'Claude MCP Connector',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
      });
    } else if (!client.redirect_uris.includes(redirectUri)) {
      client.redirect_uris.push(redirectUri);
    }

    const pendingReq = db.createPendingAuthRequest({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      state,
      scope,
      resource,
    });

    const baseUrl = getBaseUrl(req);
    const callbackUrl = `${baseUrl}/oauth/google/callback`;
    const hasGoogleOAuthEnv = Boolean(
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    );

    const actionContentHtml = hasGoogleOAuthEnv
      ? `
      <a href="/oauth/google?auth_req_id=${encodeURIComponent(pendingReq.id)}"
         class="w-full flex items-center justify-center gap-3 bg-neutral-900 hover:bg-neutral-800 text-white font-medium py-3.5 px-4 rounded-xl shadow-xs transition">
        <svg class="w-5 h-5 bg-white rounded-full p-0.5" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        <span>Continue with Google</span>
      </a>
    `
      : `
      <div class="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs space-y-2">
        <div class="font-semibold">Google OAuth 2.0 Credentials Required</div>
        <p>
          To enable <strong>Continue with Google</strong>, set <code class="font-mono bg-amber-100 px-1 py-0.5 rounded">GOOGLE_CLIENT_ID</code> and <code class="font-mono bg-amber-100 px-1 py-0.5 rounded">GOOGLE_CLIENT_SECRET</code> in your server environment variables.
        </p>
        <div class="pt-1">
          <div class="text-[11px] font-medium text-amber-800 mb-1">Authorized Redirect URI for Google Cloud Console:</div>
          <code class="block font-mono text-[11px] bg-white border border-amber-200 p-2 rounded break-all select-all">${escapeHtml(callbackUrl)}</code>
        </div>
      </div>
    `;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>VISION OAuth — Continue with Google</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-neutral-100 text-neutral-900 flex items-center justify-center p-4 font-sans">
  <div class="w-full max-w-md bg-white border border-neutral-200 rounded-2xl shadow-sm p-7">
    <div class="flex items-center justify-between mb-6">
      <div class="flex items-center gap-2.5">
        <div class="w-9 h-9 rounded-xl bg-neutral-900 text-white flex items-center justify-center font-bold text-sm">
          V
        </div>
        <div>
          <h1 class="text-lg font-semibold leading-tight">VISION Bridge</h1>
          <p class="text-xs text-neutral-500">MCP OAuth 2.1 Authorization</p>
        </div>
      </div>
      <span class="text-xs font-mono bg-emerald-50 text-emerald-700 border border-emerald-200 px-2.5 py-1 rounded-full">
        Google OIDC
      </span>
    </div>

    <div class="bg-neutral-50 border border-neutral-200/80 rounded-xl p-4 mb-6 text-xs text-neutral-600 space-y-2">
      <div class="font-semibold text-neutral-900 text-sm">
        ${escapeHtml(client.client_name || 'Claude')} wants to connect to your VISION account
      </div>
      <p class="leading-relaxed">
        Sign in with the same Google Account you use on the <strong>VISION Android app</strong>. Claude will only have access to Android devices linked to your verified Google identity.
      </p>
    </div>

    ${actionContentHtml}
  </div>
</body>
</html>`);
  });

  // ============================================================================
  // 4b. GOOGLE OAUTH 2.0 REDIRECT & CALLBACK
  // ============================================================================
  app.get('/oauth/google', (req: Request, res: Response) => {
    const authReqId = req.query.auth_req_id as string;
    const pendingReq = db.getPendingAuthRequest(authReqId);
    if (!pendingReq) {
      res.status(400).send('Invalid or expired authorization session.');
      return;
    }

    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (!googleClientId) {
      res.status(400).send('GOOGLE_CLIENT_ID is not configured on the server.');
      return;
    }

    const baseUrl = getBaseUrl(req);
    const callbackUrl = `${baseUrl}/oauth/google/callback`;

    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state: authReqId,
      access_type: 'online',
      prompt: 'select_account',
    });

    res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  app.get(['/oauth/google/callback', '/oauth/google/callback/'], async (req: Request, res: Response) => {
    try {
      const code = req.query.code as string;
      const authReqId = req.query.state as string;
      const pendingReq = db.getPendingAuthRequest(authReqId);

      if (!pendingReq || !code) {
        res.status(400).send('Invalid OAuth callback state or missing authorization code.');
        return;
      }

      const baseUrl = getBaseUrl(req);
      const callbackUrl = `${baseUrl}/oauth/google/callback`;

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID || '',
          client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
          redirect_uri: callbackUrl,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        res.status(400).send(`Google token exchange failed: ${errText}`);
        return;
      }

      const tokenData = (await tokenRes.json()) as { id_token?: string };
      if (!tokenData.id_token) {
        res.status(400).send('Google response did not include an OpenID Connect id_token.');
        return;
      }

      const verified = await verifyGoogleIdToken(tokenData.id_token);

      // Find or create VISION User using Google's verified permanent `sub`
      const user = db.findOrCreateUserByGoogleSub({
        googleSubjectId: verified.sub,
        email: verified.email,
      });

      completeMcpAuthorization(pendingReq.id, user, res);
    } catch (err: any) {
      res.status(500).send(`OAuth Error: ${err.message}`);
    }
  });

  function completeMcpAuthorization(authReqId: string, user: VisionUser, res: Response) {
    const pendingReq = db.getPendingAuthRequest(authReqId);
    if (!pendingReq) {
      res.status(400).send('Authorization session expired');
      return;
    }
    db.deletePendingAuthRequest(authReqId);

    const codeRecord = db.createAuthorizationCode({
      client_id: pendingReq.client_id,
      redirect_uri: pendingReq.redirect_uri,
      code_challenge: pendingReq.code_challenge,
      code_challenge_method: pendingReq.code_challenge_method,
      user_id: user.id,
      google_subject_id: user.google_subject_id,
      email: user.email,
      scope: pendingReq.scope,
      resource: pendingReq.resource,
    });

    const redirectUrl = new URL(pendingReq.redirect_uri);
    redirectUrl.searchParams.set('code', codeRecord.code);
    if (pendingReq.state) {
      redirectUrl.searchParams.set('state', pendingReq.state);
    }

    res.redirect(302, redirectUrl.toString());
  }

  // ============================================================================
  // 5. OAUTH 2.1 TOKEN ENDPOINT (POST /token)
  // ============================================================================
  app.post('/token', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const grantType = req.body.grant_type as string;

    if (grantType === 'authorization_code') {
      const code = req.body.code as string;
      const codeVerifier = req.body.code_verifier as string | undefined;

      if (!code) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing authorization code',
        });
        return;
      }

      const codeRecord = db.consumeAuthorizationCode(code);
      if (!codeRecord) {
        res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Invalid or expired authorization code',
        });
        return;
      }

      // Verify PKCE if code_challenge was provided during /authorize
      if (codeRecord.code_challenge) {
        if (
          !codeVerifier ||
          !verifyPkceChallenge(
            codeVerifier,
            codeRecord.code_challenge,
            codeRecord.code_challenge_method
          )
        ) {
          res.status(400).json({
            error: 'invalid_grant',
            error_description: 'PKCE code_verifier does not match code_challenge',
          });
          return;
        }
      }

      const user = db.findOrCreateUserByGoogleSub({
        googleSubjectId: codeRecord.google_subject_id,
        email: codeRecord.email,
        preferredUserId: codeRecord.user_id,
      });

      const tokenRecord = db.issueTokens({
        clientId: codeRecord.client_id,
        user,
        scope: codeRecord.scope,
        resource: codeRecord.resource,
      });

      res.status(200).json({
        access_token: tokenRecord.access_token,
        token_type: 'Bearer',
        expires_in: 30 * 24 * 60 * 60,
        refresh_token: tokenRecord.refresh_token,
        scope: tokenRecord.scope,
      });
      return;
    }

    if (grantType === 'refresh_token') {
      const refreshToken = req.body.refresh_token as string;
      if (!refreshToken) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing refresh_token',
        });
        return;
      }

      const verified = db.verifyRefreshToken(refreshToken);
      if (!verified) {
        res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Invalid or expired refresh_token',
        });
        return;
      }

      const tokenRecord = db.issueTokens({
        clientId: verified.clientId,
        user: verified.user,
        scope: verified.scope,
      });

      res.status(200).json({
        access_token: tokenRecord.access_token,
        token_type: 'Bearer',
        expires_in: 30 * 24 * 60 * 60,
        refresh_token: tokenRecord.refresh_token,
        scope: tokenRecord.scope,
      });
      return;
    }

    res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: `Unsupported grant_type: ${grantType}`,
    });
  });

  // ============================================================================
  // 6. TOKEN REVOCATION ENDPOINT (POST /revoke)
  // ============================================================================
  app.post('/revoke', (req: Request, res: Response) => {
    const token = req.body.token as string;
    if (token) {
      db.revokeToken(token);
    }
    res.status(200).end();
  });

  // ============================================================================
  // 7. VERIFIED GOOGLE ID TOKEN ENDPOINT FOR ANDROID CLIENT
  // ============================================================================
  app.post('/api/auth/google', async (req: Request, res: Response) => {
    try {
      const idToken = ((req.body.idToken || req.body.id_token || '') as string).trim();
      const preferredUserId = ((req.body.userId || '') as string).trim();

      if (!idToken) {
        res.status(401).json({
          error: 'A valid Google OpenID Connect idToken is required.',
        });
        return;
      }

      const verified = await verifyGoogleIdToken(idToken);

      const user = db.findOrCreateUserByGoogleSub({
        googleSubjectId: verified.sub,
        email: verified.email,
        preferredUserId: preferredUserId || undefined,
      });

      const devices = db.getDevicesForAccount(user.id);
      res.json({
        user,
        devices,
        derivedUserId: deriveVisionUserId(verified.sub),
      });
    } catch (err: any) {
      res.status(401).json({ error: err.message || 'Google ID token verification failed' });
    }
  });
}
