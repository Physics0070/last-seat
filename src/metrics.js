// A small Prometheus-format metrics registry (counters, gauges, one histogram). No dependency: the whole
// text exposition format is a few lines, and keeping it local means the hot path pays for nothing it does not use.

const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500];
const labelText = (labels) => {
  const pairs = Object.entries(labels).map(([k, v]) => `${k}="${String(v).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`);
  return pairs.length ? `{${pairs.join(',')}}` : '';
};

export function createMetrics() {
  const counters = new Map(); // name -> { help, series: Map<labelText, number> }
  const gauges = new Map(); // name -> { help, read }
  const histograms = new Map(); // name -> { help, series: Map<labelText, { counts, sum, count, labels }> }

  const counter = (name, labels = {}, by = 1) => {
    const entry = counters.get(name);
    if (!entry) throw new Error(`unknown counter ${name}`);
    const key = labelText(labels);
    entry.series.set(key, (entry.series.get(key) ?? 0) + by);
  };

  return {
    describeCounter: (name, help) => counters.set(name, { help, series: new Map() }),
    describeGauge: (name, help, read) => gauges.set(name, { help, read }),
    describeHistogram: (name, help) => histograms.set(name, { help, series: new Map() }),
    inc: counter,
    observe(name, labels, valueMs) {
      const entry = histograms.get(name);
      const key = labelText(labels);
      let s = entry.series.get(key);
      if (!s) entry.series.set(key, (s = { labels, counts: new Array(BUCKETS_MS.length).fill(0), sum: 0, count: 0 }));
      BUCKETS_MS.forEach((le, i) => valueMs <= le && s.counts[i]++);
      s.sum += valueMs;
      s.count++;
    },
    render() {
      const out = [];
      for (const [name, { help, series }] of counters) {
        out.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
        if (series.size === 0) out.push(`${name} 0`);
        for (const [key, value] of series) out.push(`${name}${key} ${value}`);
      }
      for (const [name, { help, read }] of gauges) out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${read()}`);
      for (const [name, { help, series }] of histograms) {
        out.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
        for (const s of series.values()) {
          BUCKETS_MS.forEach((le, i) => out.push(`${name}_bucket${labelText({ ...s.labels, le })} ${s.counts[i]}`));
          out.push(`${name}_bucket${labelText({ ...s.labels, le: '+Inf' })} ${s.count}`, `${name}_sum${labelText(s.labels)} ${s.sum}`, `${name}_count${labelText(s.labels)} ${s.count}`);
        }
      }
      return `${out.join('\n')}\n`;
    },
  };
}

export function defaultMetrics() {
  const m = createMetrics();
  m.describeCounter('txn_retries_total', 'MongoDB transactions retried after a transient error (write conflicts).');
  m.describeCounter('txn_failures_total', 'Transactions that ran out of retries and answered 503.');
  m.describeCounter('api_errors_total', 'Error responses by application error code (team_full, forbidden, rate_limited, ...).');
  m.describeCounter('board_fast_path_hits_total', 'Board pages answered from the cache before any middleware ran.');
  m.describeCounter('idempotent_replays_total', 'Requests answered from a stored Idempotency-Key response instead of running again.');
  m.describeHistogram('http_request_duration_ms', 'Request duration in milliseconds, by method, route template and status.');
  return m;
}
