class LoadTest {
  constructor({ name, concurrency, targetRps, durationMs }) {
    this.name = name;
    this.concurrency = concurrency;
    this.targetRps = targetRps;
    this.durationMs = durationMs;
    this.results = [];
    this.errors = [];
    this.startTime = null;
    this.endTime = null;
  }

  async run(operationFn) {
    this.startTime = Date.now();
    const endTime = this.startTime + this.durationMs;
    let running = 0;
    let completed = 0;

    const runBatch = () => {
      const now = Date.now();
      if (now >= endTime) return;
      const elapsed = now - this.startTime;
      const expected = Math.floor((elapsed / 1000) * this.targetRps);
      const deficit = expected - completed;
      const batchSize = Math.max(0, Math.min(deficit, this.concurrency - running));

      for (let i = 0; i < batchSize; i++) {
        running++;
        const opStart = Date.now();
        operationFn()
          .then(() => {
            this.results.push(Date.now() - opStart);
            completed++;
          })
          .catch((err) => {
            this.errors.push({ time: Date.now() - opStart, message: err.message });
            completed++;
          })
          .finally(() => {
            running--;
          });
      }
    };

    return new Promise((resolve) => {
      const interval = setInterval(() => {
        runBatch();
        if (Date.now() >= endTime && running === 0) {
          clearInterval(interval);
          this.endTime = Date.now();
          resolve();
        }
      }, 10);
    });
  }

  metrics() {
    const duration = (this.endTime - this.startTime) / 1000;
    const ops = this.results.length;
    const errors = this.errors.length;
    const sorted = [...this.results].sort((a, b) => a - b);

    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = ops > 0 ? sum / ops : 0;
    const min = sorted[0] || 0;
    const max = sorted[ops - 1] || 0;
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);

    return {
      name: this.name,
      concurrency: this.concurrency,
      targetRps: this.targetRps,
      durationSec: duration,
      totalOps: ops,
      throughput: duration > 0 ? Math.round(ops / duration) : 0,
      errors,
      errorRate: ops > 0 ? ((errors / (ops + errors)) * 100).toFixed(2) + '%' : '0%',
      latencyMs: { min: min.toFixed(2), avg: avg.toFixed(2), max: max.toFixed(2), p50: p50.toFixed(2), p95: p95.toFixed(2), p99: p99.toFixed(2) },
    };
  }

  report() {
    const m = this.metrics();
    console.log(`\n========== ${m.name} ==========`);
    console.log(`Concurrency: ${m.concurrency} | Target: ${m.targetRps} rps | Duration: ${m.durationSec}s`);
    console.log(`Throughput: ${m.throughput} ops/sec (${m.totalOps} total)`);
    console.log(`Errors: ${m.errors} (${m.errorRate})`);
    console.log(`Latency: avg=${m.latencyMs.avg}ms | p50=${m.latencyMs.p50}ms | p95=${m.latencyMs.p95}ms | p99=${m.latencyMs.p99}ms | min=${m.latencyMs.min}ms | max=${m.latencyMs.max}ms`);
    return m;
  }
}

function percentile(sorted, pct) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function runLoadTestScenarios(name, operationFn, configs) {
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  ${name}`);
  console.log(`═══════════════════════════════════════`);
  const results = [];
  for (const cfg of configs) {
    const test = new LoadTest({ name: `${name} (c=${cfg.concurrency})`, concurrency: cfg.concurrency, targetRps: cfg.targetRps, durationMs: cfg.durationMs });
    await test.run(operationFn);
    results.push(test.report());
    await new Promise((r) => setTimeout(r, 200));
  }
  return results;
}

module.exports = { LoadTest, runLoadTestScenarios, percentile };
