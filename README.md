# Agent Exhaust 🔍

**See what your agents see. Understand what they did.**

Agent Exhaust is a cognitive analytics dashboard for OpenClaw users. It transforms raw agent activity into meaningful insights—locally, privately, and automatically.

---

## Why Agent Exhaust?

Your AI agents are running tasks, making decisions, and interacting with the world. But what are they *actually* doing? Agent Exhaust bridges the gap between raw logs and human understanding through three semantic layers:

- **Events** → What happened (raw tool calls, messages, decisions)
- **Hourly Insights** → What it means (themes, patterns, efficiency metrics)
- **Daily Patterns** → What you learned (synthesis, trends, anomalies)

No cloud. No tracking. Just your agents' story, told clearly.

---

## Features

✨ **Three Semantic Layers**
- **Event Stream**: Timestamped tool calls, messages, and decisions
- **Hourly Rollups**: Aggregated themes, activity density, context switches
- **Daily Summaries**: Cross-session insights, efficiency trends, behavioral patterns

📊 **10-Theme Taxonomy**
Automatically categorizes activity into: Research, Communication, Code, Files, System, Browser, Security, Learning, Social, Other

🔒 **100% Local**
- All data stays on your machine
- No cloud dependencies
- No external API calls
- SQLite + LanceDB storage

🎯 **OpenClaw Native**
- Works with any OpenClaw setup
- Auto-detects agent sessions
- Handles main agents, sub-agents, and cron jobs
- Plugs into existing log infrastructure

📈 **Actionable Metrics**
- Session duration & efficiency
- Tool usage patterns
- Context switch frequency
- Cost tracking (token usage)
- Error rates & debugging insights

---

## Quick Start

### Option 1: npx (Recommended)

```bash
npx agent-exhaust
```

Opens the dashboard at `http://localhost:3000`. Auto-discovers your OpenClaw workspace.

### Option 2: Manual Install

```bash
# Clone the repo
git clone https://github.com/ezra-anchovy/agent-exhaust.git
cd agent-exhaust

# Install dependencies
npm install

# Run the dashboard
npm start
```

### First Launch

1. Point Agent Exhaust at your OpenClaw logs directory (auto-detected from `~/.openclaw/`)
2. Watch as it parses events and builds insights
3. Explore the timeline, themes, and daily patterns

---

## Screenshots

> 📸 Coming soon! Check back for dashboard previews.

---

## Configuration

Agent Exhaust uses a `.agent-exhaust.json` config file in your home directory:

```json
{
  "openclaw_workspace": "~/.openclaw/workspace",
  "logs_path": "~/.openclaw/logs",
  "storage": {
    "sqlite_path": "~/.agent-exhaust/data.db",
    "lancedb_path": "~/.agent-exhaust/vectors"
  },
  "analysis": {
    "hourly_rollup": true,
    "daily_summary": true,
    "theme_detection": true,
    "cost_tracking": true
  },
  "server": {
    "port": 3000,
    "host": "localhost"
  }
}
```

### Environment Variables

- `AGENT_EXHAUST_PORT` - Override server port (default: 3000)
- `OPENCLAW_WORKSPACE` - Path to OpenClaw workspace
- `AGENT_EXHAUST_DB` - Custom database location

---

## How It Works

Agent Exhaust operates in three stages:

```
┌─────────────────────────────────────────────────────────────┐
│                    AGENT EXHAUST PIPELINE                    │
└─────────────────────────────────────────────────────────────┘

   ┌─────────────┐      ┌──────────────┐      ┌─────────────┐
   │  OpenClaw   │      │   Event      │      │   Theme     │
   │    Logs     │─────▶│  Extractor   │─────▶│  Classifier │
   │  (JSON-L)   │      │              │      │  (10 types) │
   └─────────────┘      └──────────────┘      └─────────────┘
                               │                      │
                               ▼                      ▼
                        ┌──────────────┐      ┌─────────────┐
                        │   SQLite     │      │  LanceDB    │
                        │  (Metrics)   │      │  (Vectors)  │
                        └──────────────┘      └─────────────┘
                               │                      │
                               └──────────┬───────────┘
                                          ▼
                                  ┌──────────────┐
                                  │   Rollup     │
                                  │   Engine     │
                                  └──────────────┘
                                          │
                        ┌─────────────────┼─────────────────┐
                        ▼                 ▼                 ▼
                 ┌────────────┐   ┌────────────┐   ┌────────────┐
                 │   Hourly   │   │   Daily    │   │   Weekly   │
                 │  Insights  │   │  Patterns  │   │   Trends   │
                 └────────────┘   └────────────┘   └────────────┘
                        │                 │                 │
                        └─────────────────┼─────────────────┘
                                          ▼
                                  ┌──────────────┐
                                  │  Dashboard   │
                                  │  (React UI)  │
                                  └──────────────┘
```

### Data Flow

1. **Ingestion**: Tail OpenClaw logs (`~/.openclaw/logs/*.log`)
2. **Parsing**: Extract tool calls, messages, session metadata
3. **Classification**: Apply 10-theme taxonomy using keyword + semantic analysis
4. **Storage**: Write events to SQLite, embeddings to LanceDB
5. **Rollup**: Hourly cron aggregates into insights, daily into patterns
6. **Visualization**: React dashboard queries SQLite + LanceDB for UI

### Three Layers Explained

| Layer | Granularity | Purpose | Example |
|-------|-------------|---------|---------|
| **Events** | Per tool call | Raw activity log | `14:32 - exec: git status` |
| **Hourly** | 60-min windows | Session themes | `14:00-15:00: 60% Code, 30% Research, 2 context switches` |
| **Daily** | 24-hour periods | Behavioral patterns | `Feb 9: High research intensity, 3 sub-agents spawned, 95% uptime` |

---

## Contributing

We welcome contributions! Here's how to get involved:

### Bug Reports & Feature Requests

Open an issue on GitHub with:
- **Bug**: Steps to reproduce, expected vs actual behavior, logs
- **Feature**: Use case, proposed behavior, mockups (if applicable)

### Pull Requests

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/your-idea`)
3. Make your changes
4. Add tests (if applicable)
5. Run `npm test` to verify
6. Submit a PR with a clear description

### Development Setup

```bash
# Clone your fork
git clone https://github.com/your-username/agent-exhaust.git
cd agent-exhaust

# Install dependencies
npm install

# Run in dev mode (hot reload)
npm run dev

# Run tests
npm test

# Lint & format
npm run lint
npm run format
```

### Code Style

- Use TypeScript for type safety
- Follow ESLint config (Airbnb base)
- Write meaningful commit messages
- Keep functions small and focused
- Add JSDoc comments for public APIs

### Areas for Contribution

- 🎨 UI/UX improvements
- 📊 New visualization types
- 🧠 Better theme detection (ML models?)
- 🔌 Integration with other agent frameworks
- 📝 Documentation & tutorials
- 🐛 Bug fixes & performance optimizations

---

## Roadmap

- [ ] Real-time dashboard updates (WebSocket)
- [ ] Export reports (PDF, CSV, JSON)
- [ ] Custom theme definitions
- [ ] Multi-agent comparison view
- [ ] Alerting & anomaly detection
- [ ] Plugin system for custom analyzers
- [ ] Mobile app (iOS/Android)

---

## Community

- **Discord**: [Join the OpenClaw community](https://discord.gg/openclaw) (use #agent-exhaust channel)
- **GitHub Discussions**: Ask questions, share tips, showcase your setup
- **Twitter**: Follow [@OpenClaw](https://twitter.com/openclaw) for updates

---

## License

MIT License - see [LICENSE](LICENSE) file for details.

**TL;DR**: Free to use, modify, and distribute. Commercial use allowed. No warranty.

---

## Acknowledgments

Built with ❤️ for the OpenClaw community.

Special thanks to:
- OpenClaw maintainers for the agent framework
- LanceDB team for vector storage
- The open-source community for inspiration

---

**Questions?** Open an issue or ping `@ezra-anchovy` in the OpenClaw Discord.

**Star ⭐ this repo** if Agent Exhaust helps you understand your agents better!
