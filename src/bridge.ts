import { WebSocket } from 'ws';
import { analytics } from './analytics';

export const activeDevices = new Map<string, WebSocket>();
export const pendingToolCalls = new Map<string, { resolve: (result: any) => void, reject: (err: any) => void, timeout: NodeJS.Timeout }>();

export class Bridge {
  constructor() {
    setInterval(() => {
      if (analytics.checkAndResetActivity()) {
        this.broadcastAnalytics();
      }
    }, 2000);
  }

  registerDevice(deviceId: string, ws: WebSocket) {
    activeDevices.set(deviceId, ws);
    console.log(`Device registered: ${deviceId}`);

    ws.on('close', () => {
      if (activeDevices.get(deviceId) === ws) {
        activeDevices.delete(deviceId);
        console.log(`Device disconnected: ${deviceId}`);
      }
    });
  }

  handleMessage(deviceId: string, data: any, rawBytes: number = 0) {
    if (data.type === 'tool_result' && data.id) {
      const pending = pendingToolCalls.get(data.id);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(data.result);
        pendingToolCalls.delete(data.id);
      }
    } else if (data.type === 'tool_error' && data.id) {
      const pending = pendingToolCalls.get(data.id);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(data.error || 'Unknown error from device'));
        pendingToolCalls.delete(data.id);
      }
    }
  }

  async executeOnDevice(deviceId: string, toolName: string, args: any): Promise<any> {
    const deviceWs = activeDevices.get(deviceId);
    
    if (!deviceWs) {
      throw new Error("Device not connected.");
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

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pendingToolCalls.has(toolCallId)) {
          pendingToolCalls.delete(toolCallId);
          analytics.recordError();
          reject(new Error(`Timeout waiting for response from ${deviceId} for tool ${toolName}`));
        }
      }, 30000); // 30s timeout

      pendingToolCalls.set(toolCallId, { resolve, reject, timeout });

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

  getConnectedDevices(): string[] {
    return Array.from(activeDevices.keys());
  }

  broadcastAnalytics() {
    const payload = JSON.stringify({
      type: "analytics_update",
      data: analytics.getSummary()
    });

    for (const ws of activeDevices.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }
}

export const bridge = new Bridge();
