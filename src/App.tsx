/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

export interface DeviceProfile {
  deviceId: string;
  name?: string;
  os?: string;
  ip?: string;
  capabilities?: string[];
}

export default function App() {
  const [devices, setDevices] = useState<DeviceProfile[]>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [devicesRes, analyticsRes] = await Promise.all([
          fetch('/api/devices'),
          fetch('/api/analytics')
        ]);
        
        if (!devicesRes.ok || !analyticsRes.ok) throw new Error('Failed to fetch data');
        
        const devicesData = await devicesRes.json();
        const analyticsData = await analyticsRes.json();
        
        setDevices(devicesData.devices || []);
        setAnalytics(analyticsData);
      } catch (err: any) {
        setError(err.message);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 2000); // Poll every 2 seconds
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans p-8 flex flex-col items-center justify-center">
      <div className="w-full max-w-3xl bg-white border border-neutral-200 rounded-2xl shadow-sm p-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">VISION Bridge</h1>
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
            </span>
            <span className="text-sm font-medium text-neutral-500 uppercase tracking-wider">Online</span>
          </div>
        </div>

        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="bg-neutral-50 p-4 rounded-xl border border-neutral-100">
              <p className="text-neutral-500 font-medium mb-1">MCP Endpoint (Streamable HTTP)</p>
              <code className="text-neutral-800 bg-neutral-200/50 px-2 py-0.5 rounded">/mcp</code>
            </div>
            <div className="bg-neutral-50 p-4 rounded-xl border border-neutral-100">
              <p className="text-neutral-500 font-medium mb-1">Android WS Endpoint</p>
              <code className="text-neutral-800 bg-neutral-200/50 px-2 py-0.5 rounded">/ws</code>
            </div>
          </div>

          <div>
            <h2 className="text-lg font-medium mb-4 flex items-center gap-2">
              Connected Devices
              <span className="bg-neutral-100 text-neutral-600 px-2 py-0.5 rounded-full text-xs font-semibold">
                {devices.length}
              </span>
            </h2>
            
            {error && (
              <div className="text-red-500 text-sm bg-red-50 p-3 rounded-lg mb-4">
                {error}
              </div>
            )}

            {devices.length === 0 ? (
              <div className="text-center py-12 bg-neutral-50 rounded-xl border border-neutral-100 border-dashed">
                <p className="text-neutral-400 text-sm">Waiting for Android devices to connect via WebSocket...</p>
              </div>
            ) : (
              <ul className="space-y-4">
                {devices.map((device) => (
                  <li key={device.deviceId} className="flex flex-col p-5 bg-neutral-50 rounded-xl border border-neutral-100 gap-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-neutral-200/50 rounded-full flex items-center justify-center text-neutral-600">
                          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/></svg>
                        </div>
                        <div>
                          <p className="font-semibold text-neutral-800">{device.name || 'Unknown Device'}</p>
                          <p className="text-xs font-medium text-neutral-500">{device.deviceId}</p>
                        </div>
                      </div>
                      <span className="text-xs font-medium text-green-600 bg-green-50 px-2.5 py-1 rounded-full border border-green-200/50">
                        Connected
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-sm pl-[52px]">
                      {device.os && (
                        <div className="flex items-center gap-2 text-neutral-600">
                          <span className="font-medium">OS:</span> {device.os}
                        </div>
                      )}
                      {device.ip && (
                        <div className="flex items-center gap-2 text-neutral-600">
                          <span className="font-medium">IP:</span> {device.ip}
                        </div>
                      )}
                    </div>

                    {device.capabilities && device.capabilities.length > 0 && (
                      <div className="pl-[52px]">
                        <p className="text-xs font-medium text-neutral-500 mb-2 uppercase tracking-wider">Capabilities</p>
                        <div className="flex flex-wrap gap-2">
                          {device.capabilities.map((cap) => (
                            <span key={cap} className="px-2 py-1 bg-neutral-200/50 text-neutral-700 rounded text-xs font-medium">
                              {cap}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Real-Time Analytics Section */}
          <div className="pt-6 border-t border-neutral-100">
            <h2 className="text-lg font-medium mb-4">Real-Time Analytics</h2>
            
            {analytics ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-neutral-50 p-4 rounded-xl border border-neutral-100 flex flex-col">
                  <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-1">Tasks Completed</span>
                  <span className="text-2xl font-semibold text-neutral-900">{analytics.tasksCompleted}</span>
                </div>
                <div className="bg-neutral-50 p-4 rounded-xl border border-neutral-100 flex flex-col">
                  <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-1">Success Rate</span>
                  <span className="text-2xl font-semibold text-neutral-900">{analytics.successRate}%</span>
                </div>
                <div className="bg-neutral-50 p-4 rounded-xl border border-neutral-100 flex flex-col">
                  <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-1">Response Time</span>
                  <span className="text-2xl font-semibold text-neutral-900">{analytics.responseTimeMs}ms</span>
                </div>
                <div className="bg-neutral-50 p-4 rounded-xl border border-neutral-100 flex flex-col">
                  <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-1">Data Processed</span>
                  <span className="text-2xl font-semibold text-neutral-900">{analytics.dataProcessedGb} GB</span>
                </div>
              </div>
            ) : (
              <div className="text-center py-8 bg-neutral-50 rounded-xl border border-neutral-100 border-dashed">
                <p className="text-neutral-400 text-sm">Loading analytics...</p>
              </div>
            )}
            
            {analytics && analytics.alerts && analytics.alerts.length > 0 && (
              <div className="mt-4">
                <h3 className="text-sm font-medium text-neutral-500 uppercase tracking-wider mb-2">System Alerts</h3>
                <ul className="space-y-2">
                  {analytics.alerts.map((alert: any) => (
                    <li key={alert.id} className={`p-3 rounded-lg border text-sm flex items-center justify-between ${
                      alert.status === 'CRITICAL' ? 'bg-red-50 border-red-100 text-red-800' :
                      alert.status === 'WARNING' ? 'bg-amber-50 border-amber-100 text-amber-800' :
                      'bg-green-50 border-green-100 text-green-800'
                    }`}>
                      <span>{alert.message}</span>
                      <span className="text-xs font-bold opacity-75">{alert.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
