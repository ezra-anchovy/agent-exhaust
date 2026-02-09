const http = require('http')
const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')

const PORT = process.env.PORT || 3000
const DB_PATH = path.join(__dirname, 'agent_events.db')

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

function getSyntheses(days = 7) {
  const db = new Database(DB_PATH, { readonly: true })
  try {
    const since = Date.now() - (days * 24 * 60 * 60 * 1000)
    const rows = db.prepare(`
      SELECT * FROM syntheses 
      WHERE hour_bucket > ? 
      ORDER BY hour_bucket ASC
    `).all(since)
    
    return rows.map(row => ({
      hour: new Date(row.hour_bucket).toISOString(),
      hourBucket: row.hour_bucket,
      eventCount: row.event_count,
      summary: row.summary,
      theme: row.dominant_theme,
      themeBreakdown: JSON.parse(row.theme_breakdown || '{}'),
      workMode: row.work_mode
    }))
  } catch (e) {
    console.error('getSyntheses error:', e.message)
    return []
  } finally {
    db.close()
  }
}

function getEvents(limit = 1000, since = null) {
  const db = new Database(DB_PATH, { readonly: true })
  try {
    let query = 'SELECT * FROM events'
    const params = []
    
    if (since) {
      query += ' WHERE timestamp > ?'
      params.push(since)
    }
    
    query += ' ORDER BY timestamp DESC LIMIT ?'
    params.push(limit)
    
    const rows = db.prepare(query).all(...params)
    return rows.map(row => {
      // Parse content if JSON
      let content = row.content
      try {
        content = JSON.parse(row.content)
      } catch {}
      
      // Extract agent from sessionKey (format: agent:main:subagent:xxx or agent:main:main)
      const parts = (row.sessionKey || '').split(':')
      const agent = parts.length >= 3 ? parts.slice(0, 3).join(':') : row.sessionKey
      
      return {
        id: row.id,
        timestamp: new Date(row.timestamp).toISOString(),
        agent: agent || row.model || 'unknown',
        type: row.type,
        model: row.model,
        status: row.status,
        content: content
      }
    })
  } finally {
    db.close()
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  
  // API Stats endpoint
  if (url.pathname === '/api/stats') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const db = new Database(DB_PATH, { readonly: true })
      const totalEvents = db.prepare('SELECT COUNT(*) as count FROM events').get().count
      const totalSyntheses = db.prepare('SELECT COUNT(*) as count FROM syntheses').get().count
      const recentEvents = db.prepare('SELECT COUNT(*) as count FROM events WHERE timestamp > ?').get(Date.now() - 86400000).count
      db.close()
      
      res.end(JSON.stringify({
        totalEvents,
        totalSyntheses,
        recentEvents24h: recentEvents,
        timestamp: new Date().toISOString()
      }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }
  
  // Events API endpoint
  if (url.pathname === '/api/events') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const limit = parseInt(url.searchParams.get('limit')) || 1000
      const since = url.searchParams.get('since')
      const events = getEvents(limit, since)
      res.end(JSON.stringify({ events, count: events.length }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }
  
  // Syntheses API endpoint (mezzanine Gantt data)
  if (url.pathname === '/api/syntheses') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const days = parseInt(url.searchParams.get('days')) || 7
      const syntheses = getSyntheses(days)
      res.end(JSON.stringify({ syntheses, count: syntheses.length }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }
  
  // Legacy endpoint (kept for backwards compatibility)
  if (url.pathname === '/api/exhaust') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const limit = parseInt(url.searchParams.get('limit')) || 1000
      const since = url.searchParams.get('since')
      const events = getEvents(limit, since)
      res.end(JSON.stringify({ events, count: events.length }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }
  
  // Static files from frontend/dist
  const distPath = path.join(__dirname, 'frontend', 'dist')
  let filePath = path.join(distPath, url.pathname === '/' ? 'index.html' : url.pathname)
  
  // SPA fallback - serve index.html for non-asset routes
  if (!fs.existsSync(filePath) && !url.pathname.startsWith('/assets')) {
    filePath = path.join(distPath, 'index.html')
  }
  
  const ext = path.extname(filePath)
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'
  
  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.statusCode = 404
        res.end('Not Found')
      } else {
        res.statusCode = 500
        res.end('Server Error')
      }
      return
    }
    
    res.setHeader('Content-Type', contentType)
    res.end(content)
  })
})

server.listen(PORT, () => {
  console.log(`Agent Exhaust server running on http://localhost:${PORT}`)
})
