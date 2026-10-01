import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { bridge } from './bridge';

export function setupWsServer(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    let registeredDeviceId: string | null = null;

    ws.on('message', (message: string) => {
      try {
        const data = JSON.parse(message.toString());
        
        if (data.type === 'register') {
          if (data.deviceId) {
            registeredDeviceId = data.deviceId;
            bridge.registerDevice(data.deviceId, ws);
          } else {
            console.error('Invalid register payload, missing deviceId:', data);
            ws.close();
          }
        } else if (registeredDeviceId) {
          const rawBytes = Buffer.byteLength(message.toString(), 'utf8');
          bridge.handleMessage(registeredDeviceId, data, rawBytes);
        }
      } catch (e) {
        console.error('Invalid WS message', e);
      }
    });
  });

  console.log('WebSocket server attached at /ws');
}
