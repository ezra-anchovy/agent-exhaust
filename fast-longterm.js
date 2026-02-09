/**
 * Fast Long-term Synthesizer - Heuristic only, no LLM
 * Generates daily syntheses from hourly data
 */

const Database = require('better-sqlite3');
const DB_PATH = '/Users/al/.openclaw/workspace/projects/agent-exhaust/agent_events.db';
const db = new Database(DB_PATH);

// Ensure table exists
db.exec(`
    CREATE TABLE IF NOT EXISTS daily_syntheses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE,
        synthesis_count INTEGER,
        top_themes TEXT,
        productivity_summary TEXT,
        recommendations TEXT,
        created_at INTEGER
    )
`);

const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

// Get days with syntheses but no daily summary
const getDaysToProcess = db.prepare(`
    SELECT date(hour_bucket/1000, 'unixepoch', 'localtime') as day,
           COUNT(*) as hours,
           SUM(event_count) as events
    FROM syntheses
    WHERE hour_bucket > ?
    AND date(hour_bucket/1000, 'unixepoch', 'localtime') NOT IN (SELECT date FROM daily_syntheses)
    AND date(hour_bucket/1000, 'unixepoch', 'localtime') < date('now', 'localtime')
    GROUP BY day
    HAVING hours >= 4
    ORDER BY day ASC
`);

// Get theme breakdown for a day
const getDayThemes = db.prepare(`
    SELECT dominant_theme, COUNT(*) as hours, SUM(event_count) as events
    FROM syntheses
    WHERE date(hour_bucket/1000, 'unixepoch', 'localtime') = ?
    GROUP BY dominant_theme
    ORDER BY events DESC
`);

// Get work modes for a day
const getDayModes = db.prepare(`
    SELECT work_mode, COUNT(*) as hours
    FROM syntheses
    WHERE date(hour_bucket/1000, 'unixepoch', 'localtime') = ?
    GROUP BY work_mode
    ORDER BY hours DESC
`);

const insertDaily = db.prepare(`
    INSERT OR REPLACE INTO daily_syntheses (date, synthesis_count, top_themes, productivity_summary, recommendations, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
`);

function generateSummary(day, hours, events, themes, modes) {
    const topTheme = themes[0]?.dominant_theme || 'OPERATIONS';
    const topMode = modes[0]?.work_mode || 'mixed';
    
    // Calculate ratios
    const codingHours = themes.find(t => t.dominant_theme === 'CODING')?.hours || 0;
    const debugHours = themes.find(t => t.dominant_theme === 'DEBUGGING')?.hours || 0;
    const shippingHours = modes.find(m => m.work_mode === 'shipping_sprint')?.hours || 0;
    const researchHours = themes.find(t => t.dominant_theme === 'RESEARCH')?.hours || 0;
    
    const debugRatio = hours > 0 ? (debugHours / hours * 100).toFixed(0) : 0;
    const shippingRatio = hours > 0 ? (shippingHours / hours * 100).toFixed(0) : 0;
    
    let summary = `${hours}h active, ${events} events. Primary: ${topTheme.toLowerCase()}. `;
    
    if (debugRatio > 30) {
        summary += `High debugging load (${debugRatio}%). `;
    }
    if (shippingRatio < 10 && hours > 8) {
        summary += `Low shipping velocity (${shippingRatio}%). `;
    }
    if (events > 10000) {
        summary += `High activity day. `;
    }
    
    return summary.trim();
}

function generateRecommendations(themes, modes, hours) {
    const recs = [];
    
    const debugHours = themes.find(t => t.dominant_theme === 'DEBUGGING')?.hours || 0;
    const codingHours = themes.find(t => t.dominant_theme === 'CODING')?.hours || 0;
    const shippingHours = modes.find(m => m.work_mode === 'shipping_sprint')?.hours || 0;
    const mixedHours = modes.find(m => m.work_mode === 'mixed')?.hours || 0;
    
    if (debugHours / hours > 0.25) {
        recs.push('Reduce debugging overhead - consider better error handling or testing');
    }
    if (shippingHours / hours < 0.1 && hours > 8) {
        recs.push('Increase shipping focus - more time building, less researching');
    }
    if (mixedHours / hours > 0.5) {
        recs.push('Reduce context switching - batch similar tasks together');
    }
    if (codingHours > 10 && shippingHours < 2) {
        recs.push('Code is being written but not shipped - prioritize completion');
    }
    
    return recs.length > 0 ? recs.join('; ') : 'Maintain current pace';
}

console.log('[FastLongterm] Starting daily synthesis...');

const days = getDaysToProcess.all(oneWeekAgo);
console.log(`[FastLongterm] Found ${days.length} days to process`);

for (const day of days) {
    const themes = getDayThemes.all(day.day);
    const modes = getDayModes.all(day.day);
    
    const topThemes = JSON.stringify(themes.slice(0, 5));
    const summary = generateSummary(day.day, day.hours, day.events, themes, modes);
    const recommendations = generateRecommendations(themes, modes, day.hours);
    
    insertDaily.run(day.day, day.hours, topThemes, summary, recommendations, Date.now());
    console.log(`[FastLongterm] ✅ ${day.day}: ${day.hours}h, ${day.events} events`);
}

console.log('[FastLongterm] Complete!');

// Show results
const results = db.prepare('SELECT * FROM daily_syntheses ORDER BY date DESC LIMIT 7').all();
console.log('\n=== DAILY SYNTHESES ===');
results.forEach(r => {
    console.log(`\n${r.date}:`);
    console.log(`  ${r.productivity_summary}`);
    console.log(`  → ${r.recommendations}`);
});
