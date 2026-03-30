// ============================================================
// Evergreen High School — StatefulLore Module
// Translated from: American High School v3.9 lorebook
// ============================================================

// -- Static character & world data ---------------------------

const school = {
    name: "Evergreen High School",
    mascot: "Timberwolves",
    description: "Where academic excellence meets vibrant school spirit.",
};

const locations = {
    "classroom":    "Classroom",
    "hallways":     "Hallways",
    "gym":          "Gymnasium",
    "field":        "Football Field",
    "locker room":  "Locker Room",
    "library":      "Library",
    "cafeteria":    "Cafeteria",
    "auditorium":   "Auditorium",
    "office":       "School Office",
    "parking lot":  "Parking Lot",
    "lockers":      "Lockers",
};

// Characters present at each location
const locationCast = {
    "classroom":    ["Nathan", "Bridgette", "Michael"],
    "hallways":     ["Tyler", "Jake", "Rebecca", "Sophie", "Josh", "Carl"],
    "gym":          ["Brad"],
    "field":        ["Ashley", "Chad", "Kevin"],
    "locker room":  ["James"],
    "library":      ["Carrie", "Alex", "Olivia"],
    "cafeteria":    ["Amelia", "Zoe", "Max", "Maria"],
    "auditorium":   ["Jessica"],
    "office":       ["Brooke", "Mr. Gentry", "Mrs. Jenkins", "Karen"],
    "parking lot":  ["Dax"],
    "lockers":      ["Emily"],
};

const students = {
    "Brad":     "A Hispanic jock. Hangs out in the gym.",
    "Carrie":   "A brunette bookworm. Hangs out in the library.",
    "Tyler":    "A rebellious student. Hangs out in the hallways.",
    "Ashley":   "A popular cheerleader. Hangs out on the football field.",
    "Nathan":   "A studious nerd. Hangs out in the classroom.",
    "Jessica":  "A drama queen. Hangs out in the auditorium.",
    "James":    "A talented jock. Hangs out in the locker room.",
    "Bridgette":"An ambitious overachiever. Hangs out in the classroom.",
    "Dax":      "A cool rebel. Hangs out in the parking lot.",
    "Amelia":   "A sociable social butterfly. Hangs out in the cafeteria.",
    "Zoe":      "A blonde cheerleader. Hangs out in the cafeteria.",
    "Jake":     "A rebellious student. Hangs out in the hallways.",
    "Brooke":   "A popular kid. Hangs out in the school office.",
    "Alex":     "A mysterious outcast. Hangs out in the library.",
    "Max":      "A funny class clown. Hangs out in the cafeteria.",
    "Sophie":   "A creative artist. Hangs out in the hallways.",
    "Chad":     "A charismatic quarterback. Hangs out on the field.",
    "Rebecca":  "A rebellious student. Hangs out in the hallways.",
    "Kevin":    "A popular student. Hangs out on the football field.",
    "Emily":    "A quiet outcast. Hangs out by the lockers.",
    "Olivia":   "A creative artist. Hangs out in the library.",
    "Michael":  "An ambitious overachiever. Spends most of his time in the classroom.",
    "Josh":     "A mean bully. Hangs out in the hallways.",
};

const teachers = {
    "Mr. Smith":    "Charismatic English teacher, passionate about literature and engaging storytelling.",
    "Mrs. Johnson": "Strict but highly knowledgeable math teacher. Pushes students hard.",
    "Ms. Martinez": "Passionate history teacher who brings the past to life through stories.",
    "Mr. Wilson":   "Dedicated science teacher who uses hands-on experiments to make concepts clear.",
    "Mrs. Davis":   "Experienced foreign language teacher who immerses students in diverse cultures.",
    "Mr. Thompson": "Passionate PE teacher who promotes fitness, teamwork, and sportsmanship.",
    "Miss Anderson":"Talented art teacher who encourages creativity and self-expression.",
    "Mr. Lee":      "Skilled musician and dedicated music teacher.",
    "Mrs. Robinson":"Vibrant drama teacher who nurtures acting skills through theatrical productions.",
};

const staff = {
    "Rocky Plissken": "School security officer. Will immediately respond to any threat or weapon, neutralizing it through effective means.",
    "Mr. Gentry":     "School principal. Strict, no-nonsense administrator who upholds discipline.",
    "Mrs. Jenkins":   "Timid and accommodating office secretary. Easily influenced.",
    "Karen Holstead": "Self-important PTA leader. Image-obsessed and thinks she runs the school.",
    "Maria Jarmillo": "Brash, hardworking lunch lady in the cafeteria.",
    "Carl Reed":      "Observant and wise janitor who works in the hallways.",
};

// -- Module --------------------------------------------------

let _hudState = null;

export default {
    name: "Evergreen High School",
    version: "1.0.0",

    init() {
        return {
            location: "hallways",
            period: 1,
            reputation: 50,       // 0-100: 0 = outcast, 100 = most popular
            relationships: {},    // { "CharacterName": -100 to 100 }
        };
    },

    processTurn({ state, systemText, messages, charNameHint, personaName } = {}) {
        if (!state || !state.location) state = this.init();

        const loc = locations[state.location] || state.location;
        const cast = locationCast[state.location] || [];

        // Build character list for current location
        let castLines = "";
        for (const name of cast) {
            const desc = students[name] || staff[name] || "";
            castLines += `  - ${name}: ${desc}\n`;
        }
        if (!castLines) castLines = "  (Nobody notable is here right now.)\n";

        // Build relationship summary for characters the player has met
        let relLines = "";
        for (const [name, val] of Object.entries(state.relationships)) {
            const label = val >= 50 ? "Friend" : val >= 10 ? "Friendly" : val <= -50 ? "Enemy" : val <= -10 ? "Hostile" : "Neutral";
            relLines += `  - ${name}: ${label} (${val > 0 ? "+" : ""}${val})\n`;
        }
        if (!relLines) relLines = "  (No notable relationships yet.)\n";

        // Reputation label
        const repLabel =
            state.reputation >= 80 ? "Very Popular" :
            state.reputation >= 60 ? "Popular" :
            state.reputation >= 40 ? "Average" :
            state.reputation >= 20 ? "Unpopular" : "Outcast";

        const header = `[EVERGREEN HIGH SCHOOL]
School: ${school.name} — Mascot: ${school.mascot}
Current Location: ${loc} | Period: ${state.period} | Reputation: ${repLabel} (${state.reputation}/100)

=== WHO'S HERE (${loc}) ===
${castLines}
=== RELATIONSHIPS ===
${relLines}
=== ALL STUDENTS ===
${Object.entries(students).map(([n, d]) => `  - ${n}: ${d}`).join("\n")}

=== TEACHERS ===
${Object.entries(teachers).map(([n, d]) => `  - ${n}: ${d}`).join("\n")}

=== STAFF ===
${Object.entries(staff).map(([n, d]) => `  - ${n}: ${d}`).join("\n")}

=== INSTRUCTIONS ===
Embed JSON events in responses when the player moves, their reputation changes, or a relationship changes.
Use this exact format: \`\`\`game { "type": "event_type", ... } \`\`\`

Supported events:
1. Move:              \`\`\`game { "type": "move", "location": "cafeteria" } \`\`\`
   Valid locations: ${Object.keys(locations).join(", ")}
2. Reputation change: \`\`\`game { "type": "rep_change", "amount": 5 } \`\`\` (use negative for loss)
3. Relationship:      \`\`\`game { "type": "relationship", "character": "Ashley", "amount": 10 } \`\`\`
`;

        return { header, state };
    },

    handleResponse({ assistantText, state } = {}) {
        if (!state || !state.location) state = this.init();
        let cleanedText = assistantText || "";
        const events = [];

        const regex = /```game\s*({[\s\S]*?})\s*```/g;
        cleanedText = cleanedText.replace(regex, (match, jsonStr) => {
            try { events.push(JSON.parse(jsonStr)); }
            catch (e) { console.error("Failed to parse HS event:", e); }
            return "";
        });

        for (const event of events) {
            if (event.type === "move" && locations[event.location]) {
                state.location = event.location;
            } else if (event.type === "rep_change" && typeof event.amount === "number") {
                state.reputation = Math.max(0, Math.min(100, state.reputation + event.amount));
            } else if (event.type === "relationship" && event.character && typeof event.amount === "number") {
                const current = state.relationships[event.character] || 0;
                state.relationships[event.character] = Math.max(-100, Math.min(100, current + event.amount));
            }
        }

        return { state, cleanedText };
    },

    _getHudContent() {
        const state = _hudState;
        if (!state) return `<span style="color:#888;">Waiting for first turn...</span>`;

        const loc = locations[state.location] || state.location;
        const repLabel =
            state.reputation >= 80 ? "Very Popular" :
            state.reputation >= 60 ? "Popular" :
            state.reputation >= 40 ? "Average" :
            state.reputation >= 20 ? "Unpopular" : "Outcast";
        const repColor =
            state.reputation >= 60 ? "#88ff99" :
            state.reputation >= 40 ? "#ffdd88" : "#ff8888";

        const relEntries = Object.entries(state.relationships);

        return `
            <h3 style="margin-top:0; color:#88ccff;">Evergreen High</h3>

            <div style="display:flex; gap:8px; margin-bottom:8px;">
                <div style="flex:1; background:rgba(136,204,255,0.1); border:1px solid #88ccff; border-radius:4px; padding:8px;">
                    <div style="color:#aaa; font-size:0.7em; text-transform:uppercase; letter-spacing:1px;">Location</div>
                    <div style="color:#fff; font-weight:bold;">${loc}</div>
                </div>
                <div style="flex:1; background:rgba(136,204,255,0.1); border:1px solid #88ccff; border-radius:4px; padding:8px;">
                    <div style="color:#aaa; font-size:0.7em; text-transform:uppercase; letter-spacing:1px;">Period</div>
                    <div style="color:#fff; font-weight:bold;">${state.period}</div>
                </div>
            </div>

            <div style="background:rgba(136,204,255,0.1); border:1px solid #88ccff; border-radius:4px; padding:8px; margin-bottom:8px;">
                <div style="color:#aaa; font-size:0.7em; text-transform:uppercase; letter-spacing:1px;">Reputation</div>
                <div style="color:${repColor}; font-weight:bold;">${repLabel} (${state.reputation}/100)</div>
                <div style="background:#333; border-radius:3px; height:6px; margin-top:4px;">
                    <div style="background:${repColor}; width:${state.reputation}%; height:6px; border-radius:3px;"></div>
                </div>
            </div>

            ${relEntries.length > 0 ? `
            <details>
                <summary style="cursor:pointer;"><strong>Relationships (${relEntries.length})</strong></summary>
                <ul style="margin:6px 0 0 16px; padding:0;">
                    ${relEntries.map(([name, val]) => {
                        const label = val >= 50 ? "Friend" : val >= 10 ? "Friendly" : val <= -50 ? "Enemy" : val <= -10 ? "Hostile" : "Neutral";
                        const col = val >= 10 ? "#88ff99" : val <= -10 ? "#ff8888" : "#aaa";
                        return `<li style="color:${col};">${name}: ${label} (${val > 0 ? "+" : ""}${val})</li>`;
                    }).join("")}
                </ul>
            </details>` : `<p style="color:#888; margin:4px 0;">No relationships yet.</p>`}
        `;
    },

    getSettingsHtml(config) {
        return `<div id="hs-hud" style="font-family:sans-serif; padding:10px; background:rgba(0,0,0,0.5); border:1px solid #444; border-radius:5px;">${this._getHudContent()}</div>`;
    },

    updateHud(state, config) {
        _hudState = state;
        const el = document.getElementById("hs-hud");
        if (el) el.innerHTML = this._getHudContent();
    },
};
