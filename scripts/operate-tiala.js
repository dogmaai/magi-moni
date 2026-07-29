#!/usr/bin/env node
/**
 * operate-tiala.js — Devin-facing CLI for TIALA remote operations.
 *
 * Wraps lib/tiala.js and lib/tools.js so Devin (and humans) can operate the
 * TIALA (Mac mini M4) host from the shell. Requires:
 *   - GCP_SERVICE_ACCOUNT_KEY env var (or GOOGLE_APPLICATION_CREDENTIALS)
 *   - OPENCLAW_GATEWAY_TOKEN env var (if the OpenClaw URL is a public/tunnel URL)
 *   - OPENCLAW_URL env var (optional; overrides BigQuery discovery)
 *
 * Usage:
 *   node scripts/operate-tiala.js services
 *   node scripts/operate-tiala.js system
 *   node scripts/operate-tiala.js screenshot [output.jpg]
 *   node scripts/operate-tiala.js restart <service> --confirm
 *   node scripts/operate-tiala.js exec --command="ollama list" --confirm
 *   node scripts/operate-tiala.js action --action=click --coordinate=100,200 --confirm
 *   node scripts/operate-tiala.js agent "Safariを開いてdogma.jpを表示して" --confirm
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Set up GCP credentials from the environment variable used by Devin snapshots.
// Use a stable filename so repeated invocations do not pile up files in the
// home directory. A fixed path in the user's home dir is safe with 0o600.
const gcpKeyJson = process.env.GCP_SERVICE_ACCOUNT_KEY;
if (gcpKeyJson && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const keyFile = process.env.GCP_KEY_FILE || path.join(
    os.homedir(),
    '.magi-moni-gcp.json'
  );
  fs.writeFileSync(keyFile, gcpKeyJson, { mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFile;
}

const {
  getServicesStatus,
  getSystemInfo,
  getScreenshot,
} = require('../lib/tiala');
const { executeAka1Tool } = require('../lib/tools');

const BOOLEAN_FLAGS = new Set(['confirm', 'json']);

function parseArgs(argv) {
  const positional = [];
  const options = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      let key, value;
      if (eq !== -1) {
        key = arg.slice(2, eq);
        value = arg.slice(eq + 1);
      } else {
        key = arg.slice(2);
        if (BOOLEAN_FLAGS.has(key)) {
          value = true;
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          value = argv[++i];
        } else {
          value = true;
        }
      }
      if (key === 'coordinate') {
        value = String(value).split(/[,\s]+/).map(Number).filter(n => Number.isFinite(n));
      }
      if (key === 'keys') {
        value = String(value).split(/[,\s]+/);
      }
      options[key] = value;
    } else {
      positional.push(arg);
    }
  }

  return { positional, options };
}

function printUsage() {
  console.log(`Usage: node scripts/operate-tiala.js <command> [options]

Commands:
  services                              Query TIALA service statuses
  system                                Query TIALA system info
  screenshot [output.jpg]               Capture TIALA screen and save to file
  restart <service_name>                Restart a TIALA service (requires --confirm)
  exec --command=<cmd>                Execute an allowlisted command (requires --confirm)
  action --action=<name> [options]    Perform a GUI action (requires --confirm)
  agent "<instruction>" [options]       Delegate to the OpenClaw agent (requires --confirm)

Action options:
  --coordinate=x,y                    Click/scroll coordinate
  --text=<string>                     Text to type
  --key=<name>                        Single key to press
  --keys=a,b                          Hotkey combination
  --direction=up|down                 Scroll direction
  --amount=<number>                   Scroll amount

Agent options:
  --model=<model>                     OpenClaw model (default: openclaw/default)
  --session-key=<key>                 Session key for continuity

Common options:
  --confirm                           Confirm dangerous operations
  --json                              Print raw JSON output
`);
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional.shift();

  if (!command) {
    printUsage();
    process.exit(1);
  }

  const confirmed = !!options.confirm;

  try {
    switch (command) {
      case 'services':
      case 'status': {
        const result = await getServicesStatus();
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'system':
      case 'info': {
        const result = await getSystemInfo();
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'screenshot': {
        const result = await getScreenshot();
        const outFile = positional[0] || `/tmp/tiala-screenshot-${Date.now()}.jpg`;
        fs.writeFileSync(outFile, result.base64, 'base64');
        console.log(JSON.stringify({
          status: result.status,
          source: result.source,
          contentType: result.contentType,
          file: path.resolve(outFile),
          base64_length: result.base64?.length || 0
        }, null, 2));
        break;
      }

      case 'restart': {
        const serviceName = positional[0] || options.service_name;
        if (!serviceName) {
          console.error('Error: service_name is required');
          printUsage();
          process.exit(1);
        }
        const result = await executeAka1Tool('tiala_restart', { service_name: serviceName, confirmed });
        if (result.status === 'confirmation_required') {
          console.log(JSON.stringify(result, null, 2));
          process.exit(2);
        }
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'exec': {
        const cmd = options.command || positional.join(' ');
        if (!cmd) {
          console.error('Error: command is required (use --command="...")');
          printUsage();
          process.exit(1);
        }
        const result = await executeAka1Tool('tiala_exec', { command: cmd, confirmed });
        if (result.status === 'confirmation_required') {
          console.log(JSON.stringify(result, null, 2));
          process.exit(2);
        }
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'action': {
        const action = options.action || positional.shift();
        if (!action) {
          console.error('Error: action is required (use --action=<name>)');
          printUsage();
          process.exit(1);
        }
        const result = await executeAka1Tool('tiala_action', {
          action,
          coordinate: options.coordinate,
          text: options.text,
          key: options.key,
          keys: options.keys,
          direction: options.direction,
          amount: options.amount ? Number(options.amount) : undefined,
          confirmed,
        });
        if (result.status === 'confirmation_required') {
          console.log(JSON.stringify(result, null, 2));
          process.exit(2);
        }
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'agent': {
        const instruction = positional.join(' ') || options.instruction;
        if (!instruction) {
          console.error('Error: instruction is required');
          printUsage();
          process.exit(1);
        }
        const result = await executeAka1Tool('openclaw_agent', {
          instruction,
          model: options.model,
          session_key: options['session-key'] || options.session_key,
          confirmed,
        });
        if (result.status === 'confirmation_required') {
          console.log(JSON.stringify(result, null, 2));
          process.exit(2);
        }
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
