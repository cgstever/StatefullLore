# StatefullLore

A programmable, stateful lore engine extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern) that replaces the built-in lorebook with code-driven game logic.

StatefullLore loads JavaScript lore modules (like [X-Change World](https://github.com/cgstever/overwrite-st) or [Simple Lore](https://github.com/cgstever/simple-lore)) that implement full game mechanics — stat tracking, event detection, transformation systems, inventory management, and more. The extension handles SillyTavern integration, state persistence, and prompt injection; the lore module handles all game logic.

## Features

- **Programmable lore engine** — replaces ST's static lorebook with JavaScript modules that implement `processTurn()` and `handleResponse()`
- **Fetch interceptor** — hooks into SillyTavern's prompt pipeline to inject dynamic context headers built by the lore module
- **State persistence via IndexedDB** — character state, persona state, and lore modules are stored locally and survive page reloads
- **Cross-device sync** — import a lore file on any browser and it uploads to your ST server; every other browser on the same ST instance auto-loads it
- **Auto-update from GitHub** — polls `version.json` from lore repos on startup; downloads fresh modules when versions differ
- **Scene Page mode** *(experimental, Phase 2)* — replaces full chat history with a focused per-turn scene page, reducing context usage while maintaining narrative coherence
- **Debug mode** — toggleable logging for development and troubleshooting
- **Multiple lore module support** — load and switch between different game systems

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

## Usage

Once installed, StatefullLore automatically:

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

## Configuration

Settings are available in the SillyTavern extensions panel under **StatefullLore**:

| Setting | Default | Description |
|---------|---------|-------------|
| **Enabled** | `true` | Master toggle for the extension |
| **Scene Page Mode** | `false` | Experimental — replaces full chat history with a per-turn scene page |
| **Recent Message Count** | `3` | Number of recent messages to include in Scene Page mode |
| **Max Summary Tokens** | `400` | Token budget for the story summary in Scene Page mode |
| **Debug** | `false` | Enables verbose console logging |

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

## File Structure

```
StatefullLore/
├── index.js         ← Main extension file (~64 KB) — ST integration, state management, fetch interceptor
├── manifest.json    ← Extension metadata (v1.37.0)
└── style.css        ← Extension panel styles
```

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

## Version

**v1.37.0**

## Related Projects

- [overwrite-st](https://github.com/cgstever/overwrite-st) — X-Change World lore engine (primary lore module)
- [simple-lore](https://github.com/cgstever/simple-lore) — Minimal D&D 5e RPG module

## License

This project is provided as-is for use with SillyTavern.
