/**
 * Fast Heuristic Backfill - No LLM
 * Uses keyword matching to classify 17K+ events quickly
 */

const Database = require('better-sqlite3');
const DB_PATH = '/Users/al/.openclaw/workspace/projects/agent-exhaust/agent_events.db';
const db = new Database(DB_PATH);

const TAXONOMY = [
    'INFRASTRUCTURE', 'RESEARCH', 'CODING', 'COMMUNICATION', 
    'PLANNING', 'ANALYSIS', 'OPERATIONS', 'MEMORY', 
    'DEBUGGING', 'SHIPPING'
];

// Keyword patterns for fast classification
const PATTERNS = {
    DEBUGGING: /debug|error|fix|troubleshoot|issue|fail|broken|stack|trace|exception|crash/i,
    SHIPPING: /ship|deploy|commit|push|release|publish|done|finish|complete|merge|pr\b/i,
    CODING: /code|script|function|implement|refactor|write|create|build|develop|edit|file/i,
    RESEARCH: /search|fetch|find|discover|lookup|query|explore|investigate|browse|read/i,
    INFRASTRUCTURE: /config|gateway|restart|setup|env|plugin|cache|install|server|port|process/i,
    ANALYSIS: /analy|probab|market|eval|summar|aggregat|calculat|roi|metric|stat|report/i,
    COMMUNICATION: /msg|notif|telegram|user|comm|reply|tweet|post|email|chat|send|message/i,
    MEMORY: /memory|remember|recall|context|history|session|persist|store|save/i,
    PLANNING: /plan|schedule|task|todo|priority|roadmap|next|will|should|goal/i,
    OPERATIONS: /ops|monitor|health|status|check|run|exec|process|manage/i
};

function classifyEvent(content) {
    if (!content) return 'OPERATIONS';
    
    for (const [theme, pattern] of Object.entries(PATTERNS)) {
        if (pattern.test(content)) return theme;
    }
    return 'OPERATIONS';
}

function generateSummary(content, type) {
    if (!content) return 'Agent activity';
    // Truncate and clean
    const clean = content.substring(0, 200).replace(/\n/g, ' ').trim();
    return clean || `${type || 'Event'} recorded`;
}

// Get uninterpreted events
const getUninterpreted = db.prepare(`
    SELECT id, sessionKey, timestamp, content_snippet as content, type
    FROM events 
    WHERE id NOT IN (SELECT id FROM interpretations)
    ORDER BY timestamp ASC
`);

const insertInterpretation = db.prepare(`
    INSERT OR IGNORE INTO interpretations (id, sessionKey, timestamp, summary, theme, model)
    VALUES (?, ?, ?, ?, ?, 'heuristic-v1')
`);

console.log('[Backfill] Starting fast heuristic classification...');

const events = getUninterpreted.all();
console.log(`[Backfill] Found ${events.length} uninterpreted events`);

let processed = 0;
const batchSize = 1000;

const insertMany = db.transaction((batch) => {
    for (const event of batch) {
        const theme = classifyEvent(event.content);
        const summary = generateSummary(event.content, event.type);
        insertInterpretation.run(event.id, event.sessionKey, event.timestamp, summary, theme);
    }
});

// Process in batches
for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize);
    insertMany(batch);
    processed += batch.length;
    console.log(`[Backfill] Processed ${processed}/${events.length} (${((processed/events.length)*100).toFixed(1)}%)`);
}

console.log(`[Backfill] Complete! Classified ${processed} events`);

// Verify
const remaining = db.prepare(`SELECT COUNT(*) as count FROM events WHERE id NOT IN (SELECT id FROM interpretations)`).get();
console.log(`[Backfill] Remaining uninterpreted: ${remaining.count}`);
