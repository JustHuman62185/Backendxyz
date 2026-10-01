import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import { bridge } from './bridge';

export function setupWsServer(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let registeredDeviceId: string | null = null;
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientIp =
      (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : undefined) ||
      req.socket.remoteAddress ||
      undefined;

    ws.on('message', (message: string) => {
      try {
        const rawText = message.toString();
        const data = JSON.parse(rawText);

        if (data.type === 'register') {
          if (data.deviceId) {
            registeredDeviceId = data.deviceId;
            const { user, device } = bridge.registerDevice(data, ws, clientIp);
            const accountDevices = bridge.getDevicesForUser(user.id);

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'registered',
                  status: 'ok',
                  userId: user.id,
                  googleSubjectId: user.google_subject_id,
                  email: user.email,
                  deviceId: device.id,
                  deviceName: device.device_name,
                  devices: accountDevices,
                })
              );
            }
          } else {
            console.error('Invalid register payload, missing deviceId:', data);
            ws.close();
          }
        } else if (registeredDeviceId) {
          const rawBytes = Buffer.byteLength(rawText, 'utf8');
          bridge.handleMessage(registeredDeviceId, data, rawBytes);
        }
      } catch (e) {
        console.error('Invalid WS message', e);
      }
    });
  });

  console.log('WebSocket server attached at /ws');
}
