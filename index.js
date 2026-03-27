/**
 * StatefullLore  --  SillyTavern Extension
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
    scenePageMode: false,
    recentMessageCount: 3,
    maxSummaryTokens: 400,
};

// -- Auto-update config ------------------------------------------------------

const XCHANGE_LORE_URL = 'https://raw.githubusercontent.com/cgstever/overwrite-st/main/x_change_world.js';
const XCHANGE_VERSION_URL = 'https://raw.githubusercontent.com/cgstever/overwrite-st/main/version.json';
const XCHANGE_LORE_KEY = 'x_change_world';

// -- Runtime state -----------------------------------------------------------

let settings = {};
let db = null;
let activeLore = null;
let lastTurnResult = null;

// -- IndexedDB ---------------------------------------------------------------

const DB_NAME = 'overwrite';
const DB_VERSION = 2;
const STORE_STATE = 'session_state';
const STORE_PERSONA = 'persona_state';
const STORE_LORE = 'lore_modules';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const idb = e.target.result;
            if (!idb.objectStoreNames.contains(STORE_STATE))
                idb.createObjectStore(STORE_STATE, { keyPath: 'id' });
            if (!idb.objectStoreNames.contains(STORE_PERSONA))
                idb.createObjectStore(STORE_PERSONA, { keyPath: 'id' });
            if (!idb.objectStoreNames.contains(STORE_LORE))
                idb.createObjectStore(STORE_LORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbGet(store, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result?.data ?? null);
        req.onerror = () => reject(req.error);
    });
}

function idbPut(store, key, data) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).put({ id: key, data });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

function idbDelete(store, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

function idbGetAll(store) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

// -- Keys --------------------------------------------------------------------

function getSessionKey() {
    const ctx = SillyTavern.getContext();
    const chatId = ctx.getCurrentChatId?.() || 'unknown';
    // ctx.characterId is undefined in group chats; fall back to the last
    // non-user, non-system message name so each character gets its own bucket.
    let charName = ctx.characters?.[ctx.characterId]?.name;
    if (!charName) {
        const chatLog = ctx.chat || [];
        for (let i = chatLog.length - 1; i >= 0; i--) {
            const m = chatLog[i];
            if (!m.is_user && !m.is_system && m.name) {
                charName = m.name;
                break;
            }
        }
    }
    charName = charName || 'unknown';
    return `${charName}::${chatId}`;
}

function getPersonaKey() {
    const ctx = SillyTavern.getContext();
    // Include chatId so pill/effect state is scoped per chat, not globally per persona.
    // Base stats are re-seeded from rs.personas on turn 1 so this is safe.
    const chatId = ctx.getCurrentChatId?.() || 'unknown';
    return `persona::${ctx.name1 || 'User'}::${chatId}`;
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
    const blob = new Blob([source], { type: 'text/plain' });
    const formData = new FormData();
    formData.append('file', blob, uploadName);
    const resp = await fetch('/api/files/upload', { method: 'POST', body: formData });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`ST file upload failed ${resp.status}: ${text.slice(0, 200)}`);
    }
    const result = await resp.json();
    const serverPath = result.path || result.url;
    if (!serverPath) throw new Error('ST upload response had no path: ' + JSON.stringify(result));
    return serverPath;
}

async function importAndActivateLore(source, filename) {
    const key = filename.replace(/\.js$/, '');
    const lore = await loadLoreFromSource(source, key);
    await idbPut(STORE_LORE, key, {
        source,
        filename,
        name: lore.name || key,
        version: lore.version || '?',
        importedAt: Date.now(),
    });
    try {
        const serverPath = await uploadLoreToServer(source, key);
        settings.server_lores = settings.server_lores || {};
        settings.server_lores[key] = serverPath;
        console.log(`[OW] Lore uploaded to ST server: ${serverPath}`);
    } catch (ex) {
        console.warn('[OW] Server upload failed (lore works locally only):', ex.message);
    }
    activeLore = lore;
    settings.active_lore = key;
    saveSettings();
    return lore;
}

async function loadLoreFromUrl(url) {
    const bustUrl = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    const resp = await fetch(bustUrl);
    if (!resp.ok) throw new Error(`Fetch ${url} failed: ${resp.status}`);
    const source = await resp.text();
    const filename = url.split('/').pop().split('?')[0] || 'lore.js';
    return importAndActivateLore(source, filename);
}

async function activateStoredLore(key) {
    const stored = await idbGet(STORE_LORE, key);
    if (!stored || !stored.source) {
        console.warn(`[OW] No stored lore found for key: ${key}`);
        return null;
    }
    activeLore = await loadLoreFromSource(stored.source, key);
    settings.active_lore = key;
    saveSettings();
    return activeLore;
}

async function syncLoreFromServer(key, serverPath) {
    console.log(`[OW] Syncing lore from server: ${key}`);
    const resp = await fetch(serverPath);
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
    const source = await resp.text();
    const lore = await loadLoreFromSource(source, key);
    await idbPut(STORE_LORE, key, {
        source,
        filename: key + '.js',
        name: lore.name || key,
        version: lore.version || '?',
        importedAt: Date.now(),
    });
    console.log(`[OW] Synced into IDB: ${key} v${lore.version || '?'}`);
    return { lore, source };
}

// -- Auto-update -------------------------------------------------------------

async function checkForLoreUpdate(silent = false) {
    if (!silent) showLoreInfo('Checking for updates...', '');
    try {
        const resp = await fetch(XCHANGE_VERSION_URL + '?t=' + Date.now());
        if (!resp.ok) throw new Error(`Version check failed: ${resp.status}`);
        const { version: remoteVersion } = await resp.json();
        const localVersion = activeLore?.version ?? null;

        if (localVersion === remoteVersion) {
            if (!silent) showLoreInfo(`Already up to date: v${localVersion}`, 'ok');
            return false;
        }

        const fromStr = localVersion ? `v${localVersion}` : 'none';
        showLoreInfo(`Updating lore: ${fromStr} → v${remoteVersion}…`, '');
        await loadLoreFromUrl(XCHANGE_LORE_URL);
        showLoreInfo(`Updated to v${remoteVersion} ✓`, 'ok');
        return true;
    } catch (ex) {
        if (!silent) showLoreInfo(`Update check failed: ${ex.message}`, 'err');
        console.warn('[OW] Update check failed:', ex);
        return false;
    }
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

function buildScenePage(pending, messages) {
    const scenePage = [];

    // --- Layer 1: System message (character card + guidelines) ---------------
    // ST already constructs this; keep it as-is.
    const sysMsg = messages.find(m => m.role === 'system');
    if (sysMsg) {
        let sysContent = sysMsg.content || '';

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
        // Normal turn — header goes in Layer 2 as scene context
        scenePage.push({
            role: 'system',
            content: '[SCENE CONTEXT]\n' + pending.header + '\n[/SCENE CONTEXT]',
        });
    }
    // On priority turns the header is held back and injected into Layer 5,
    // so the model treats it as an active instruction rather than background.

    // --- Layer 3: Story summary (beat history) ------------------------------
    // Suppressed on TX turns — the model only needs the transformation header.
    if (pending.storySummary && !isPriorityTurn) {
        scenePage.push({
            role: 'system',
            content: pending.storySummary,
        });
    }

    // --- Layer 4: Recent messages -------------------------------------------
    // Use the engine's recentMessageCount when provided (e.g. 1 on TX turns),
    // otherwise fall back to the user's setting, then the default of 3.
    const recentCount = pending.recentMessageCount
        || settings.recentMessageCount
        || 3;

    // Gather only user/assistant messages (skip system messages).
    const chatMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');

    // We want the last `recentCount` *exchanges* (pairs).  An exchange is
    // typically one user + one assistant message, so we keep recentCount * 2
    // messages total.  The very last user message goes into Layer 5 instead.
    const sliceCount = recentCount * 2;
    const tail = chatMessages.slice(-sliceCount);

    // Separate out the current (last) user message — it goes in Layer 5.
    let currentUserMsg = null;
    if (tail.length > 0 && tail[tail.length - 1].role === 'user') {
        currentUserMsg = tail.pop();
    }

    // Everything remaining is the dialogue history window.
    for (const m of tail) {
        scenePage.push({ role: m.role, content: m.content });
    }

    // --- Layer 5: Current user message with injections ----------------------
    if (currentUserMsg) {
        let content = currentUserMsg.content || '';

        // Prepend the director brief — suppressed on TX turns
        if (pending.brief && !isPriorityTurn) {
            content = `[DIRECTOR]\n${pending.brief}\n[/DIRECTOR]\n\n` + content;
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
    const sessionKey = getSessionKey();
    let result;

    if (activeLore && typeof activeLore.handleResponse === 'function') {
        const evts = lastTurnResult.events || {};
        try {
            result = await activeLore.handleResponse({
                assistantText,
                state: lastTurnResult.state,
                events: evts,
                config: activeLore._config || {},
            });
            if (result) result.ok = true;
        } catch (ex) {
            console.error('[OW] handleResponse error:', ex);
        }
    }

    if (result?.ok) {
        await idbPut(STORE_STATE, sessionKey, result.state);
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
                    <button id="ow-update-btn" class="menu_button" title="Check GitHub for a newer version of X-Change World lore">Check Update</button>
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
                <b>Scene Page (experimental)</b>
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

        const serverPath = settings.server_lores?.[key];
        if (serverPath) {
            try {
                const resp = await fetch(serverPath);
                if (!resp.ok) throw new Error(`${resp.status}`);
                const source = await resp.text();
                const lore = await importAndActivateLore(source, key + '.js');
                await refreshLoreSelector();
                showLoreInfo(`Reloaded: ${lore.name || key} v${lore.version || '?'}`, 'ok');
                renderModuleSettings();
                return;
            } catch (ex) {
                console.warn('[OW] Server reload failed, trying IDB:', ex.message);
            }
        }

        const stored = await idbGet(STORE_LORE, key);
        if (stored?.source) {
            try {
                activeLore = await loadLoreFromSource(stored.source, key);
                settings.active_lore = key;
                saveSettings();
                await refreshLoreSelector();
                showLoreInfo(`Reloaded from cache: ${activeLore.name || key}`, 'ok');
                renderModuleSettings();
                return;
            } catch (ex) {
                console.warn('[OW] IDB reload failed:', ex.message);
            }
        }

        showLoreInfo('Reload failed: no source found.', 'err');
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
    const all = await idbGetAll(STORE_LORE);
    for (const entry of all) {
        const d = entry.data;
        const opt = document.createElement('option');
        opt.value = entry.id;
        opt.textContent = `${d.name || entry.id} v${d.version || '?'}`;
        if (entry.id === settings.active_lore) opt.selected = true;
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
    await idbDelete(STORE_LORE, key);
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
}

function clearModuleSettings() {
    const container = document.getElementById('ow-module-settings');
    if (container) container.innerHTML = '';
}

// -- State management --------------------------------------------------------

async function exportState() {
    const sessionKey = getSessionKey();
    const personaKey = getPersonaKey();
    const state = await idbGet(STORE_STATE, sessionKey);
    const persona = await idbGet(STORE_PERSONA, personaKey);
    const blob = new Blob(
        [JSON.stringify({ sessionKey, personaKey, state, persona, exportedAt: Date.now() }, null, 2)],
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
            if (data.state) await idbPut(STORE_STATE, data.sessionKey || getSessionKey(), data.state);
            if (data.persona) await idbPut(STORE_PERSONA, data.personaKey || getPersonaKey(), data.persona);
            alert('State imported.');
        } catch (ex) {
            alert('Import failed: ' + ex.message);
        }
    };
    input.click();
}

async function clearState() {
    if (!confirm('Clear all lore state for this chat?')) return;
    await idbPut(STORE_STATE, getSessionKey(), {});
    alert('State cleared.');
}

async function clearPersonaState() {
    if (!confirm('Clear persona pill/effect state for this chat?')) return;
    const personaKey = getPersonaKey();
    await idbPut(STORE_PERSONA, personaKey, {});
    // Also clear any old-format keys (persona::Name without chatId)
    try {
        const all = await idbGetAll(STORE_PERSONA);
        for (const entry of all) {
            const k = entry.id || '';
            // Old format: persona::Name (exactly 2 segments)
            if (k.startsWith('persona::') && k.split('::').length === 2) {
                await idbDelete(STORE_PERSONA, k);
                console.log('[OW] Deleted legacy persona key:', k);
            }
        }
    } catch (ex) { console.warn('[OW] clearPersonaState migration:', ex); }
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
    const sessionKey = getSessionKey();
    const state = (await idbGet(STORE_STATE, sessionKey)) || {};
    _renderDebugContent(panel, state, {});
}

async function _renderDebugContent(panel, state, events) {
    let info = '';
    if (activeLore && typeof activeLore.getDebugInfo === 'function') {
        let ps = {};
        try {
            const personaKey = getPersonaKey();
            ps = (await idbGet(STORE_PERSONA, personaKey)) || {};
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
        const sessionKey = getSessionKey();
        const fullState = (await idbGet(STORE_STATE, sessionKey)) || state;
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
    try {
        db = await openDB();
        console.log('[OW] IndexedDB ready');
        // Migrate legacy persona keys: delete old persona::Name entries (no chatId segment)
        // These were created before v6.4.4 and cause pill state to bleed across chats
        try {
            const allPersona = await idbGetAll(STORE_PERSONA);
            for (const entry of allPersona) {
                const k = entry.id || '';
                if (k.startsWith('persona::') && k.split('::').length === 2) {
                    await idbDelete(STORE_PERSONA, k);
                    console.log('[OW] Migrated: deleted legacy persona key', k);
                }
            }
        } catch (ex) { console.warn('[OW] Persona migration failed:', ex); }
    } catch (ex) {
        console.error('[OW] IndexedDB failed:', ex);
        return;
    }

    loadSettings();

    if (settings.server_lores && Object.keys(settings.server_lores).length > 0) {
        for (const [key, serverPath] of Object.entries(settings.server_lores)) {
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
            // Silently check for a newer version; shows status only if update found or fails
            checkForLoreUpdate(true).catch(() => {});
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
                    <b>StatefullLore</b>
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

        // Seed the HUD with existing state from IDB so it doesn't show "Waiting..."
        try {
            const seedState = await idbGet(STORE_STATE, getSessionKey());
            if (seedState && activeLore && typeof activeLore.updateHud === 'function') {
                activeLore.updateHud(seedState, activeLore._config);
            }
        } catch (_) { /* non-critical */ }
    }

    const { eventSource, event_types } = ctx;
    if (eventSource && event_types) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

        // Reload saved state + refresh HUD when user switches to a different chat
        if (event_types.CHAT_CHANGED) {
            eventSource.on(event_types.CHAT_CHANGED, async () => {
                try {
                    const newState = await idbGet(STORE_STATE, getSessionKey());
                    if (activeLore && typeof activeLore.updateHud === 'function') {
                        activeLore.updateHud(newState || null, activeLore._config);
                    }
                    // Also refresh the debug panel if open
                    if (settings.debug) refreshDebugPanel();
                    console.log('[OW] Chat changed — reloaded state from IDB');
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
                        const sessionKey = getSessionKey();
                        const personaKey = getPersonaKey();

                        let state = (await idbGet(STORE_STATE, sessionKey)) || {};
                        let personaState = (await idbGet(STORE_PERSONA, personaKey)) || {};

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
                        // Append the payload system message if it adds anything not already there
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
                        let turnResult;
                        try {
                            turnResult = await activeLore.processTurn({
                                systemText,
                                messages,
                                state,
                                personaState,
                                config: activeLore._config || {},
                                charNameHint: charData?.name || null,
                                personaName: ctx.name1 || null,
                            });
                        } catch (ex) {
                            console.error('[OW] processTurn error:', ex);
                            return _origFetch.apply(this, args);
                        }

                        if (!turnResult) {
                            if (settings.debug) console.log('[OW] processTurn returned null — passthrough');
                            return _origFetch.apply(this, args);
                        }

                        state = turnResult.state || state;
                        personaState = turnResult.persona_state || personaState;

                        await idbPut(STORE_STATE, sessionKey, state);
                        await idbPut(STORE_PERSONA, personaKey, personaState);

                        lastTurnResult = { ...turnResult, _mode: 'fetch-chat' };

                        if (typeof activeLore.updateHud === 'function') {
                            activeLore.updateHud(state, activeLore._config);
                        }

                        // ── Build scene page: this replaces payload.messages ─
                        // The extension has 100% control from here. ST's assembled
                        // history is discarded and rebuilt from scratch.
                        const pending = {
                            header:             turnResult.header || null,
                            brief:              turnResult.brief || null,
                            systemPrompt:       turnResult.systemPrompt || null,
                            inject:             turnResult.inject || [],
                            scrubbed_messages:  turnResult.scrubbed_messages || null,
                            storySummary:       turnResult.storySummary || null,
                            recentMessageCount: turnResult.recentMessageCount || null,
                            priorityInjection:  turnResult.priorityInjection || false,
                        };

                        payload.messages = buildScenePage(pending, payload.messages);

                        // Priority / TX turns: append write directive as the final
                        // message so it's the absolute last thing the model sees.
                        const isPriorityTurn = pending.priorityInjection || pending.recentMessageCount === 1;
                        if (isPriorityTurn && pending.header) {
                            payload.messages.push({
                                role: 'system',
                                content: pending.header +
                                    '\n\nWrite the full transformation scene now. Use the physical guide above as your style reference. Multiple detailed paragraphs describing each physical change. Each change gets its own paragraph. Do not write a short response.',
                            });
                        }

                        opts.body = JSON.stringify(payload);

                        if (settings.debug) {
                            console.log('[OW] Assembled (' + payload.messages.length + ' msgs):',
                                payload.messages.map(m => m.role + '(' + (m.content || '').length + ')').join(', '));
                            console.log('[OW] Turn:', {
                                turn: state.turn,
                                headerLen: turnResult.header?.length || 0,
                                briefLen: turnResult.brief?.length || 0,
                                priority: isPriorityTurn,
                                events: turnResult.events,
                            });
                            if (turnResult.header) console.log('[OW] HEADER:\n' + turnResult.header);
                            if (turnResult.brief)  console.log('[OW] BRIEF:\n'  + turnResult.brief);
                            updateDebugPanel(turnResult, state);
                        }

                    } else if (typeof payload.prompt === 'string') {
                        // ── Text completion — not yet implemented ────────────
                        if (settings.debug) console.log('[OW] Text completion detected — passthrough');
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
