import { parentPort } from 'node:worker_threads';
import { initArena } from './duel.mjs';
import { apply } from './params.mjs';
import { runJobs, aggregate, objective } from './evaluate.mjs';

// Arena colliders are built once per worker and reused for every duel of every
// candidate. Job lists are sent once and cached — they are identical across
// generations by design (common random numbers).
let jobs = null;

await initArena();
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', (msg) => {
  if (msg.type === 'jobs') { jobs = msg.jobs; return; }

  if (msg.type === 'eval') {
    apply(msg.vec);
    const metrics = aggregate(runJobs(jobs));
    const loss = objective(metrics);
    parentPort.postMessage({
      type: 'result', id: msg.id, loss: loss.total, parts: loss.parts, metrics,
    });
  }
});
