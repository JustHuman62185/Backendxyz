export interface Alert {
  id: string;
  message: string;
  status: "OK" | "WARNING" | "CRITICAL";
}

class AnalyticsEngine {
  public tasksCompleted = 0;
  public totalRequests = 0;
  public successfulRequests = 0;
  public totalLatencyMs = 0;
  public apiCalls = 0;
  public dataProcessedBytes = 0;
  public alerts: Alert[] = [];

  private hasActivitySinceLastBroadcast = false;

  recordRequest(bytesSent: number) {
    this.totalRequests++;
    this.apiCalls++;
    this.dataProcessedBytes += bytesSent;
    this.hasActivitySinceLastBroadcast = true;
  }

  recordSuccess(latencyMs: number, bytesReceived: number) {
    this.tasksCompleted++;
    this.successfulRequests++;
    this.totalLatencyMs += latencyMs;
    this.dataProcessedBytes += bytesReceived;
    this.hasActivitySinceLastBroadcast = true;
  }

  recordError(bytesReceived: number = 0) {
    this.tasksCompleted++;
    this.dataProcessedBytes += bytesReceived;
    this.hasActivitySinceLastBroadcast = true;
  }

  recordAlert(message: string, status: "OK" | "WARNING" | "CRITICAL") {
    this.alerts.unshift({ id: Date.now().toString(), message, status });
    if (this.alerts.length > 5) this.alerts.pop();
    this.hasActivitySinceLastBroadcast = true;
  }

  getSummary() {
    const successRate = this.totalRequests > 0 
      ? (this.successfulRequests / this.totalRequests) * 100 
      : 100;
      
    const responseTimeMs = this.tasksCompleted > 0 
      ? Math.round(this.totalLatencyMs / this.tasksCompleted) 
      : 0;

    const dataProcessedGb = this.dataProcessedBytes / (1024 * 1024 * 1024);

    return {
      tasksCompleted: this.tasksCompleted,
      successRate: Number(successRate.toFixed(1)),
      responseTimeMs,
      apiCalls: this.apiCalls,
      dataProcessedGb: Number(dataProcessedGb.toFixed(6)), // High precision to show small JSON payloads
      alerts: this.alerts,
    };
  }

  checkAndResetActivity(): boolean {
    const active = this.hasActivitySinceLastBroadcast;
    this.hasActivitySinceLastBroadcast = false;
    return active;
  }
}

export const analytics = new AnalyticsEngine();
