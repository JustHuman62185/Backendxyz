import { WebSocket } from 'ws';
import { analytics } from './analytics';
import { db, VisionDevice, VisionUser } from './db';

export interface DeviceRegistrationPayload {
  type: 'register';
  deviceId: string;
  googleSubjectId?: string;
  sub?: string;
  userId?: string;
  email?: string;
  deviceName?: string;
  name?: string;
  os?: string;
  ip?: string;
  capabilities?: string[];
}

export interface ConnectedDeviceView {
  deviceId: string;
  name: string;
  deviceName: string;
  userId: string;
  googleSubjectId: string;
  email?: string;
  os: string;
  ip?: string;
  capabilities: string[];
  online: boolean;
  createdAt: string;
  lastSeenAt: string;
}

export const activeDevices = new Map<string, WebSocket>();
export const pendingToolCalls = new Map<
  string,
  {
    resolve: (result: any) => void;
    reject: (err: any) => void;
    timeout: NodeJS.Timeout;
    startTime: number;
  }
>();

export class Bridge {
  constructor() {
    setInterval(() => {
      if (analytics.checkAndResetActivity()) {
        this.broadcastAnalytics();
      }
    }, 2000);
  }

  /**
   * Registers an Android device on WebSocket connect and links it to the VISION User Account
   * anchored by Google's permanent OpenID Connect `sub` (`google_subject_id`).
   */
  registerDevice(
    payloadOrDeviceId: string | DeviceRegistrationPayload,
    ws: WebSocket,
    clientIp?: string
  ): { user: VisionUser; device: VisionDevice } {
    const payload: DeviceRegistrationPayload =
      typeof payloadOrDeviceId === 'string'
        ? { type: 'register', deviceId: payloadOrDeviceId }
        : payloadOrDeviceId;

    const deviceId = payload.deviceId;
    const existingDevice = db.getDeviceById(deviceId);

    const googleSub =
      payload.googleSubjectId?.trim() ||
      payload.sub?.trim() ||
      existingDevice?.device_authentication_data.google_subject_id ||
      `unlinked_${deviceId}`;

    // 1. Find or create VISION account in `users` table by permanent `google_subject_id`
    const user = db.findOrCreateUserByGoogleSub({
      googleSubjectId: googleSub,
      email: payload.email,
      preferredUserId: payload.userId,
    });

    // 2. Upsert device in `devices` table with foreign key `user_id = user.id`
    const device = db.upsertDevice({
      deviceId,
      userId: user.id,
      googleSubjectId: user.google_subject_id,
      deviceName: payload.deviceName || payload.name || existingDevice?.device_name || deviceId,
      os: payload.os || 'Android',
      ip: payload.ip || clientIp,
      capabilities: payload.capabilities,
    });

    activeDevices.set(deviceId, ws);
    console.log(
      `Device registered: ${deviceId} -> VISION User ${user.id} (sub: ${user.google_subject_id})`
    );
    analytics.recordAlert(
      `Device ${device.device_name} (${deviceId}) connected under account ${user.id}`,
      'OK'
    );

    ws.on('close', () => {
      if (activeDevices.get(deviceId) === ws) {
        activeDevices.delete(deviceId);
        console.log(`Device disconnected: ${deviceId}`);
      }
    });

    return { user, device };
  }

  handleMessage(deviceId: string, data: any, rawBytes: number = 0) {
    if (data.type === 'tool_result' && data.id) {
      const pending = pendingToolCalls.get(data.id);
      if (pending) {
        clearTimeout(pending.timeout);
        const latencyMs = Date.now() - pending.startTime;
        analytics.recordSuccess(latencyMs, rawBytes);
        pending.resolve(data.result);
        pendingToolCalls.delete(data.id);
      }
    } else if (data.type === 'tool_error' && data.id) {
      const pending = pendingToolCalls.get(data.id);
      if (pending) {
        clearTimeout(pending.timeout);
        analytics.recordError(rawBytes);
        pending.reject(new Error(data.error || 'Unknown error from device'));
        pendingToolCalls.delete(data.id);
      }
    }
  }

  async executeOnDevice(deviceId: string, toolName: string, args: any): Promise<any> {
    const deviceWs = activeDevices.get(deviceId);

    if (!deviceWs || deviceWs.readyState !== WebSocket.OPEN) {
      throw new Error(`Device ${deviceId} is not currently connected.`);
    }

    const toolCallId = `call_${Math.random().toString(36).substring(2, 11)}`;
    const payload = {
      type: 'tool_call',
      id: toolCallId,
      tool: toolName,
      args: args || {},
    };

    const payloadString = JSON.stringify(payload);
    const bytesSent = Buffer.byteLength(payloadString, 'utf8');
    analytics.recordRequest(bytesSent);
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pendingToolCalls.has(toolCallId)) {
          pendingToolCalls.delete(toolCallId);
          analytics.recordError();
          reject(new Error(`Timeout waiting for response from ${deviceId} for tool ${toolName}`));
        }
      }, 30000); // 30s timeout

      pendingToolCalls.set(toolCallId, { resolve, reject, timeout, startTime });

      deviceWs.send(payloadString, (err) => {
        if (err) {
          clearTimeout(timeout);
          pendingToolCalls.delete(toolCallId);
          analytics.recordError();
          reject(err);
        }
      });
    });
  }

  private toDeviceView(device: VisionDevice): ConnectedDeviceView {
    const user = db.getUserById(device.user_id);
    const ws = activeDevices.get(device.id);
    const online = Boolean(ws && ws.readyState === WebSocket.OPEN);

    return {
      deviceId: device.id,
      name: device.device_name,
      deviceName: device.device_name,
      userId: device.user_id,
      googleSubjectId: device.device_authentication_data.google_subject_id,
      email: user?.email,
      os: device.device_authentication_data.os,
      ip: device.device_authentication_data.ip,
      capabilities: device.device_authentication_data.capabilities,
      online,
      createdAt: device.created_at,
      lastSeenAt: device.device_authentication_data.last_seen_at,
    };
  }

  /**
   * Resolves `SELECT * FROM devices WHERE user_id = ?` for a specific VISION User account.
   */
  getDevicesForUser(userIdOrSub: string): ConnectedDeviceView[] {
    const devices = db.getDevicesForAccount(userIdOrSub);
    return devices.map((d) => this.toDeviceView(d));
  }

  /**
   * Resolves the target connected device for an authenticated VISION User.
   * Ensures Claude can ONLY access devices belonging to the authenticated VISION account.
   */
  resolveTargetDeviceForUser(userIdOrSub: string, requestedDeviceId?: string): ConnectedDeviceView {
    const userDevices = this.getDevicesForUser(userIdOrSub);

    if (userDevices.length === 0) {
      throw new Error(
        `No Android devices are paired to VISION account (${userIdOrSub}) yet. Sign in with the same Google Account in the VISION Android app to link your phone.`
      );
    }

    if (requestedDeviceId) {
      const match = userDevices.find((d) => d.deviceId === requestedDeviceId);
      if (!match) {
        throw new Error(
          `Access denied or device not found: Device '${requestedDeviceId}' does not belong to VISION account ${userIdOrSub}.`
        );
      }
      if (!match.online) {
        throw new Error(
          `Device '${match.deviceName}' (${match.deviceId}) belongs to your VISION account but is currently offline.`
        );
      }
      return match;
    }

    const firstOnline = userDevices.find((d) => d.online);
    if (!firstOnline) {
      const names = userDevices.map((d) => `${d.deviceName} (${d.deviceId})`).join(', ');
      throw new Error(
        `Your VISION account has ${userDevices.length} registered device(s) [${names}], but none are currently connected online via WebSocket.`
      );
    }

    return firstOnline;
  }

  /**
   * Returns all currently online devices (with full profile metadata).
   */
  getConnectedDevices(): ConnectedDeviceView[] {
    return db
      .getAllDevices()
      .map((d) => this.toDeviceView(d))
      .filter((d) => d.online);
  }

  /**
   * Returns all registered devices (both online and offline).
   */
  getAllRegisteredDevices(): ConnectedDeviceView[] {
    return db.getAllDevices().map((d) => this.toDeviceView(d));
  }

  broadcastAnalytics() {
    const payload = JSON.stringify({
      type: 'analytics_update',
      data: analytics.getSummary(),
    });

    for (const ws of activeDevices.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }
}

export const bridge = new Bridge();
