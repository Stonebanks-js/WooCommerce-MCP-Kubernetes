import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics, served on METRICS_PORT (never through the Ingress). */
export class Metrics {
  readonly registry = new Registry();
  readonly toolCalls: Counter<'server' | 'tool' | 'outcome' | 'source'>;
  readonly toolDuration: Histogram<'server' | 'tool'>;
  readonly upstreamUp: Gauge<'server'>;
  readonly httpRequests: Counter<'route' | 'method' | 'status'>;

  constructor(defaults = true) {
    if (defaults) collectDefaultMetrics({ register: this.registry });
    this.toolCalls = new Counter({
      name: 'gateway_tool_calls_total',
      help: 'Tool calls executed through the gateway core, by outcome',
      labelNames: ['server', 'tool', 'outcome', 'source'],
      registers: [this.registry],
    });
    this.toolDuration = new Histogram({
      name: 'gateway_tool_call_duration_seconds',
      help: 'Upstream tool call duration',
      labelNames: ['server', 'tool'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.registry],
    });
    this.upstreamUp = new Gauge({
      name: 'gateway_upstream_up',
      help: '1 when the upstream MCP server is connected, 0 otherwise (disabled = 0)',
      labelNames: ['server'],
      registers: [this.registry],
    });
    this.httpRequests = new Counter({
      name: 'gateway_http_requests_total',
      help: 'HTTP requests handled by the gateway',
      labelNames: ['route', 'method', 'status'],
      registers: [this.registry],
    });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
