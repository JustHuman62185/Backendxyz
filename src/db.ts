import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Core Database Tables matching the VISION Security & Identity Architecture:
 *
 * users
 * ────────────────────
 * id                 (e.g., "usr_8f319201")
 * google_subject_id  (Permanent OpenID Connect "sub" identifier from Google)
 * email              (Mutable user email from Google)
 * created_at         (ISO timestamp)
 *
 * devices
 * ────────────────────
 * id                          (e.g., "DEV-...")
 * user_id                     (Foreign key -> users.id)
 * device_name                 (Human-readable device name)
 * device_authentication_data  (JSON metadata: os, capabilities, ip, google_subject_id, etc.)
 * created_at                  (ISO timestamp)
 */

export interface VisionUser {
  id: string;
  google_subject_id: string;
  email: string;
  created_at: string;
}

export interface DeviceAuthData {
  google_subject_id: string;
  os: string;
  ip?: string;
  capabilities: string[];
  last_seen_at: string;
}

export interface VisionDevice {
  id: string;
  user_id: string;
  device_name: string;
  device_authentication_data: DeviceAuthData;
  created_at: string;
}

export interface OAuthClientRecord {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  client_secret_expires_at?: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
}

export interface PendingAuthRequest {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state?: string;
  scope: string;
  resource?: string;
  created_at: number;
}

export interface AuthorizationCodeRecord {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  user_id: string;
  google_subject_id: string;
  email?: string;
  scope: string;
  resource?: string;
  expires_at: number;
}

export interface OAuthTokenRecord {
  access_token: string;
  refresh_token: string;
  client_id: string;
  user_id: string;
  google_subject_id: string;
  scope: string;
  resource?: string;
  expires_at: number;
  created_at: string;
}

interface PersistedState {
  users: VisionUser[];
  devices: VisionDevice[];
  oauthClients: OAuthClientRecord[];
  oauthTokens: OAuthTokenRecord[];
}

const DB_FILE_PATH = path.join(process.cwd(), '.vision-db.json');
const TOKEN_SECRET = process.env.OAUTH_JWT_SECRET || 'vision-mcp-bridge-permanent-sub-secret-key';

function signStatelessPayload(prefix: string, data: Record<string, any>, secretSuffix = ''): string {
  const payloadB64 = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', TOKEN_SECRET + secretSuffix)
    .update(payloadB64)
    .digest('base64url');
  return `${prefix}.${payloadB64}.${sig}`;
}

function verifyStatelessPayload<T = any>(
  token: string,
  expectedPrefix: string,
  secretSuffix = ''
): T | null {
  if (!token || !token.startsWith(`${expectedPrefix}.`)) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, payloadB64, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', TOKEN_SECRET + secretSuffix)
    .update(payloadB64)
    .digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Generates a deterministic VISION user_id ("usr_...") from Google's stable `sub` identifier.
 */
export function deriveVisionUserId(googleSubjectId: string): string {
  const hash = crypto.createHash('sha256').update(googleSubjectId).digest('hex').substring(0, 8);
  return `usr_${hash}`;
}

class VisionDatabase {
  // Primary tables
  private usersById = new Map<string, VisionUser>();
  private usersByGoogleSub = new Map<string, VisionUser>();
  private devicesById = new Map<string, VisionDevice>();

  // OAuth 2.1 state
  private oauthClients = new Map<string, OAuthClientRecord>();
  private pendingAuthRequests = new Map<string, PendingAuthRequest>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private consumedAuthCodes = new Set<string>();
  private accessTokens = new Map<string, OAuthTokenRecord>();
  private refreshTokens = new Map<string, OAuthTokenRecord>();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(DB_FILE_PATH)) {
        const raw = fs.readFileSync(DB_FILE_PATH, 'utf8');
        const parsed = JSON.parse(raw) as Partial<PersistedState>;

        for (const user of parsed.users || []) {
          this.usersById.set(user.id, user);
          this.usersByGoogleSub.set(user.google_subject_id, user);
        }
        for (const device of parsed.devices || []) {
          this.devicesById.set(device.id, device);
        }
        for (const client of parsed.oauthClients || []) {
          this.oauthClients.set(client.client_id, client);
        }
        for (const token of parsed.oauthTokens || []) {
          this.accessTokens.set(token.access_token, token);
          this.refreshTokens.set(token.refresh_token, token);
        }
      }
    } catch (err) {
      console.warn('Failed to load .vision-db.json, starting with fresh in-memory state:', err);
    }
  }

  private saveToDisk() {
    try {
      const state: PersistedState = {
        users: Array.from(this.usersById.values()),
        devices: Array.from(this.devicesById.values()),
        oauthClients: Array.from(this.oauthClients.values()),
        oauthTokens: Array.from(this.accessTokens.values()),
      };
      fs.writeFileSync(DB_FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      // Ignore write errors in ephemeral/read-only environments
    }
  }

  // ============================================================================
  // USERS TABLE OPERATIONS (Google `sub` = Permanent Identity Anchor)
  // ============================================================================

  /**
   * Finds an existing VISION user by Google's permanent `sub` (`google_subject_id`),
   * or creates a new VISION user if one does not exist yet.
   *
   * Never creates a duplicate account for the same `google_subject_id`, regardless
   * of whether the user entered via the VISION Android app or Claude's MCP OAuth flow.
   */
  findOrCreateUserByGoogleSub(params: {
    googleSubjectId: string;
    email?: string;
    preferredUserId?: string;
  }): VisionUser {
    const sub = params.googleSubjectId.trim();
    if (!sub) {
      throw new Error('google_subject_id (sub) is required');
    }

    const existing = this.usersByGoogleSub.get(sub);

    if (existing) {
      let mutated = false;

      // Update email if provided and changed (email is mutable; sub is permanent)
      if (params.email && params.email.trim() && params.email.trim() !== existing.email) {
        existing.email = params.email.trim();
        mutated = true;
      }

      // If the Android app sends its canonical usr_... ID for this sub and it differs,
      // reconcile the primary key so Android & MCP share the exact same users.id.
      if (
        params.preferredUserId &&
        params.preferredUserId.startsWith('usr_') &&
        params.preferredUserId !== existing.id
      ) {
        const oldId = existing.id;
        const newId = params.preferredUserId;
        this.usersById.delete(oldId);
        existing.id = newId;
        this.usersById.set(newId, existing);

        // Cascade update devices.user_id and oauth_tokens.user_id
        for (const dev of this.devicesById.values()) {
          if (dev.user_id === oldId) {
            dev.user_id = newId;
          }
        }
        for (const tok of this.accessTokens.values()) {
          if (tok.user_id === oldId) {
            tok.user_id = newId;
          }
        }
        mutated = true;
      }

      if (mutated) {
        this.saveToDisk();
      }
      return existing;
    }

    const userId =
      params.preferredUserId && params.preferredUserId.startsWith('usr_')
        ? params.preferredUserId
        : deriveVisionUserId(sub);

    const newUser: VisionUser = {
      id: userId,
      google_subject_id: sub,
      email: params.email?.trim() || `${sub}@google-identity.vision`,
      created_at: new Date().toISOString(),
    };

    this.usersById.set(newUser.id, newUser);
    this.usersByGoogleSub.set(newUser.google_subject_id, newUser);
    this.saveToDisk();

    return newUser;
  }

  getUserById(userId: string): VisionUser | undefined {
    return this.usersById.get(userId);
  }

  getUserByGoogleSub(googleSubjectId: string): VisionUser | undefined {
    return this.usersByGoogleSub.get(googleSubjectId);
  }

  getAllUsers(): VisionUser[] {
    return Array.from(this.usersById.values());
  }

  // ============================================================================
  // DEVICES TABLE OPERATIONS (devices.user_id -> users.id)
  // ============================================================================

  /**
   * Upserts a device in the `devices` table and links it to the owning VISION user.
   */
  upsertDevice(params: {
    deviceId: string;
    userId: string;
    googleSubjectId: string;
    deviceName?: string;
    os?: string;
    ip?: string;
    capabilities?: string[];
  }): VisionDevice {
    const existing = this.devicesById.get(params.deviceId);
    const now = new Date().toISOString();

    const authData: DeviceAuthData = {
      google_subject_id: params.googleSubjectId,
      os: params.os || existing?.device_authentication_data.os || 'Android',
      ip: params.ip || existing?.device_authentication_data.ip,
      capabilities:
        params.capabilities && params.capabilities.length > 0
          ? params.capabilities
          : existing?.device_authentication_data.capabilities || [],
      last_seen_at: now,
    };

    const device: VisionDevice = {
      id: params.deviceId,
      user_id: params.userId,
      device_name: params.deviceName || existing?.device_name || params.deviceId,
      device_authentication_data: authData,
      created_at: existing?.created_at || now,
    };

    this.devicesById.set(device.id, device);
    this.saveToDisk();
    return device;
  }

  /**
   * SELECT * FROM devices WHERE user_id = ?
   */
  getDevicesByUserId(userId: string): VisionDevice[] {
    const results: VisionDevice[] = [];
    for (const device of this.devicesById.values()) {
      if (device.user_id === userId) {
        results.push(device);
      }
    }
    return results;
  }

  /**
   * Finds all devices for a user by either `users.id` or `google_subject_id`.
   */
  getDevicesForAccount(userIdOrSub: string): VisionDevice[] {
    const user = this.usersById.get(userIdOrSub) || this.usersByGoogleSub.get(userIdOrSub);
    const results: VisionDevice[] = [];
    for (const device of this.devicesById.values()) {
      if (
        device.user_id === userIdOrSub ||
        (user &&
          (device.user_id === user.id ||
            device.device_authentication_data.google_subject_id === user.google_subject_id))
      ) {
        results.push(device);
      }
    }
    return results;
  }

  getDeviceById(deviceId: string): VisionDevice | undefined {
    return this.devicesById.get(deviceId);
  }

  getAllDevices(): VisionDevice[] {
    return Array.from(this.devicesById.values());
  }

  // ============================================================================
  // OAUTH 2.1 CLIENTS, CODES, AND TOKENS (Stateless HMAC + In-Memory Resilient)
  // ============================================================================

  registerOAuthClient(
    metadata: Partial<OAuthClientRecord> & { redirect_uris: string[] }
  ): OAuthClientRecord {
    const clientId = metadata.client_id || `mcp_client_${crypto.randomUUID()}`;
    const isPublic = metadata.token_endpoint_auth_method === 'none';
    const clientSecret = isPublic
      ? undefined
      : metadata.client_secret || crypto.randomBytes(24).toString('hex');

    const record: OAuthClientRecord = {
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      client_name: metadata.client_name || 'Claude MCP Connector',
      redirect_uris: metadata.redirect_uris,
      grant_types: metadata.grant_types || ['authorization_code', 'refresh_token'],
      response_types: metadata.response_types || ['code'],
      token_endpoint_auth_method:
        metadata.token_endpoint_auth_method || (isPublic ? 'none' : 'client_secret_post'),
    };

    this.oauthClients.set(clientId, record);
    this.saveToDisk();
    return record;
  }

  getOAuthClient(clientId: string): OAuthClientRecord | undefined {
    return this.oauthClients.get(clientId);
  }

  createPendingAuthRequest(req: Omit<PendingAuthRequest, 'id' | 'created_at'>): PendingAuthRequest {
    const createdAt = Date.now();
    const id = signStatelessPayload(
      'authreq',
      {
        ...req,
        created_at: createdAt,
        nonce: crypto.randomBytes(6).toString('hex'),
      },
      '_authreq'
    );
    const record: PendingAuthRequest = {
      ...req,
      id,
      created_at: createdAt,
    };
    this.pendingAuthRequests.set(id, record);
    return record;
  }

  getPendingAuthRequest(id: string): PendingAuthRequest | undefined {
    if (!id) return undefined;
    const req = this.pendingAuthRequests.get(id);
    if (req) {
      if (Date.now() - req.created_at > 15 * 60 * 1000) {
        this.pendingAuthRequests.delete(id);
        return undefined;
      }
      return req;
    }

    // Fallback: verify stateless HMAC pending request (survives Render restarts during OAuth login)
    const decoded = verifyStatelessPayload<Omit<PendingAuthRequest, 'id'>>(
      id,
      'authreq',
      '_authreq'
    );
    if (decoded && Date.now() - decoded.created_at <= 15 * 60 * 1000) {
      return { ...decoded, id };
    }
    return undefined;
  }

  deletePendingAuthRequest(id: string) {
    this.pendingAuthRequests.delete(id);
  }

  createAuthorizationCode(
    data: Omit<AuthorizationCodeRecord, 'code' | 'expires_at'>
  ): AuthorizationCodeRecord {
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    const code = signStatelessPayload(
      'vis_code',
      {
        ...data,
        expires_at: expiresAt,
        nonce: crypto.randomBytes(6).toString('hex'),
      },
      '_code'
    );
    const record: AuthorizationCodeRecord = {
      ...data,
      code,
      expires_at: expiresAt,
    };
    this.authCodes.set(code, record);
    return record;
  }

  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | undefined {
    if (!code || this.consumedAuthCodes.has(code)) {
      return undefined;
    }

    const record = this.authCodes.get(code);
    if (record) {
      this.authCodes.delete(code);
      this.consumedAuthCodes.add(code);
      if (Date.now() > record.expires_at) {
        return undefined;
      }
      return record;
    }

    // Fallback: verify stateless HMAC authorization code
    const decoded = verifyStatelessPayload<Omit<AuthorizationCodeRecord, 'code'>>(
      code,
      'vis_code',
      '_code'
    );
    if (decoded && Date.now() <= decoded.expires_at) {
      this.consumedAuthCodes.add(code);
      return { ...decoded, code };
    }

    return undefined;
  }

  /**
   * Creates a self-verifiable + stored OAuth token pair bound to the VISION user (`user_id` & `google_subject_id`).
   */
  issueTokens(params: {
    clientId: string;
    user: VisionUser;
    scope: string;
    resource?: string;
  }): OAuthTokenRecord {
    const expiresInSeconds = 30 * 24 * 60 * 60; // 30 days
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

    const payloadObj = {
      uid: params.user.id,
      sub: params.user.google_subject_id,
      eml: params.user.email,
      cid: params.clientId,
      exp: expiresAt,
      nonce: crypto.randomBytes(8).toString('hex'),
    };

    const accessToken = signStatelessPayload('vis_at', payloadObj, '');
    const refreshToken = signStatelessPayload('vis_rt', payloadObj, '_refresh');

    const record: OAuthTokenRecord = {
      access_token: accessToken,
      refresh_token: refreshToken,
      client_id: params.clientId,
      user_id: params.user.id,
      google_subject_id: params.user.google_subject_id,
      scope: params.scope || 'openid profile email vision:devices',
      resource: params.resource,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
    };

    this.accessTokens.set(accessToken, record);
    this.refreshTokens.set(refreshToken, record);
    this.saveToDisk();

    return record;
  }

  /**
   * Resolves an OAuth Bearer access token to the owning VISION User:
   * OAuth token ➔ VISION user ➔ user_id ➔ SELECT devices WHERE user_id = ?
   */
  verifyAccessToken(token: string): {
    user: VisionUser;
    clientId: string;
    scope: string;
    expiresAt: number;
  } | null {
    const nowSec = Math.floor(Date.now() / 1000);

    // 1. Check in-memory / persisted store
    const stored = this.accessTokens.get(token);
    if (stored) {
      if (stored.expires_at < nowSec) {
        this.accessTokens.delete(token);
        return null;
      }
      const user =
        this.usersByGoogleSub.get(stored.google_subject_id) ||
        this.usersById.get(stored.user_id) ||
        this.findOrCreateUserByGoogleSub({
          googleSubjectId: stored.google_subject_id,
          preferredUserId: stored.user_id,
        });

      return {
        user,
        clientId: stored.client_id,
        scope: stored.scope,
        expiresAt: stored.expires_at,
      };
    }

    // 2. Fallback: verify HMAC-signed token (survives Render container restarts seamlessly)
    const payload = verifyStatelessPayload<{
      uid: string;
      sub: string;
      eml?: string;
      cid?: string;
      exp: number;
    }>(token, 'vis_at', '');

    if (payload && payload.exp && payload.exp >= nowSec && payload.sub) {
      const user = this.findOrCreateUserByGoogleSub({
        googleSubjectId: payload.sub,
        email: payload.eml,
        preferredUserId: payload.uid,
      });
      return {
        user,
        clientId: payload.cid || 'claude-mcp',
        scope: 'openid profile email vision:devices',
        expiresAt: payload.exp,
      };
    }

    return null;
  }

  verifyRefreshToken(refreshToken: string): {
    user: VisionUser;
    clientId: string;
    scope: string;
  } | null {
    const stored = this.refreshTokens.get(refreshToken);
    if (stored) {
      const user =
        this.usersByGoogleSub.get(stored.google_subject_id) ||
        this.usersById.get(stored.user_id);
      if (user) {
        return {
          user,
          clientId: stored.client_id,
          scope: stored.scope,
        };
      }
    }

    const payload = verifyStatelessPayload<{
      uid: string;
      sub: string;
      eml?: string;
      cid?: string;
    }>(refreshToken, 'vis_rt', '_refresh');

    if (payload && payload.sub) {
      const user = this.findOrCreateUserByGoogleSub({
        googleSubjectId: payload.sub,
        email: payload.eml,
        preferredUserId: payload.uid,
      });
      return {
        user,
        clientId: payload.cid || 'claude-mcp',
        scope: 'openid profile email vision:devices',
      };
    }

    return null;
  }

  revokeToken(token: string) {
    const record = this.accessTokens.get(token) || this.refreshTokens.get(token);
    if (record) {
      this.accessTokens.delete(record.access_token);
      this.refreshTokens.delete(record.refresh_token);
      this.saveToDisk();
    }
  }

  getActiveTokenCountForUser(userId: string): number {
    const nowSec = Math.floor(Date.now() / 1000);
    let count = 0;
    for (const tok of this.accessTokens.values()) {
      if (tok.user_id === userId && tok.expires_at >= nowSec) {
        count++;
      }
    }
    return count;
  }
}

export const db = new VisionDatabase();
