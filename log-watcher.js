const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const Database = require('better-sqlite3');

const SESSIONS_DIR = '/Users/al/.openclaw/agents/main/sessions';
const DB_PATH = '/Users/al/.openclaw/workspace/projects/agent-exhaust/agent_events.db';
const db = new Database(DB_PATH);

const insertStmt = db.prepare('INSERT INTO events (sessionKey, timestamp, model, type, content_snippet, status, source) VALUES (?, ?, ?, ?, ?, ?, ?)');

const SESSIONS_JSON_PATH = path.join(SESSIONS_DIR, 'sessions.json');
let sessionsMap = {};

function loadSessionsMap() {
  try {
    if (fs.existsSync(SESSIONS_JSON_PATH)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_JSON_PATH, 'utf8'));
      const map = {};
      for (const [key, val] of Object.entries(data)) {
        if (val.sessionId) {
          map[val.sessionId] = key;
        }
      }
      sessionsMap = map;
    }
  } catch (e) {
    console.error('Error loading sessions map:', e);
  }
}

// Load initially
loadSessionsMap();

// Watch sessions.json for changes
const sessionsWatcher = chokidar.watch(SESSIONS_JSON_PATH);
sessionsWatcher.on('change', () => {
  loadSessionsMap();
});

function getSource(sessionKey, event, snippet) {
  const text = snippet || '';
  const lowerText = text.toLowerCase();

  // Heartbeat has priority
  if (lowerText.includes('read heartbeat.md if it exists') || lowerText.includes('heartbeat_ok')) return 'heartbeat';
  
  // Explicit tags in content
  if (text.includes('[cron:')) return 'cron';
  if (text.includes('[subagent:')) return 'subagent';

  // Telegram user ID check (user_initiated)
  // This covers both the user message and any metadata containing the ID
  if (text.includes('7969283458')) return 'user_initiated';

  // Map via sessions.json
  const fullKey = sessionsMap[sessionKey];
  if (fullKey) {
    if (fullKey === 'agent:main:main') return 'user_initiated';
    if (fullKey.includes(':cron:')) return 'cron';
    if (fullKey.includes(':subagent:')) return 'subagent';
  }

  // Default for user messages (even if ID is missing)
  if (event.type === 'message' && event.message?.role === 'user') {
    return 'user_initiated';
  }

  return 'unknown';
}

function processFile(filePath, isInitial = false) {
  if (!filePath.endsWith('.jsonl')) return;
  
  try {
    const stats = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content) return;
    
    const lines = content.trim().split('\n');
    const sessionKey = path.basename(filePath, '.jsonl');
    const sixHoursAgo = Date.now() - (6 * 60 * 60 * 1000);

    // If initial, process only relevant lines from last 6 hours
    // Otherwise just process the latest line
    const linesToProcess = isInitial ? lines : [lines[lines.length - 1]];

    db.transaction(() => {
        for (const line of linesToProcess) {
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            const timestamp = event.timestamp ? new Date(event.timestamp).getTime() : stats.mtimeMs;

            if (isInitial && timestamp < sixHoursAgo) continue;

            // Check if already in DB to prevent duplicates on file changes
            const existing = db.prepare('SELECT id FROM events WHERE sessionKey = ? AND timestamp = ?').get(sessionKey, timestamp);
            if (existing) continue;

            // Slice content to 1000 chars to prevent DB ballooning
            const snippet = line.slice(0, 1000);

            insertStmt.run(
              sessionKey,
              timestamp,
              event.model || event.message?.model || 'unknown',
              event.type || 'unknown',
              snippet,
              event.status || 'ok',
              getSource(sessionKey, event, snippet)
            );
          } catch (e) {}
        }
    })();
  } catch (e) {}
}

const watcher = chokidar.watch(SESSIONS_DIR, {
  persistent: true,
  ignoreInitial: false,
  depth: 0
});

watcher.on('add', (filePath) => processFile(filePath, true));
watcher.on('change', (filePath) => processFile(filePath, false));

console.log(`Watching ${SESSIONS_DIR} for agent exhaust (snippet mode)...`);
