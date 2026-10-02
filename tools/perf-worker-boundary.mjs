import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
// Node communication cost only: no snapshot construction or path computation.
const worker = new Worker(`
  const { parentPort } = require('node:worker_threads');
  parentPort.on('message', message => parentPort.postMessage(message.id));
`, { eval: true });
function ping(payload, transfer = []) {
  return new Promise(resolve => {
    worker.once('message', resolve);
    worker.postMessage(payload, transfer);
  });
}
try {
  await ping({ id: 0 });
  for (const kind of ['small', 'clone-81KiB', 'copy-transfer-81KiB']) {
    const costs = [];
    const source = new Float32Array(144 * 144).fill(1);
    for (let i = 0; i < 550; i++) {
      const start = performance.now();
      if (kind === 'small') await ping({ id: i });
      else if (kind === 'clone-81KiB') await ping({ id: i, cost: source });
      else {
        const copy = source.slice();
        await ping({ id: i, cost: copy }, [copy.buffer]);
      }
      if (i >= 50) costs.push(performance.now() - start);
    }
    costs.sort((a, b) => a - b);
    console.log(JSON.stringify({ kind, p50ms: costs[250], p95ms: costs[475], p99ms: costs[495] }));
  }
} finally { await worker.terminate(); }
