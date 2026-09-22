// scripts/retrigger.js - Square Era Auto-Retrigger Dispatcher
// Retriggers successor workflow run before 5-hour cutoff

const https = require('https');

const GH_PAT = process.env.GH_PAT || process.env.GITHUB_TOKEN;
const OWNER = 'yasamarium';
const REPO = 'square-era-server-room5';
const WORKFLOW_ID = 'runner.yml';

if (!GH_PAT) {
  console.warn('GH_PAT token missing. Retriggering relying on schedule cron.');
  process.exit(0);
}

const payload = JSON.stringify({ ref: 'main' });

const options = {
  hostname: 'api.github.com',
  path: `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_ID}/dispatches`,
  method: 'POST',
  headers: {
    'User-Agent': 'NodeJS-Retrigger',
    'Authorization': `Bearer ${GH_PAT}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

const req = https.request(options, res => {
  if (res.statusCode === 204 || res.statusCode === 200 || res.statusCode === 201) {
    console.log(`Success: Dispatched successor workflow for ${REPO}!`);
    process.exit(0);
  } else {
    console.warn(`Retrigger response: HTTP ${res.statusCode}`);
    process.exit(0);
  }
});

req.on('error', err => {
  console.warn('Retrigger dispatch network notice:', err.message);
  process.exit(0);
});

req.write(payload);
req.end();
