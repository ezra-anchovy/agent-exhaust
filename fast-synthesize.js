/**
 * Fast Heuristic Synthesizer - No LLM
 * Generates hourly syntheses using aggregation only
 */

const Database = require('better-sqlite3');
const DB_PATH = '/Users/al/.openclaw/workspace/projects/agent-exhaust/agent_events.db';
const db = new Database(DB_PATH);

const oneHourMs = 3600 * 1000;
const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

// Get hours needing synthesis
const getUnsynthesizedHours = db.prepare(`
    SELECT 
        (e.timestamp / ${oneHourMs}) * ${oneHourMs} as hour_bucket,
        COUNT(*) as event_count
    FROM events e
    JOIN interpretations i ON e.id = i.id
    WHERE e.timestamp > ?
    AND (e.timestamp / ${oneHourMs}) * ${oneHourMs} NOT IN (SELECT hour_bucket FROM syntheses)
    GROUP BY hour_bucket
    HAVING COUNT(*) >= 5
    ORDER BY hour_bucket ASC
`);

// Get theme breakdown for an hour
const getThemeBreakdown = db.prepare(`
    SELECT i.theme, COUNT(*) as count
    FROM events e
    JOIN interpretations i ON e.id = i.id
    WHERE e.timestamp >= ? AND e.timestamp < ?
    GROUP BY i.theme
    ORDER BY count DESC
`);

const insertSynthesis = db.prepare(`
    INSERT OR IGNORE INTO syntheses (hour_bucket, event_count, summary, dominant_theme, theme_breakdown, work_mode, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

function determineWorkMode(themes) {
    const top = themes[0]?.theme;
    if (!top) return 'mixed';
    
    const modeMap = {
        'SHIPPING': 'shipping_sprint',
        'RESEARCH': 'research_dive',
        'DEBUGGING': 'debugging_session',
        'PLANNING': 'planning',
        'INFRASTRUCTURE': 'maintenance',
        'CODING': 'shipping_sprint',
    };
    return modeMap[top] || 'mixed';
}

function generateSummary(themes, eventCount) {
    const topThemes = themes.slice(0, 3).map(t => t.theme.toLowerCase()).join(', ');
    return `Processed ${eventCount} events. Primary focus: ${topThemes}.`;
}

console.log('[FastSynth] Starting...');

const hours = getUnsynthesizedHours.all(oneWeekAgo);
console.log(`[FastSynth] Found ${hours.length} hours to synthesize`);

let processed = 0;
for (const hour of hours) {
    const themes = getThemeBreakdown.all(hour.hour_bucket, hour.hour_bucket + oneHourMs);
    const dominantTheme = themes[0]?.theme || 'OPERATIONS';
    const themeBreakdown = JSON.stringify(themes);
    const workMode = determineWorkMode(themes);
    const summary = generateSummary(themes, hour.event_count);
    
    insertSynthesis.run(
        hour.hour_bucket,
        hour.event_count,
        summary,
        dominantTheme,
        themeBreakdown,
        workMode,
        Date.now()
    );
    
    processed++;
    if (processed % 10 === 0) {
        console.log(`[FastSynth] Processed ${processed}/${hours.length}`);
    }
}

console.log(`[FastSynth] Complete! Generated ${processed} syntheses`);

// Verify
const total = db.prepare('SELECT COUNT(*) as c FROM syntheses').get();
console.log(`[FastSynth] Total syntheses now: ${total.c}`);
