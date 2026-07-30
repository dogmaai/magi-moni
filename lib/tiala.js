/**
 * @module lib/tiala
 * TIALA (Mac mini M4) remote operation client via OpenClaw Gateway.
 *
 * Replaces the previous central-dogma REST client. All operations are now
 * dispatched as OpenClaw tool invocations through lib/openclaw.js.
 */
const { callOpenClawExec } = require('./openclaw');

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

// Cache for the most recent TIALA screenshot so the UI layer can send it to the user.
let lastTialaScreenshot = null;

function shellQuote(script) {
  // Wrap a Node -e script in single quotes so the remote shell passes it as one argument.
  // The caller must not contain any single quotes.
  return `'${script.replace(/'/g, "'\\''")}'`;
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

  const res = await callOpenClawExec(`node -e ${shellQuote(script)}`, 15);
  const stdout = res.stdout || '';
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
  const res = await callOpenClawExec(command, 30);
  return { status: 'executed', service: serviceName, output: res };
}

async function executeCommand(command) {
  const res = await callOpenClawExec(command, 30);
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

  const res = await callOpenClawExec(`node -e ${shellQuote(script)}`, 15);
  const stdout = res.stdout || '';
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

function parseCoordinate(coordinate) {
  if (Array.isArray(coordinate) && coordinate.length >= 2) {
    return { x: Number(coordinate[0]), y: Number(coordinate[1]) };
  }
  if (typeof coordinate === 'string') {
    const parts = coordinate.split(/[,\s]+/).map(Number).filter(n => Number.isFinite(n));
    if (parts.length >= 2) return { x: parts[0], y: parts[1] };
  }
  return null;
}

/**
 * Capture a screenshot from TIALA using the macOS screencapture command.
 * The image is returned as a base64 JPEG.
 */
async function getScreenshot() {
  const tmpFile = `/tmp/magi-moni-screenshot-${Date.now()}.jpg`;
  const command = `screencapture -x -t jpg "${tmpFile}" && base64 "${tmpFile}" && rm -f "${tmpFile}"`;
  const res = await callOpenClawExec(command, 60);

  const stdout = res.stdout || '';
  const b64 = stdout.replace(/\s/g, '').replace(/^data:image\/[^;]+;base64,/, '').slice(0, 10_000_000);
  if (!b64 || b64.length < 100) {
    throw new Error(`screenshot base64 is empty or too small: ${stdout.slice(0, 200)}`);
  }

  lastTialaScreenshot = {
    base64: b64,
    contentType: 'image/jpeg',
    capturedAt: Date.now()
  };

  return {
    status: 'ok',
    source: 'screencapture',
    contentType: 'image/jpeg',
    base64: b64
  };
}

function getLastScreenshot() {
  return lastTialaScreenshot;
}

function clearLastScreenshot() {
  lastTialaScreenshot = null;
}

const KEY_CODE_MAP = {
  return: 36, enter: 76, space: 49, tab: 48, escape: 53,
  delete: 51, backspace: 51, forwarddelete: 117,
  up: 126, down: 125, left: 123, right: 124,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  capslock: 57, help: 114,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111
};

const MODIFIER_MAP = {
  command: 'command', cmd: 'command',
  option: 'option', opt: 'option', alt: 'option',
  control: 'control', ctrl: 'control',
  shift: 'shift', fn: 'fn'
};

function escapeAppleScriptString(text) {
  // Escape backslashes and double quotes, and fold newlines so the
  // keystroke string stays on a single AppleScript source line.
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
}

/**
 * Generate an AppleScript snippet and a cliclick command for a GUI action.
 * Falls back to osascript when cliclick is unavailable.
 */
function buildActionScripts({ action, coordinate, text, key, keys, direction, amount }) {
  const coord = parseCoordinate(coordinate);
  const x = coord ? coord.x : null;
  const y = coord ? coord.y : null;

  let osaScript = '';
  let cliclickCmd = '';

  if (action === 'click' || action === 'left_click') {
    if (x == null || y == null) throw new Error('click には coordinate が必要です');
    osaScript = `tell application "System Events"\n  click at {${x}, ${y}}\nend tell`;
    cliclickCmd = `c:${x},${y}`;
  } else if (action === 'right_click') {
    if (x == null || y == null) throw new Error('right_click には coordinate が必要です');
    osaScript = `tell application "System Events"\n  key down control\n  click at {${x}, ${y}}\n  key up control\nend tell`;
    cliclickCmd = `rc:${x},${y}`;
  } else if (action === 'double_click') {
    if (x == null || y == null) throw new Error('double_click には coordinate が必要です');
    osaScript = `tell application "System Events"\n  double click at {${x}, ${y}}\nend tell`;
    cliclickCmd = `dc:${x},${y}`;
  } else if (action === 'type' || action === 'write') {
    if (text == null) throw new Error('type には text が必要です');
    const safeText = escapeAppleScriptString(text);
    osaScript = `tell application "System Events"\n  keystroke "${safeText}"\nend tell`;
    // cliclick t: doesn't handle complex characters/quotes well, so we only use it as a fallback
    // by writing the raw text into a file and using a helper below.
    cliclickCmd = null;
  } else if (action === 'key' || action === 'press') {
    if (key == null) throw new Error('key には key が必要です');
    const k = String(key).toLowerCase();
    const code = KEY_CODE_MAP[k];
    if (code != null) {
      osaScript = `tell application "System Events"\n  key code ${code}\nend tell`;
    } else if (k.length === 1) {
      const safeKey = escapeAppleScriptString(k);
      osaScript = `tell application "System Events"\n  keystroke "${safeKey}"\nend tell`;
    } else {
      throw new Error(`未知の key: ${key}`);
    }
  } else if (action === 'hotkey' || action === 'keys') {
    const hotkeys = Array.isArray(keys) ? keys : (keys ? [keys] : []);
    if (hotkeys.length === 0) throw new Error('hotkey には keys が必要です');

    const mainKeyRaw = hotkeys[hotkeys.length - 1];
    const modifiers = hotkeys.slice(0, -1).map(m => MODIFIER_MAP[String(m).toLowerCase()]).filter(Boolean);
    const mainKey = String(mainKeyRaw).toLowerCase();
    const code = KEY_CODE_MAP[mainKey];
    const mainKeyEscaped = code != null ? `key code ${code}` : `keystroke "${escapeAppleScriptString(mainKeyRaw)}"`;

    if (modifiers.length > 0) {
      const using = modifiers.map(m => `${m} down`).join(', ');
      osaScript = `tell application "System Events"\n  ${mainKeyEscaped} using {${using}}\nend tell`;
    } else {
      osaScript = `tell application "System Events"\n  ${mainKeyEscaped}\nend tell`;
    }

    // Hotkey is handled with osascript only to avoid interpolating the key
    // character into an unquoted shell command for cliclick.
  } else if (action === 'scroll') {
    if (x == null || y == null) throw new Error('scroll には coordinate が必要です');
    let delta = Number(amount);
    if (!Number.isFinite(delta)) delta = 10;
    if (direction === 'down' || direction === 'backward' || direction === 'back') delta = -Math.abs(delta);
    if (direction === 'up' || direction === 'forward' || direction === 'front') delta = Math.abs(delta);
    osaScript = `tell application "System Events"\n  scroll ${delta} at {${x}, ${y}}\nend tell`;
  } else {
    throw new Error(`未知の action: ${action}`);
  }

  return { osaScript, cliclickCmd };
}

/**
 * Perform a GUI action on TIALA using macOS osascript (System Events).
 * Uses cliclick when available for simple click actions.
 */
async function performAction({ action, coordinate, text, key, keys, direction, amount }) {
  if (!action) throw new Error('action は必須です');

  const { osaScript, cliclickCmd } = buildActionScripts({
    action, coordinate, text, key, keys, direction, amount
  });

  // Prefer cliclick for simple clicks / hotkeys when available.
  if (cliclickCmd) {
    const script = [
      'if command -v cliclick >/dev/null 2>&1; then',
      `  cliclick ${cliclickCmd}`,
      'else',
      '  cat > /tmp/magi_action.scpt << \'EOF\'',
      osaScript,
      'EOF',
      '  osascript /tmp/magi_action.scpt',
      'fi'
    ].join('\n');

    const res = await callOpenClawExec(script, 30);
    return { status: 'ok', action, command: `cliclick fallback`, output: res };
  }

  // Default osascript path.
  const heredoc = [
    'cat > /tmp/magi_action.scpt << \'EOF\'',
    osaScript,
    'EOF',
    'osascript /tmp/magi_action.scpt'
  ].join('\n');

  const res = await callOpenClawExec(heredoc, 30);
  return { status: 'ok', action, output: res };
}

module.exports = {
  getServicesStatus,
  restartService,
  executeCommand,
  getSystemInfo,
  getScreenshot,
  getLastScreenshot,
  clearLastScreenshot,
  performAction,
};
