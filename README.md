# StatefulLore

A programmable, stateful lore engine extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern) that replaces the built-in lorebook with code-driven game logic.

---

## What is this, really?

Most SillyTavern setups rely on the AI model to remember things — character state, what happened last turn, what a character looks like right now. The model does its best, but it forgets, drifts, and contradicts itself over time. The longer a session runs, the worse it gets.

StatefulLore takes a different approach: **the model remembers nothing. The extension remembers everything.**

Every single turn, StatefulLore builds a complete, authoritative snapshot of the current state — stats, effects, body, clothing, active mechanics — and injects it directly into the prompt. The model doesn't need to remember anything because it's told everything it needs to know, fresh, every turn. It just reads the scene and writes.

This isn't a lorebook with extra features. It's a replacement for the entire concept of how state is managed in SillyTavern.

---

## How this is different

Here's what most SillyTavern setups use to manage what the model knows:

- **World Info / Lorebooks** — keyword-triggered entries injected into context when matched
- **Outlets** — control where lorebook entries appear in the prompt
- **Author's Note** — a freeform text block injected at a fixed position
- **System Prompt** — static instructions set per character or globally
- **Memory** — a manually maintained text block summarizing what's happened so far
- **Chat history** — the full message log the model reads for context

All of these share the same problem: the model is still responsible for keeping track of what's actually true. It reads what you give it and does its best — but over a long session, it drifts, forgets, and contradicts itself.

StatefulLore replaces that entire layer. None of those tools are involved. Instead:

- A **lore module** (a JavaScript file) owns all state — stats, effects, flags, counters, active mechanics
- Every turn, that module builds a complete, authoritative snapshot of what's true right now
- That snapshot is injected directly into the prompt as a structured header
- The model reads it, reacts, and writes — it doesn't need to remember anything

Your lorebook entries won't carry over. This isn't an enhancement to the existing system — it's a replacement for the concept.

---

## The philosophy

The core idea is simple: **the model is a writer, not a database.**

Language models are remarkably good at reading a scene and writing something compelling. They are not reliable at tracking state across dozens of turns, remembering a stat value from ten messages ago, or maintaining consistency in a complex world over a long session. Asking them to do both at once is asking them to do the wrong job.

StatefulLore separates those responsibilities cleanly:

- **The lore module** owns all state — stats, flags, effects, counters, mechanics. It runs the numbers, detects events, and decides what's true about the world right now.
- **The model** receives that truth as a clean, injected header every turn. It reads, it reacts, it writes. That's all it has to do.

The result is a system where complex, long-running mechanics work reliably — not because the model got better at remembering, but because it never had to remember in the first place.

---

## Features

- **Programmable lore engine** — replaces ST's static lorebook with JavaScript modules that implement `processTurn()` and `handleResponse()`
- **Fetch interceptor** — hooks into SillyTavern's prompt pipeline to inject dynamic context headers built by the lore module
- **State persistence via IndexedDB** — character state, persona state, and lore modules are stored locally and survive page reloads
- **Cross-device sync** — import a lore file on any browser and it uploads to your ST server; every other browser on the same ST instance auto-loads it
- **Auto-update from GitHub** — polls `version.json` from lore repos on startup; downloads fresh modules when versions differ
- **Scene Page mode** *(experimental, Phase 2)* — replaces full chat history with a focused per-turn scene page, reducing context usage while maintaining narrative coherence
- **Debug mode** — toggleable logging for development and troubleshooting
- **Multiple lore module support** — load and switch between different game systems

---

## Installation

### Method 1: SillyTavern Extension Installer

1. Open SillyTavern
2. Go to **Extensions** → **Install Extension**
3. Enter the repository URL:

```
https://github.com/cgstever/StatefullLore
```

4. Click Install — SillyTavern will clone the repo into your extensions folder

### Method 2: Manual Installation

1. Navigate to your SillyTavern installation's extension folder:

```bash
cd SillyTavern/data/default-user/extensions/third-party/
```

2. Clone this repository:

```bash
git clone https://github.com/cgstever/StatefullLore.git
```

3. Restart SillyTavern

The extension will appear in the extensions panel on next load.

---

## Usage

Once installed, StatefulLore automatically:

1. Opens its IndexedDB stores for state persistence
2. Checks for lore module updates from GitHub
3. Loads the active lore module (e.g., X-Change World)
4. Intercepts every generation request to inject the module's context headers
5. Processes AI responses through the module's event detection system
6. Persists updated state back to IndexedDB

### Loading a Lore Module

Lore modules are loaded from a raw GitHub URL. The extension ships with built-in support for X-Change World:

```
https://raw.githubusercontent.com/cgstever/overwrite-st/main/x_change_world.js
```

Additional modules (like [simple-lore](https://github.com/cgstever/simple-lore)) can be pointed at via their raw URLs.

---

## Configuration

Settings are available in the SillyTavern extensions panel under **StatefullLore**:

| Setting | Default | Description |
|---------|---------|-------------|
| **Enabled** | `true` | Master toggle for the extension |
| **Scene Page Mode** | `false` | Experimental — replaces full chat history with a per-turn scene page |
| **Recent Message Count** | `3` | Number of recent messages to include in Scene Page mode |
| **Max Summary Tokens** | `400` | Token budget for the story summary in Scene Page mode |
| **Debug** | `false` | Enables verbose console logging |

---

## Architecture

```
┌─────────────────────────────────────────┐
│              SillyTavern                 │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │         StatefullLore             │  │
│  │                                   │  │
│  │  ┌─────────┐   ┌──────────────┐  │  │
│  │  │  Fetch   │   │   IndexedDB  │  │  │
│  │  │Intercept │   │  Persistence │  │  │
│  │  └────┬─────┘   └──────┬───────┘  │  │
│  │       │                │          │  │
│  │  ┌────▼────────────────▼───────┐  │  │
│  │  │      Lore Module API        │  │  │
│  │  │  processTurn()              │  │  │
│  │  │  handleResponse()           │  │  │
│  │  └────────────┬────────────────┘  │  │
│  └───────────────│───────────────────┘  │
└──────────────────│──────────────────────┘
                   │
    ┌──────────────▼──────────────┐
    │     Lore Module (JS)        │
    │  e.g. x_change_world.js     │
    │  e.g. lore.js (simple-lore) │
    └─────────────────────────────┘
```

---

## File Structure

```
StatefullLore/
├── index.js         ← Main extension file (~64 KB) — ST integration, state management, fetch interceptor
├── manifest.json    ← Extension metadata (v1.37.0)
└── style.css        ← Extension panel styles
```

---

## Lore Module Interface

A lore module is a JavaScript file with a default export implementing:

```javascript
export default {
    name: "My Lore Module",
    version: "1.0.0",

    // Called before each AI generation with current state
    processTurn(state, context) { ... },

    // Called after AI responds to detect and apply events
    handleResponse(response, state) { ... },
};
```

The module receives full state (stats, flags, inventory, effects) and returns context headers for prompt injection and state mutations to persist.

---

## Version

**v1.37.0**

---

## Related Projects

- [overwrite-st](https://github.com/cgstever/overwrite-st) — X-Change World lore engine (primary lore module)
- [simple-lore](https://github.com/cgstever/simple-lore) — Minimal D&D 5e RPG module

---

## License

This project is provided as-is for use with SillyTavern.
