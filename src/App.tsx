/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

export interface DeviceProfile {
  deviceId: string;
  name?: string;
  deviceName?: string;
  userId: string;
  googleSubjectId: string;
  email?: string;
  os?: string;
  ip?: string;
  capabilities?: string[];
  online?: boolean;
  createdAt?: string;
  lastSeenAt?: string;
}

export interface VisionAccountView {
  id: string;
  google_subject_id: string;
  email: string;
  created_at: string;
  activeTokens: number;
  devices: DeviceProfile[];
}

export default function App() {
  const [devices, setDevices] = useState<DeviceProfile[]>([]);
  const [accounts, setAccounts] = useState<VisionAccountView[]>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [devicesRes, analyticsRes] = await Promise.all([
          fetch('/api/devices'),
          fetch('/api/analytics'),
        ]);

        if (!devicesRes.ok || !analyticsRes.ok) throw new Error('Failed to fetch data');

        const devicesData = await devicesRes.json();
        const analyticsData = await analyticsRes.json();

        setDevices(devicesData.devices || []);
        setAccounts(devicesData.accounts || []);
        setAnalytics(analyticsData);
        setError('');
      } catch (err: any) {
        setError(err.message);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans p-6 md:p-8 flex flex-col items-center justify-center">
      <div className="w-full max-w-4xl bg-white border border-neutral-200 rounded-2xl shadow-sm p-6 md:p-8 space-y-8">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-100 pb-6">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-semibold tracking-tight">VISION Bridge</h1>
              <span className="text-xs font-mono bg-neutral-900 text-white px-2.5 py-0.5 rounded-full">
                OAuth 2.1 + Google OIDC
              </span>
            </div>
            <p className="text-sm text-neutral-500 mt-1">
              Central MCP &amp; WebSocket Gateway
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
            </span>
            <span className="text-sm font-medium text-neutral-500 uppercase tracking-wider">Online</span>
          </div>
        </div>

        {/* Endpoints Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          <div className="bg-neutral-50 p-3.5 rounded-xl border border-neutral-100">
            <p className="text-neutral-500 text-xs font-medium mb-1">MCP Endpoint (OAuth Protected)</p>
            <code className="text-neutral-800 bg-neutral-200/60 px-2 py-0.5 rounded text-xs font-mono">/mcp</code>
          </div>
          <div className="bg-neutral-50 p-3.5 rounded-xl border border-neutral-100">
            <p className="text-neutral-500 text-xs font-medium mb-1">Android WS Endpoint</p>
            <code className="text-neutral-800 bg-neutral-200/60 px-2 py-0.5 rounded text-xs font-mono">/ws</code>
          </div>
          <div className="bg-neutral-50 p-3.5 rounded-xl border border-neutral-100">
            <p className="text-neutral-500 text-xs font-medium mb-1">VISION OAuth Authorize</p>
            <code className="text-neutral-800 bg-neutral-200/60 px-2 py-0.5 rounded text-xs font-mono">/authorize</code>
          </div>
          <div className="bg-neutral-50 p-3.5 rounded-xl border border-neutral-100">
            <p className="text-neutral-500 text-xs font-medium mb-1">OAuth Discovery (RFC 8414)</p>
            <code className="text-neutral-800 bg-neutral-200/60 px-2 py-0.5 rounded text-xs font-mono">/.well-known/oauth-authorization-server</code>
          </div>
        </div>

        {error && (
          <div className="text-red-600 text-sm bg-red-50 border border-red-100 p-3 rounded-lg">
            {error}
          </div>
        )}

        {/* VISION Identity Accounts & Multi-Device Hierarchy */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium flex items-center gap-2">
              Connected Accounts &amp; Devices
              <span className="bg-neutral-100 text-neutral-600 px-2.5 py-0.5 rounded-full text-xs font-semibold">
                {devices.length} online
              </span>
            </h2>
          </div>

          {accounts.length === 0 ? (
            <div className="text-center py-12 bg-neutral-50 rounded-xl border border-neutral-200 border-dashed">
              <p className="text-neutral-400 text-sm">
                Waiting for Android devices or Claude MCP OAuth connections...
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {accounts.map((account) => (
                <div
                  key={account.google_subject_id}
                  className="p-5 bg-neutral-50 rounded-xl border border-neutral-200 space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200/70 pb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-neutral-900 text-white flex items-center justify-center font-semibold text-sm">
                        G
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-neutral-900">{account.email}</span>
                          <span className="text-xs font-mono bg-neutral-200/80 text-neutral-800 px-2 py-0.5 rounded">
                            {account.id}
                          </span>
                        </div>
                        <p className="text-xs font-mono text-neutral-500">
                          sub: {account.google_subject_id}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 px-2.5 py-1 rounded-full">
                        {account.activeTokens} Claude OAuth {account.activeTokens === 1 ? 'Grant' : 'Grants'}
                      </span>
                      <span className="text-xs font-medium bg-neutral-200/70 text-neutral-700 px-2.5 py-1 rounded-full">
                        {account.devices.length} {account.devices.length === 1 ? 'Device' : 'Devices'}
                      </span>
                    </div>
                  </div>

                  {account.devices.length === 0 ? (
                    <p className="text-xs text-neutral-400 italic pl-2">
                      No Android phones paired to this VISION account yet.
                    </p>
                  ) : (
                    <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {account.devices.map((device) => (
                        <li
                          key={device.deviceId}
                          className="p-4 bg-white rounded-xl border border-neutral-200/80 flex flex-col gap-2.5"
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="font-semibold text-sm text-neutral-900">
                                {device.deviceName || device.name || 'Android Device'}
                              </p>
                              <p className="text-xs font-mono text-neutral-500">{device.deviceId}</p>
                            </div>
                            <span
                              className={`text-xs font-medium px-2.5 py-0.5 rounded-full border ${
                                device.online
                                  ? 'text-green-700 bg-green-50 border-green-200'
                                  : 'text-neutral-500 bg-neutral-100 border-neutral-200'
                              }`}
                            >
                              {device.online ? 'Connected' : 'Offline'}
                            </span>
                          </div>

                          <div className="flex flex-wrap gap-3 text-xs text-neutral-600">
                            {device.os && (
                              <span>
                                <strong>OS:</strong> {device.os}
                              </span>
                            )}
                            {device.ip && (
                              <span>
                                <strong>IP:</strong> {device.ip}
                              </span>
                            )}
                          </div>

                          {device.capabilities && device.capabilities.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 pt-1">
                              {device.capabilities.map((cap) => (
                                <span
                                  key={cap}
                                  className="px-2 py-0.5 bg-neutral-100 text-neutral-700 rounded text-[11px] font-medium"
                                >
                                  {cap}
                                </span>
                              ))}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Real-Time Analytics Section */}
        <div className="pt-6 border-t border-neutral-100">
          <h2 className="text-lg font-medium mb-4">Real-Time Analytics</h2>

          {analytics ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-neutral-50 p-4 rounded-xl border border-neutral-100 flex flex-col">
                <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-1">
                  Tasks Completed
                </span>
                <span className="text-2xl font-semibold text-neutral-900">{analytics.tasksCompleted}</span>
              </div>
              <div className="bg-neutral-50 p-4 rounded-xl border border-neutral-100 flex flex-col">
                <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-1">
                  Success Rate
                </span>
                <span className="text-2xl font-semibold text-neutral-900">{analytics.successRate}%</span>
              </div>
              <div className="bg-neutral-50 p-4 rounded-xl border border-neutral-100 flex flex-col">
                <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-1">
                  Response Time
                </span>
                <span className="text-2xl font-semibold text-neutral-900">{analytics.responseTimeMs}ms</span>
              </div>
              <div className="bg-neutral-50 p-4 rounded-xl border border-neutral-100 flex flex-col">
                <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-1">
                  Data Processed
                </span>
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
              <h3 className="text-sm font-medium text-neutral-500 uppercase tracking-wider mb-2">
                System Alerts
              </h3>
              <ul className="space-y-2">
                {analytics.alerts.map((alert: any) => (
                  <li
                    key={alert.id}
                    className={`p-3 rounded-lg border text-sm flex items-center justify-between ${
                      alert.status === 'CRITICAL'
                        ? 'bg-red-50 border-red-100 text-red-800'
                        : alert.status === 'WARNING'
                        ? 'bg-amber-50 border-amber-100 text-amber-800'
                        : 'bg-green-50 border-green-100 text-green-800'
                    }`}
                  >
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
  );
}
