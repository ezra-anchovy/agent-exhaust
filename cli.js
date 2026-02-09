#!/usr/bin/env node

/**
 * Agent Exhaust CLI
 * See what your agent swarm actually did
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const command = args[0];

const SCRIPTS = {
    'start': 'server.js',
    'serve': 'server.js',
    'watch': 'log-watcher.js',
    'ingest': 'log-watcher.js',
    'synthesize': 'fast-synthesize.js',
    'sync': 'fast-synthesize.js',
    'longterm': 'fast-longterm.js',
    'daily': 'fast-longterm.js',
    'backfill': 'fast-backfill.js',
    'interpret': 'fast-backfill.js'
};

function showHelp() {
    console.log(`
Agent Exhaust - Cognitive telemetry for OpenClaw agents

Usage: agent-exhaust <command>

Commands:
  start, serve     Start the dashboard server (default port 3000)
  watch, ingest    Watch session files and ingest events
  synthesize, sync Generate hourly syntheses
  longterm, daily  Generate daily pattern analysis
  backfill         Fast-classify historical events (heuristic)

Examples:
  agent-exhaust start          # Start dashboard at http://localhost:3000
  agent-exhaust watch          # Begin real-time event ingestion
  agent-exhaust synthesize     # Generate missing hourly syntheses

Environment:
  PORT             Dashboard port (default: 3000)
  SESSIONS_DIR     Path to OpenClaw sessions (default: ~/.openclaw/agents/main/sessions)

More info: https://github.com/ezra-anchovy/agent-exhaust
`);
}

if (!command || command === 'help' || command === '--help' || command === '-h') {
    showHelp();
    process.exit(0);
}

const script = SCRIPTS[command];
if (!script) {
    console.error(`Unknown command: ${command}`);
    console.error('Run "agent-exhaust help" for usage');
    process.exit(1);
}

const scriptPath = path.join(__dirname, script);
if (!fs.existsSync(scriptPath)) {
    console.error(`Script not found: ${scriptPath}`);
    process.exit(1);
}

// Run the script
const child = spawn('node', [scriptPath], {
    stdio: 'inherit',
    cwd: __dirname
});

child.on('error', (err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
});

child.on('exit', (code) => {
    process.exit(code || 0);
});
