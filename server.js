const http = require('http')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const Database = require('better-sqlite3')
const topology = require('./topology-module')

const PORT = process.env.PORT || 3000
const DB_PATH = path.join(__dirname, 'agent_events.db')
const distPath = path.join(__dirname, 'frontend/dist')

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const FIVE_MINUTES_MS = 5 * 60 * 1000
const PROVIDER_CACHE_TTL_MS = 60 * 1000
const providerPortfolioCache = {
  expiresAt: 0,
  data: null
}

function asIso(value) {
  if (value == null) return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : null
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
  }
  return null
}

function pickLastStatusMessage(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event || typeof event !== 'object') continue
    const candidates = [
      event.text,
      event.status_message,
      event.statusMessage,
      event.message,
      event.status,
      event.phase,
      event.kind
    ]
    const found = candidates.find(v => typeof v === 'string' && v.trim())
    if (found) return found.trim()
  }
  return null
}

function pickLastTimestamp(events, fallbackMs) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event || typeof event !== 'object') continue
    const candidates = [event.ts, event.timestamp, event.time, event.created_at]
    for (const value of candidates) {
      const iso = asIso(value)
      if (iso) return iso
    }
    if (typeof event.epochMs === 'number' && Number.isFinite(event.epochMs)) {
      return new Date(event.epochMs).toISOString()
    }
  }
  return new Date(fallbackMs).toISOString()
}

function getActiveAcpSessions() {
  const now = Date.now()
  // Scan ALL agent directories for ACP streams, not just codex/claude
  const agentsBase = '/Users/al/.openclaw/agents'
  const roots = []
  try {
    for (const name of fs.readdirSync(agentsBase)) {
      const sessDir = path.join(agentsBase, name, 'sessions')
      if (fs.existsSync(sessDir)) {
        roots.push({ agent: name, dir: sessDir })
      }
    }
  } catch { /* ignore */ }
  const sessions = []
  let filesScanned = 0

  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue
    const files = fs.readdirSync(root.dir)
      .filter(name => name.endsWith('.acp-stream.jsonl'))
      .map(name => path.join(root.dir, name))
    filesScanned += files.length

    for (const filePath of files) {
      let stat
      try {
        stat = fs.statSync(filePath)
      } catch {
        continue
      }
      if ((now - stat.mtimeMs) > TWO_HOURS_MS) continue

      let text = ''
      try {
        text = fs.readFileSync(filePath, 'utf8')
      } catch {
        text = ''
      }
      const events = text
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)

      sessions.push({
        agent: root.agent,
        session_key: path.basename(filePath, '.acp-stream.jsonl'),
        last_event_timestamp: pickLastTimestamp(events, stat.mtimeMs),
        last_status_message: pickLastStatusMessage(events),
        is_running: (now - stat.mtimeMs) <= FIVE_MINUTES_MS
      })
    }
  }

  sessions.sort((a, b) => Date.parse(b.last_event_timestamp || 0) - Date.parse(a.last_event_timestamp || 0))

  return {
    checked_at: new Date(now).toISOString(),
    active_window_minutes: 120,
    running_window_minutes: 5,
    files_scanned: filesScanned,
    sessions
  }
}

function getProfileRotationStatus() {
  const filePath = '/Users/al/Projects/codex-rotation/profiles.json'
  if (!fs.existsSync(filePath)) {
    return {
      source: filePath,
      active_profile: null,
      profiles: [],
      rotation_log: [],
      error: 'profiles.json not found'
    }
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : []

  const mappedProfiles = profiles.map(profile => ({
    id: profile.id || null,
    email: profile.email || null,
    five_hour_pct: typeof profile.five_hour_pct === 'number' ? profile.five_hour_pct : null,
    weekly_pct: typeof profile.weekly_pct === 'number' ? profile.weekly_pct : null,
    last_checked: profile.last_checked || null
  }))

  const log = Array.isArray(parsed.rotation_log)
    ? parsed.rotation_log.slice(-5)
    : []

  return {
    source: filePath,
    active_profile: parsed.active_profile || null,
    profiles: mappedProfiles,
    rotation_log: log
  }
}

function getAgentStatus() {
  const agentsRoot = '/Users/al/.openclaw/agents'
  if (!fs.existsSync(agentsRoot)) {
    return {
      source: agentsRoot,
      checked_at: new Date().toISOString(),
      agents: [],
      error: 'agents directory not found'
    }
  }

  const names = fs.readdirSync(agentsRoot)
    .filter(name => !name.startsWith('.'))
    .filter(name => {
      try {
        return fs.statSync(path.join(agentsRoot, name)).isDirectory()
      } catch {
        return false
      }
    })

  const agents = names.map(name => {
    const sessionsDir = path.join(agentsRoot, name, 'sessions')
    if (!fs.existsSync(sessionsDir)) {
      return { agent: name, last_active_timestamp: null }
    }

    let lastMtime = 0
    let files = []
    try {
      files = fs.readdirSync(sessionsDir)
    } catch {
      files = []
    }

    for (const fileName of files) {
      const filePath = path.join(sessionsDir, fileName)
      let stat
      try {
        stat = fs.statSync(filePath)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      if (stat.mtimeMs > lastMtime) lastMtime = stat.mtimeMs
    }

    return {
      agent: name,
      last_active_timestamp: lastMtime ? new Date(lastMtime).toISOString() : null
    }
  })

  agents.sort((a, b) => Date.parse(b.last_active_timestamp || 0) - Date.parse(a.last_active_timestamp || 0))
  return {
    source: agentsRoot,
    checked_at: new Date().toISOString(),
    agents
  }
}

function parseProviderStatus(raw) {
  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean)
  const providers = []
  let openaiUsage = {
    five_hour_pct_left: null,
    five_hour_time_left: null,
    weekly_pct_left: null,
    weekly_time_left: null
  }
  let authSummary = null

  for (const line of lines) {
    if (line.startsWith('Providers w/ OAuth/tokens')) {
      authSummary = line
      continue
    }
    if (line.startsWith('- openai-codex usage:')) {
      const usage = line.match(/5h\s+(\d+)%\s+left\s+⏱([^·]+)·\s*Week\s+(\d+)%\s+left\s+⏱(.+)$/)
      if (usage) {
        openaiUsage = {
          five_hour_pct_left: Number(usage[1]),
          five_hour_time_left: usage[2].trim(),
          weekly_pct_left: Number(usage[3]),
          weekly_time_left: usage[4].trim()
        }
      }
      continue
    }

    if (line.startsWith('- ') && line.includes(' effective=')) {
      const nameMatch = line.match(/^- ([a-z0-9-]+)\s+effective=/i)
      if (!nameMatch) continue
      const provider = nameMatch[1]
      const health = line.includes('OAuth') || line.includes('token') || line.includes('api_key')
        ? 'available'
        : 'unknown'
      const effectiveMatch = line.match(/effective=([^|]+)/)
      providers.push({
        provider,
        configured: true,
        health,
        detail: effectiveMatch ? effectiveMatch[1].trim() : 'configured'
      })
    }
  }

  return {
    source: 'openclaw models status',
    checked_at: new Date().toISOString(),
    auth_summary: authSummary,
    openai_usage: openaiUsage,
    providers
  }
}

function getProviderPortfolio() {
  const now = Date.now()
  if (providerPortfolioCache.data && providerPortfolioCache.expiresAt > now) {
    return {
      ...providerPortfolioCache.data,
      cache: { hit: true, ttl_seconds: 60 }
    }
  }

  try {
    const output = execSync('openclaw models status', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const parsed = parseProviderStatus(output)
    providerPortfolioCache.data = parsed
    providerPortfolioCache.expiresAt = now + PROVIDER_CACHE_TTL_MS
    return {
      ...parsed,
      cache: { hit: false, ttl_seconds: 60 }
    }
  } catch (error) {
    return {
      source: 'openclaw models status',
      checked_at: new Date().toISOString(),
      openai_usage: {
        five_hour_pct_left: null,
        five_hour_time_left: null,
        weekly_pct_left: null,
        weekly_time_left: null
      },
      providers: [],
      error: error.message,
      cache: { hit: false, ttl_seconds: 60 }
    }
  }
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
  
  // Subagents API endpoint - active subagents from local DB
  if (url.pathname === '/api/subagents') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const minutes = parseInt(url.searchParams.get('minutes')) || 30
      const limit = parseInt(url.searchParams.get('limit')) || 50
      const since = Date.now() - (minutes * 60 * 1000)
      
      const db = new Database(DB_PATH, { readonly: true })
      try {
        // Get recent sessions with their latest activity
        const rows = db.prepare(`
          SELECT 
            sessionKey,
            MAX(timestamp) as lastActive,
            model,
            COUNT(*) as eventCount,
            agentId
          FROM events 
          WHERE timestamp > ?
          GROUP BY sessionKey
          ORDER BY lastActive DESC
          LIMIT ?
        `).all(since, limit)
        
        const subagents = rows.map(row => {
          const parts = (row.sessionKey || '').split(':')
          const spawner = parts.length >= 2 ? parts[1] : 'unknown'
          const isSubagent = row.sessionKey?.includes(':subagent:')
          const label = parts.length >= 4 ? parts[3] : row.sessionKey
          const modelParts = (row.model || '').split('/')
          const provider = modelParts.length >= 2 ? modelParts[0] : 'unknown'
          const modelName = modelParts.length >= 2 ? modelParts.slice(1).join('/') : row.model
          
          return {
            sessionKey: row.sessionKey,
            spawner: spawner,
            label: label,
            model: modelName,
            provider: provider,
            lastActive: row.lastActive,
            eventCount: row.eventCount,
            isActive: (Date.now() - row.lastActive) < 60000, // active in last minute
            agentId: row.agentId
          }
        })
        
        const active = subagents.filter(s => s.isActive).length
        
        res.end(JSON.stringify({
          subagents: subagents,
          active: active,
          total: subagents.length,
          timestamp: new Date().toISOString()
        }))
      } finally {
        db.close()
      }
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Topology API endpoint - live model/provider hierarchy
  if (url.pathname === '/api/topology') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const hours = parseInt(url.searchParams.get('hours')) || 24
      const result = {
        topology: topology.getTopologyFromDB(hours),
        recent: topology.getRecentActivityFromDB(50),
        live: topology.parseLiveSessionFiles(5),
        timestamp: new Date().toISOString()
      }
      res.end(JSON.stringify(result))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Model Topology API endpoint - React-compatible format
  if (url.pathname === '/api/model-topology') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const hours = parseInt(url.searchParams.get('hours')) || 24
      const topologyData = topology.getTopologyFromDB(hours)
      
      // Transform topology data into React format
      const agents = []
      const providerHealth = []
      
      // Build provider health
      for (const [providerName, providerData] of Object.entries(topologyData.providers || {})) {
        providerHealth.push({
          provider: providerName,
          callCount: providerData.totalEvents || 0,
          lastSeen: null // Will be set from models
        })
      }
      
      // Build agents list from provider/model/agents hierarchy
      for (const [providerName, providerData] of Object.entries(topologyData.providers || {})) {
        for (const [modelName, modelData] of Object.entries(providerData.models || {})) {
          // Find the latest lastSeen for this provider
          const providerIdx = providerHealth.findIndex(p => p.provider === providerName)
          if (providerIdx >= 0) {
            const lastSeen = new Date(modelData.lastSeen || Date.now()).toISOString()
            if (!providerHealth[providerIdx].lastSeen || new Date(lastSeen) > new Date(providerHealth[providerIdx].lastSeen)) {
              providerHealth[providerIdx].lastSeen = lastSeen
            }
          }
          
          // Create agent entries
          for (const [agentId, count] of Object.entries(modelData.agents || {})) {
            // Parse agent ID to extract subagent info
            const parts = agentId.split(':')
            const isMainAgent = parts.length <= 3
            const parentAgentId = parts.slice(0, 3).join(':')
            
            if (isMainAgent) {
              // Check if we already have this agent
              const existingAgent = agents.find(a => a.id === agentId)
              if (existingAgent) {
                existingAgent.sessions += 1
                // Update to most active model
                if (count > (existingAgent.count || 0)) {
                  existingAgent.model = modelName
                  existingAgent.count = count
                }
              } else {
                agents.push({
                  id: agentId,
                  sessions: 1,
                  model: modelName,
                  provider: providerName,
                  count: count,
                  subagents: []
                })
              }
            } else {
              // This is a subagent, find or create parent
              let parent = agents.find(a => a.id === parentAgentId)
              if (!parent) {
                parent = {
                  id: parentAgentId,
                  sessions: 0,
                  model: modelName,
                  provider: providerName,
                  count: 0,
                  subagents: []
                }
                agents.push(parent)
              }
              
              // Add or update subagent
              const existingSub = parent.subagents.find(s => s.label === agentId)
              if (existingSub) {
                existingSub.count += count
              } else {
                parent.subagents.push({
                  label: agentId,
                  model: modelName,
                  provider: providerName,
                  count: count
                })
              }
            }
          }
        }
      }
      
      const result = {
        agents: agents,
        providerHealth: providerHealth,
        timestamp: new Date().toISOString()
      }
      
      res.end(JSON.stringify(result))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Enhanced Topology API endpoint - with task/instance counting and time filters
  if (url.pathname === '/api/topology-v2') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const timeRange = url.searchParams.get('time') || 'today'
      const liveData = topology.parseLiveSessionFiles(5)
      
      // Get 24h topology
      const topology24h = topology.getTopologyFromDB(24)
      // Get Lifetime topology (approximated as 1 year)
      const topologyLifetime = topology.getTopologyFromDB(8760)
      
      // Calculate active instances
      const activeInstanceCounts = {}
      for (const activity of liveData) {
        const key = `${activity.provider}|${activity.model}|${activity.sessionId}`
        activeInstanceCounts[key] = (activeInstanceCounts[key] || 0) + 1
      }
      
      const providers = {}
      let totalTasksAllTime = 0
      let totalTasksToday = 0
      let totalActiveInstances = 0
      
      // Merge topologies
      const allProviders = new Set([
        ...Object.keys(topology24h.providers),
        ...Object.keys(topologyLifetime.providers)
      ])

      for (const pName of allProviders) {
        const p24 = topology24h.providers[pName] || { models: {}, totalEvents: 0 }
        const pLife = topologyLifetime.providers[pName] || { models: {}, totalEvents: 0 }
        
        providers[pName] = {
          provider: pName,
          models: {},
          tasksToday: p24.totalEvents,
          tasksLifetime: pLife.totalEvents,
          activeInstances: 0,
          lastSeen: 0
        }
        
        const allModels = new Set([
          ...Object.keys(p24.models),
          ...Object.keys(pLife.models)
        ])
        
        for (const mName of allModels) {
          const m24 = p24.models[mName] || { count: 0, lastSeen: 0 }
          const mLife = pLife.models[mName] || { count: 0, lastSeen: 0 }
          
          const key = `${pName}|${mName}`
          const activeCount = Object.entries(activeInstanceCounts)
            .filter(([k]) => k.startsWith(key))
            .reduce((sum, [, c]) => sum + c, 0)
          
          const lastSeen = Math.max(m24.lastSeen || 0, mLife.lastSeen || 0)
          
          providers[pName].models[mName] = {
            model: mName,
            tasksToday: m24.count,
            tasksLifetime: mLife.count,
            activeInstances: activeCount,
            lastSeen: lastSeen,
            isActive: (Date.now() - lastSeen) < (5 * 60 * 1000)
          }
          
          providers[pName].activeInstances += activeCount
          providers[pName].lastSeen = Math.max(providers[pName].lastSeen, lastSeen)
        }
        
        totalTasksToday += providers[pName].tasksToday
        totalTasksAllTime += providers[pName].tasksLifetime
        totalActiveInstances += providers[pName].activeInstances
      }
      
      const result = {
        timeRange,
        providers,
        summary: {
          totalTasksToday,
          totalTasksAllTime,
          totalActiveInstances,
          totalProviders: Object.keys(providers).length,
          totalModels: Object.values(providers).reduce((sum, p) => sum + Object.keys(p.models).length, 0)
        },
        timestamp: new Date().toISOString()
      }
      
      res.end(JSON.stringify(result))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

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

  // Stats Overview endpoint
  if (url.pathname === '/api/stats/overview') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const db = new Database(DB_PATH, { readonly: true })
      const totalEvents = db.prepare('SELECT COUNT(*) as count FROM events').get().count
      const totalSessions = db.prepare('SELECT COUNT(DISTINCT agentId) as count FROM events').get().count
      const events24h = db.prepare('SELECT COUNT(*) as count FROM events WHERE timestamp > ?').get(Date.now() - 86400000).count
      db.close()
      
      res.end(JSON.stringify({
        total_events: totalEvents,
        total_sessions: totalSessions,
        events_24h: events24h,
        timestamp: new Date().toISOString()
      }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Stats Recent Activity endpoint
  if (url.pathname === '/api/stats/recent-activity') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const limit = parseInt(url.searchParams.get('limit')) || 50
      const secondsBack = 60
      const since = Date.now() - (secondsBack * 1000)
      
      const db = new Database(DB_PATH, { readonly: true })
      const rows = db.prepare(`
        SELECT 
          e.id,
          e.timestamp,
          e.sessionKey as session,
          e.model,
          e.type,
          e.content_snippet as summary,
          i.theme
        FROM events e
        LEFT JOIN interpretations i ON e.id = i.id
        WHERE e.timestamp > ?
        ORDER BY e.timestamp DESC
        LIMIT ?
      `).all(since, limit)
      
      db.close()
      
      const activity = rows.map(row => ({
        id: row.id,
        timestamp: new Date(row.timestamp).toISOString(),
        session: row.session || 'unknown',
        model: row.model || 'unknown',
        summary: row.summary || row.type,
        theme: row.theme || 'general'
      }))
      
      res.end(JSON.stringify({ activity, count: activity.length }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Stats Costs endpoint (placeholder - no cost data in DB)
  if (url.pathname === '/api/stats/costs') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const db = new Database(DB_PATH, { readonly: true })
      const modelCounts = db.prepare(`
        SELECT model, COUNT(*) as count
        FROM events
        WHERE model IS NOT NULL AND model != '' AND model != 'unknown'
        GROUP BY model
        ORDER BY count DESC
      `).all()
      db.close()
      
      // Placeholder cost estimation (not real costs)
      const costPerModel = modelCounts.map(m => ({
        model: m.model,
        cost: 0, // No actual cost data available
        count: m.count
      }))
      
      res.end(JSON.stringify({
        total_cost: 0,
        avg_cost_per_1k: 0,
        by_model: costPerModel,
        note: 'Cost data not available - showing placeholder'
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
  
  // Themes API endpoint - theme distribution and timeline
  if (url.pathname === '/api/themes') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')

    try {
      const db = new Database(DB_PATH, { readonly: true })
      const hours = parseInt(url.searchParams.get('hours')) || 24
      const view = url.searchParams.get('view') || 'count'
      const range = url.searchParams.get('range') || 'week'
      const cutoff = Date.now() - (hours * 60 * 60 * 1000)

      // Theme distribution - filter by range (all-time vs weekly)
      let themeQuery = `
        SELECT theme, COUNT(*) as count
        FROM interpretations
        WHERE theme IS NOT NULL AND theme != ''
      `

      if (range === 'week') {
        const weekCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000)
        themeQuery += ` AND rowid IN (SELECT rowid FROM interpretations WHERE rowid > (SELECT MIN(rowid) FROM interpretations) + 50000 LIMIT 10000)`
      }

      themeQuery += ` GROUP BY theme ORDER BY count DESC`

      const themeCounts = db.prepare(themeQuery).all()

      // Theme timeline from syntheses (hourly breakdowns) - filter by hours
      const synthRows = db.prepare(`
        SELECT hour_bucket, theme_breakdown
        FROM syntheses
        WHERE theme_breakdown IS NOT NULL
        AND hour_bucket > ?
        ORDER BY hour_bucket ASC
      `).all(cutoff)

      const timeline = synthRows.map(r => {
        let breakdown = {}
        try { breakdown = JSON.parse(r.theme_breakdown) } catch(e) {}
        return { hour: r.hour_bucket, themes: breakdown }
      })

      // Recent theme activity
      const recentThemes = db.prepare(`
        SELECT theme, summary, rowid
        FROM interpretations
        WHERE theme IS NOT NULL
        ORDER BY rowid DESC
        LIMIT 20
      `).all()

      db.close()

      res.end(JSON.stringify({
        distribution: themeCounts,
        timeline,
        recent: recentThemes,
        total: themeCounts.reduce((s, t) => s + t.count, 0)
      }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Stats History endpoint - hourly event counts
  if (url.pathname === '/api/stats/history') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const db = new Database(DB_PATH, { readonly: true })
      const hoursBack = parseInt(url.searchParams.get('hours')) || 24
      const cutoff = Date.now() - (hoursBack * 60 * 60 * 1000)
      
      const rows = db.prepare(`
        SELECT 
          CAST(timestamp / 3600000 AS INTEGER) * 3600000 as hour_bucket,
          COUNT(*) as count
        FROM events
        WHERE timestamp > ?
        GROUP BY hour_bucket
        ORDER BY hour_bucket ASC
      `).all(cutoff)
      
      db.close()
      
      const history = rows.map(r => ({
        timestamp: r.hour_bucket,
        count: r.count
      }))
      
      res.end(JSON.stringify({ history, count: history.length }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Dashboard v2 API endpoints

  // Stats Timeline - event counts over time for charts
  if (url.pathname === '/api/stats/timeline') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const db = new Database(DB_PATH, { readonly: true })
      const hours = parseInt(url.searchParams.get('hours')) || 24
      const cutoff = Date.now() - (hours * 60 * 60 * 1000)
      
      const rows = db.prepare(`
        SELECT 
          CAST(timestamp / 3600000 AS INTEGER) * 3600000 as hour_bucket,
          COUNT(*) as count,
          COUNT(DISTINCT sessionKey) as sessions
        FROM events
        WHERE timestamp > ?
        GROUP BY hour_bucket
        ORDER BY hour_bucket ASC
      `).all(cutoff)
      
      db.close()
      
      const timeline = rows.map(r => ({
        timestamp: r.hour_bucket,
        count: r.count,
        sessions: r.sessions
      }))
      
      res.end(JSON.stringify({ timeline, count: timeline.length }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Stats Heatmap - activity by hour/day for heatmap visualization
  if (url.pathname === '/api/stats/heatmap') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const db = new Database(DB_PATH, { readonly: true })
      const days = parseInt(url.searchParams.get('days')) || 7
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000)
      
      const rows = db.prepare(`
        SELECT 
          CAST(timestamp / 3600000 AS INTEGER) * 3600000 as hour_bucket,
          COUNT(*) as count
        FROM events
        WHERE timestamp > ?
        GROUP BY hour_bucket
        ORDER BY hour_bucket ASC
      `).all(cutoff)
      
      db.close()
      
      const heatmap = rows.map(r => ({
        hour: new Date(r.hour_bucket).getHours(),
        day: new Date(r.hour_bucket).getDay(),
        timestamp: r.hour_bucket,
        count: r.count
      }))
      
      res.end(JSON.stringify({ heatmap, count: heatmap.length }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Theme Timeline - theme distribution over time
  if (url.pathname === '/api/stats/theme-timeline') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const db = new Database(DB_PATH, { readonly: true })
      const hours = parseInt(url.searchParams.get('hours')) || 24
      const cutoff = Date.now() - (hours * 60 * 60 * 1000)
      
      const rows = db.prepare(`
        SELECT 
          CAST(timestamp / 3600000 AS INTEGER) * 3600000 as hour_bucket,
          theme,
          COUNT(*) as count
        FROM interpretations
        WHERE timestamp > ? AND theme IS NOT NULL AND theme != ''
        GROUP BY hour_bucket, theme
        ORDER BY hour_bucket ASC
      `).all(cutoff)
      
      db.close()
      
      const timeline = rows.map(r => ({
        timestamp: r.hour_bucket,
        theme: r.theme,
        count: r.count
      }))
      
      res.end(JSON.stringify({ timeline, count: timeline.length }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Mission - current mission/narrative from recent activity
  if (url.pathname === '/api/stats/mission') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const db = new Database(DB_PATH, { readonly: true })
      const cutoff = Date.now() - (24 * 60 * 60 * 1000)
      
      const recentEvents = db.prepare(`
        SELECT COUNT(*) as count FROM events WHERE timestamp > ?
      `).get(cutoff)
      
      const topModels = db.prepare(`
        SELECT model, COUNT(*) as count 
        FROM events 
        WHERE timestamp > ? AND model IS NOT NULL
        GROUP BY model 
        ORDER BY count DESC 
        LIMIT 5
      `).all(cutoff)
      
      db.close()
      
      res.end(JSON.stringify({
        narrative: 'Agent swarm active - building and shipping products',
        events_24h: recentEvents.count,
        top_models: topModels,
        timestamp: new Date().toISOString()
      }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Stats Models - model usage statistics
  if (url.pathname === '/api/stats/models') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const db = new Database(DB_PATH, { readonly: true })
      const hours = parseInt(url.searchParams.get('hours')) || 24
      const cutoff = Date.now() - (hours * 60 * 60 * 1000)
      
      const models = db.prepare(`
        SELECT model, COUNT(*) as count
        FROM events
        WHERE timestamp > ? AND model IS NOT NULL AND model != 'unknown'
        GROUP BY model
        ORDER BY count DESC
        LIMIT 20
      `).all(cutoff)
      
      db.close()
      
      res.end(JSON.stringify({ models, count: models.length }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Stats Active - currently active sessions
  if (url.pathname === '/api/stats/active') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const db = new Database(DB_PATH, { readonly: true })
      const minutes = parseInt(url.searchParams.get('minutes')) || 30
      const cutoff = Date.now() - (minutes * 60 * 1000)
      
      const active = db.prepare(`
        SELECT 
          sessionKey,
          model,
          MAX(timestamp) as last_seen,
          COUNT(*) as event_count
        FROM events
        WHERE timestamp > ?
        GROUP BY sessionKey
        ORDER BY last_seen DESC
      `).all(cutoff)
      
      db.close()
      
      res.end(JSON.stringify({ active, count: active.length }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Stats Syntheses - synthesis data for dashboard
  if (url.pathname === '/api/stats/syntheses') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    try {
      const db = new Database(DB_PATH, { readonly: true })
      const hours = parseInt(url.searchParams.get('hours')) || 24
      const cutoff = Date.now() - (hours * 60 * 60 * 1000)
      
      const syntheses = db.prepare(`
        SELECT 
          hour_bucket,
          event_count,
          summary,
          dominant_theme,
          work_mode
        FROM syntheses
        WHERE hour_bucket > ?
        ORDER BY hour_bucket DESC
        LIMIT 50
      `).all(cutoff)
      
      db.close()
      
      res.end(JSON.stringify({ syntheses, count: syntheses.length }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Agent Graph API endpoint - live agent hierarchy for Cytoscape.js
  if (url.pathname === '/api/agent-graph') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'no-cache')

    try {
      const minutes = parseInt(url.searchParams.get('minutes')) || 360
      const since = Date.now() - (minutes * 60 * 1000)
      const RUNS_PATH = path.join(require('os').homedir(), '.openclaw/subagents/runs.json')
      const nodes = {}
      const edges = []
      const MAIN_AGENTS = ['main', 'jane', 'swift']
      const now = Date.now()

      // Seed orchestrator nodes
      MAIN_AGENTS.forEach(name => {
        nodes['agent:' + name] = {
          data: { id: 'agent:' + name, label: name, model: '', tokens: 0,
                  status: 'active', task: 'Orchestrator', node_type: 'main' }
        }
      })

      // Load runs.json for true parent-child hierarchy
      if (fs.existsSync(RUNS_PATH)) {
        const runsData = JSON.parse(fs.readFileSync(RUNS_PATH, 'utf8'))
        const runs = runsData.runs || {}

        Object.entries(runs).forEach(([runId, run]) => {
          const createdAt = run.createdAt || 0
          if (createdAt < since) return // skip old runs

          const label = (run.label || runId).slice(0, 28)
          const model = (run.model || '').split('/').slice(1).join('/') || run.model || '–'
          const status = run.cleanupHandled ? 'done' : (run.endedAt ? 'recent' : 'active')
          const nid = 'run:' + runId

          nodes[nid] = {
            data: { id: nid, label: label, model: run.model || '', tokens: 0,
                    status: status, task: (run.task || ''), node_type: 'subagent' }
          }

          // Derive parent from requesterSessionKey: "agent:jane:cron:xxx" → "agent:jane"
          const req = run.requesterSessionKey || ''
          const parts = req.split(':')
          const parentAgentId = parts.length >= 2 ? 'agent:' + parts[1] : 'agent:main'
          const parentId = nodes[parentAgentId] ? parentAgentId : 'agent:main'

          edges.push({ data: { id: 'e-' + runId.slice(0,8), source: parentId, target: nid } })
        })
      }

      res.end(JSON.stringify({
        nodes: Object.values(nodes),
        edges,
        generated_at: new Date().toISOString()
      }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Founder overview endpoint - ACP observability dashboard payload
  if (url.pathname === '/api/founder/overview') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')

    try {
      const payload = {
        active_acp_sessions: getActiveAcpSessions(),
        profile_rotation_status: getProfileRotationStatus(),
        agent_status: getAgentStatus(),
        provider_portfolio: getProviderPortfolio(),
        timestamp: new Date().toISOString()
      }
      res.end(JSON.stringify(payload))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // Static files - serve dashboard-v2.html as main (upgraded from luxury)
  let filePath = url.pathname === '/' ? path.join(__dirname, 'dashboard-v7.html') : path.join(__dirname, url.pathname.slice(1))
  
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
