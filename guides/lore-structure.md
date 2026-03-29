# Lore Module Structure

A lore module is a JavaScript file that exports a single default object. The StatefulLore extension loads it, calls its methods each turn, and handles all the ST integration — the lore module just has to implement the interface.

---

## The Minimal Module

```javascript
const VERSION = '1.0.0';

const MyLore = {
    name: 'My Lore',
    version: VERSION,

    init(data) {
        // Called once when the module loads.
        // Return a config object (or empty object if you have no config).
        return {};
    },

    processTurn({ state, systemText, messages, charNameHint, personaName } = {}) {
        // Called before every generation. Build your prompt injection here.
        // state is the persisted game state object — add/read whatever you need.
        // Return { systemPrompt, state } at minimum.
        if (!state) state = {};
        state.turn = (state.turn || 0) + 1;

        const systemPrompt = `[Your injected context goes here]`;

        return { systemPrompt, state };
    },

    handleResponse({ assistantText, state } = {}) {
        // Called after every AI response. Parse events, update state.
        // Return { state } at minimum.
        return { state };
    },
};

export default MyLore;
```

That's a complete, working lore module. Everything else is optional.

---

## processTurn

Called before every AI generation. This is where you build what the model sees.

**Parameters:**
- `state` — your persisted game state object. Starts empty, you own its shape entirely.
- `systemText` — the character card's system prompt text (from ST)
- `messages` — the current chat history
- `charNameHint` — character name extracted from the card
- `personaName` — the active persona name

**Return:**
```javascript
return {
    systemPrompt,   // String injected as a system message — the main way to give the model context
    state,          // Updated state object — always return this
};
```

The `systemPrompt` you return is what gets injected into the prompt every turn. This is where you put the character's current stats, active effects, scene location, rules the model should follow, quest state — anything the model needs to know right now.

---

## handleResponse

Called after every AI response. Parse what the model wrote, detect events, update state.

**Parameters:**
- `assistantText` — the full text of the AI's response
- `state` — the current game state

**Return:**
```javascript
return {
    state,          // Updated state — always return this
    cleanedText,    // Optional: return a cleaned version of assistantText to strip event tags
};
```

A common pattern is to have the model embed structured event tags in its response (e.g. ` ```game { "type": "gain_xp", "amount": 50 } ``` `), parse them here, apply them to state, and return a `cleanedText` with the tags stripped out so they don't show in chat.

---

## State

State is a plain JavaScript object. The extension persists it to IndexedDB automatically between turns and across page reloads. You own its shape entirely — put whatever you need in it.

```javascript
// Example state shape for an RPG
{
    turn: 42,
    player: {
        name: 'Aria',
        hp: 28,
        maxHp: 36,
        level: 4,
        xp: 3200,
        gold: 45,
        inventory: ['rope', 'torch', 'healing potion'],
    },
    quests: [
        { title: 'The Missing Merchant', objective: 'Find Aldric', done: false }
    ],
    flags: {
        world: { town: 'Millhaven', region: 'The Ashwood' },
        inCombat: false,
    }
}
```

State survives page reloads, browser restarts, and cross-device sync (if using the same ST instance). Never store anything that only matters for the current turn — use local variables for that.

---

## Optional Methods

### `getSettingsHtml(config)`

Return an HTML string to render in the extension panel under a collapsible section named after your lore module. This is where you put your HUD, character management UI, custom toggles, or anything else the player needs to interact with.

```javascript
getSettingsHtml(config) {
    return `<div style="color:#ccc;">
        HP: ${_hudState?.player?.hp ?? '—'}
    </div>`;
}
```

The extension calls this when it renders the panel. Wire up interactivity in `onSettingsRendered`.

### `onSettingsRendered(config, helpers)`

Called immediately after `getSettingsHtml` is injected into the DOM. Attach event listeners here.

```javascript
onSettingsRendered(config, helpers) {
    document.getElementById('my-button')?.addEventListener('click', () => {
        // do something
    });
}
```

`helpers` provides utility functions from the extension — currently includes `clearPersonaPill` to reset persona state.

### `updateHud(state, config)`

Called every turn after state updates. Use it to refresh your HUD without waiting for the panel to re-render.

```javascript
updateHud(state, config) {
    _hudState = state;
    const el = document.getElementById('my-hud');
    if (el) el.innerHTML = buildMyHudHtml(state);
}
```

### `getDebugInfo(state, events, config, ps)`

Return a string to display in the debug panel when debug mode is on. Useful during development.

---

## The Floating HUD Window

The extension provides a floating pop-out window that stays on screen while you chat. It syncs with your panel UI automatically. To hook into it, expose a refresh function on `window`:

```javascript
// In updateHud or wherever your state updates:
_hudState = state;
window._myLoreFloatRefresh?.();

// In getSettingsHtml, add a Float button:
`<button onclick="window._myLoreFloatToggle?.()">Float</button>`
```

See [simple-lore](https://github.com/cgstever/simple-lore) for a full working implementation of the float window.

---

## Putting It Together

The flow every turn:

1. Player sends a message
2. Extension calls `processTurn` → you return a `systemPrompt`
3. Extension injects that into the prompt alongside the chat history
4. Model generates a response
5. Extension calls `handleResponse` → you parse events, update state
6. Extension persists state to IndexedDB
7. Extension calls `updateHud` → your HUD refreshes

The model never holds state. You do. Every turn it gets a fresh, authoritative picture of the world from your `systemPrompt`.
