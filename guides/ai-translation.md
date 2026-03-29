# Translating a Lorebook to a Lore Module

This guide is for using an AI (Claude, Grok, etc.) to convert an existing SillyTavern lorebook into a StatefulLore lore module. It covers what to give the AI, what to ask for, and how to verify the result.

---

## What You're Actually Doing

A lorebook is a collection of static text entries that get injected into the prompt when keywords match. A lore module is code that builds that injection dynamically — based on state that persists and updates every turn.

The translation isn't just copying text. It's deciding:
- What information needs to be **tracked** (changes over time — health, stats, inventory, flags)
- What information is **static** (world lore, character voice, rules that never change)
- What **events** the model can trigger (gaining XP, taking damage, picking up items)
- What the model needs to see **every turn** vs. only sometimes

---

## Before You Start

Read through your lorebook and sort each entry into one of these buckets:

| Type | Examples | Becomes |
|------|----------|---------|
| Static world lore | Location descriptions, history, factions | String constants in the module |
| Character rules | How the character speaks, personality notes | Part of the system prompt block |
| Trackable values | HP, stats, gold, inventory, flags | Fields in the state object |
| Conditional content | "Show this if X is true" | if/else logic in processTurn |
| Events | "When the player does Y, update Z" | Entries in handleResponse |

---

## The Prompt to Give the AI

Copy this prompt and fill in the bracketed sections with your actual lorebook content:

---

**Prompt:**

I want to convert a SillyTavern lorebook into a JavaScript lore module for the StatefulLore extension.

**What StatefulLore does:**
- It calls `processTurn()` before every AI generation. I return a `systemPrompt` string that gets injected into the prompt.
- It calls `handleResponse()` after every AI response. I parse the response for events and update state.
- `state` is a plain JS object I own completely. It persists across turns automatically.
- The model never holds state — it only sees what I inject each turn.

**The lore module interface:**
```javascript
export default {
    name: 'My Lore',
    version: '1.0.0',

    init(data) { return {}; },

    processTurn({ state, systemText, messages, charNameHint, personaName } = {}) {
        if (!state) state = {};
        // build systemPrompt here
        return { systemPrompt, state };
    },

    handleResponse({ assistantText, state } = {}) {
        // parse events here, update state
        return { state };
    },
};
```

**My lorebook entries:**

[PASTE YOUR LOREBOOK ENTRIES HERE — include the keyword triggers and the entry content]

**What I want:**

Please produce a complete lore module JavaScript file that:

1. Defines a `state` shape covering all trackable values from the lorebook (stats, flags, inventory, etc.)
2. Builds a `systemPrompt` in `processTurn` that injects the right context each turn, using state values where relevant
3. Parses events in `handleResponse` — have the model embed structured event tags like ` ```game { "type": "...", ... } ``` ` in its responses, then apply them to state
4. Strips event tags from `cleanedText` before returning so they don't show in chat
5. Includes a basic HUD in `getSettingsHtml` that shows the key state values the player would want to see

Keep the code clean and readable. Add comments explaining what each section does.

---

## What to Check After

Once the AI produces the module, review it for these things before loading it:

**State shape** — Does it cover everything from your lorebook that can change? Missing a field means it won't be tracked.

**System prompt** — Read the string it builds in `processTurn`. Would the model understand the world from that alone? The model gets nothing else from your lorebook — this is it.

**Event parsing** — Does `handleResponse` actually parse the events it defined? It's easy to define an event type and forget to handle it.

**Default state** — What does a fresh game look like? Make sure the initial values make sense.

**Edge cases** — What if `state.player` doesn't exist yet? What if a field is undefined? The module should handle first-turn gracefully.

---

## Loading the Module

Once you have the file, host it somewhere with a raw URL — GitHub is easiest. Push it to a public repo, then grab the raw URL:

```
https://raw.githubusercontent.com/yourusername/your-repo/main/lore.js
```

Paste that URL into the StatefulLore extension panel under "Lore Module URL" and hit load.

---

## Tips

**Start small.** Don't try to convert a huge lorebook all at once. Get a minimal version working first — basic state shape, a system prompt that injects one or two things, one event. Then expand.

**The system prompt is everything.** Spend most of your time getting this right. If the model doesn't have the information it needs in the system prompt, it will make things up or forget. Be explicit.

**Events are optional to start.** You can build a working module with no event parsing at all — just state you set manually and inject every turn. Add event-driven updates once the basics work.

**Use the HUD to debug.** If something feels off in the narrative, check the HUD — it shows you exactly what state the module has, so you can tell whether the problem is the state being wrong or the model misreading it.
