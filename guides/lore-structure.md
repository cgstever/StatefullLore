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
        // Return { header, state } at minimum. Use header, not systemPrompt —
        // systemPrompt replaces the character card entirely, header injects alongside it.
        if (!state || !state.yourCriticalField) state = this.init();
        state.turn = (state.turn || 0) + 1;

        const header = `[Your injected context goes here]`;

        return { header, state };
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
    header,         // String injected alongside the character card — the main way to give the model context.
                    // Use header, not systemPrompt. systemPrompt replaces the card entirely;
                    // header injects your lore alongside it so the model keeps both.
    brief,          // Optional. A short per-turn directive injected as a [DIRECTOR] block closer to the
                    // model's generation point. Use this for active instructions ("you are transforming this
                    // turn", "maintain this form") that shouldn't be buried in the header.
    state,          // Updated state object — always return this
};
```

The `header` you return is what gets injected into the prompt every turn. This is where you put the character's current stats, active effects, scene location, event format rules, quest state — anything the model needs to know right now.

**Macros:** You can use `{{user}}` and `{{char}}` anywhere in your header, brief, or other returned strings. The engine resolves them to the active persona name and character name before injection. This means your lore descriptions can reference the player and character by name without hardcoding.

### Message Scanning

If your module needs the model to act on something the *same turn* the user mentions it (e.g. a form change, a spell cast, a location transition), you need a message scanner. Without one, the model won't have the relevant context until the *next* turn — after state has already updated.

The pattern: scan the last user message for known keywords, and if one matches, inject extra context into the header for that turn.

```javascript
function detectPending(messages, knownKeys) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser || !lastUser.content) return null;
    const text = lastUser.content.toLowerCase();
    // Check longest keys first to avoid partial matches
    const sorted = [...knownKeys].sort((a, b) => b.length - a.length);
    for (const key of sorted) {
        if (text.includes(key.toLowerCase())) return key;
    }
    return null;
}
```

Call this in `processTurn` and use the result to inject the relevant description into the header on the same turn. This is how you get the model to write a transformation, cast a spell, or enter a location correctly on the turn the user asks for it — not one turn late.

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

**Important:** Don't set the HUD element's `innerHTML` to the full output of `getSettingsHtml` — that function returns the wrapper div (which has the element's id on it), so you'd end up nesting that div inside itself on every turn. Instead, split your HUD into a wrapper and an inner content helper, and only replace the inner content in `updateHud`:

```javascript
_getHudContent() {
    const state = _hudState;
    if (!state) return `<span>Waiting for first turn...</span>`;
    return `<!-- your HUD inner HTML here, no wrapper div -->`;
},

getSettingsHtml(config) {
    return `<div id="my-hud" style="...">${this._getHudContent()}</div>`;
},

updateHud(state, config) {
    _hudState = state;
    const el = document.getElementById('my-hud');
    if (el) el.innerHTML = this._getHudContent();
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
2. Extension calls `processTurn` → you return a `header` (and optionally `brief`)
3. Extension resolves `{{user}}`/`{{char}}` macros in your output
4. Extension injects the header alongside the character card (and brief near the generation point)
5. Model generates a response
6. Extension calls `handleResponse` → you parse events, update state
7. Extension persists state to IndexedDB
8. Extension calls `updateHud` → your HUD refreshes

The model never holds state. You do. Every turn it gets a fresh, authoritative picture of the world from your `header`.
