// Hit the deployed canary: WORKER_URL=https://pvd311-worker.<sub>.workers.dev CANARY_TOKEN=... npm run canary
const url = process.env.WORKER_URL, token = process.env.CANARY_TOKEN;
if (!url || !token) { console.error('set WORKER_URL and CANARY_TOKEN'); process.exit(1); }
const r = await fetch(`${url}/canary`, { headers: { 'x-canary-token': token } });
console.log(r.status, JSON.stringify(await r.json(), null, 2));
