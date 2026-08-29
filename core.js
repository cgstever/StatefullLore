/**
 * StatefulLore  --  SillyTavern Extension
 *
 * A programmable lore engine that replaces ST's lorebook with stateful,
 * code-driven game logic. Loads JS lore modules that implement
 * processTurn() and handleResponse(). The extension handles ST integration,
 * state persistence, and injection plumbing. The lore module handles all
 * game logic.
 *
 * Cross-device sync: import a lore file once on any browser -> it uploads to
 * your ST server -> every other browser/device on the same ST instance auto-
 * loads it on next page load. No manual steps required.
 */

// -- Constants ---------------------------------------------------------------

const MODULE_NAME = 'StatefulLore';

const DEFAULTS = {
    enabled: true,
    active_lore: null,
    debug: false,
    server_lores: {},
    scenePageMode: true,
    recentMessageCount: 3,
    maxSummaryTokens: 400,
    // v2.0.4: the card's first_mes (greeting) sets scene context that fights
    // scene/scenario overrides the user configures in the extension. Stripping
    // it from the API payload lets the extension's scene setup win. Greeting
    // stays in the ST UI for reference.
    skipGreetingInHistory: true,
};

// -- Runtime state -----------------------------------------------------------

let settings = {};
let activeLore = null;
let lastTurnResult = null;

// -- Debug log buffer (v2.0.5) ----------------------------------------------
// Captures one turn's worth of [OW]/[XCW]/[XR] console output + explicit
// markers (USER_MSG, PROCESS_TURN_*, AI_RESPONSE, etc) into a per-turn array
// that gets flushed into state._debug_dump.turn_log when state is persisted.
// A daemon on the server side (xcw-watcher) renders these into per-character
// .md/.log files so debugging doesn't require pasting browser console.

let _debugLogBuffer = [];
let _lastAssembled = null;  // {messages, engine} — captured per turn, flushed to state
const _DEBUG_BUFFER_CAP = 800;
const _DEBUG_PREFIXES = ['[OW]', '[XCW]', '[XR]'];

const _origConsoleLog = console.log.bind(console);
const _origConsoleError = console.error.bind(console);
const _origConsoleWarn = console.warn.bind(console);

function _captureLog(level, args) {
    try {
        const first = args[0];
        if (typeof first !== 'string') return;
        let matched = false;
        for (const p of _DEBUG_PREFIXES) {
            if (first.startsWith(p)) { matched = true; break; }
        }
        if (!matched) return;
        const ts = new Date().toISOString();
        const parts = [];
        for (const a of args) {
            if (typeof a === 'string') parts.push(a);
            else {
                try { parts.push(JSON.stringify(a)); }
                catch (_) { parts.push(String(a)); }
            }
        }
        let line = parts.join(' ');
        if (line.length > 4000) line = line.substring(0, 4000) + '...[truncated]';
        _debugLogBuffer.push(`${ts} ${level} ${line}`);
        if (_debugLogBuffer.length > _DEBUG_BUFFER_CAP) {
            _debugLogBuffer.splice(0, _debugLogBuffer.length - _DEBUG_BUFFER_CAP);
        }
    } catch (_) { /* never let logging crash anything */ }
}

console.log = function (...args) { _captureLog('LOG ', args); _origConsoleLog(...args); };
console.error = function (...args) { _captureLog('ERR ', args); _origConsoleError(...args); };
console.warn = function (...args) { _captureLog('WARN', args); _origConsoleWarn(...args); };

function _resetDebugBuffer() { _debugLogBuffer = []; }

function _pushDebugMarker(label, payload) {
    try {
        const ts = new Date().toISOString();
        let detail = '';
        if (payload !== undefined) {
            if (typeof payload === 'string') {
                detail = payload.length > 600 ? payload.substring(0, 600) + '...[truncated]' : payload;
            } else {
                try { detail = JSON.stringify(payload).substring(0, 600); }
                catch (_) { detail = String(payload); }
            }
        }
        _debugLogBuffer.push(`${ts} MARK ${label}${detail ? ' ' + detail : ''}`);
        if (_debugLogBuffer.length > _DEBUG_BUFFER_CAP) {
            _debugLogBuffer.splice(0, _debugLogBuffer.length - _DEBUG_BUFFER_CAP);
        }
    } catch (_) { /* swallow */ }
}

function _flushDebugBuffer(state) {
    try {
        if (!state || typeof state !== 'object') return;
        if (!state._debug_dump || typeof state._debug_dump !== 'object') {
            state._debug_dump = {};
        }
        state._debug_dump.turn_log = _debugLogBuffer.slice();
        state._debug_dump.flushed_at = new Date().toISOString();
        state._debug_dump.extension_version = '2.0.16';
        if (_lastAssembled) {
            state._debug_dump.assembled = _lastAssembled;
        }
    } catch (_) { /* swallow */ }
}

// v2.0.14 — write per-turn debug payload to a sidecar file outside the chat log.
// Engine _xrebuild (full shadow ~165KB) and extension _debug_dump.assembled (full
// prompt capture ~140KB) together bloat each chat message snapshot by ~310KB.
// ST reloads the entire chat JSONL on every turn, so historical debug accumulates
// linear slowdown. Move them to per-turn files under chats_debug/ which ST never
// reads, then strip from state before saveChat.
//
// On upload failure, do NOT strip — fall back to the old behavior (debug stays in
// main JSONL). Zero data loss either way; the chat just stays slow that turn.
async function _writeSidecarDebug(state) {
    try {
        if (!state || typeof state !== 'object') return;
        const hasShadow = !!state._xrebuild;
        const hasAssembled = !!(state._debug_dump && state._debug_dump.assembled);
        if (!hasShadow && !hasAssembled) return;

        const ctx = SillyTavern.getContext();
        const charName = ctx?.characters?.[ctx.characterId]?.name || ctx?.name2 || 'Unknown';

        // Chat ID resolver — try ST APIs, fall back to first-message send_date
        // (unique-per-chat, deterministic across reloads, safe for filenames).
        let chatId = null;
        try {
            if (typeof ctx.getCurrentChatId === 'function') chatId = ctx.getCurrentChatId();
            if (!chatId && typeof globalThis.getCurrentChatId === 'function') chatId = globalThis.getCurrentChatId();
            if (!chatId && ctx.chat_metadata && ctx.chat_metadata.chat_id_hash) chatId = String(ctx.chat_metadata.chat_id_hash);
            if (!chatId && Array.isArray(ctx.chat) && ctx.chat.length > 0 && ctx.chat[0] && ctx.chat[0].send_date) {
                chatId = String(ctx.chat[0].send_date);
            }
        } catch (_) { /* ignore */ }
        if (!chatId) {
            console.warn('[XCW-sidecar] No chat ID — skipping sidecar (debug stays in main JSONL this turn)');
            return;
        }

        const turn = (state.turn != null) ? state.turn
                   : (state._xrebuild && state._xrebuild.turn != null) ? state._xrebuild.turn
                   : 0;

        const payload = {
            captured_at: new Date().toISOString(),
            character: charName,
            chat_id: chatId,
            turn: turn,
            engine_version: state.engine_version || null,
            _xrebuild: state._xrebuild || null,
            _debug_dump_assembled: (state._debug_dump && state._debug_dump.assembled) || null,
        };

        const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
        const turnStr = String(turn).padStart(4, '0');
        // IMPORTANT: ST's /api/files/upload validates the name with
        // validateAssetFileName (src/endpoints/assets.js): the regex
        // /^[a-zA-Z0-9_\-.]+$/ REJECTS any '/', so a nested name 400s and the
        // upload silently fails (debug falls back inline -> chat keeps bloating).
        // VERIFIED against the live validator (engine/_validate_name_test.mjs).
        // So use a FLAT name (no slashes) encoding char + chat + turn. Lands at
        // data/<user>/user/files/. _pull_logs.py reads this flat name.
        const filename = `xcwdbg_${safe(charName)}_${safe(chatId)}_turn_${turnStr}.json`;

        const headers = ctx.getRequestHeaders();
        const body = JSON.stringify(payload);
        const data = btoa(unescape(encodeURIComponent(body)));

        const resp = await fetch('/api/files/upload', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: filename, data }),
        });

        if (!resp.ok) {
            console.warn('[XCW-sidecar] Upload failed:', resp.status, '— keeping debug in main JSONL (fallback)');
            return;
        }

        // Upload succeeded — strip the heavy fields from state so saveChat
        // writes a small line. _xrebuild_log stays (small rolling buffer).
        delete state._xrebuild;
        if (state._debug_dump) {
            delete state._debug_dump.assembled;
            state._debug_dump.sidecar_turn = turn;
            state._debug_dump.sidecar_file = filename;
        }
    } catch (e) {
        console.error('[XCW-sidecar] Failed:', e && e.message ? e.message : e);
        // Don't throw — sidecar failure should never break a chat turn.
    }
}

// v2.0.5 — build the rich per-turn capture used by both completion modes.
function _buildAssembledCapture(opts) {
    try {
        const {
            mode, payload, turnResult, pending, isPriorityTurn,
            systemText, messagesIn, charData, ctx, _personaDesc,
            personaState, settings, promptString,
        } = opts;
        const _trClean = {};
        for (const k of Object.keys(turnResult || {})) {
            if (k === 'state' || k === 'persona_state') continue;
            _trClean[k] = turnResult[k];
        }
        const cap = {
            captured_at: new Date().toISOString(),
            mode: mode,
            priority: !!isPriorityTurn,
            messages: (payload.messages || []).map(m => ({ role: m.role, content: m.content || '' })),
            turnResult: _trClean,
            processTurn_inputs: {
                systemText: systemText || '',
                messages_in: (messagesIn || []).map(m => ({ role: m.role, content_chars: (m.content || '').length })),
                charNameHint: charData?.name || null,
                personaName: ctx?.name1 || null,
                personaDescription: _personaDesc || '',
                cardPersonality: charData?.personality || '',
                cardDescription_chars: (charData?.description || '').length,
                cardScenario: charData?.scenario || '',
                locationOverride: settings?.locationOverride || '',
                scenarioOverride: settings?.scenarioOverride || '',
            },
            pending: pending || null,
            settings_snapshot: {
                scenePageMode: settings?.scenePageMode,
                recentMessageCount: settings?.recentMessageCount,
                maxSummaryTokens: settings?.maxSummaryTokens,
                debug: settings?.debug,
                skipGreetingInHistory: settings?.skipGreetingInHistory,
                locationOverride: settings?.locationOverride || null,
                scenarioOverride: settings?.scenarioOverride || null,
                active_lore: settings?.active_lore,
            },
            personaState: personaState || null,
            engine_summary: {
                systemPrompt_chars: (turnResult?.systemPrompt || '').length,
                header_chars:       (turnResult?.header || '').length,
                brief_chars:        (turnResult?.brief || '').length,
                inject_count:       (turnResult?.inject || []).length,
                events_keys:        turnResult?.events ? Object.keys(turnResult.events) : [],
            },
        };
        if (promptString) cap.prompt_string = promptString;
        return cap;
    } catch (_) { return null; }
}

// -- Message-based state helpers ---------------------------------------------

// v2.0.10 — DEEP-CLONE state on read. Prior versions returned a reference to
// the stored state object, which meant every swipe of a turn (and even prior
// turns' state) all ended up sharing the same mutable object. Result: when
// processTurn mutated `state` during swipe N, the mutation propagated back to
// every other swipe slot's saved state. Once chat.json serialized, all swipes
// looked identical — the body_modifier reroll worked at runtime but never
// stuck per-slot. Cloning forces each call to start with a fresh independent
// state and write back its own snapshot.
function _cloneState(s) {
    if (s == null) return s;
    try { return JSON.parse(JSON.stringify(s)); }
    catch (_) { return s; }  // fall back to shared ref if non-serializable (extremely rare)
}

function readMsgState() {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg.is_user && !msg.is_system) {
            // v2.0.13 — on swipe N, msg.swipe_id is N but msg.variables[N] doesn't
            // exist yet (we're about to generate it). The previous code returned
            // undefined and walked back to the PRIOR AI message's state — whose
            // `_last_chat_msg_count` is stale → `isRegen` evaluated false →
            // processTurn re-ran full turn each swipe → turn counter incremented
            // and arousal compounded.
            //
            // Fix: walk the CURRENT msg's variables slots from highest down,
            // returning the most recent completed swipe's state. That state's
            // `_last_chat_msg_count` matches current chatMsgCount → isRegen=true
            // → processTurn runs regen branch → no turn increment, no arousal
            // mutation. TX-turn body_modifier reroll still works because the
            // regen branch resets `resolved_body` + `card_body` and re-runs
            // buildTransformationGuidance (which contains the reroll RNG).
            if (msg.variables && typeof msg.variables === 'object') {
                const slotKeys = Object.keys(msg.variables)
                    .map(k => parseInt(k, 10))
                    .filter(k => !isNaN(k))
                    .sort((a, b) => b - a);  // newest swipe first
                for (const k of slotKeys) {
                    const s = msg.variables[k]?.state;
                    if (s !== undefined) return _cloneState(s);
                }
            }
            // No state on any slot of this AI msg — keep searching backwards
        }
    }
    return null;
}

async function writeMsgState(state) {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg.is_user && !msg.is_system) {
            msg.variables = msg.variables || {};
            msg.variables[msg.swipe_id || 0] = {
                ...(msg.variables[msg.swipe_id || 0] || {}),
                state,
            };
            await ctx.saveChat();
            // v2.0.11 — refresh HUD on every save (see writeTurnState comment)
            try {
                if (activeLore && typeof activeLore.updateHud === 'function') {
                    activeLore.updateHud(state, activeLore._config);
                }
            } catch (_) { /* HUD refresh is best-effort */ }
            return;
        }
    }
    // Turn 1 — no AI message exists yet; state held in lastTurnResult
    // and written when onMessageReceived fires after the first response.
}

function readPersonaState() {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg.is_user && !msg.is_system) {
            const ps = msg.variables?.[msg.swipe_id || 0]?.personaState;
            if (ps !== undefined) return _cloneState(ps);
            // No personaState on this swipe/message — keep searching backwards
        }
    }
    return null;
}

async function writePersonaState(personaState) {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg.is_user && !msg.is_system) {
            msg.variables = msg.variables || {};
            msg.variables[msg.swipe_id || 0] = {
                ...(msg.variables[msg.swipe_id || 0] || {}),
                personaState,
            };
            await ctx.saveChat();
            return;
        }
    }
}

// Write both state and personaState in a single saveChat call
// v2.0.11 — also refresh the HUD here. After v2.0.10's clone-on-read, the HUD
// holds a snapshot reference; without an explicit refresh on every save, any
// turn whose updateHud() call in the fetch interceptor was skipped (errors,
// unusual paths) leaves the HUD frozen on the prior clone. Doing it here is
// the catch-all — every successful state write also pings the HUD.
async function writeTurnState(state, personaState) {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    _flushDebugBuffer(state);
    // v2.0.14 — offload heavy debug fields to per-turn sidecar file BEFORE saveChat.
    // Strips state._xrebuild and state._debug_dump.assembled on successful upload,
    // dropping ~310KB/turn of bloat from the chat JSONL. Falls back to old behavior
    // (debug stays in main file) if upload fails. Never throws.
    await _writeSidecarDebug(state);
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg.is_user && !msg.is_system) {
            msg.variables = msg.variables || {};
            msg.variables[msg.swipe_id || 0] = {
                ...(msg.variables[msg.swipe_id || 0] || {}),
                state,
                personaState,
            };
            await ctx.saveChat();
            try {
                if (activeLore && typeof activeLore.updateHud === 'function') {
                    activeLore.updateHud(state, activeLore._config);
                }
            } catch (_) { /* HUD refresh is best-effort */ }
            return;
        }
    }
}

// -- Lore module loading -----------------------------------------------------

async function loadLoreFromSource(source, key) {
    const blob = new Blob([source], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    try {
        const mod = await import(url);
        const lore = mod.default;
        if (!lore || typeof lore.processTurn !== 'function') {
            throw new Error('Lore module must export default with processTurn()');
        }
        if (typeof lore.init === 'function') {
            lore._config = lore.init(lore.data || {});
        }
        lore._key = key;
        lore._source = source;
        console.log(`[OW] Loaded: ${lore.name || key} v${lore.version || '?'}`);
        return lore;
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function uploadLoreToServer(source, key) {
    const uploadName = key + '.lore.txt';
    const headers = SillyTavern.getContext().getRequestHeaders();
    const data = btoa(unescape(encodeURIComponent(source)));
    const resp = await fetch('/api/files/upload', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: uploadName, data }),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`ST file upload failed ${resp.status}: ${text.slice(0, 200)}`);
    }
    const result = await resp.json();
    const serverPath = result.path || result.url;
    if (!serverPath) throw new Error('ST upload response had no path: ' + JSON.stringify(result));
    return serverPath;
}

async function importAndActivateLore(source, filename, { sourceUrl = null } = {}) {
    const key = filename.replace(/\.js$/, '');
    const lore = await loadLoreFromSource(source, key);
    activeLore = lore;
    settings.active_lore = key;
    // Persist to ST server BEFORE returning so Update/Reload reliably sees fresh bytes.
    // Previously fire-and-forget — caused Update-then-Reload to return stale bytes if the
    // upload hadn't committed, or to fake success if the upload silently failed.
    try {
        const serverPath = await uploadLoreToServer(source, key);
        settings.server_lores = settings.server_lores || {};
        const prev = typeof settings.server_lores[key] === 'object' ? settings.server_lores[key] : {};
        const entry = { path: serverPath, name: lore.name || key, version: lore.version || '?' };
        entry.sourceUrl  = sourceUrl || lore.sourceUrl || prev.sourceUrl || null;
        entry.versionUrl = lore.versionUrl || prev.versionUrl || null;
        settings.server_lores[key] = entry;
        console.log(`[OW] Lore persisted to ST server: ${serverPath}`);
    } catch (ex) {
        console.warn('[OW] Server upload failed:', ex.message);
        throw new Error(`Server persistence failed: ${ex.message}`);
    }
    saveSettings();
    return lore;
}

async function loadLoreFromUrl(url) {
    const bustUrl = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    const resp = await fetch(bustUrl);
    if (!resp.ok) throw new Error(`Fetch ${url} failed: ${resp.status}`);
    const source = await resp.text();
    const filename = url.split('/').pop().split('?')[0] || 'lore.js';
    return importAndActivateLore(source, filename, { sourceUrl: url });
}

async function activateStoredLore(key) {
    const entry = settings.server_lores?.[key];
    const serverPath = typeof entry === 'string' ? entry : entry?.path;
    if (!serverPath) {
        console.warn(`[OW] No server path found for lore: ${key}`);
        return null;
    }
    const resp = await fetch(serverPath);
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
    const source = await resp.text();
    activeLore = await loadLoreFromSource(source, key);
    settings.active_lore = key;
    saveSettings();
    return activeLore;
}

async function syncLoreFromServer(key, serverPath) {
    console.log(`[OW] Loading lore from server: ${key}`);
    const resp = await fetch(serverPath);
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
    const source = await resp.text();
    const lore = await loadLoreFromSource(source, key);
    // Upgrade legacy string entry to rich object — preserve sourceUrl/versionUrl
    const prev = typeof settings.server_lores[key] === 'object' ? settings.server_lores[key] : {};
    settings.server_lores[key] = { ...prev, path: serverPath, name: lore.name || key, version: lore.version || '?' };
    saveSettings();
    console.log(`[OW] Loaded from server: ${key} v${lore.version || '?'}`);
    return { lore, source };
}

// -- Auto-update -------------------------------------------------------------

async function checkForLoreUpdate(silent = false) {
    const key = settings.active_lore;
    const entry = settings.server_lores?.[key];
    const versionUrl = (typeof entry === 'object' && entry?.versionUrl) || null;
    const sourceUrl  = (typeof entry === 'object' && entry?.sourceUrl)  || null;

    if (!sourceUrl) {
        if (!silent) showLoreInfo('No source URL stored for this lore.', 'err');
        return false;
    }

    // Capture the version we're upgrading FROM before any fetch — used in the success toast.
    const priorVersion = activeLore?.version ?? null;

    if (!silent) showLoreInfo('Checking for updates...', '');
    try {
        // If a versionUrl is available, do a lightweight version check first
        if (versionUrl) {
            const resp = await fetch(versionUrl + (versionUrl.includes('?') ? '&' : '?') + 't=' + Date.now());
            if (!resp.ok) throw new Error(`Version check failed: ${resp.status}`);
            const { version: remoteVersion } = await resp.json();

            if (priorVersion === remoteVersion) {
                if (!silent) showLoreInfo(`Already up to date: v${priorVersion}`, 'ok');
                return false;
            }

            const fromStr = priorVersion ? `v${priorVersion}` : 'none';
            showLoreInfo(`Updating lore: ${fromStr} → v${remoteVersion}…`, '');
        }

        // Re-fetch the full lore from its source URL — await persists the new bytes to ST server.
        await loadLoreFromUrl(sourceUrl);
        const newVersion = activeLore?.version || '?';
        const fromTo = priorVersion ? `v${priorVersion} → v${newVersion}` : `v${newVersion}`;
        showLoreInfo(`Updated ${fromTo} — Reload to apply`, 'ok');
        return true;
    } catch (ex) {
        if (!silent) showLoreInfo(`Update check failed: ${ex.message}`, 'err');
        console.warn('[OW] Update check failed:', ex);
        return false;
    }
}

// -- Macro replacement -------------------------------------------------------

/**
 * Replace SillyTavern-style macros ({{user}}, {{char}}, etc.) in a string.
 * Lore modules may use these placeholders in their output; ST's own macro
 * system doesn't run on content the extension injects, so we handle it here.
 */
function resolveMacros(text, ctx) {
    if (!text || typeof text !== 'string') return text;
    const userName = ctx?.name1 || 'User';
    const charName = ctx?.characters?.[ctx.characterId]?.name || ctx?.name2 || 'Character';
    return text
        .replace(/\{\{user\}\}/gi, userName)
        .replace(/\{\{char\}\}/gi, charName);
}

// -- Generate interceptor ----------------------------------------------------

// overwriteInterceptor is kept as a no-op so ST doesn't crash if it calls this
// global by convention.  All work — processTurn, scene page assembly, injection —
// is now handled exclusively by the fetch interceptor below.
globalThis.overwriteInterceptor = async function (chat, contextSize, abort, type) {};

// -- Scene Page assembly (Phase 2) -------------------------------------------

/**
 * Return sensible token budgets based on the model's context window size.
 * Called by buildScenePage so it can decide how many recent messages to keep
 * and how long the story summary / header sections are allowed to be.
 */
function getTokenBudgets(contextSize) {
    if (contextSize <= 8192) {
        return { recentMessages: 2, maxSummaryTokens: 200, maxHeaderTokens: 600 };
    } else if (contextSize <= 16384) {
        return { recentMessages: 3, maxSummaryTokens: 400, maxHeaderTokens: 1000 };
    } else if (contextSize <= 32768) {
        return { recentMessages: 5, maxSummaryTokens: 600, maxHeaderTokens: 1200 };
    } else {
        return { recentMessages: 8, maxSummaryTokens: 800, maxHeaderTokens: 1500 };
    }
}

/**
 * Build a minimal, self-contained "scene page" that replaces the full chat
 * history.  The model receives everything it needs in five layers:
 *
 *   1. System message  – character card + guidelines (kept from ST)
 *   2. Scene context   – the state header from the lore engine
 *   3. Story summary   – compressed beat history ("Previously: …")
 *   4. Recent messages  – last N messages for dialogue continuity
 *   5. Current turn     – user message with injections (brief, TX, rules)
 *
 * @param {Object} pending - window._owPendingInjection data
 * @param {Array}  messages - payload.messages from the outgoing request
 * @returns {Array} the assembled scene page message array
 */

/**
 * Convert a messages array into a ChatML-formatted prompt string.
 * This gives the plugin full control over the prompt in text completion mode
 * without needing a model-specific chat template.
 */
function messagesToChatML(messages, isPriorityTurn) {
    let prompt = '';
    for (const msg of messages) {
        prompt += '<|im_start|>' + (msg.role || 'user') + '\n' + (msg.content || '') + '<|im_end|>\n';
    }
    // On priority/TX turns, add the TX directive as a final system message
    if (isPriorityTurn) {
        prompt += '<|im_start|>system\nWrite the full transformation scene now. Use the physical guide as your style reference. Multiple detailed paragraphs describing each physical change. Each change gets its own paragraph. Do not write a short response.<|im_end|>\n';
    }
    // End with assistant start token so the model generates
    prompt += '<|im_start|>assistant\n';
    return prompt;
}

/**
 * Post-TX example dialogue (Cody 2026-08-29).
 *
 * A card's `mes_example` is written for its ORIGINAL body and is correct pre-TX, so it
 * must not be edited. Cards that need it instead carry a SECOND table at
 * `data.extensions.xcw.mes_example_post_tx`, written for the transformed body. While a
 * transformation is active we swap one for the other.
 *
 * Returns {orig, post} so the caller can do a LITERAL string swap. That matters: ST puts
 * examples either inside the system prompt or in separate messages depending on settings,
 * and swapping the card's own exact text finds them in both cases without parsing <START>
 * regions. Cards with no post-TX table return null and behave exactly as before.
 */
function postTxExamplePair(ctx) {
    try {
        const c = ctx?.characters?.[ctx?.characterId];
        if (!c) return null;
        const d = c.data || c;
        const post = d?.extensions?.xcw?.mes_example_post_tx;
        if (typeof post !== 'string' || !post.trim()) return null;
        const orig = String(d?.mes_example || c?.mes_example || '').trim();
        if (!orig) return null;
        return { orig, post: post.trim() };
    } catch (e) {
        return null;
    }
}

/** Swap the pre-TX example block for the post-TX one, in-place, wherever it appears. */
function applyPostTxExamples(messages, pair) {
    if (!pair || !Array.isArray(messages)) return 0;
    let hits = 0;
    for (const m of messages) {
        if (!m || typeof m.content !== 'string' || !m.content.includes(pair.orig)) continue;
        m.content = m.content.split(pair.orig).join(pair.post);
        hits++;
    }
    if (hits) console.log('[OW] post-TX examples swapped in ' + hits + ' message(s)');
    return hits;
}

function buildScenePage(pending, messages) {
    const scenePage = [];

    // --- Scrub: swap in scrubbed messages if the lore engine provided them ---
    // The engine strips pill color/effect names so the model never sees them.
    if (pending.scrubbed_messages && pending.scrubbed_messages.length) {
        messages = pending.scrubbed_messages;
    }

    // --- Layer 1: System message (character card + guidelines) ---------------
    // Filter to actor-relevant content only — engine-internal fields (Stats:,
    // Sex Baseline:, Anatomy Snapshot:, raw build data) are stripped so the
    // model only receives what it needs to voice the character well.
    const sysMsg = messages.find(m => m.role === 'system');
    if (sysMsg) {
        let sysContent = sysMsg.content || '';

        // Strip engine-internal lines the model has no use for as an actor.
        // These fields are already extracted by processTurn for statgen.
        sysContent = sysContent
            // Remove Stats: line entirely
            .replace(/^Stats:.*$/m, '')
            // Remove Sex Baseline: line
            .replace(/^Sex Baseline:.*$/m, '')
            // Remove Anatomy Snapshot block (header + indented content)
            .replace(/^Anatomy Snapshot:\s*\n(?:.*\n)*?(?=\n[A-Z]|\n*$)/m, '')
            // Collapse multiple blank lines to one
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        // Apply lore-engine-driven card strip patterns (engine owns what to remove)
        for (const pat of (pending.cardStripPatterns || [])) {
            try { sysContent = sysContent.replace(new RegExp(pat, 'm'), ''); }
            catch(e) { /* skip bad pattern */ }
        }
        sysContent = sysContent.replace(/\n{3,}/g, '\n\n').trim();

        // Post-TX: replace old Appearance + Anatomy with transformed body descriptors
        if (pending.anatomyOverride) {
            // Strip old Appearance block
            sysContent = sysContent.replace(/^Appearance:\s*\n(?:.*\n)*?(?=\n[A-Z]|\n*$)/m, '');
            // Strip old Sexual Tendencies block
            sysContent = sysContent.replace(/^Sexual Tendencies:\s*\n(?:.*\n)*?(?=\n[A-Z]|\n*$)/m, '');
            // Strip any remaining Anatomy Snapshot that survived first pass
            sysContent = sysContent.replace(/^Anatomy Snapshot:\s*\n(?:.*\n)*?(?=\n[A-Z]|\n*$)/m, '');
            // Line-level stripping: engine provides words to remove from card text
            if (pending.stripWords && pending.stripWords.length) {
                const pattern = new RegExp('\\b(' + pending.stripWords.join('|') + ')\\b', 'i');
                sysContent = sysContent.split('\n').filter(line => {
                    // Keep labeled header lines (Name:, Age:, etc.) even if they match
                    if (/^[A-Z][a-z]+:/.test(line.trim())) return true;
                    return !pattern.test(line);
                }).join('\n');
            }
            // Collapse blanks
            sysContent = sysContent.replace(/\n{3,}/g, '\n\n').trim();
            // Inject new anatomy after the Name/Age/Sex header
            const nameBlock = sysContent.match(/^(?:Name:.*\n(?:Age:.*\n)?(?:Sex:.*\n)?)/m);
            if (nameBlock) {
                const insertPos = nameBlock.index + nameBlock[0].length;
                sysContent = sysContent.substring(0, insertPos) + '\n' + pending.anatomyOverride + '\n' + sysContent.substring(insertPos);
            } else {
                // Fallback: prepend
                sysContent = pending.anatomyOverride + '\n\n' + sysContent;
            }
            sysContent = sysContent.replace(/\n{3,}/g, '\n\n').trim();
        }

        // Append any system-position inject entries to the system message
        for (const inj of (pending.inject || [])) {
            if (!inj || !inj.text || inj.position !== 'system') continue;
            if (inj.text === pending.header || inj.text === pending.brief) continue;
            sysContent = inj.replace ? inj.text : sysContent + '\n' + inj.text;
        }

        // Replace system prompt entirely if the lore engine provided one
        if (pending.systemPrompt) {
            sysContent = pending.systemPrompt;
        }

        scenePage.push({ role: 'system', content: sysContent });
    }

    // --- Layer 2: Scene context (lore engine header) ------------------------
    // Detect priority-injection turns: the lore engine flags turns where
    // content should be placed front-and-center (Layer 5) rather than as
    // background context (Layer 2).  recentMessageCount === 1 is kept as a
    // secondary signal for backwards compatibility.
    const isPriorityTurn = pending.priorityInjection === true
        || pending.recentMessageCount === 1;

    if (pending.header && !isPriorityTurn) {
        // Normal turn — header already contains <engine-data> wrapper from the
        // engine, so no extra wrapper needed. Story summary is appended into the
        // same system message so the model sees one unified data block.
        const summaryText = pending.condensedSummary || pending.storySummary || '';
        let headerContent = pending.header;
        if (summaryText) {
            // Insert story summary inside the engine-data block (before </engine-data>)
            const closeTag = '</engine-data>';
            const closeIdx = headerContent.lastIndexOf(closeTag);
            if (closeIdx !== -1) {
                headerContent = headerContent.substring(0, closeIdx)
                    + '\n<story-so-far>\n' + summaryText + '\n</story-so-far>\n'
                    + headerContent.substring(closeIdx);
            } else {
                // Fallback: append after header
                headerContent += '\n<story-so-far>\n' + summaryText + '\n</story-so-far>';
            }
        }
        scenePage.push({
            role: 'system',
            content: headerContent,
        });
    }
    // On priority turns the header is held back and injected into Layer 5,
    // so the model treats it as an active instruction rather than background.

    // --- Layer 4: Recent messages -------------------------------------------
    // Engine provides scrubbedRecentMessages (body-catalog terms removed from
    // assistant messages to prevent echo pattern). Fall back to slicing from
    // the full message array if the engine didn't provide them.
    let recentForPage;
    if (pending.scrubbedRecentMessages && pending.scrubbedRecentMessages.length > 0) {
        recentForPage = pending.scrubbedRecentMessages.slice();
    } else {
        const recentCount = pending.recentMessageCount
            || settings.recentMessageCount
            || 3;
        const chatMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');
        const sliceCount = recentCount * 2;
        recentForPage = chatMessages.slice(-sliceCount);
    }

    // Separate out the current (last) user message — it goes in Layer 5.
    let currentUserMsg = null;
    if (recentForPage.length > 0 && recentForPage[recentForPage.length - 1].role === 'user') {
        currentUserMsg = recentForPage.pop();
    }

    // Everything remaining is the dialogue history window.
    for (const m of recentForPage) {
        scenePage.push({ role: m.role, content: m.content });
    }

    // --- Layer 5: Current user message with injections ----------------------
    if (currentUserMsg) {
        let content = currentUserMsg.content || '';

        // Prepend the director brief — suppressed on TX turns
        if (pending.brief && !isPriorityTurn) {
            content = `<director>\n${pending.brief}\n</director>\n\n` + content;
        }

        // On priority turns, inject the full header as an active instruction
        // between the director brief and the user's text.  The lore engine
        // includes its own write instruction, so the plugin stays generic.
        // On priority turns, TX header goes as final system message instead
        // of being embedded here. User message stays clean.
        // if (isPriorityTurn && pending.header) { ... moved to post-assembly }

        // Process remaining inject entries (non-system, non-header, non-brief)
        for (const inj of (pending.inject || [])) {
            if (!inj || !inj.text) continue;
            if (inj.text === pending.header || inj.text === pending.brief) continue;
            if (inj.position === 'system') continue;  // already handled in Layer 1

            switch (inj.position) {
                case 'before_last_user':
                    content = inj.text + '\n\n' + content;
                    break;
                case 'after_last_user':
                    content = content + '\n\n' + inj.text;
                    break;
                case 'depth': {
                    const depth = inj.depth || 0;
                    // On priority/TX turns, skip depth-0 injections (hard
                    // rules about orgasm gates etc.) — they're not relevant
                    // during transformation and can trigger model safety.
                    if (depth === 0 && isPriorityTurn) {
                        break;
                    }
                    // Normal turns: merge depth-0 into system message to
                    // prevent the model from echoing tags as visible text.
                    if (depth === 0 && scenePage.length > 0 && scenePage[0].role === 'system') {
                        scenePage[0].content += '\n\n' + inj.text;
                    } else {
                        const pos = Math.max(0, scenePage.length - depth);
                        scenePage.splice(pos, 0, {
                            role: inj.role || 'system',
                            content: inj.text,
                        });
                    }
                    break;
                }
                // prefill is handled after the user message is pushed
            }
        }

        scenePage.push({ role: 'user', content });
    }

    // --- Prefill (assistant priming) ----------------------------------------
    for (const inj of (pending.inject || [])) {
        if (inj && inj.text && inj.position === 'prefill') {
            scenePage.push({ role: 'assistant', content: inj.text });
        }
    }

    return scenePage;
}

function applyInjection(chat, inj, stFormat) {
    if (!inj || !inj.text) return;

    const isUser = (m) => stFormat ? (m.is_user && !m.is_system) : m.role === 'user';
    const isSystem = (m) => stFormat ? m.is_system : m.role === 'system';
    const getMes = (m) => stFormat ? (m.mes || '') : (m.content || '');
    const setMes = (m, val) => { if (stFormat) m.mes = val; else m.content = val; };

    switch (inj.position) {
        case 'system': {
            const idx = chat.findIndex(isSystem);
            if (idx >= 0) {
                setMes(chat[idx], inj.replace ? inj.text : getMes(chat[idx]) + '\n' + inj.text);
            }
            break;
        }
        case 'before_last_user': {
            for (let i = chat.length - 1; i >= 0; i--) {
                if (isUser(chat[i])) {
                    setMes(chat[i], inj.text + '\n\n' + getMes(chat[i]));
                    break;
                }
            }
            break;
        }
        case 'after_last_user': {
            for (let i = chat.length - 1; i >= 0; i--) {
                if (isUser(chat[i])) {
                    setMes(chat[i], getMes(chat[i]) + '\n\n' + inj.text);
                    break;
                }
            }
            break;
        }
        case 'depth': {
            const depth = inj.depth || 0;
            const pos = Math.max(0, chat.length - depth);
            if (stFormat) {
                chat.splice(pos, 0, {
                    name: '', is_user: false, is_system: true,
                    mes: inj.text, send_date: new Date().toISOString(),
                });
            } else {
                chat.splice(pos, 0, { role: inj.role || 'system', content: inj.text });
            }
            break;
        }
        case 'prefill': {
            if (stFormat) {
                chat.push({
                    name: '', is_user: false, is_system: false,
                    mes: inj.text, send_date: new Date().toISOString(),
                });
            } else {
                chat.push({ role: 'assistant', content: inj.text });
            }
            break;
        }
    }
}

// -- Post-response handler ---------------------------------------------------

async function onMessageReceived(messageIndex) {
    if (!settings.enabled || !lastTurnResult) return;

    const ctx = SillyTavern.getContext();
    const chat = ctx.chat;
    if (!chat || messageIndex < 0 || messageIndex >= chat.length) return;

    const msg = chat[messageIndex];
    if (!msg || msg.is_user) return;

    const assistantText = msg.mes || '';

    // Find the last user message before this assistant reply (for turn log compression)
    let userText = '';
    for (let i = messageIndex - 1; i >= 0; i--) {
        if (chat[i] && chat[i].is_user) {
            userText = chat[i].mes || '';
            break;
        }
    }

    // v2.0.5 — capture the AI response and surrounding handleResponse activity
    _pushDebugMarker('AI_RESPONSE', { chars: assistantText.length, preview: assistantText.substring(0, 300) });

    let result;

    if (activeLore && typeof activeLore.handleResponse === 'function') {
        const evts = lastTurnResult.events || {};
        const _hrStart = performance.now ? performance.now() : Date.now();
        _pushDebugMarker('HANDLE_RESPONSE_START');
        try {
            result = await activeLore.handleResponse({
                assistantText,
                userText,
                state: lastTurnResult.state,
                events: evts,
                config: activeLore._config || {},
            });
            if (result) result.ok = true;
            _pushDebugMarker('HANDLE_RESPONSE_DONE', {
                ms: Math.round(((performance.now ? performance.now() : Date.now()) - _hrStart) * 1000) / 1000,
                cleaned_chars: (result?.cleanedText || result?.cleaned_text || '').length || null,
            });
        } catch (ex) {
            console.error('[OW] handleResponse error:', ex);
            _pushDebugMarker('HANDLE_RESPONSE_ERROR', String(ex && ex.stack || ex));
        }
    }

    // v2.0.5 — capture handleResponse outcome before flushing state
    try {
        if (_lastAssembled) {
            _lastAssembled.handle_response = {
                ok: !!result?.ok,
                assistantText_chars: assistantText.length,
                assistantText: assistantText,
                cleanedText: result?.cleanedText || result?.cleaned_text || null,
                cleanedText_changed: !!(result && (result.cleanedText || result.cleaned_text) &&
                                       (result.cleanedText || result.cleaned_text) !== assistantText),
                full_result_keys: result ? Object.keys(result) : [],
            };
        }
    } catch (_) { /* swallow */ }

    if (result?.ok) {
        await writeTurnState(result.state, lastTurnResult?._personaState);
        // v2.0.12 — expose to window so engine HUD live-state read can find it
        try {
            if (typeof window !== 'undefined') window._owLastTurnState = result.state;
        } catch (_) { /* non-critical */ }
        const cleaned = result.cleanedText || result.cleaned_text;
        if (cleaned && cleaned !== assistantText) {
            msg.mes = cleaned;
            const el = document.querySelector(`#chat .mes[mesid="${messageIndex}"] .mes_text`);
            if (el) {
                el.innerHTML = ctx.messageFormatting?.(cleaned, msg.name, msg.is_system, msg.is_user, messageIndex) || cleaned;
            }
        }
        // Refresh HUD after assistant response processed
        if (activeLore && typeof activeLore.updateHud === 'function') {
            activeLore.updateHud(result.state, activeLore._config);
        }
    } else {
        // handleResponse didn't run — persist processTurn state to the new message
        await writeTurnState(lastTurnResult?.state, lastTurnResult?._personaState);
    }

    lastTurnResult = null;
}

// -- Settings UI -------------------------------------------------------------

function getSettingsHtml() {
    return `
    <div id="ow-settings">
        <label style="margin-bottom:8px; display:flex; align-items:center; gap:6px;">
            <input type="checkbox" id="ow-enabled">
            <span>Enabled</span>
        </label>

        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Lore Modules</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <select id="ow-active-select" class="text_pole" style="width:100%;margin-bottom:6px;">
                    <option value="">(none loaded)</option>
                </select>
                <div style="display:flex; gap:4px; flex-wrap:wrap;">
                    <button id="ow-import-btn" class="menu_button" title="Import a .js lore file from your device">Import (.js)</button>
                    <button id="ow-import-url-btn" class="menu_button" title="Load a lore file from a URL">From URL</button>
                    <button id="ow-reload-btn" class="menu_button">Reload</button>
                    <button id="ow-update-btn" class="menu_button" title="Check for a newer version of the active lore">Check Update</button>
                    <button id="ow-remove-btn" class="menu_button redWarning">Remove</button>
                </div>
                <div id="ow-info" class="ow-status" style="display:none;margin-top:6px;"></div>
            </div>
        </div>

        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Debug</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label style="margin-bottom:6px; display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" id="ow-debug">
                    <span>Debug logging</span>
                </label>
                <div id="ow-debug-panel" style="display:none"></div>
            </div>
        </div>

        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Scene Page</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label style="margin-bottom:6px; display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" id="ow-scene-page-mode">
                    <span>Enable Scene Page Mode</span>
                </label>
                <small style="display:block;margin-bottom:8px;opacity:0.7;">
                    Replace full chat history with a focused scene page each turn.
                    The model receives only the character card, current state, story
                    summary, and last few messages.
                </small>
                <label style="margin-bottom:6px; display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" id="ow-skip-greeting">
                    <span>Skip card greeting in history</span>
                </label>
                <small style="display:block;margin-bottom:8px;opacity:0.7;">
                    Cuts the character's first_mes from the API payload so its scene
                    context doesn't fight your extension scene/scenario overrides.
                    Greeting stays visible in the chat UI.
                </small>
                <div id="ow-scene-page-options" style="margin-left:4px;">
                    <label style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
                        <span>Recent messages:</span>
                        <input type="number" id="ow-recent-msg-count" class="text_pole" min="1" max="10" value="3" style="width:60px;">
                    </label>
                    <label style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
                        <span>Max summary tokens:</span>
                        <input type="number" id="ow-max-summary-tokens" class="text_pole" min="100" max="800" value="400" style="width:70px;">
                    </label>
                </div>
            </div>
        </div>

        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>State</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div style="display:flex; gap:4px; flex-wrap:wrap;">
                    <button id="ow-export-state" class="menu_button">Export</button>
                    <button id="ow-import-state" class="menu_button">Import</button>
                    <button id="ow-clear-state" class="menu_button redWarning">Clear (this chat)</button>
                </div>
            </div>
        </div>

        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Scene Override</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <small style="display:block;margin-bottom:8px;opacity:0.7;">
                    Override the card's location and scenario. Leave on "Card Default" to use what the card provides.
                </small>
                <label style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                    <span>Location:</span>
                    <select id="ow-location-override" class="text_pole" style="width:100%;">
                        <option value="">(Card Default)</option>
                        <option value="_custom">Custom...</option>
                    </select>
                </label>
                <input type="text" id="ow-location-custom" class="text_pole" placeholder="Type custom location..." style="width:100%;margin-bottom:6px;display:none;">
                <label style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                    <span>Scene:</span>
                    <select id="ow-scene-select" class="text_pole" style="width:100%;">
                        <option value="">(Card Default)</option>
                        <option value="_random">Random</option>
                        <option value="_custom">Custom...</option>
                    </select>
                </label>
                <textarea id="ow-scenario-override" class="text_pole" rows="3" placeholder="(blank = use card scenario)" style="width:100%;resize:vertical;margin-bottom:6px;display:none;"></textarea>
            </div>
        </div>

        <div id="ow-module-settings"></div>
    </div>`;
}

function bindSettingsEvents() {
    bindCheckbox('ow-enabled', 'enabled');
    bindCheckbox('ow-debug', 'debug', (v) => {
        const p = document.getElementById('ow-debug-panel');
        if (p) p.style.display = v ? 'block' : 'none';
    });

    // Scene Page settings
    bindCheckbox('ow-scene-page-mode', 'scenePageMode', (v) => {
        const opts = document.getElementById('ow-scene-page-options');
        if (opts) opts.style.opacity = v ? '1' : '0.5';
    });
    // v2.0.4: greeting-strip toggle
    bindCheckbox('ow-skip-greeting', 'skipGreetingInHistory');

    const recentMsgEl = document.getElementById('ow-recent-msg-count');
    if (recentMsgEl) {
        recentMsgEl.value = settings.recentMessageCount || 3;
        recentMsgEl.addEventListener('change', () => {
            settings.recentMessageCount = Math.max(1, Math.min(10, parseInt(recentMsgEl.value, 10) || 3));
            recentMsgEl.value = settings.recentMessageCount;
            saveSettings();
        });
    }

    const maxTokensEl = document.getElementById('ow-max-summary-tokens');
    if (maxTokensEl) {
        maxTokensEl.value = settings.maxSummaryTokens || 400;
        maxTokensEl.addEventListener('change', () => {
            settings.maxSummaryTokens = Math.max(100, Math.min(800, parseInt(maxTokensEl.value, 10) || 400));
            maxTokensEl.value = settings.maxSummaryTokens;
            saveSettings();
        });
    }

    // Scene Override settings
    const locSelect = document.getElementById('ow-location-override');
    const locCustom = document.getElementById('ow-location-custom');
    const sceneSelect = document.getElementById('ow-scene-select');
    const scenarioEl = document.getElementById('ow-scenario-override');

    // Helper: get scenes for a location from the active lore
    function _getScenesForLocation(locValue) {
        if (!locValue || locValue === '_custom') return [];
        const scenes = activeLore?.data?.scenes;
        if (!scenes) return [];
        return scenes[locValue] || [];
    }

    // Helper: populate scene dropdown based on selected location
    function _populateSceneDropdown() {
        if (!sceneSelect) return;
        const locVal = locSelect?.value || '';
        const scenes = _getScenesForLocation(locVal);
        // Clear existing options
        sceneSelect.innerHTML = '';
        // Always have Card Default
        const defOpt = document.createElement('option');
        defOpt.value = ''; defOpt.textContent = '(Card Default)';
        sceneSelect.appendChild(defOpt);
        if (scenes.length > 0) {
            const randOpt = document.createElement('option');
            randOpt.value = '_random'; randOpt.textContent = 'Random';
            sceneSelect.appendChild(randOpt);
            scenes.forEach((s, i) => {
                const opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = s.name;
                sceneSelect.appendChild(opt);
            });
        }
        const custOpt = document.createElement('option');
        custOpt.value = '_custom'; custOpt.textContent = 'Custom...';
        sceneSelect.appendChild(custOpt);
        // Restore saved selection
        if (settings.sceneSelection && locVal === settings.sceneLocationKey) {
            sceneSelect.value = settings.sceneSelection;
        } else {
            sceneSelect.value = '';
        }
        _applySceneSelection();
    }

    // v2.0.3: fetch the card's default scenario (from charData.scenario field,
    // falling back to parsing the "Scenario:" block in description). Used to
    // pre-fill the Custom textarea so the user can make small edits rather
    // than typing from scratch.
    function _getCardDefaultScenario() {
        try {
            const ctx = SillyTavern.getContext();
            const charData = ctx?.characters?.[ctx?.characterId];
            if (!charData) return '';
            if (charData.scenario && String(charData.scenario).trim()) {
                return String(charData.scenario).trim();
            }
            const desc = charData.description || '';
            if (!desc) return '';
            const blocks = String(desc).split(/\n\s*\n/);
            for (const block of blocks) {
                const firstLine = block.split('\n')[0].trim();
                if (/^Scenario\s*:/i.test(firstLine)) {
                    return block.replace(/^Scenario\s*:\s*\n?/i, '').trim();
                }
            }
        } catch (e) {
            console.warn('[OW] _getCardDefaultScenario failed:', e.message);
        }
        return '';
    }

    // Helper: apply current scene selection to scenarioOverride
    function _applySceneSelection() {
        if (!sceneSelect || !scenarioEl) return;
        const val = sceneSelect.value;
        const locVal = locSelect?.value || '';
        const scenes = _getScenesForLocation(locVal);

        if (val === '') {
            // Card Default
            scenarioEl.style.display = 'none';
            scenarioEl.value = '';
            settings.scenarioOverride = '';
        } else if (val === '_custom') {
            // Custom — show textarea for manual entry.
            // v2.0.3: if the textarea is empty, pre-fill with the card's
            // default scenario so the user can edit rather than type from
            // scratch. Their edits save to settings.scenarioOverride.
            scenarioEl.style.display = 'block';
            if (!scenarioEl.value || !scenarioEl.value.trim()) {
                const cardDefault = _getCardDefaultScenario();
                if (cardDefault) {
                    scenarioEl.value = cardDefault;
                    settings.scenarioOverride = cardDefault;
                }
            }
        } else if (val === '_random') {
            // Random — pick one at random
            if (scenes.length > 0) {
                const pick = scenes[Math.floor(Math.random() * scenes.length)];
                scenarioEl.style.display = 'block';
                scenarioEl.value = pick.text;
                settings.scenarioOverride = pick.text;
            }
        } else {
            // Named scene by index
            const idx = parseInt(val, 10);
            if (scenes[idx]) {
                scenarioEl.style.display = 'block';
                scenarioEl.value = scenes[idx].text;
                settings.scenarioOverride = scenes[idx].text;
            }
        }
        settings.sceneSelection = val;
        settings.sceneLocationKey = locVal;
        saveSettings();
    }

    if (locSelect) {
        locSelect.value = settings.locationOverride || '';
        if (locSelect.value === '_custom' && locCustom) locCustom.style.display = 'block';
        locSelect.addEventListener('change', () => {
            if (locSelect.value === '_custom') {
                if (locCustom) locCustom.style.display = 'block';
                settings.locationOverride = locCustom?.value || '';
            } else {
                if (locCustom) locCustom.style.display = 'none';
                settings.locationOverride = locSelect.value;
            }
            _populateSceneDropdown();
            saveSettings();
        });
    }
    if (locCustom) {
        locCustom.value = (settings.locationOverride && locSelect?.value === '_custom') ? settings.locationOverride : '';
        locCustom.addEventListener('input', () => {
            settings.locationOverride = locCustom.value;
            saveSettings();
        });
    }
    if (sceneSelect) {
        sceneSelect.addEventListener('change', () => {
            _applySceneSelection();
        });
    }
    if (scenarioEl) {
        scenarioEl.value = settings.scenarioOverride || '';
        if (settings.sceneSelection === '_custom') scenarioEl.style.display = 'block';
        scenarioEl.addEventListener('input', () => {
            settings.scenarioOverride = scenarioEl.value;
            saveSettings();
        });
    }
    // Initial population of location + scene dropdowns from lore data
    _populateLocationDropdown();
    _populateSceneDropdown();

    const selectEl = document.getElementById('ow-active-select');
    if (selectEl) {
        selectEl.addEventListener('change', async () => {
            const key = selectEl.value;
            if (!key) {
                activeLore = null;
                settings.active_lore = null;
                saveSettings();
                clearModuleSettings();
                return;
            }
            try {
                await activateStoredLore(key);
                showLoreInfo(`Activated: ${activeLore.name || key}`, 'ok');
                renderModuleSettings();
            } catch (ex) {
                showLoreInfo(`Failed to load: ${ex.message}`, 'err');
            }
        });
        refreshLoreSelector();
    }

    document.getElementById('ow-import-btn')?.addEventListener('click', handleImportLore);

    document.getElementById('ow-import-url-btn')?.addEventListener('click', async () => {
        const url = prompt('Enter the URL of your lore .js file:');
        if (!url || !url.trim()) return;
        showLoreInfo('Loading from URL...', '');
        try {
            const lore = await loadLoreFromUrl(url.trim());
            await refreshLoreSelector();
            showLoreInfo(`Loaded & synced: ${lore.name || 'lore'} v${lore.version || '?'}`, 'ok');
            renderModuleSettings();
        } catch (ex) {
            showLoreInfo(`Failed: ${ex.message}`, 'err');
        }
    });

    document.getElementById('ow-reload-btn')?.addEventListener('click', async () => {
        const key = settings.active_lore;
        if (!key) { showLoreInfo('No active lore to reload.', 'err'); return; }
        showLoreInfo('Reloading...', '');

        const entry = settings.server_lores?.[key];
        const serverPath = typeof entry === 'string' ? entry : entry?.path;
        if (serverPath) {
            try {
                // Reload from local ST server — skip re-upload, file is already there
                const resp = await fetch(serverPath);
                if (!resp.ok) throw new Error(`${resp.status}`);
                const source = await resp.text();
                const lore = await loadLoreFromSource(source, key);
                activeLore = lore;
                // Preserve existing entry metadata
                if (typeof entry === 'object') {
                    entry.version = lore.version || '?';
                    entry.name = lore.name || key;
                }
                saveSettings();
                await refreshLoreSelector();
                showLoreInfo(`Reloaded: ${lore.name || key} v${lore.version || '?'}`, 'ok');
                renderModuleSettings();
                return;
            } catch (ex) {
                console.warn('[OW] Server reload failed:', ex.message);
            }
        }

        showLoreInfo('Reload failed: no server path found.', 'err');
    });

    document.getElementById('ow-remove-btn')?.addEventListener('click', handleRemoveLore);
    document.getElementById('ow-update-btn')?.addEventListener('click', () => checkForLoreUpdate(false));
    document.getElementById('ow-export-state')?.addEventListener('click', exportState);
    document.getElementById('ow-import-state')?.addEventListener('click', importState);
    document.getElementById('ow-clear-state')?.addEventListener('click', clearState);
}

function bindCheckbox(id, key, onChange) {
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = settings[key];
    el.addEventListener('change', () => {
        settings[key] = el.checked;
        saveSettings();
        if (onChange) onChange(el.checked);
    });
}

function showLoreInfo(msg, type) {
    const el = document.getElementById('ow-info');
    if (!el) return;
    el.style.display = 'block';
    el.textContent = msg;
    el.className = `ow-status ${type || ''}`;
}

async function refreshLoreSelector() {
    const el = document.getElementById('ow-active-select');
    if (!el) return;
    el.innerHTML = '<option value="">(none)</option>';
    for (const [key, entry] of Object.entries(settings.server_lores || {})) {
        const name = typeof entry === 'string' ? key : (entry?.name || key);
        const version = typeof entry === 'string' ? '?' : (entry?.version || '?');
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = `${name} v${version}`;
        if (key === settings.active_lore) opt.selected = true;
        el.appendChild(opt);
    }
}

async function handleImportLore() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.js';
    input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        showLoreInfo(`Importing ${file.name}...`, '');
        try {
            const source = await file.text();
            const lore = await importAndActivateLore(source, file.name);
            await refreshLoreSelector();
            showLoreInfo(`Imported & synced: ${lore.name || file.name} v${lore.version || '?'}`, 'ok');
            renderModuleSettings();
        } catch (ex) {
            console.error('[OW] Import failed:', ex);
            showLoreInfo(`Import failed: ${ex.message}`, 'err');
        }
    };
    input.click();
}

async function handleRemoveLore() {
    const el = document.getElementById('ow-active-select');
    const key = el?.value;
    if (!key) return;
    if (!confirm(`Remove lore module "${key}"?`)) return;
    if (settings.server_lores?.[key]) {
        delete settings.server_lores[key];
    }
    if (settings.active_lore === key) {
        activeLore = null;
        settings.active_lore = null;
        clearModuleSettings();
    }
    saveSettings();
    await refreshLoreSelector();
    showLoreInfo('Removed.', 'ok');
}

// Populate location dropdown from lore data categories (called after lore load/change)
function _populateLocationDropdown() {
    const locSelect = document.getElementById('ow-location-override');
    if (!locSelect) return;
    const saved = locSelect.value || settings.locationOverride || '';
    locSelect.innerHTML = '';
    const defOpt = document.createElement('option');
    defOpt.value = ''; defOpt.textContent = '(Card Default)';
    locSelect.appendChild(defOpt);

    const categories = activeLore?.data?.scenes?._categories;
    if (categories && Array.isArray(categories)) {
        for (const cat of categories) {
            const group = document.createElement('optgroup');
            group.label = cat.name;
            for (const loc of (cat.locations || [])) {
                const opt = document.createElement('option');
                opt.value = loc.key;
                opt.textContent = loc.label;
                group.appendChild(opt);
            }
            locSelect.appendChild(group);
        }
    }

    const custOpt = document.createElement('option');
    custOpt.value = '_custom'; custOpt.textContent = 'Custom...';
    locSelect.appendChild(custOpt);

    // Restore saved selection
    locSelect.value = saved;
    if (!locSelect.value && saved && saved !== '_custom') locSelect.value = '';
}

function renderModuleSettings() {
    const container = document.getElementById('ow-module-settings');
    if (!container) return;
    if (!activeLore || typeof activeLore.getSettingsHtml !== 'function') {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${activeLore.name || 'Lore'} Settings</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                ${activeLore.getSettingsHtml(activeLore._config || {})}
            </div>
        </div>`;
    if (typeof activeLore.onSettingsRendered === 'function') {
        activeLore.onSettingsRendered(activeLore._config || {}, {
            clearPersonaPill: clearPersonaState,
        });
    }
    // Refresh location dropdown from new lore data
    _populateLocationDropdown();
}

function clearModuleSettings() {
    const container = document.getElementById('ow-module-settings');
    if (container) container.innerHTML = '';
}

// -- State management --------------------------------------------------------

async function exportState() {
    const state = readMsgState();
    const persona = readPersonaState();
    const blob = new Blob(
        [JSON.stringify({ state, persona, exportedAt: Date.now() }, null, 2)],
        { type: 'application/json' }
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lore-state-${Date.now()}.json`;
    a.click();
}

async function importState() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (data.state) await writeMsgState(data.state);
            if (data.persona) await writePersonaState(data.persona);
            alert('State imported.');
        } catch (ex) {
            alert('Import failed: ' + ex.message);
        }
    };
    input.click();
}

async function clearState() {
    if (!confirm('Clear all lore state for this chat?')) return;
    await writeMsgState({});
    alert('State cleared.');
}

async function clearPersonaState() {
    if (!confirm('Clear persona pill/effect state for this chat?')) return;
    await writePersonaState({});
    alert('Persona pill state cleared.');
}

// -- Debug panel -------------------------------------------------------------

function updateDebugPanel(turn, state) {
    const panel = document.getElementById('ow-debug-panel');
    if (!panel || !settings.debug) return;
    panel.style.display = 'block';
    _renderDebugContent(panel, state, turn.events || {});
}

async function refreshDebugPanel() {
    const panel = document.getElementById('ow-debug-panel');
    if (!panel) return;
    panel.style.display = 'block';
    const state = readMsgState() || {};
    _renderDebugContent(panel, state, {});
}

let _slLastChosenName = null;   // sticky post-rename name for the debug panel (per chat)
async function _renderDebugContent(panel, state, events) {
    // Sticky chosen-name: the panel can transiently render a state that predates a rename (a
    // pre-rename message, or an in-flight turn), which flashes the OLD card name for a frame.
    // Once we've seen a _chosen_name for this chat, keep applying it so the panel name is stable.
    // Reset on CHAT_CHANGED so it never bleeds into a different chat.
    if (state && state._chosen_name) {
        _slLastChosenName = state._chosen_name;
    } else if (_slLastChosenName && state && state._card_name && !state._chosen_name) {
        state = Object.assign({}, state, { _chosen_name: _slLastChosenName });
    }
    let info = '';
    if (activeLore && typeof activeLore.getDebugInfo === 'function') {
        let ps = {};
        try {
            ps = readPersonaState() || {};
        } catch (e) { /* ignore */ }
        const raw = activeLore.getDebugInfo(state, events, activeLore._config || {}, ps);
        info = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    } else {
        info = [
            `Turn: ${state?.turn || '?'}`,
            `Events: ${Object.keys(events).join(', ') || 'none'}`,
        ].join('\n');
    }

    panel.innerHTML = `<pre style="
        font-family: monospace;
        font-size: 11px;
        line-height: 1.4;
        background: var(--SmartThemeBlurTintColor, #1a1a2e);
        color: var(--SmartThemeBodyColor, #ccc);
        padding: 8px 10px;
        border-radius: 4px;
        max-height: 500px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-word;
        margin: 4px 0;
    ">${escapeHtml(info)}</pre>
    <div style="display:flex; gap:4px; margin-top:4px; flex-wrap:wrap;">
        <button class="menu_button" id="ow-debug-refresh">Refresh</button>
        <button class="menu_button" id="ow-debug-copy">Copy</button>
        <button class="menu_button" id="ow-debug-dump-state">Dump JSON</button>
        <button class="menu_button" id="ow-debug-dump-header">Dump Header</button>
    </div>`;

    document.getElementById('ow-debug-refresh')?.addEventListener('click', refreshDebugPanel);

    document.getElementById('ow-debug-copy')?.addEventListener('click', () => {
        const done = () => {
            const btn = document.getElementById('ow-debug-copy');
            if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500); }
        };
        const fail = () => {
            const btn = document.getElementById('ow-debug-copy');
            if (btn) { btn.textContent = 'Failed'; setTimeout(() => btn.textContent = 'Copy', 1500); }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(info).then(done).catch(() => {
                _fallbackCopy(info) ? done() : fail();
            });
        } else {
            _fallbackCopy(info) ? done() : fail();
        }
    });

    document.getElementById('ow-debug-dump-state')?.addEventListener('click', async () => {
        const fullState = readMsgState() || state;
        const dump = JSON.stringify(fullState, null, 2);
        const blob = new Blob([dump], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `ow-state-${Date.now()}.json`; a.click();
        URL.revokeObjectURL(url);
    });

    document.getElementById('ow-debug-dump-header')?.addEventListener('click', () => {
        const header = lastTurnResult?.header || lastTurnResult?.brief || '(no header from last turn)';
        const blob = new Blob([header], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `ow-header-${Date.now()}.txt`; a.click();
        URL.revokeObjectURL(url);
    });
}

function escapeHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _fallbackCopy(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch (e) {
        return false;
    }
}

// -- Settings persistence ----------------------------------------------------

function loadSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULTS);
    }
    settings = ctx.extensionSettings[MODULE_NAME];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (!(k in settings)) settings[k] = v;
    }
}

function saveSettings() {
    const ctx = SillyTavern.getContext();
    ctx.extensionSettings[MODULE_NAME] = settings;
    ctx.saveSettingsDebounced();
}

// -- Init --------------------------------------------------------------------

(async function init() {
    loadSettings();

    if (settings.server_lores && Object.keys(settings.server_lores).length > 0) {
        for (const [key, entry] of Object.entries(settings.server_lores)) {
            const serverPath = typeof entry === 'string' ? entry : entry?.path;
            if (!serverPath) continue;
            try {
                await syncLoreFromServer(key, serverPath);
            } catch (ex) {
                console.warn(`[OW] Failed to sync lore "${key}" from server:`, ex.message);
            }
        }
    }

    if (settings.active_lore) {
        try {
            await activateStoredLore(settings.active_lore);
            // Silently check for a newer version if this lore has a sourceUrl
            const activeEntry = settings.server_lores?.[settings.active_lore];
            if (typeof activeEntry === 'object' && activeEntry?.sourceUrl) {
                checkForLoreUpdate(true).catch(() => {});
            }
        } catch (ex) {
            console.warn('[OW] Could not activate lore:', ex);
        }
    }

    const ctx = SillyTavern.getContext();

    const container = document.getElementById('extensions_settings2');
    if (container) {
        const wrapper = document.createElement('div');
        wrapper.classList.add('extension_container');
        wrapper.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>StatefulLore</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    ${getSettingsHtml()}
                </div>
            </div>
        `;
        container.appendChild(wrapper);
        bindSettingsEvents();
        renderModuleSettings();

        // Seed the HUD with existing state so it doesn't show "Waiting..."
        try {
            const seedState = readMsgState();
            if (seedState && activeLore && typeof activeLore.updateHud === 'function') {
                activeLore.updateHud(seedState, activeLore._config);
            }
        } catch (_) { /* non-critical */ }

        // Force the floating status window open on boot
        // Small delay to ensure onSettingsRendered has run and created the float
        setTimeout(() => {
            const floatWin = document.getElementById('xcw-float');
            if (floatWin && floatWin.style.display === 'none') {
                if (typeof window._xcwFloatToggle === 'function') window._xcwFloatToggle();
            } else if (!floatWin && typeof window._xcwFloatToggle === 'function') {
                window._xcwFloatToggle();
            }
        }, 500);
    }

    const { eventSource, event_types } = ctx;
    if (eventSource && event_types) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

        // Reload saved state + refresh HUD when user switches to a different chat
        if (event_types.CHAT_CHANGED) {
            eventSource.on(event_types.CHAT_CHANGED, async () => {
                try {
                    lastTurnResult = null;
                    _slLastChosenName = null;   // clear sticky rename-name when switching chats
                    const newState = readMsgState();
                    if (activeLore && typeof activeLore.updateHud === 'function') {
                        activeLore.updateHud(newState || null, activeLore._config);
                    }
                    // Also refresh the debug panel if open
                    if (settings.debug) refreshDebugPanel();
                    console.log('[OW] Chat changed — reloaded state from message variables');
                } catch (e) {
                    console.warn('[OW] Failed to reload state on chat change:', e);
                }
            });
        }
    }

    if (!window._owFetchInstalled) {
        const _origFetch = window.fetch;
        window.fetch = async function (...args) {
            const [url, opts] = args;
            const urlStr = typeof url === 'string' ? url : url?.url || '';

            // Only intercept generation POSTs when lore is active
            if (settings.enabled && activeLore &&
                opts?.method === 'POST' &&
                opts?.body && typeof opts.body === 'string' &&
                opts.body.length > 500 &&
                !urlStr.includes('/settings/')) {
                try {
                    const payload = JSON.parse(opts.body);

                    if (payload.messages && Array.isArray(payload.messages)) {
                        // ── Chat completion: full pipeline ───────────────────
                        const ctx = SillyTavern.getContext();

                        // v2.0.5 — start a fresh log buffer for this turn
                        _resetDebugBuffer();
                        _lastAssembled = null;
                        _pushDebugMarker('TURN_START', { mode: 'chat-completion' });

                        let state = readMsgState() || {};
                        let personaState = readPersonaState() || {};

                        // v2.0.5 — capture the user message that prompted this turn
                        try {
                            const lastUser = (ctx.chat || []).slice().reverse().find(m => m && m.is_user);
                            if (lastUser && lastUser.mes) {
                                _pushDebugMarker('USER_MSG', lastUser.mes);
                            }
                        } catch (_) { /* swallow */ }

                        // Build systemText from the card description directly — this is
                        // the authoritative source for Stats:, Name:, Sex:, etc.
                        // ST's system_prompt field is separate and typically does not
                        // contain the card description, so we always pull from ctx.
                        // The payload system message (system_prompt) is appended after
                        // so processTurn still has access to any extra directives.
                        let systemText = '';
                        const _cardData = ctx.characters?.[ctx.characterId];
                        if (_cardData) {
                            const parts = [];
                            if (_cardData.description) parts.push(_cardData.description);
                            if (_cardData.personality) parts.push(_cardData.personality);
                            if (_cardData.scenario)    parts.push('Scenario: ' + _cardData.scenario);
                            systemText = parts.join('\n');
                        }
                        // Append the payload system message if it adds anything not already there.
                        // v2.0.0: systemText is used by the engine for stat/card extraction only.
                        // The model-facing system message comes exclusively from pending.systemPrompt
                        // (engine-owned). ST's sysMsg content does NOT reach the model from here.
                        const sysMsg = payload.messages.find(m => m.role === 'system');
                        if (sysMsg && sysMsg.content && !systemText.includes(sysMsg.content.substring(0, 80))) {
                            systemText = systemText ? systemText + '\n' + sysMsg.content : sysMsg.content;
                        }

                        const messages = payload.messages.map(m => ({
                            role: m.role,
                            content: m.content || '',
                        }));

                        const charData = ctx.characters?.[ctx.characterId];

                        // ── Run lore engine ──────────────────────────────────
                        // v2.0.2: persona description fallback. ctx.persona is empty
                        // in some ST setups where persona content is delivered via the
                        // system message instead. Fall back to sysMsg.content when
                        // ctx.persona is empty. Trade-off: if a user's system prompt
                        // holds non-persona content (jailbreak / format prefs), that
                        // content will bleed into the engine's <user> block. Acceptable
                        // for this extension's primary audience.
                        const _ctxPersona = ctx.persona && String(ctx.persona).trim();
                        const _sysMsgFallback = (!_ctxPersona && sysMsg && sysMsg.content && sysMsg.content.trim()) || '';
                        const _personaDesc = _ctxPersona || _sysMsgFallback;
                        let turnResult;
                        const _ptStart = performance.now ? performance.now() : Date.now();
                        _pushDebugMarker('PROCESS_TURN_START');
                        try {
                            turnResult = await activeLore.processTurn({
                                systemText,
                                messages,
                                state,
                                personaState,
                                config: activeLore._config || {},
                                charNameHint: charData?.name || null,
                                personaName: ctx.name1 || null,
                                personaDescription: _personaDesc,
                                cardPersonality: charData?.personality || '',
                                cardDescription: charData?.description || '',
                                cardScenario: charData?.scenario || '',
                                cardTags: charData?.tags || [],
                                locationOverride: settings.locationOverride || '',
                                scenarioOverride: settings.scenarioOverride || '',
                            });
                        } catch (ex) {
                            console.error('[OW] processTurn error:', ex);
                            _pushDebugMarker('PROCESS_TURN_ERROR', String(ex && ex.stack || ex));
                            return _origFetch.apply(this, args);
                        }

                        const _ptMs = Math.round(((performance.now ? performance.now() : Date.now()) - _ptStart) * 1000) / 1000;
                        if (!turnResult) {
                            _pushDebugMarker('PROCESS_TURN_PASSTHROUGH', { ms: _ptMs });
                            if (settings.debug) console.log('[OW] processTurn returned null — passthrough');
                            return _origFetch.apply(this, args);
                        }
                        _pushDebugMarker('PROCESS_TURN_DONE', {
                            ms: _ptMs,
                            brief_chars: (turnResult.brief || '').length,
                            header_chars: (turnResult.header || '').length,
                            system_prompt_chars: (turnResult.systemPrompt || '').length,
                            inject_count: (turnResult.inject || []).length,
                            events: turnResult.events ? Object.keys(turnResult.events) : [],
                        });

                        state = turnResult.state || state;
                        personaState = turnResult.persona_state || personaState;

                        lastTurnResult = { ...turnResult, _mode: 'fetch-chat', _personaState: personaState };

                        // v2.0.12 — expose post-processTurn state on window so the engine's
                        // HUD live-state read can find it even before writeTurnState has
                        // persisted it to chat variables. Without this, turn 1 shows
                        // "Waiting for first turn..." until the AI response is saved.
                        try {
                            if (typeof window !== 'undefined') window._owLastTurnState = state;
                        } catch (_) { /* non-critical */ }

                        if (typeof activeLore.updateHud === 'function') {
                            activeLore.updateHud(state, activeLore._config);
                        }

                        // ── Build scene page: this replaces payload.messages ─
                        // The extension has 100% control from here. ST's assembled
                        // history is discarded and rebuilt from scratch.
                        const pending = {
                            header:             resolveMacros(turnResult.header || null, ctx),
                            brief:              resolveMacros(turnResult.brief || null, ctx),
                            systemPrompt:       resolveMacros(turnResult.systemPrompt || null, ctx),
                            inject:             turnResult.inject || [],
                            scrubbed_messages:  turnResult.scrubbed_messages || null,
                            storySummary:       resolveMacros(turnResult.storySummary || null, ctx),
                            condensedSummary:   turnResult.condensedSummary || '',
                            scrubbedRecentMessages: turnResult.scrubbedRecentMessages || null,
                            recentMessageCount: turnResult.recentMessageCount || null,
                            priorityInjection:  turnResult.priorityInjection || false,
                            // v2.0.7 — lore-owned priority message text. Extension stays generic;
                            // whatever the lore puts here is what gets appended at message[-1] on
                            // priority turns. Lore-agnostic plumbing.
                            priorityDirective:  resolveMacros(turnResult.priorityDirective || null, ctx),
                            personaBlock:       resolveMacros(turnResult.personaBlock || null, ctx),
                            anatomyOverride:    state._card_anatomy_override || null,
                            stripWords:         state._card_strip_words || null,
                            // Post-TX example dialogue — gated on the same signal as the
                            // anatomy override, so examples and body text can never
                            // disagree about which state the character is in.
                            postTxExamples:     state._card_anatomy_override
                                                  ? postTxExamplePair(ctx) : null,
                        };

                        // Also resolve macros in inject entries
                        for (const inj of pending.inject) {
                            if (inj && inj.text) inj.text = resolveMacros(inj.text, ctx);
                        }

                        const isPriorityTurn = pending.priorityInjection || pending.recentMessageCount === 1;

                        // Swap pre-TX example dialogue for the post-TX table BEFORE the
                        // branch, so whichever path runs inherits the corrected text —
                        // scene-page mode copies the system message through, and fallback
                        // mode passes native history straight out. Runs on the source
                        // array, so it catches examples whether ST folded them into the
                        // system prompt or sent them as their own messages.
                        applyPostTxExamples(payload.messages, pending.postTxExamples);

                        if (settings.scenePageMode) {
                            // ── Scene Page mode: full rebuild ────────────────
                            payload.messages = buildScenePage(pending, payload.messages);

                            // v2.0.7 — Priority turns: append the lore-supplied priorityDirective
                            // verbatim at message[-1] so it's the last thing the model sees.
                            // Extension stays lore-agnostic — the lore module owns ALL the prose;
                            // whatever it sets in turnResult.priorityDirective is what gets appended.
                            // No directive supplied -> no append (lore's call).
                            if (isPriorityTurn && pending.priorityDirective) {
                                payload.messages.push({
                                    role: 'system',
                                    content: pending.priorityDirective,
                                });
                            }
                        } else {
                            // ── Fallback: ST native history + header injected ─
                            // Full chat history passes through untouched. Header,
                            // brief, and priority directive are still injected.

                            // Scrub pill names from messages in fallback mode too
                            if (pending.scrubbed_messages && pending.scrubbed_messages.length) {
                                payload.messages = pending.scrubbed_messages;
                            }
                            if (pending.header && !isPriorityTurn) {
                                // Header already contains <engine-data> wrapper
                                payload.messages.unshift({
                                    role: 'system',
                                    content: pending.header,
                                });
                            }

                            // Inject brief into the last user message
                            if (pending.brief && !isPriorityTurn) {
                                const lastUser = [...payload.messages].reverse().find(m => m.role === 'user');
                                if (lastUser) {
                                    lastUser.content = `<director>\n${pending.brief}\n</director>\n\n` + lastUser.content;
                                }
                            }

                            // Priority / TX turns: append header + write directive
                            if (isPriorityTurn && pending.header) {
                                payload.messages.push({
                                    role: 'system',
                                    content: pending.header +
                                        '\n\nWrite the full transformation scene now. Use the physical guide above as your style reference. Multiple detailed paragraphs describing each physical change. Each change gets its own paragraph. Do not write a short response.',
                                });
                            }
                        }

                        // v2.0.4: strip the card's first_mes (greeting) from the API payload
                        // so its scene context doesn't fight extension scene/scenario overrides.
                        // Greeting stays visible in the ST chat UI; only the generation payload
                        // is affected. Skipped when no user message has been sent yet (chat is
                        // just the greeting so far — model would have nothing to respond to).
                        if (settings.skipGreetingInHistory !== false && Array.isArray(payload.messages)) {
                            const _firstAstIdx = payload.messages.findIndex(m => m && m.role === 'assistant');
                            if (_firstAstIdx >= 0) {
                                const _hasUserAfter = payload.messages.slice(_firstAstIdx + 1).some(m => m && m.role === 'user');
                                if (_hasUserAfter) {
                                    payload.messages.splice(_firstAstIdx, 1);
                                }
                            }
                        }

                        opts.body = JSON.stringify(payload);

                        // v2.0.5 — always log assembled prompt size to debug buffer (not gated on settings.debug)
                        _pushDebugMarker('PROMPT_ASSEMBLED', {
                            msg_count: payload.messages.length,
                            total_chars: payload.messages.reduce((n, m) => n + (m.content || '').length, 0),
                            priority: isPriorityTurn,
                            roles: payload.messages.map(m => m.role + '(' + (m.content || '').length + ')'),
                        });

                        // v2.0.5 — stash EVERYTHING for off-device debugging.
                        // Persisted into state._debug_dump.assembled by _flushDebugBuffer at saveChat.
                        _lastAssembled = _buildAssembledCapture({
                            mode: 'chat-completion',
                            payload, turnResult, pending,
                            isPriorityTurn,
                            systemText, messagesIn: messages,
                            charData, ctx, _personaDesc,
                            personaState, settings,
                        });

                        if (settings.debug) {
                            console.log('[OW] Assembled (' + payload.messages.length + ' msgs):',
                                payload.messages.map(m => m.role + '(' + (m.content || '').length + ')').join(', '));
                            // v2.0.1: engine now returns systemPrompt (owned by engine) in place of header
                            const _promptForDebug = turnResult.systemPrompt || turnResult.header;
                            console.log('[OW] Turn:', {
                                turn: state.turn,
                                systemPromptLen: (_promptForDebug || '').length,
                                briefLen: turnResult.brief?.length || 0,
                                priority: isPriorityTurn,
                                events: turnResult.events,
                            });
                            if (_promptForDebug) console.log('[OW] SYSTEM PROMPT:\n' + _promptForDebug);
                            if (turnResult.brief) console.log('[OW] BRIEF:\n' + turnResult.brief);
                            updateDebugPanel(turnResult, state);
                        }

                    } else if (typeof payload.prompt === 'string') {
                        // ── Text completion: full rebuild ────────────────────
                        // ST has already serialized payload.messages into payload.prompt
                        // using its own template. We discard that and rebuild from
                        // payload.messages ourselves using ChatML, giving us the same
                        // header injection control as in chat completion mode.
                        // v2.0.5 — fresh debug buffer for this turn
                        _resetDebugBuffer();
                        _lastAssembled = null;
                        _pushDebugMarker('TURN_START', { mode: 'text-completion' });
                        if (settings.debug) console.log('[OW] Text completion detected — rebuilding prompt');

                        if (!payload.messages || !Array.isArray(payload.messages)) {
                            // No messages array to work from — passthrough
                            if (settings.debug) console.log('[OW] Text completion: no messages array, passthrough');
                        } else {
                            const ctx = SillyTavern.getContext();

                            let state = readMsgState() || {};
                            let personaState = readPersonaState() || {};

                            // Build systemText from the card directly
                            let systemText = '';
                            const _cardDataTX = ctx.characters?.[ctx.characterId];
                            if (_cardDataTX) {
                                const parts = [];
                                if (_cardDataTX.description) parts.push(_cardDataTX.description);
                                if (_cardDataTX.personality)  parts.push(_cardDataTX.personality);
                                if (_cardDataTX.scenario)     parts.push('Scenario: ' + _cardDataTX.scenario);
                                systemText = parts.join('\n');
                            }
                            const sysMsgTX = payload.messages.find(m => m.role === 'system');
                            if (sysMsgTX && sysMsgTX.content && !systemText.includes(sysMsgTX.content.substring(0, 80))) {
                                systemText = systemText ? systemText + '\n' + sysMsgTX.content : sysMsgTX.content;
                            }

                            const messagesTX = payload.messages.map(m => ({
                                role: m.role,
                                content: m.content || '',
                            }));

                            const charDataTX = ctx.characters?.[ctx.characterId];

                            // Run lore engine
                            let turnResultTX;
                            try {
                                turnResultTX = await activeLore.processTurn({
                                    systemText,
                                    messages: messagesTX,
                                    state,
                                    personaState,
                                    config: activeLore._config || {},
                                    charNameHint: charDataTX?.name || null,
                                    personaName: ctx.name1 || null,
                                    personaDescription: ctx.persona || '',
                                    cardPersonality: charDataTX?.personality || '',
                                    cardDescription: charDataTX?.description || '',
                                    cardScenario: charDataTX?.scenario || '',
                                    cardTags: charDataTX?.tags || [],
                                    locationOverride: settings.locationOverride || '',
                                    scenarioOverride: settings.scenarioOverride || '',
                                });
                            } catch (ex) {
                                console.error('[OW] processTurn error (text completion):', ex);
                                // passthrough on error
                            }

                            if (turnResultTX) {
                                state = turnResultTX.state || state;
                                personaState = turnResultTX.persona_state || personaState;

                                lastTurnResult = { ...turnResultTX, _mode: 'fetch-text', _personaState: personaState };

                                // v2.0.12 — see chat-completion path above for rationale
                                try {
                                    if (typeof window !== 'undefined') window._owLastTurnState = state;
                                } catch (_) { /* non-critical */ }

                                if (typeof activeLore.updateHud === 'function') {
                                    activeLore.updateHud(state, activeLore._config);
                                }

                                // Build the message array with header injected
                                const pendingTX = {
                                    header:            resolveMacros(turnResultTX.header || null, ctx),
                                    brief:             resolveMacros(turnResultTX.brief || null, ctx),
                                    systemPrompt:      resolveMacros(turnResultTX.systemPrompt || null, ctx),
                                    inject:            turnResultTX.inject || [],
                                    scrubbed_messages: turnResultTX.scrubbed_messages || null,
                                    storySummary:      resolveMacros(turnResultTX.storySummary || null, ctx),
                                    condensedSummary:  turnResultTX.condensedSummary || '',
                                    scrubbedRecentMessages: turnResultTX.scrubbedRecentMessages || null,
                                    recentMessageCount:turnResultTX.recentMessageCount || null,
                                    priorityInjection: turnResultTX.priorityInjection || false,
                                    // v2.0.7 — lore-owned priority append text (see chat-completion comment)
                                    priorityDirective: resolveMacros(turnResultTX.priorityDirective || null, ctx),
                                    personaBlock:      resolveMacros(turnResultTX.personaBlock || null, ctx),
                                };

                                // Also resolve macros in inject entries
                                for (const inj of pendingTX.inject) {
                                    if (inj && inj.text) inj.text = resolveMacros(inj.text, ctx);
                                }

                                const isPriorityTX = pendingTX.priorityInjection || pendingTX.recentMessageCount === 1;

                                // Build assembled messages array same as chat mode
                                let assembledMessages;
                                if (settings.scenePageMode) {
                                    assembledMessages = buildScenePage(pendingTX, payload.messages);
                                } else {
                                    assembledMessages = (pendingTX.scrubbed_messages && pendingTX.scrubbed_messages.length)
                                        ? [...pendingTX.scrubbed_messages]
                                        : [...payload.messages];
                                    if (pendingTX.header && !isPriorityTX) {
                                        // Header already contains <engine-data> wrapper
                                        assembledMessages.unshift({
                                            role: 'system',
                                            content: pendingTX.header,
                                        });
                                    }
                                    if (pendingTX.brief && !isPriorityTX) {
                                        const lastUserTX = [...assembledMessages].reverse().find(m => m.role === 'user');
                                        if (lastUserTX) {
                                            lastUserTX.content = `<director>\n${pendingTX.brief}\n</director>\n\n` + lastUserTX.content;
                                        }
                                    }
                                    // v2.0.7 — append lore-supplied priorityDirective verbatim;
                                    // extension stays generic (no hardcoded TX prose).
                                    if (isPriorityTX && pendingTX.priorityDirective) {
                                        assembledMessages.push({
                                            role: 'system',
                                            content: pendingTX.priorityDirective,
                                        });
                                    }
                                }

                                // v2.0.4: strip card greeting from assembled messages before ChatML
                                // serialization — matches the chat-completion behavior.
                                if (settings.skipGreetingInHistory !== false && Array.isArray(assembledMessages)) {
                                    const _firstAstIdxTX = assembledMessages.findIndex(m => m && m.role === 'assistant');
                                    if (_firstAstIdxTX >= 0) {
                                        const _hasUserAfterTX = assembledMessages.slice(_firstAstIdxTX + 1).some(m => m && m.role === 'user');
                                        if (_hasUserAfterTX) {
                                            assembledMessages.splice(_firstAstIdxTX, 1);
                                        }
                                    }
                                }

                                // Serialize to ChatML and replace payload.prompt entirely
                                payload.prompt = messagesToChatML(assembledMessages, isPriorityTX);
                                // Remove messages array so the backend uses our prompt string
                                delete payload.messages;
                                opts.body = JSON.stringify(payload);

                                // v2.0.5 — capture text-completion prompt for off-device debugging
                                _pushDebugMarker('PROMPT_ASSEMBLED', {
                                    mode: 'text-completion',
                                    msg_count: assembledMessages.length,
                                    prompt_chars: payload.prompt.length,
                                    priority: isPriorityTX,
                                });
                                _lastAssembled = _buildAssembledCapture({
                                    mode: 'text-completion',
                                    payload: { messages: assembledMessages },
                                    turnResult: turnResultTX,
                                    pending: pendingTX,
                                    isPriorityTurn: isPriorityTX,
                                    systemText: systemText,
                                    messagesIn: messagesTX,
                                    charData: charDataTX,
                                    ctx, _personaDesc: ctx.persona || '',
                                    personaState, settings,
                                    promptString: payload.prompt,
                                });

                                if (settings.debug) {
                                    console.log('[OW] Text completion rebuilt prompt (' + payload.prompt.length + ' chars)');
                                    // v2.0.1: support engine systemPrompt in addition to legacy header
                                    const _promptForDebugTX = turnResultTX.systemPrompt || turnResultTX.header;
                                    if (_promptForDebugTX) console.log('[OW] SYSTEM PROMPT:\n' + _promptForDebugTX);
                                }
                            }
                        }
                    }

                } catch (e) {
                    if (e !== 'skip' && settings.debug) {
                        console.warn('[OW] Fetch intercept error:', e);
                    }
                }
            }

            return _origFetch.apply(this, args);
        };
        window._owFetchInstalled = true;
        console.log('[OW] Fetch interceptor installed');
    }

    console.log(`[OW] Extension loaded  --  lore: ${activeLore ? activeLore.name : 'none'}`);
})();
