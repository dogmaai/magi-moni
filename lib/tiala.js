/**
 * @module lib/tiala
 * TIALA (Mac mini M4) remote operation client via OpenClaw Gateway.
 *
 * Replaces the previous central-dogma REST client. All operations are now
 * dispatched as OpenClaw tool invocations through lib/openclaw.js.
 */
const { callOpenClaw } = require('./openclaw');

const SERVICES = {
  ollama: 11435,
  openclaw: 18789,
  'moomoo-bridge': 11436,
  opend: 11111,
  ttyd: 7681,
  netdata: 19999,
};

// Services whose restart cannot safely be automated via this surface.
const MANUAL_RESTART = new Set(['opend', 'openclaw', 'ttyd', 'netdata']);

const RESTART_COMMANDS = {
  ollama: 'launchctl kickstart -k gui/$(id -u)/com.ollama.server 2>&1 || brew services restart ollama',
  'moomoo-bridge': 'nohup bash $HOME/repos/magi-moomoo/scripts/start-bridge.sh > /dev/null 2>&1 &',
};

function shellQuote(script) {
  // Wrap a Node -e script in single quotes so the remote shell passes it as one argument.
  // The caller must not contain any single quotes.
  return `'${script.replace(/'/g, "'\\''")}'`;
}

function execArgs(command, timeoutSec = 30) {
  return {
    command,
    host: 'gateway',
    security: 'full',
    timeout: timeoutSec,
    ask: 'off'
  };
}

async function getServicesStatus() {
  const svcJson = JSON.stringify(SERVICES);
  const manualJson = JSON.stringify([...MANUAL_RESTART]);
  const script = [
    'const {execSync} = require("child_process");',
    'const os = require("os");',
    `const svc = ${svcJson};`,
    `const manual = new Set(${manualJson});`,
    'const services = Object.entries(svc).map(([name, port]) => {',
    '  try {',
    '    const r = execSync("lsof -i :" + port + " -sTCP:LISTEN -t", {timeout: 5000}).toString().trim();',
    '    return { name, port, port_listening: r.length > 0, process_running: r.length > 0, status: r.length > 0 ? "running" : "stopped", restartable: !manual.has(name) };',
    '  } catch (e) {',
    '    return { name, port, port_listening: false, process_running: false, status: "stopped", restartable: !manual.has(name) };',
    '  }',
    '});',
    'console.log(JSON.stringify({ hostname: os.hostname(), platform: os.platform(), services }));'
  ].join(' ');

  const res = await callOpenClaw('exec', execArgs(`node -e ${shellQuote(script)}`, 15));
  const stdout = (res && (res.stdout || res.output || res.result)) || '';
  const parsed = stdout.match(/\{.*\}/s);
  if (!parsed) {
    return { raw: res, stdout, note: 'Could not parse service status JSON' };
  }
  try {
    return JSON.parse(parsed[0]);
  } catch (e) {
    return { raw: res, stdout, note: 'Could not parse service status JSON', error: e.message };
  }
}

async function restartService(serviceName) {
  if (!(serviceName in SERVICES)) {
    throw new Error(`Unknown service: ${serviceName}. Known services: ${Object.keys(SERVICES).join(', ')}`);
  }
  if (MANUAL_RESTART.has(serviceName)) {
    throw new Error(`Service "${serviceName}" must be restarted manually on TIALA`);
  }
  const command = RESTART_COMMANDS[serviceName];
  if (!command) {
    throw new Error(`No automated restart command configured for ${serviceName}`);
  }
  const res = await callOpenClaw('exec', execArgs(command, 30));
  return { status: 'executed', service: serviceName, output: res };
}

async function executeCommand(command) {
  const res = await callOpenClaw('exec', execArgs(command, 30));
  return { status: 'executed', command, output: res };
}

async function getSystemInfo() {
  const script = [
    'const os = require("os");',
    'const {execSync} = require("child_process");',
    'let diskUsed = null;',
    'try {',
    '  const df = execSync("df -h /", {timeout: 5000}).toString();',
    '  const m = df.split("\\n")[1].match(/([0-9.]+%)/);',
    '  diskUsed = m ? m[1] : null;',
    '} catch (e) {}',
    'const toGb = (b) => Number((b / 1024 / 1024 / 1024).toFixed(2));',
    'const total = toGb(os.totalmem());',
    'const free = toGb(os.freemem());',
    'console.log(JSON.stringify({',
    '  hostname: os.hostname(),',
    '  platform: os.platform(),',
    '  arch: os.arch(),',
    '  uptime_hours: Number((os.uptime() / 3600).toFixed(2)),',
    '  cpu_cores: os.cpus().length,',
    '  cpu_model: os.cpus()[0].model,',
    '  memory: { total_gb: total, free_gb: free, used_pct: Number(((total - free) / total * 100).toFixed(2)) },',
    '  disk_used_pct: diskUsed,',
    '  load_avg: os.loadavg()',
    '}));'
  ].join(' ');

  const res = await callOpenClaw('exec', execArgs(`node -e ${shellQuote(script)}`, 15));
  const stdout = (res && (res.stdout || res.output || res.result)) || '';
  const parsed = stdout.match(/\{.*\}/s);
  if (!parsed) {
    return { raw: res, stdout, note: 'Could not parse system info JSON' };
  }
  try {
    return JSON.parse(parsed[0]);
  } catch (e) {
    return { raw: res, stdout, note: 'Could not parse system info JSON', error: e.message };
  }
}

/**
 * Capture a screenshot from TIALA.
 * First tries the OpenClaw computer tool, then falls back to macOS screencapture.
 */
async function getScreenshot() {
  try {
    const res = await callOpenClaw('computer', { action: 'screenshot' }, { timeout: 30000 });
    return { status: 'ok', source: 'computer', data: res };
  } catch (e) {
    const msg = e.message || '';
    if (!/unknown tool|not found|not available|computer/i.test(msg)) {
      throw e;
    }
  }

  const res = await callOpenClaw(
    'exec',
    execArgs('screencapture -x -t jpg /tmp/magi-moni-screenshot.jpg && base64 /tmp/magi-moni-screenshot.jpg', 30)
  );
  const stdout = (res && (res.stdout || res.output || res.result)) || '';
  const b64 = stdout.replace(/\s/g, '').slice(0, 1000000);
  return { status: 'ok', source: 'screencapture', base64: b64 };
}

/**
 * Perform a screen action on TIALA via the OpenClaw computer tool.
 */
async function performAction({ action, coordinate, text, key, keys, direction, amount }) {
  const args = { action };
  if (coordinate) args.coordinate = coordinate;
  if (text) args.text = text;
  if (key) args.key = key;
  if (keys) args.keys = keys;
  if (direction) args.direction = direction;
  if (amount != null) args.amount = amount;

  const res = await callOpenClaw('computer', args, { timeout: 30000 });
  return { status: 'ok', action, data: res };
}

module.exports = {
  getServicesStatus,
  restartService,
  executeCommand,
  getSystemInfo,
  getScreenshot,
  performAction,
};
