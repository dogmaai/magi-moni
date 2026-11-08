#!/usr/bin/env node
/**
 * operate-tiala.js — read-only CLI for checking the TIALA host.
 *
 * Wraps lib/tiala.js so Devin (and humans) can check the TIALA (Mac mini M4)
 * host from the shell: service status, system info and a screenshot.
 * Mutating operations (restart, command execution, GUI actions, agent
 * delegation) were removed on 2026-11-09 (Jun's decision): they go only
 * through Discord with Jun's confirmation button. Requires:
 *   - GCP_SERVICE_ACCOUNT_KEY env var (or GOOGLE_APPLICATION_CREDENTIALS)
 *   - OPENCLAW_GATEWAY_TOKEN env var (if the OpenClaw URL is a public/tunnel URL)
 *   - OPENCLAW_URL env var (optional; overrides BigQuery discovery)
 *
 * Usage:
 *   node scripts/operate-tiala.js services
 *   node scripts/operate-tiala.js system
 *   node scripts/operate-tiala.js screenshot [output.jpg]
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

const REMOVED_COMMANDS = new Set(['restart', 'exec', 'action', 'agent']);

function printUsage() {
  console.log(`Usage: node scripts/operate-tiala.js <command>

Commands (read-only):
  services                              Query TIALA service statuses
  system                                Query TIALA system info
  screenshot [output.jpg]               Capture TIALA screen and save to file

restart / exec / action / agent were removed: request them in Discord
(/ask), where Jun approves each change with the confirmation button.
`);
}

async function main() {
  const positional = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  const command = positional.shift();

  if (!command) {
    printUsage();
    process.exit(1);
  }

  if (REMOVED_COMMANDS.has(command)) {
    console.error(`'${command}' was removed; request it in Discord (/ask) with Jun's confirmation.`);
    process.exit(2);
  }

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
