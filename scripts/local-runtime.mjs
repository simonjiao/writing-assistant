#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const userId = process.getuid?.();
const nodeDir = dirname(process.execPath);

const services = {
  api: {
    label: 'local.writing-assistant.api',
    port: 8787,
    stdout: resolve(projectRoot, '.data/logs/api.log'),
    stderr: resolve(projectRoot, '.data/logs/api.err'),
    command: 'exec node apps/api/dist/server.js',
    buildWorkspaces: ['@wa/core', '@wa/skills', '@wa/api'],
  },
  web: {
    label: 'local.writing-assistant.web',
    port: 5173,
    stdout: resolve(projectRoot, '.data/logs/web.log'),
    stderr: resolve(projectRoot, '.data/logs/web.err'),
    command: 'exec npm run dev --workspace @wa/web',
    buildWorkspaces: [],
  },
};

const action = process.argv[2] ?? 'status';
const target = process.argv[3] ?? 'all';

if (process.platform !== 'darwin') {
  fail('local:* runtime scripts use macOS launchctl. Use Docker or add a platform-specific runner for non-macOS hosts.');
}
if (userId === undefined) fail('Cannot determine current user id for launchctl.');
checkNode22();

const selected = selectServices(target);

if (action === 'start') {
  start(selected);
} else if (action === 'stop') {
  stop(selected);
} else if (action === 'restart') {
  stop(selected);
  start(selected);
} else if (action === 'status') {
  await status(selected);
} else {
  fail(`Unknown action "${action}". Use start, stop, restart, or status.`);
}

function selectServices(value) {
  if (value === 'all') return Object.entries(services);
  if (services[value]) return [[value, services[value]]];
  fail(`Unknown target "${value}". Use all, api, or web.`);
}

function start(entries) {
  const buildSet = new Set(entries.flatMap(([, service]) => service.buildWorkspaces));
  for (const workspace of buildSet) run('npm', ['run', 'build', '--workspace', workspace]);

  mkdirSync(resolve(projectRoot, '.data/logs'), { recursive: true });
  for (const [name, service] of entries) {
    const existing = serviceState(service);
    if (existing?.running) {
      console.log(`${name}: already running (${service.label})`);
      continue;
    }
    if (isPortInUse(service.port)) {
      fail(`${name}: port ${service.port} is already in use by an unmanaged process. Stop it before using npm run local:start -- ${name}.`);
    }
    if (existing) removeService(service);
    const shellCommand = `cd ${shellQuote(projectRoot)} && PATH=${shellQuote(nodeDir)}:$PATH ${service.command}`;
    run('launchctl', ['submit', '-l', service.label, '-o', service.stdout, '-e', service.stderr, '--', '/bin/zsh', '-lc', shellCommand]);
    console.log(`${name}: started (${service.label})`);
  }
}

function stop(entries) {
  for (const [name, service] of entries) {
    if (!serviceState(service)) {
      console.log(`${name}: stopped`);
      continue;
    }
    removeService(service);
    console.log(`${name}: stopped (${service.label})`);
  }
}

async function status(entries) {
  for (const [name, service] of entries) {
    const state = serviceState(service);
    const portUsed = isPortInUse(service.port);
    const health = name === 'api' ? await healthText(`http://127.0.0.1:${service.port}/health`) : await healthText(`http://127.0.0.1:${service.port}/`);
    const pidText = state?.pid ? ` pid=${state.pid}` : '';
    const statusText = state?.running ? 'running' : (portUsed ? 'unmanaged' : 'stopped');
    console.log(`${name}: ${statusText}${pidText} port=${service.port} health=${health}`);
    console.log(`  logs: ${service.stdout}`);
  }
}

function serviceState(service) {
  const output = launchctlPrint(service.label);
  if (!output) return undefined;
  const pid = output.match(/\bpid = (\d+)/)?.[1];
  return { running: output.includes('state = running'), pid };
}

function removeService(service) {
  spawnSync('launchctl', ['remove', service.label], { cwd: projectRoot, stdio: 'ignore' });
}

function launchctlPrint(label) {
  const result = spawnSync('launchctl', ['print', `gui/${userId}/${label}`], { cwd: projectRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : undefined;
}

function isPortInUse(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { cwd: projectRoot, encoding: 'utf8' });
  return result.status === 0 && result.stdout.includes(`:${port}`);
}

async function healthText(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    return response.ok ? 'ok' : `http-${response.status}`;
  } catch {
    return 'unreachable';
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit', env: { ...process.env, PATH: `${nodeDir}:${process.env.PATH ?? ''}` } });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed.`);
}

function checkNode22() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 22) fail(`Node 22 is required. Current Node is ${process.version}. Run nvm use first.`);
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
