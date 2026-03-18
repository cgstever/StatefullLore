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

globalThis.overwriteInterceptor = async function (chat, contextSize, abort, type) {
    if (!settings.enabled) return;
    if (type === 'quiet' || type === 'impersonate') return;

    const ctx = SillyTavern.getContext();
    const sessionKey = getSessionKey();
    const personaKey = getPersonaKey();

    let state = (await idbGet(STORE_STATE, sessionKey)) || {};
    let personaState = (await idbGet(STORE_PERSONA, personaKey)) || {};

    let systemText = '';
    const systemIdx = chat.findIndex(m => m.role === 'system');
    if (systemIdx >= 0) {
        systemText = chat[systemIdx].content || '';
    }

    if (!systemText) {
        const charData = ctx.characters?.[ctx.characterId];
        if (charData) {
            const parts = [];
            if (charData.name)        parts.push('Name: ' + charData.name);
            if (charData.personality) parts.push('Personality: ' + charData.personality);
            if (charData.description) parts.push(charData.description);
            if (charData.scenario)    parts.push('Scenario: ' + charData.scenario);
            if (charData.mes_example) parts.push(charData.mes_example);
            systemText = parts.join('\n');
        }
    }

    if (!systemText) {
        const fallbackIdx = chat.findIndex(m => m.role !== 'user' && m.role !== 'assistant');
        if (fallbackIdx >= 0) systemText = chat[fallbackIdx].content || '';
    }

    if (settings.debug) {
        const src = systemIdx >= 0 && systemText ? 'chat[system]'
            : ctx.characters?.[ctx.characterId]?.name ? 'ctx.characters'
            : 'fallback';
        console.log('[OW] systemText:', systemText.length + 'ch from ' + src,
            '| chat roles:', chat.map((m, i) => m.role + '(' + (m.content || '').length + ')').join(', '));
        if (chat.length > 0) {
            console.log('[OW] chat[0] keys:', Object.keys(chat[0]).join(', '));
            console.log('[OW] chat[0] raw:', JSON.stringify(chat[0]).substring(0, 500));
        }
    }

    let messages = chat.map(m => ({ role: m.role, content: m.content || '' }));

    const hasContent = messages.some(m => m.content && m.content.length > 0 && m.role);
    if (!hasContent && ctx.chat && ctx.chat.length > 0) {
        messages = [];
        for (const msg of ctx.chat) {
            if (!msg || msg.is_system) continue;
            const role = msg.is_user ? 'user' : 'assistant';
            const content = msg.mes || '';
            if (content) messages.push({ role, content });
        }
    }

    if (!activeLore) return;

    const charData = ctx.characters?.[ctx.characterId];
    const charNameHint = charData?.name || null;

    let turnResult;
    try {
        turnResult = await activeLore.processTurn({
            systemText,
            messages,
            state,
            personaState,
            config: activeLore._config || {},
            charNameHint,
            personaName: ctx.name1 || null,
        });
        if (!turnResult) {
            if (settings.debug) console.log('[OW] processTurn returned null');
            return;
        }
        state = turnResult.state || state;
        personaState = turnResult.persona_state || personaState;
    } catch (ex) {
        console.error('[OW] processTurn error:', ex);
        return;
    }

    lastTurnResult = { ...turnResult, _mode: 'js' };

    await idbPut(STORE_STATE, sessionKey, state);
    await idbPut(STORE_PERSONA, personaKey, personaState);

    // Update the status HUD (inline panel + floating window)
    if (activeLore && typeof activeLore.updateHud === 'function') {
        activeLore.updateHud(state, activeLore._config);
    }

    // Injection is handled entirely by the fetch interceptor below, which fires
    // on the outgoing HTTP POST and covers both payload.messages (chat-format)
    // and payload.prompt (text-completion) backends.  A direct chat-array
    // mutation here would cause the header/brief to appear twice because ST
    // serialises the already-mutated array into the same request body that the
    // fetch interceptor then modifies again.

    window._owPendingInjection = {
        header: turnResult.header || null,
        brief: turnResult.brief || null,
        systemPrompt: turnResult.systemPrompt || null,
        inject: turnResult.inject || [],
        scrubbed_messages: turnResult.scrubbed_messages || null,
        ts: Date.now(),
    };

    if (settings.debug) {
        console.log('[OW] Turn processed', {
            mode: lastTurnResult._mode,
            turn: state.turn,
            headerLength: turnResult.header?.length || 0,
            brief: turnResult.brief?.substring(0, 150),
            events: turnResult.events,
            injectCount: turnResult.inject?.length || 0,
            pill: state.active_pill,
            arousal: state.arousal,
        });
        if (turnResult.header) {
            console.log('[OW] INJECTED HEADER:\n' + turnResult.header);
        }
        if (turnResult.brief) {
            console.log('[OW] DIRECTOR BRIEF:\n' + turnResult.brief);
        }
        updateDebugPanel(turnResult, state);
    }
};

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
    }

    const { eventSource, event_types } = ctx;
    if (eventSource && event_types) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    }

    if (!window._owFetchInstalled) {
        const _origFetch = window.fetch;
        window.fetch = async function (...args) {
            const [url, opts] = args;
            const urlStr = typeof url === 'string' ? url : url?.url || '';
            const pending = window._owPendingInjection;

            if (pending && pending.ts && (Date.now() - pending.ts < 30000) &&
                opts?.method === 'POST' && opts?.body && typeof opts.body === 'string' && opts.body.length > 500) {
                try {
                    const payload = JSON.parse(opts.body);
                    let modified = false;

                    if (payload.messages && Array.isArray(payload.messages)) {
                        if (urlStr.includes('/settings/')) throw 'skip';

                        let lastUserIdx = -1;
                        for (let i = payload.messages.length - 1; i >= 0; i--) {
                            if (payload.messages[i].role === 'user') {
                                lastUserIdx = i;
                                break;
                            }
                        }

                        if (lastUserIdx >= 0) {
                            let userContent = payload.messages[lastUserIdx].content || '';
                            if (pending.header) {
                                userContent = pending.header + '\n\n' + userContent;
                            }
                            if (pending.brief) {
                                userContent = `[DIRECTOR]\n${pending.brief}\n[/DIRECTOR]\n\n` + userContent;
                            }
                            payload.messages[lastUserIdx].content = userContent;
                            modified = true;
                        }

                        if (pending.systemPrompt) {
                            const sysIdx = payload.messages.findIndex(m => m.role === 'system');
                            if (sysIdx >= 0) {
                                payload.messages[sysIdx].content = pending.systemPrompt;
                                modified = true;
                            }
                        }

                        // Process positional inject entries.
                        // Skip any entry whose text is already handled by pending.header
                        // or pending.brief — those are injected above via the explicit paths.
                        for (const inj of (pending.inject || [])) {
                            if (!inj || !inj.text) continue;
                            if (inj.text === pending.header || inj.text === pending.brief) continue;
                            switch (inj.position) {
                                case 'system': {
                                    const sysIdx = payload.messages.findIndex(m => m.role === 'system');
                                    if (sysIdx >= 0) {
                                        payload.messages[sysIdx].content = inj.replace
                                            ? inj.text
                                            : payload.messages[sysIdx].content + '\n' + inj.text;
                                        modified = true;
                                    }
                                    break;
                                }
                                case 'before_last_user': {
                                    let ui = -1;
                                    for (let i = payload.messages.length - 1; i >= 0; i--) {
                                        if (payload.messages[i].role === 'user') { ui = i; break; }
                                    }
                                    if (ui >= 0) {
                                        payload.messages[ui].content = inj.text + '\n\n' + (payload.messages[ui].content || '');
                                        modified = true;
                                    }
                                    break;
                                }
                                case 'after_last_user': {
                                    let ui = -1;
                                    for (let i = payload.messages.length - 1; i >= 0; i--) {
                                        if (payload.messages[i].role === 'user') { ui = i; break; }
                                    }
                                    if (ui >= 0) {
                                        payload.messages[ui].content = (payload.messages[ui].content || '') + '\n\n' + inj.text;
                                        modified = true;
                                    }
                                    break;
                                }
                                case 'depth': {
                                    const depth = inj.depth || 0;
                                    const pos = Math.max(0, payload.messages.length - depth);
                                    payload.messages.splice(pos, 0, {
                                        role: inj.role || 'system',
                                        content: inj.text,
                                    });
                                    modified = true;
                                    break;
                                }
                                case 'prefill': {
                                    payload.messages.push({ role: 'assistant', content: inj.text });
                                    modified = true;
                                    break;
                                }
                            }
                        }
                    } else if (payload.prompt && typeof payload.prompt === 'string') {
                        if (urlStr.includes('/settings/')) throw 'skip';

                        let prompt = payload.prompt;
                        if (pending.header || pending.brief) {
                            const injection = (pending.brief ? `[DIRECTOR]\n${pending.brief}\n[/DIRECTOR]\n\n` : '') +
                                              (pending.header || '');
                            const lastNewlines = prompt.lastIndexOf('\n\n');
                            if (lastNewlines > prompt.length * 0.5) {
                                prompt = prompt.substring(0, lastNewlines) + '\n\n' + injection + prompt.substring(lastNewlines);
                            } else {
                                prompt = injection + '\n\n' + prompt;
                            }
                            payload.prompt = prompt;
                            modified = true;
                        }

                        // Best-effort positional inject for text-completion format
                        // depth/prefill/system are not directly expressible; before/after
                        // last user turn are approximated via the last \n\nUser: boundary.
                        for (const inj of (pending.inject || [])) {
                            if (!inj || !inj.text) continue;
                            if (inj.position === 'before_last_user' || inj.position === 'after_last_user') {
                                const lastNewlines = prompt.lastIndexOf('\n\n');
                                if (lastNewlines > prompt.length * 0.5) {
                                    prompt = inj.position === 'before_last_user'
                                        ? prompt.substring(0, lastNewlines) + '\n\n' + inj.text + prompt.substring(lastNewlines)
                                        : prompt + '\n\n' + inj.text;
                                } else {
                                    prompt = inj.text + '\n\n' + prompt;
                                }
                                modified = true;
                            }
                        }
                        if (modified) payload.prompt = prompt;
                    }

                    // Apply scrubbed messages from lore engine (pill-context effect-name scrubbing)
                    const scrubbedMsgs = pending.scrubbed_messages || (lastTurnResult && lastTurnResult.scrubbed_messages);
                    if (scrubbedMsgs && payload.messages && Array.isArray(payload.messages)) {
                        // The lore engine already scrubbed the chat messages; overlay them.
                        // Build a lookup by index — scrubbed array matches the original
                        // messages slice the lore saw, which is the last N messages.
                        // Replace from the end of payload.messages backwards.
                        const offset = payload.messages.length - scrubbedMsgs.length;
                        for (let si = 0; si < scrubbedMsgs.length; si++) {
                            const pi = offset + si;
                            if (pi >= 0 && pi < payload.messages.length && scrubbedMsgs[si].content !== undefined) {
                                if (payload.messages[pi].content !== scrubbedMsgs[si].content) {
                                    payload.messages[pi].content = scrubbedMsgs[si].content;
                                    modified = true;
                                }
                            }
                        }
                        if (settings.debug && modified) {
                            console.log('[OW] Applied lore-scrubbed messages (pill effect names)');
                        }
                    }
                    // Text-completion prompt: use lore's scrubPillText helper if available
                    if (payload.prompt && typeof payload.prompt === 'string' && activeLore && typeof activeLore._scrubPillEffectText === 'function') {
                        const before = payload.prompt;
                        payload.prompt = activeLore._scrubPillEffectText(payload.prompt, activeLore._config);
                        if (before !== payload.prompt) modified = true;
                    }

                    if (modified) {
                        window._owPendingInjection = null;
                        opts.body = JSON.stringify(payload);
                        if (settings.debug) {
                            console.log('[OW] Fetch injection applied to:', urlStr);
                        }
                    }
                } catch (e) {
                    if (e !== 'skip' && settings.debug) {
                        console.warn('[OW] Fetch intercept parse error:', e);
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
