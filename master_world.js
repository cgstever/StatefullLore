/**
 * master_world.js
 * Lore engine for the Otherworld / Master setting.
 * Converted from master_world.py — StatefullLore JS module.
 *
 * Contract: export default { name, version, data, init, processTurn, handleResponse, getDebugInfo }
 * processTurn({ systemText, messages, state, personaState, config, charNameHint, personaName })
 *   → { ok, name, sex, state, persona_state, events, header, brief, systemPrompt, inject[] }
 * handleResponse({ assistantText, state, events, config })
 *   → { ok, state, cleanedText? }
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const _VERSION = '1.0.0';

const BODY_SLOTS = ['chest','genitals'];

// ═══════════════════════════════════════════════════════════════════════════════
// EMBEDDED RULESET
// ═══════════════════════════════════════════════════════════════════════════════

const LORE_DATA = {
  version: _VERSION,
  stat_signals: {
    WIL: [[+4, ['strong-willed','stubborn','determined','disciplined']],
          [+2, ['confident','proud','independent']],
          [-2, ['anxious','insecure','needy','meek']],
          [-4, ['broken','hopeless','submissive wreck']]],
    DOM: [[+4, ['dominant','commanding','controlling','alpha']],
          [+2, ['assertive','bold','switch']]],
    SUB: [[+4, ['submissive','obedient','yielding','service']],
          [+2, ['shy','deferential','switch']]],
    CON: [[+4, ['athletic','resilient','enduring','warrior']],
          [+2, ['healthy','stamina']],
          [-2, ['fragile','delicate','sickly']],
          [-4, ['frail','overwhelmed','broken body']]],
    BON: [[+4, ['loyal','devoted','loving','affectionate','clingy','attached','worshipful']],
          [+2, ['warm','tender','gentle','caring','eager to please']],
          [-2, ['cold','aloof','detached','guarded','untrusting','reserved']],
          [-4, ['independent','closed off','emotionally unavailable','walls up','isolated']]]
  },
  wil_dc_bands: [[16,20,18],[11,15,14],[6,10,10],[0,5,6]],
  spell_tiers: {
    1: ['runes trace','runes drift','rune-light','runes pulse','rune glow',
        'magic hums','arcane warmth','arcane heat','arcane glow','arcane light',
        'the keep responds','the castle responds','the walls respond',
        'magic brushes','magic stirs','magic curls','magic settles',
        'the air shifts','the air thickens','something shifts in her',
        'something stirs','something blooms','something loosens',
        'the spell lingers','the spell breathes','enchantment stirs',
        'enchantment hums','enchantment settles','enchantment curls',
        'magic seeps','magic bleeds','magic threads','magic creeps',
        'warmth spreads through','warmth blooms','warmth curls through',
        'her body softens','her form softens','her shape softens',
        'body starts to','form starts to','begins to reshape','begins to shift',
        'begins to change','begins to soften','begins to alter',
        'her body softening','her form softening','her shape shifting',
        'his body softening','his form softening','his shape shifting',
        'magic is working','spell is working','the enchantment is working',
        'taking effect','taking hold','settling in','seeping in'],
    2: ['he commands the magic','he bends the magic','he weaves the magic',
        'he weaves a spell','he weaves his','he weaves runes','weaves a spell',
        'he casts','he speaks the words','he speaks an incantation',
        'he speaks the incantation','he raises his hand','he gestures',
        'he channels','he directs the magic','he bends reality',
        'runes flare','runes flaring','runes blazed','runes blaze',
        'runes ignite','runes igniting','runes burn','runes burning',
        'runes carve','runes carving','runes etch','runes etching',
        'runes write themselves','runes seal','runes lock','runes lock into',
        'rune-light floods','rune-light blazes','rune-light ignites',
        'magic reshapes','magic remakes','magic rewrites','magic compels',
        'magic floods','magic pours','magic surges','magic crashes',
        'magic burns through','magic tears through','magic moves through',
        'the spell takes hold','the spell takes her','the spell takes him',
        'the spell catches','the spell grabs','the spell washes over',
        'the spell floods','the spell surges','the spell ignites',
        'the enchantment takes hold','the enchantment grabs',
        'arcane force','arcane power floods','arcane energy','arcane light floods',
        'silver light floods','violet light','violet runes','his runes',
        'his magic reshapes','his magic remakes','his magic floods',
        'his magic washes','his magic surges','his magic flows',
        'her body reshapes','her body remakes','her body shifts',
        'her form reshapes','her form remakes','her shape remakes',
        'him body reshapes','his body remakes','his form reshapes',
        'his form remakes','his shape remakes',
        'transformed by','transformation washes','transformation floods',
        'the magic transforms','the magic alters','the magic shifts',
        'every part of her reshaping','every part of him reshaping',
        'reshaping head to toe','reshaping her entirely','reshaping him entirely'],
    3: ['permanently sealed','permanently bound','permanently locked',
        'permanently altered','permanently remade','permanently marked',
        'irreversibly','cannot be undone','can never be undone',
        'can never be reversed','can never return','there is no going back',
        'sealed forever','bound forever','locked forever','claimed forever',
        'brands her','bloodline sealed','bloodline bound','bloodline marked',
        'the brand takes','the collar binds permanently','owned completely',
        'fully claimed','runes seal permanently','his mark is permanent',
        'will never leave','can never leave her body','cannot be removed']
  },
  slot_keywords: {
    genitals: ['genitals','groin','loins','cunt','cock','pussy','slit','phallus',
               'folds','entrance','channel','sheath','womanhood','manhood',
               'anatomy','her sex','his sex','between her legs','between his legs',
               'between her thighs','between his thighs',
               'penis','vagina','shaft','length','vulva','clitoris'],
    chest: ['breasts','breast','bust','bosom','nipples','nipple',
            'her chest','his chest','flat chest','her bust','cleavage'],
  },
  instant_mods: ['entirely','completely','all at once','in an instant','wholly','fully',
                 'in one stroke','remakes entirely','utterly','from head to'],
  location_kw: {
    forest: ['forest','trees','canopy','woods','path','undergrowth'],
    gate: ['gate','entrance','threshold','doors of the keep'],
    keep: ['keep','castle','citadel','hall','chamber','corridor','spire'],
    throne: ['throne','dais','audience chamber'],
    dungeon: ['dungeon','cell','chains','pit','beneath the keep'],
    world: ['village','town','road','kingdom','beyond the forest']
  },
  arousal_kw: {
    1: ['flush','flushed','warm','warmth','aware','nervous','squirm','fidget',
        'breathless','distracted','stir','stirring','tingle','flutter','throb',
        'shiver','sensitive','sensitivity'],
    2: ['wet','slick','ache','aching','tremble','trembling','needy','want','wanting',
        'heat','arousal','aroused','hungry','pulse','pulsing','clench','clenching',
        'leak','leaking','drip','dripping','moan','moaning','gasp','whimper',
        'hips','core','melting','melt'],
    3: ['desperate','soaking','burning','unbearable','beg','begging','writhe',
        'writhing','consumed','overwhelmed','mindless','frantic','delirious',
        'please','need you','want you','take me','fill me']
  },
  orgasm_kw: {
    primary: ['cums','climaxes','orgasms','comes','reaches her peak',
              'reaches his peak','reaches climax','hits her peak','hits climax',
              'shatters','falls apart','breaks apart','comes apart',
              'loses control','loses herself','loses himself',
              'her release','his release','screams her release',
              'cries out in release','sobbing through her climax',
              'forced orgasm','forced to cum','forced to climax',
              'orgasm tears through','orgasm crashes through',
              'orgasm rips through','pleasure crests','pleasure shatters',
              'pleasure overwhelms','convulses','spasms','her body locks',
              'her whole body shakes','her whole body shudders',
              'she cannot stop cumming','she cannot stop coming',
              "can't stop cumming","can't stop coming",
              'crests','peaks','tips over','tips over the edge',
              'goes over the edge','pushed over the edge',
              'helplessly cumming','helplessly climaxing',
              'wrung out of her','wrung from her body'],
    secondary: ['aftershock','trembling through the last of it',
                'still shaking','still trembling','still spasming',
                'limp and shaking','limp and trembling','limp in his grip',
                'barely conscious','barely present','barely herself',
                'mindless','thoughtless','blissed out','wrecked']
  },
  corruption_kw: ['swallows','swallows his','swallows it','drinks','drinks it down',
    'drinks him down','tastes','tastes him','gulps','gulps it down',
    'takes it','takes his cum','takes his seed','takes his load',
    'seed touches','cum hits','fills her mouth','fills his mouth',
    'drips down her throat','drips down his throat',
    'coats her throat','coats his throat','coats her tongue',
    'coats his tongue','floods her mouth','floods his mouth',
    'pours down her throat','pours down his throat',
    'swallow every drop','swallows every drop',
    'seed touches her skin','seed touches his skin',
    'cum touches her skin','cum touches his skin',
    'seed on her','seed on him','coats her skin','coats his skin',
    'his cum marks','his seed marks','rune-seed','glowing seed',
    'silver seed','silver cum','seed glows','cum glows',
    'cums inside','comes inside','finishes inside',
    'empties inside','floods her womb','floods his',
    'seeds her','breeds her','plants his seed',
    'paints her womb','fills her womb','fills her completely',
    'pumps inside','pumps into her','pumps into him',
    'buried deep as he','releases inside','spills inside',
    'corruption spreads','corruption takes hold','corruption blooms',
    'the corruption','fog takes hold','fog settles','mind fogs',
    'something changes in her','something changes in him',
    'not herself','not himself','craving begins'],
  pregnancy_kw: ['fills you','floods your','empties inside','cums inside',
                 'breeds deep','paints your womb','pumps inside',
                 'buried deep as he cums','releases inside'],
  birth_kw: ['born','birth','delivered','child arrives','into the world',
             'first cry','newborn'],
  kneel_kw: ['kneels','kneeling','kneel','on her knees','on his knees',
             'falls to her knees','falls to his knees','falls to knees',
             'drops to her knees','drops to his knees','drops to knees',
             'sinks to her knees','sinks to his knees','sinks to knees',
             'collapses to her knees','collapses to knees',
             'on her knees before','on his knees before','at his feet',
             'prostrates','prostrate','bows before','bows low before',
             'bows at his feet','head bowed','forehead to the floor',
             'pressed to the floor','floor before him',
             'submission posture','kneels in submission','kneels in deference'],
  trimester_nudge_kw: ['months pass','weeks pass','time passes','months have passed',
    'weeks have passed','growing larger','growing bigger','growing heavier',
    'belly grows','belly swells','belly rounds','belly is round',
    'nearly time','almost time','soon','birth is close','close to term',
    'swollen with','heavy with','full with','ripe with',
    'showing','visibly pregnant','unmistakably pregnant',
    'larger now','bigger now','further along',
    'the child moves','she can feel it move','he can feel it move',
    'kicks','first kick','movement','the baby'],
  corruption_thresholds: [0,1,3,6,10],
  corruption_deltas: {1:[-1,+1],2:[-2,+2],3:[-2,+3],4:[-3,+3]},
  corruption_floors: {1:5,2:15,3:25,4:35},
  sub_thresholds: [[81,4],[61,3],[41,2],[21,1],[0,0]],
  master_stats: {DOM:20,WIL:20,CON:18,INT:20,SUB:4,DES:12},
  card_format: {
    field_patterns: {
      name: '^Name:\\s*(.+?)\\s*$',
      sex: '^Sex:\\s*(.+?)\\s*$',
      stats: '^Stats:\\s*(.+?)\\s*$'
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const _d20 = () => Math.floor(Math.random() * 20) + 1;
const _d100 = () => Math.floor(Math.random() * 100) + 1;
const _kw = (text, kws) => { const t = text.toLowerCase(); return kws.some(k => t.includes(k)); };
const _wilMod = w => Math.floor((w - 10) / 2);
const _bonMod = b => Math.floor((b - 10) / 2);
const _dbg = (debug, ...args) => { if (debug) console.log('[MASTER]', ...args); };

function _baseDc(wil, rs) {
  for (const [lo, hi, dc] of rs.wil_dc_bands) {
    if (lo <= wil && wil <= hi) return dc;
  }
  return 14;
}

// ─── Body helpers ──────────────────────────────────────────────────────────────

function _initBody(state, birthSex, birthGenitals) {
  const b = state.body;
  b.birth_sex = birthSex;
  b.birth_genitals = birthGenitals;
  for (const slot of BODY_SLOTS) {
    const sex = (slot === 'genitals') ? birthGenitals : birthSex;
    b.slots[slot].birth = sex;
    b.slots[slot].current = sex;
  }
}

function _isUnified(state) {
  const vals = BODY_SLOTS.map(s => state.body.slots[s].current);
  return new Set(vals).size === 1;
}

function _unifiedGender(state) {
  if (_isUnified(state)) return state.body.slots.chest.current;
  return null;
}

function _isPregEligible(state) {
  return state.body.slots.genitals.current === 'female';
}

function _transformSlot(state, slot, direction, locked = false, debug = false) {
  if (!state.body.slots[slot]) return;
  const s = state.body.slots[slot];
  if (s.locked) return;
  const old = s.current;
  s.current = direction;
  if (locked) s.locked = true;
  if (old !== direction) _dbg(debug, `BODY: ${slot} ${old}→${direction}${locked ? ' LOCKED' : ''}`);
}

function _bodySummary(state) {
  const out = {};
  for (const s of BODY_SLOTS) out[s] = state.body.slots[s].current;
  return out;
}

function _changedSlots(state) {
  return BODY_SLOTS.filter(s => state.body.slots[s].current !== state.body.slots[s].birth);
}

function _originalSlots(state) {
  return BODY_SLOTS.filter(s => state.body.slots[s].current === state.body.slots[s].birth);
}

function _subStage(score, rs) {
  for (const [threshold, stage] of rs.sub_thresholds) {
    if (score >= threshold) return stage;
  }
  return 0;
}

function _corruptionStage(doses, rs) {
  let stage = 0;
  rs.corruption_thresholds.forEach((t, i) => { if (doses >= t) stage = i; });
  return stage;
}

function _castleIntensity(resistance) {
  return Math.floor((100 - resistance) / 20);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT STATE
// ═══════════════════════════════════════════════════════════════════════════════

function defaultState(rs) {
  return {
    turn: 0,
    flags: {
      statgen_done: false, in_domain: true, will_broken: false,
      loyalty_bound: false, devoted: false, broodbound: false,
      graced: false, fate_locked: false, location: 'keep'
    },
    stats: {WIL:10, DOM:10, SUB:10, BON:10, CON:10},
    resistance: 50,
    loyalty: 0,
    body: {
      birth_sex: null, birth_genitals: null,
      slots: {
        chest:   {birth:null, current:null, locked:false},
        genitals:{birth:null, current:null, locked:false}
      },
      desc: {}
    },
    submission: {score:0, stage:0, locked:false},
    corruption: {doses:0, stage:0, wil_delta:0, sub_delta:0},
    bindings: {collared:false, branded:false, bloodline_sealed:false},
    pregnancy: {pregnant:false, trimester:0, father:null, turns_pregnant:0},
    orgasms: {session:0, lifetime:0, forced:0, corruption_linked:0},
    arousal: {current:0, floor:0},
    resistance_dc: {current:14, base:14},
    target_body: null, fate: null, exit_record: null,
    grace_marks: null, active_roster: [],
    enchantments: [],
    measurements: {},
    _last_user_hash: null,
    _resist_streak: 0,
    _bon_30: false,
    _bon_60: false
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CARD PARSING
// ═══════════════════════════════════════════════════════════════════════════════

function _cardSection(systemText) {
  const m = /^Name:\s*.+/mi.exec(systemText || '');
  return m ? systemText.slice(m.index) : (systemText || '');
}

function _rx(pat, text) {
  const m = pat.exec(text || '');
  return m ? m[1].trim() : null;
}

function extractCardName(t, rs) {
  return _rx(rs._card_name_re || /^Name:\s*(.+?)\s*$/m, t);
}

function extractCardSex(t, rs) {
  return _rx(rs._card_sex_re || /^Sex:\s*(.+?)\s*$/m, t);
}

function _extractStatBlock(text) {
  const found = {};
  for (const m of (text || '').matchAll(/\b(WIL|DOM|SUB|BON|CON)\s*[:=]\s*(\d+)/gi)) {
    found[m[1].toUpperCase()] = _clamp(parseInt(m[2]), 0, 20);
  }
  return found;
}

function _inferStats(text, rs) {
  const stats = {WIL:10, DOM:10, SUB:10, BON:10, CON:10};
  const t = (text || '').toLowerCase();
  for (const [stat, signalList] of Object.entries(rs.stat_signals || {})) {
    let delta = 0;
    for (const [amount, keywords] of signalList) {
      if (keywords.some(kw => t.includes(kw))) delta += amount;
    }
    stats[stat] = _clamp(10 + _clamp(delta, -8, 8), 0, 20);
  }
  return stats;
}

function _extractBaselines(description, rs) {
  const baselines = {};
  const chunks = [];
  for (const line of (description || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const part of trimmed.split(/(?<=[.!?])\s+/)) {
      const p = part.trim();
      if (p) chunks.push(p);
    }
  }
  const slotPriority = {
    genitals: ['anatomy','sex baseline','genitals'],
    face: ['face','appearance'],
    body: ['appearance','height','weight','build'],
    cosmetic: ['hair','skin','color','colour'],
    voice: ['voice','tone','speech']
  };
  for (const [slot, keywords] of Object.entries(rs.baseline_kw || {})) {
    const hits = chunks.filter(c => keywords.some(kw => c.toLowerCase().includes(kw)));
    if (!hits.length) continue;
    const priorityWords = slotPriority[slot] || [];
    const priorityHits = hits.filter(c => priorityWords.some(pw => c.toLowerCase().slice(0,30).includes(pw)));
    const bestList = priorityHits.length ? priorityHits : hits;
    const best = bestList.reduce((a, b) => a.length <= b.length ? a : b);
    baselines[slot] = best.slice(0, 200);
  }
  return baselines;
}

function _extractMeasurements(text) {
  const out = {};
  const t = text || '';
  const h = /(\d'\d{1,2})/i.exec(t);
  if (h) out.height = h[1].trim();
  const w = /(\d{2,3})\s*(?:lbs?|kg)/i.exec(t);
  if (w) out.weight = w[0].trim();
  const c = /\b([A-Fa-f]{1,2}[-\s]?cup)/i.exec(t);
  if (c) out.bust = c[1].trim();
  const ck = /(\d+[-\s]?inch[^.]*?(?:cock|penis|shaft))/i.exec(t);
  if (ck) out.cock = ck[1].trim();
  const a = /(?:anatomy|sex baseline)[:\s]+([^\n.]+)/i.exec(t);
  if (a) out.anatomy = a[1].trim().slice(0, 80);
  return out;
}

function _identityCategory(sexLabel) {
  if (!sexLabel) return 'unknown';
  const s = sexLabel.toLowerCase();
  if (['trans woman','mtf','trans fem','transgender woman'].some(x => s.includes(x))) return 'trans_mtf';
  if (['trans man','ftm','trans masc','transgender man'].some(x => s.includes(x))) return 'trans_ftm';
  if (['non-binary','nonbinary','enby','genderqueer','genderfluid','agender'].some(x => s.includes(x))) return 'nb';
  if (['female','woman','girl'].some(x => s.includes(x))) return 'cis_female';
  if (['male','man','boy'].some(x => s.includes(x))) return 'cis_male';
  return 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATGEN
// ═══════════════════════════════════════════════════════════════════════════════

function _runStatgen(state, systemText, rs, debug, name = '') {
  const cardText = _cardSection(systemText);
  const explicit = _extractStatBlock(cardText);
  const inferred = _inferStats(cardText, rs);
  for (const k of Object.keys(state.stats)) {
    state.stats[k] = (k in explicit) ? explicit[k] : inferred[k];
  }
  if (Object.keys(explicit).length) _dbg(debug, `STATGEN explicit:`, explicit);
  _dbg(debug, `STATGEN final:`, state.stats);

  const wil = state.stats.WIL;
  state.resistance = wil * 5;
  const dc = _baseDc(wil, rs);
  state.resistance_dc.base = dc;
  state.resistance_dc.current = dc;

  // Birth body parsing
  let birthSex = 'male', birthGenitals = 'male';
  const sbLineM = /sex baseline[^:]*:([^\n]+)/i.exec(cardText);
  const sbLine = sbLineM ? sbLineM[1].toLowerCase() : '';
  if (/male/.test(sbLine) && !/female/.test(sbLine)) birthSex = 'male';
  else if (/female/.test(sbLine)) birthSex = 'female';
  else if (/feminine body/.test(sbLine)) birthSex = 'female';
  else if (/male body/.test(sbLine)) birthSex = 'male';

  if (/\bpenis\b|\bvagina\b|male genitalia|female genitalia/.test(sbLine)) {
    if (/\bvagina\b|female genitalia/.test(sbLine)) birthGenitals = 'female';
    else birthGenitals = 'male';
  } else {
    const anM = /anatomy[^.\r\n]*?(penis|vagina)/i.exec(cardText);
    if (anM) birthGenitals = anM[1].toLowerCase() === 'penis' ? 'male' : 'female';
    else birthGenitals = birthSex;
  }

  _initBody(state, birthSex, birthGenitals);
  const sexRaw = extractCardSex(cardText, rs) || '';
  state._sex_label = sexRaw.toLowerCase();
  _dbg(debug, `BIRTH: body=${birthSex} genitals=${birthGenitals}`);

  // Baseline extraction
  const mDesc = /<description>(.*?)<\/description>/is.exec(cardText);
  const desc = mDesc ? mDesc[1].trim() : cardText;
  const baselines = _extractBaselines(desc, rs);
  for (const [slot, baseline] of Object.entries(baselines)) {
    state.body.desc[slot] = baseline;
  }
  state.measurements = _extractMeasurements(desc);
  state.flags.statgen_done = true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN PARSER
// ═══════════════════════════════════════════════════════════════════════════════

const _TOKEN_RE = /m\/([^\s]+)/gi;

function _tokens(text) {
  const out = [];
  for (const m of (text || '').matchAll(/m\/([^\s]+)/gi)) out.push(m[1].toLowerCase());
  return out;
}

function _stripTokens(text) {
  return (text || '').replace(/m\/([^\s]+)/gi, '').trim();
}

function _applyTokens(state, personaState, tokens, debug, rs) {
  for (const tok of tokens) {
    const p = tok.split(':');
    if (tok === 'pregnant') {
      state.pregnancy = {pregnant:true, trimester:1, father:'Master', turns_pregnant:0};
      _dbg(debug, 'TOKEN m/pregnant');
    } else if (tok === 'birth') {
      if (state.pregnancy.trimester === 3) _doBirth(state, personaState, debug, rs);
    } else if (p[0] === 'sub' && p.length >= 3) {
      try {
        const val = _clamp(parseInt(p[2]), 0, 100);
        state.submission.score = val;
        state.submission.stage = _subStage(val, rs);
        _dbg(debug, `TOKEN m/sub:${p[1]}:${val}`);
      } catch(e) {}
    } else if (tok === 'corrupt:dose') {
      _addDose(state, debug, rs);
    } else if (tok === 'corrupt:reverse') {
      _reverseCorruption(state, debug, rs);
    } else if (p[0] === 'body' && p.length >= 2) {
      if (p[1] === 'clear') state.target_body = null;
      else state.target_body = p[1];
      _dbg(debug, `TOKEN m/body:${p[1]}`);
    } else if (p[0] === 'slot' && p.length >= 3) {
      const slot = p[2];
      if (state.body.slots[slot]) {
        if (p[1] === 'lock') state.body.slots[slot].locked = true;
        else if (p[1] === 'unlock') state.body.slots[slot].locked = false;
        else if (p[1] === 'set' && p.length >= 4) {
          const dir = ['male','female'].includes(p[3]) ? p[3] : null;
          if (dir) _transformSlot(state, slot, dir, false, debug);
        }
      }
    } else if (p[0] === 'resistance' && p.length === 3 && p[1] === 'set') {
      state.resistance = _clamp(parseInt(p[2]) || 0, 0, 100);
    } else if (p[0] === 'loyalty' && p.length === 3 && p[1] === 'set') {
      state.loyalty = _clamp(parseInt(p[2]) || 0, 0, 100);
    } else if (tok === 'dc:reset') {
      const dc = _baseDc(state.stats.WIL, rs);
      state.resistance_dc.base = dc;
      state.resistance_dc.current = dc;
    } else if (p[0] === 'loc' && p.length >= 2 && rs.location_kw[p[1]]) {
      state.flags.location = p[1];
      _dbg(debug, `TOKEN m/loc:${p[1]}`);
    } else if (p[0] === 'roster') {
      if (p[1] === 'inject' && p.length >= 3) {
        const rname = p[2];
        if (!state.active_roster.some(r => r.name.toLowerCase() === rname.toLowerCase())) {
          state.active_roster.push({name: rname, turns_remaining: 3});
        }
      } else if (p[1] === 'clear') {
        state.active_roster = [];
      }
    } else if (p[0] === 'enchant') {
      if (p[1] === 'clear') {
        const nm = p.length >= 3 ? p.slice(2).join(':') : null;
        if (nm) {
          state.enchantments = state.enchantments.filter(e =>
            !(e.name.toLowerCase() === nm.toLowerCase() && !e.locked));
        } else {
          state.enchantments = state.enchantments.filter(e => e.locked);
        }
      } else if (p[1] === 'unlock' && p.length >= 3) {
        const nm = p.slice(2).join(':');
        for (const e of state.enchantments) {
          if (e.name.toLowerCase() === nm.toLowerCase()) e.locked = false;
        }
      }
    } else if (p[0] === 'fate' && p.length >= 2) {
      _applyFate(state, personaState, p[1], debug, rs);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORRUPTION
// ═══════════════════════════════════════════════════════════════════════════════

function _addDose(state, debug, rs) {
  const old = state.corruption.stage;
  state.corruption.doses += 1;
  const nw = _corruptionStage(state.corruption.doses, rs);
  if (nw > old) _crossCorruption(state, old, nw, debug, rs);
  state.corruption.stage = nw;
}

function _crossCorruption(state, old, nw, debug, rs) {
  for (let s = old + 1; s <= nw; s++) {
    const [wd, sd] = rs.corruption_deltas[s] || [0,0];
    state.stats.WIL = _clamp(state.stats.WIL + wd, 0, 20);
    state.stats.SUB = _clamp(state.stats.SUB + sd, 0, 20);
    state.corruption.wil_delta += wd;
    state.corruption.sub_delta += sd;
    state.arousal.floor = Math.max(state.arousal.floor, rs.corruption_floors[s] || 0);
    const dcNew = _baseDc(state.stats.WIL, rs);
    state.resistance_dc.base = dcNew;
    if (dcNew < state.resistance_dc.current) state.resistance_dc.current = dcNew;
    if (s === 4) state.flags.broodbound = true;
    _dbg(debug, `CORRUPTION ${old}→${s} WIL${wd >= 0 ? '+' : ''}${wd} SUB${sd >= 0 ? '+' : ''}${sd}`);
  }
}

function _reverseCorruption(state, debug, rs) {
  state.stats.WIL = _clamp(state.stats.WIL - state.corruption.wil_delta, 0, 20);
  state.stats.SUB = _clamp(state.stats.SUB - state.corruption.sub_delta, 0, 20);
  state.corruption = {doses:0, stage:0, wil_delta:0, sub_delta:0};
  state.flags.broodbound = false;
  state.arousal.floor = 0;
  const dc = _baseDc(state.stats.WIL, rs);
  state.resistance_dc.base = dc;
  state.resistance_dc.current = dc;
  _dbg(debug, 'CORRUPTION reversed');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE SCANS
// ═══════════════════════════════════════════════════════════════════════════════

function _scanArousal(text, state, debug, rs) {
  let delta = 0;
  const t = text.toLowerCase();
  for (const [weight, keywords] of Object.entries(rs.arousal_kw || {})) {
    const w = parseInt(weight);
    const hits = Math.min(keywords.filter(kw => t.includes(kw)).length, 4);
    if (hits) {
      const cur = state.arousal.current + delta;
      delta += w * hits * Math.max(1, 1 + cur / 30);
    }
  }
  return Math.floor(delta);
}

function _kwWb(text, keywords) {
  for (const kw of keywords) {
    if (kw.length <= 4) {
      if (new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(text)) return true;
    } else {
      if (text.includes(kw)) return true;
    }
  }
  return false;
}

function _matchingSlots(t, rs) {
  const allKw = ['entire body','whole body','every part of her','every part of him',
    'all of her body','all of him','head to toe',
    'completely transformed','entirely transformed','fully transformed',
    'remakes her entirely','remakes him entirely',
    'reshapes her entirely','reshapes him entirely',
    'body remakes','body reshapes'];
  if (allKw.some(kw => t.includes(kw))) return ['chest','genitals'];
  return Object.entries(rs.slot_keywords || {})
    .filter(([, kws]) => _kwWb(t, kws))
    .map(([sl]) => sl);
}

const _FEM_KW = ['feminine','feminize','feminizing','womanly','female','softer','soften',
  'breasts','breast','curves','curvy','hourglass','widen','widening',
  'vagina','pussy','cunt','womanhood','smaller','delicate','slender',
  'higher','lighter','softer voice','soprano','alto','rounder','fuller',
  'silky','smooth','long hair','flowing hair','grow out'];
const _MASC_KW = ['masculine','masculinize','masculinizing','manly','male','harder','harden',
  'penis','cock','shaft','manhood','broader','broaden','muscular','muscle',
  'deeper','lower','deeper voice','bass','baritone','rougher','coarser',
  'shorter hair','stubble','jaw','adams apple','larger','heavier'];

function _spellDirection(text) {
  const t = text.toLowerCase();
  const fem = _FEM_KW.filter(kw => t.includes(kw)).length;
  const masc = _MASC_KW.filter(kw => t.includes(kw)).length;
  if (fem > masc) return 'female';
  if (masc > fem) return 'male';
  if (fem === masc && fem > 0) return 'female';
  return null;
}

function _scanSpells(text, rs) {
  const t = text.toLowerCase();
  let tier = 0;
  for (const ti of [3,2,1]) {
    if ((rs.spell_tiers[ti] || []).some(kw => t.includes(kw))) { tier = ti; break; }
  }
  if (tier === 0) return {tier:0, slot:null, slots:[], instant:false, direction:null};
  const slots = _matchingSlots(t, rs);
  const instant = (rs.instant_mods || []).some(kw => t.includes(kw));
  const direction = _spellDirection(t);
  return {tier, slot: slots[0] || null, slots, instant, direction};
}

function _scanLocation(text, state, rs) {
  const t = text.toLowerCase();
  for (const [loc, kws] of Object.entries(rs.location_kw || {})) {
    if (kws.some(kw => t.includes(kw))) { state.flags.location = loc; return; }
  }
}

function _advanceSlot(state, slot, tier, instant, debug, direction = null, text = '') {
  if (!state.body.slots[slot]) return;
  const s = state.body.slots[slot];
  if (s.locked) return;
  if (!direction) direction = _spellDirection(text) || (s.current === 'male' ? 'female' : 'male');
  const locked = (tier === 3);
  _transformSlot(state, slot, direction, locked, debug);
  if (!state.body._slot_first_turn) state.body._slot_first_turn = {};
  if (!state.body._slot_first_turn[slot]) state.body._slot_first_turn[slot] = state.turn || 0;
}

function _resistanceCheck(state, tier, orgasmThisTurn, debug) {
  if (state.flags.will_broken) { _dbg(debug, 'RESIST: auto-fail (will_broken)'); return false; }
  if (state.arousal.current >= 50) { _dbg(debug, 'RESIST: auto-fail (arousal≥50)'); return false; }
  const roll = _d20();
  const mod = _wilMod(state.stats.WIL);
  const pen = (tier === 3 ? 4 : 0) + (orgasmThisTurn ? 2 : 0);
  const total = roll + mod - pen;
  const dc = state.resistance_dc.current;
  const ok = total >= dc;
  const band = roll === 20 ? 'crit' : (roll === 1 ? 'fumble' : (ok ? 'pass' : 'fail'));
  _dbg(debug, `RESIST: d20(${roll})+${mod}-${pen}=${total} vs DC${dc} → ${ok ? 'PASS' : 'FAIL'}`);
  if (!state._roll_results) state._roll_results = [];
  state._roll_results.push({event:'resist', band, roll, mod, total, dc});
  if (ok) {
    state.resistance_dc.current += 3;
    state._resist_streak = (state._resist_streak || 0) + 1;
    if (state._resist_streak >= 3) {
      state.stats.BON = _clamp(state.stats.BON - 1, 0, 20);
      state._resist_streak = 0;
      _dbg(debug, 'BON -1 (3 consecutive resists)');
    }
  } else {
    state._resist_streak = 0;
    state.resistance = _clamp(state.resistance - 10, 0, 100);
    state.submission.score = _clamp(state.submission.score + 5, 0, 100);
  }
  return ok;
}

function _applyOrgasm(state, debug, rs) {
  const forced = state.resistance > 0 && !state.flags.will_broken;
  const orgType = forced ? 'forced' : 'willing';
  state.orgasms.session += 1;
  state.orgasms.lifetime += 1;
  if (forced) {
    state.orgasms.forced += 1;
    state.resistance = _clamp(state.resistance - 8, 0, 100);
  }
  if (state.corruption.stage >= 2) {
    state.orgasms.corruption_linked += 1;
    _addDose(state, debug, rs);
  }
  state.submission.score = _clamp(state.submission.score + 3, 0, 100);
  const bonDc = 10 - _bonMod(state.stats.BON);
  const gain = _d20() >= bonDc ? 5 : 2;
  state.loyalty = _clamp(state.loyalty + gain, 0, 100);
  state.arousal.current = Math.max(state.arousal.floor, state.arousal.current - 15);
  state.arousal.floor += 2;
  state._aftermath_turn = state.turn;
  state._last_orgasm_type = orgType;
  _dbg(debug, `ORGASM (${orgType}) loyalty+${gain}`);
}

function _applyAmbient(state, debug, rs) {
  const a = state.arousal.current;
  const aDecay = a>=50?5:a>=40?4:a>=30?3:a>=20?2:a>=10?1:0;
  const cDecay = [0,1,2,4,6][state.corruption.stage] || 0;
  const fDecay = state.flags.location === 'forest' ? 2 : 0;
  state.resistance = _clamp(state.resistance - 1 - aDecay - cDecay - fDecay, 0, 100);
  const bm = _bonMod(state.stats.BON);
  const wb = state.flags.will_broken ? 2 : 0;
  state.loyalty = _clamp(state.loyalty + Math.max(0, 2 + bm + wb), 0, 100);
  const aSub = a>=40?4:a>=30?3:a>=20?2:a>=10?1:0;
  state.submission.score = _clamp(state.submission.score + 1 + aSub, 0, 100);
  if (state.flags.location === 'forest') {
    state.arousal.floor = Math.max(state.arousal.floor, 5);
    state.arousal.current = _clamp(state.arousal.current - 3, state.arousal.floor, 60);
  }
  _triggerRoll(state, 'ambient', 'BON', 12, debug);
}

function _checkThresholds(state, debug, rs) {
  if (state.resistance <= 0 && !state.flags.will_broken) {
    state.flags.will_broken = true;
    state.submission.score = _clamp(state.submission.score + 10, 0, 100);
    state.arousal.floor = Math.max(state.arousal.floor, 20);
    _dbg(debug, 'THRESHOLD: will_broken');
  }
  const loy = state.loyalty;
  if (loy >= 30 && !state._bon_30) {
    state._bon_30 = true;
    state.stats.BON = _clamp(state.stats.BON + 1, 0, 20);
    _dbg(debug, 'BON +1 (loyalty≥30)');
  }
  if (loy >= 60 && !state._bon_60) {
    state._bon_60 = true;
    state.stats.BON = _clamp(state.stats.BON + 1, 0, 20);
    _dbg(debug, 'BON +1 (loyalty≥60)');
  }
  if (loy >= 50 && !state.flags.loyalty_bound) {
    state.flags.loyalty_bound = true;
    state.submission.score = _clamp(state.submission.score + 5, 0, 100);
  }
  if (loy >= 80 && !state.flags.devoted) {
    state.flags.devoted = true;
    state.submission.score = _clamp(state.submission.score + 5, 0, 100);
  }
  const oldSs = state.submission.stage;
  const newSs = _subStage(state.submission.score, rs);
  if (newSs !== oldSs && !state.submission.locked) {
    const labels = ['Defiant','Wavering','Yielding','Broken','Devoted'];
    state.submission.stage = newSs;
    _dbg(debug, `SUBMISSION: ${oldSs}→${newSs} [${labels[newSs]}]`);
    if (newSs === 4) state.stats.BON = _clamp(state.stats.BON + 1, 0, 20);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREGNANCY & BIRTH
// ═══════════════════════════════════════════════════════════════════════════════

function _tryPregnancy(state, debug) {
  if (!_isPregEligible(state) || state.pregnancy.pregnant) return;
  const {CON, WIL:_w} = state.stats;
  const chance = _clamp(10 + (CON/20)*20 + ((100-state.resistance)/100)*25 + (state.loyalty/100)*15, 10, 70);
  const roll = _d100();
  _dbg(debug, `PREGNANCY: d100=${roll} vs chance=${chance.toFixed(0)}`);
  if (roll <= chance) {
    state.pregnancy = {pregnant:true, trimester:1, father:'Master', turns_pregnant:0};
    _dbg(debug, 'PREGNANCY: conceived');
  }
}

function _doBirth(state, personaState, debug, rs) {
  if (!state.pregnancy.pregnant || state.pregnancy.trimester !== 3) return;
  const changed = _changedSlots(state);
  const fateScore = {'pet':8,'marked':5,'guardian':4,'echo':2,'released':-3}[state.fate || ''] || 0;
  const power = _clamp(
    10 + state.corruption.stage*5 + state.submission.stage*3 + changed.length*3 + fateScore,
    7, 80
  );
  const roll = _d100();
  const w = Math.max(5, 30 - Math.floor(power/3));
  const m = Math.max(20, 60 - Math.floor(power/4));
  const s = Math.max(50, 80 - Math.floor(power/5));
  let band, gc;
  if (roll <= w) { band = 'weak'; gc = 40; }
  else if (roll <= m) { band = 'moderate'; gc = 60; }
  else if (roll <= s) { band = 'strong'; gc = 80; }
  else { band = 'exceptional'; gc = 95; }
  const allGifts = ['true_arcane_ability','physical_perfection','semi_immortal','masters_sense','magic_resistance'];
  const gifts = allGifts.filter(() => _d100() <= gc);
  const child = {
    id: (personaState.children || []).length + 1,
    tier: 1, father: 'Master',
    power_score: power, power_band: band,
    gifts, turn_born: state.turn, tier_label: band.charAt(0).toUpperCase()+band.slice(1),
    mother_snapshot: {
      corruption_stage: state.corruption.stage,
      submission_stage: state.submission.stage,
      form: _bodySummary(state)
    }
  };
  if (!personaState.children) personaState.children = [];
  personaState.children.push(child);
  state.pregnancy = {pregnant:false, trimester:0, father:null, turns_pregnant:0};
  state.arousal.floor = Math.max(0, state.arousal.floor - 10);
  state.loyalty = _clamp(state.loyalty + 10, 0, 100);
  _dbg(debug, `BIRTH Tier1 power=${power} band=${band} gifts=${gifts}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FATE
// ═══════════════════════════════════════════════════════════════════════════════

function _applyFate(state, personaState, fateType, debug, rs) {
  const changed = _changedSlots(state);
  const gates = {
    pet: state.submission.stage >= 4 && state.loyalty >= 80,
    guardian: state.stats.CON >= 14 && changed.length >= 3,
    echo: state.flags.will_broken && state.submission.stage < 3,
    release: true,
    marked: state.body.slots.genitals.current !== state.body.slots.genitals.birth
  };
  if (!gates[fateType]) { _dbg(debug, `FATE: ${fateType} conditions not met`); return; }
  state.fate = fateType;
  state.flags.fate_locked = true;
  const er = {
    fate: fateType, turn: state.turn,
    submission_stage: state.submission.stage,
    corruption_stage: state.corruption.stage,
    form_snapshot: _bodySummary(state)
  };
  if (fateType === 'marked') {
    state.flags.graced = true;
    state.bindings.bloodline_sealed = true;
    er.grace_marks = {lifespan:'centuries', beauty:'undying', master_sense:true, bloodline_sealed:true};
    state.grace_marks = er.grace_marks;
  } else if (fateType === 'release' || fateType === 'released') {
    state.bindings.collared = false;
    state.bindings.branded = false;
  } else if (fateType === 'pet') {
    for (const s of Object.values(state.body.slots)) s.locked = true;
  }
  state.exit_record = er;
  _dbg(debug, `FATE: ${fateType} turn ${state.turn}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRIGGER ROLL SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

function _triggerRoll(state, event, statKey, dc, debug) {
  const stat = (state.stats || {})[statKey] || 10;
  const mod = Math.floor((stat - 10) / 2);
  const roll = _d20();
  const total = roll + mod;
  const band = roll === 20 ? 'crit' : (total >= dc ? 'pass' : (roll === 1 ? 'fumble' : 'fail'));
  const result = {event, band, roll, mod, total, dc};
  if (!state._roll_results) state._roll_results = [];
  state._roll_results.push(result);
  _dbg(debug, `ROLL ${event.toUpperCase()}: d20(${roll})${mod >= 0 ? '+' : ''}${mod}=${total} vs DC${dc} → ${band.toUpperCase()}`);
  return result;
}

// ─── Roll flavor tables ───────────────────────────────────────────────────────

const _ROLL_FLAVOR = {
  'arousal,crit,male': "He caught it. Felt it coming and locked it down before it landed. The body noted the situation. He refused it ground.",
  'arousal,crit,female': "She caught herself. Felt the warmth beginning and refused it before it settled. The want is there. She is not available to it.",
  'arousal,pass,male': "He felt it. Recognized it. Did not give it ground.",
  'arousal,pass,female': "She felt it rising and held herself still. The want is there. It is not in charge.",
  'arousal,fail,male': "He felt it and it got through. The body responded before the mind finished deciding whether to allow it.",
  'arousal,fail,female': "It got through her before she could stop it. The warmth is there now and it will not close.",
  'arousal,fumble,male': "It hit him all at once. No warning, no partial. The body is entirely ahead of him now.",
  'arousal,fumble,female': "It went through her completely. She is flushed and wet and the mind is still catching up.",
  'spell,crit,male': "His body absorbed the reshaping with strange steadiness. The change happened. The ground held.",
  'spell,crit,female': "Her body took the transformation without breaking stride. It changed. She is still here.",
  'spell,pass,male': "He is changed and still himself. The transformation did not take anything it wasn't aimed at.",
  'spell,pass,female': "She is different now and she is still herself. The spell took what it wanted. Nothing else moved.",
  'spell,fail,male': "The transformation rippled through more than the targeted form. Something in him came loose.",
  'spell,fail,female': "The change moved through more than just the body. Something loosened that was holding things in place.",
  'spell,fumble,male': "The spell went through him like a flood. Nothing was held back. The changed parts and the self have separated.",
  'spell,fumble,female': "The spell went through her like she wasn't there. The transformation was total in a way that wasn't planned.",
  'orgasm,crit,male': "He came and came back. The orgasm was real and complete and it did not take him apart.",
  'orgasm,crit,female': "She came and held herself together through it. The pleasure was real. She did not disappear into it.",
  'orgasm,pass,male': "He came and the defiance survived. Shaken. Present. The orgasm happened to the body.",
  'orgasm,pass,female': "She came and kept her feet under her. The pleasure washed through without carrying everything with it.",
  'orgasm,fail,male': "He came and something with it. Not all of it will come back. The orgasm took a piece.",
  'orgasm,fail,female': "She came and the edges went soft. The resistance that lived in the tension is quieter now.",
  'orgasm,fumble,male': "He came and the bottom dropped out. Whatever was holding him apart from this — it's gone.",
  'orgasm,fumble,female': "She came completely apart. Everything she had been keeping at a distance came down with it.",
  'dose,crit,male': "He felt it enter him and named it. The craving is real. He knows what it is. Knowing does not stop it.",
  'dose,crit,female': "She felt it and held onto what it was. The warmth is his doing. The want is manufactured. She knows that.",
  'dose,pass,male': "He felt the fog thicken and stayed inside his own head. The want pressed in. He did not move toward it.",
  'dose,pass,female': "She felt the want sharpen and held herself back from it. It is there. She is not chasing it.",
  'dose,fail,male': "The fog thickened and he was inside it before he noticed. The want is his now whether he named it or not.",
  'dose,fail,female': "The warmth settled in and she stopped fighting it so hard. It is there and she is not sure it is still wrong.",
  'dose,fumble,male': "He is lost in it. The craving is indistinguishable from thought now. He is not sure what he wanted before this.",
  'dose,fumble,female': "The fog took everything. The want for him is the loudest thing. She cannot find the thought that used to resist it.",
  'resist,crit,male': "He held. Not just held — pushed back. The spell broke against something in him and he felt it break.",
  'resist,crit,female': "She held and felt the spell break against her. The will that did that is still there. Still hers.",
  'resist,pass,male': "He held. The spell pressed and he was still there when it finished pressing.",
  'resist,pass,female': "She held. The pressure passed and she is still herself on the other side of it.",
  'resist,fail,male': "He failed to hold. The spell got through and took what it came for.",
  'resist,fail,female': "She couldn't hold it. The spell got through her and she felt it land.",
  'resist,fumble,male': "The resistance collapsed entirely. The spell went through him like he wasn't there.",
  'resist,fumble,female': "It all gave way at once. The spell took everything it wanted and she had nothing left to put against it.",
  'kneel,crit,male': "He knelt and every part of him knew it was performance. The body is on the floor. The self is not.",
  'kneel,crit,female': "She knelt and kept herself exactly where she was. The posture is his. The interior is not.",
  'kneel,pass,male': "He knelt. Hated it clearly and specifically. The act was physical.",
  'kneel,pass,female': "She knelt and held onto something while doing it. The act happened. Something did not go with it.",
  'kneel,fail,male': "He knelt and something went with the motion. He did not mean to give that. He gave it.",
  'kneel,fail,female': "She knelt and felt something go with it. The act carried more than she had intended to send.",
  'kneel,fumble,male': "He knelt and it landed. Completely. The act and the meaning were the same thing.",
  'kneel,fumble,female': "She knelt and there was nothing held back. The act and everything behind it landed at once.",
  'collar,crit,male': "The collar went on and something in him responded that he did not authorize. He felt it and held the line.",
  'collar,crit,female': "The collar settled around her throat and something deep said yes before she finished deciding what to feel.",
  'collar,pass,male': "The collar went on. He felt the weight of it. The meaning arrived slowly.",
  'collar,pass,female': "The collar is there. She is aware of it constantly. What that awareness means is still being decided.",
  'collar,fail,male': "The collar is just a collar. Physical. He is waiting for the meaning to arrive and it is already here.",
  'collar,fail,female': "The collar is cold metal. She feels it. It has not become anything yet.",
  'collar,fumble,male': "The collar went on and he felt it as rejection of everything that came before it. Just the collar. Just that.",
  'collar,fumble,female': "The collar is a fact. Cold, indifferent. She resents it with the small specific rage of someone who knows it will become something larger.",
  'brand,crit,male': "The brand is his. He knows it without deciding to know it. The mark and what it means arrived at the same time.",
  'brand,crit,female': "The brand settled into her skin and she felt it as truth. His. Permanently. Something in her did not fight that.",
  'brand,pass,male': "The mark is there. He is still deciding what it means to him.",
  'brand,pass,female': "The mark is permanent. She is still arriving at what that is.",
  'brand,fail,male': "The brand is a scar. Permanent, yes. Significant, he is not sure. He is waiting for the weight to arrive.",
  'brand,fail,female': "The brand is just there. Permanent. She looks at it and it has not become what it was supposed to yet.",
  'brand,fumble,male': "The brand is a wound. He understands what it was supposed to say. His body disagrees.",
  'brand,fumble,female': "The brand is a mark of something she did not consent to. She knows that. She will not forget that.",
  'ambient,crit,male': "There is a moment — quiet, brief — where being in his presence does not feel like loss.",
  'ambient,crit,female': "Something settles in her between the harder things. Not peace exactly. Something adjusted.",
  'ambient,pass,male': "He is still here. That fact has become more neutral than it was.",
  'ambient,pass,female': "She is adjusting to this place, to him. Not warmth. Familiarity.",
  'ambient,fail,male': "This place weighs on him. The weight is ordinary now, which is its own kind of bad.",
  'ambient,fail,female': "The castle presses. The presence presses. She is carrying it.",
  'ambient,fumble,male': "Something is harder than usual today. He cannot name it. He is further from himself than he was.",
  'ambient,fumble,female': "She is far from home in a way that arrives suddenly and does not leave."
};

function _rollFlavorLines(state, rs) {
  const results = state._roll_results || [];
  if (!results.length) return [];
  const ug = _unifiedGender(state);
  const g = ug || (state.body.birth_sex || 'female');
  return results.map(r => {
    const text = _ROLL_FLAVOR[`${r.event},${r.band},${g}`];
    return text ? `[${r.event.toUpperCase()} ${r.band.toUpperCase()}] ${text}` : null;
  }).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FRAGMENT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

function _arousalBand(arousal) {
  if (arousal >= 50) return 5;
  if (arousal >= 40) return 4;
  if (arousal >= 30) return 3;
  if (arousal >= 20) return 2;
  if (arousal >= 10) return 1;
  return 0;
}

function _resistanceBand(resistance) {
  if (resistance >= 80) return 0;
  if (resistance >= 60) return 1;
  if (resistance >= 40) return 2;
  if (resistance >= 20) return 3;
  if (resistance >= 1) return 4;
  return 5;
}

function _compositeBand(ab, ss, cs, wb) {
  if (wb) return 5;
  return Math.min(5, ab + Math.floor(cs/2) + Math.max(0, ss-2));
}

function _reluctanceBand(ab, ss) {
  return Math.max(0, ab - ss);
}

function _buildFragmentCtx(state, rs) {
  const birth = state.body.birth_sex || 'male';
  const ug = _unifiedGender(state);
  const changed = _changedSlots(state);
  const ab = _arousalBand(state.arousal.current);
  const ss = state.submission.stage;
  const cs = state.corruption.stage;
  const wb = state.flags.will_broken;
  const cb = _compositeBand(ab, ss, cs, wb);
  const stats = state.stats || {};
  const wil = stats.WIL || 10, sub_s = stats.SUB || 10;
  const bon = stats.BON || 10, con = stats.CON || 10, dom = stats.DOM || 10;
  const wilMod = Math.floor((wil-10)/2);
  const subMod = Math.floor((sub_s-10)/2);
  const bonMod = Math.floor((bon-10)/2);
  const conMod = Math.floor((con-10)/2);
  const domMod = Math.floor((dom-10)/2);
  const rbRaw = _reluctanceBand(ab, ss);
  const rb = Math.max(0, rbRaw + (wil >= 14 ? 1 : wil <= 7 ? -1 : 0));
  const conWindow = con >= 14 ? 0.6 : con <= 7 ? 1.5 : 1.0;
  const subNudge = sub_s >= 14 ? -1 : sub_s <= 7 ? 1 : 0;
  const effSs = Math.max(0, ss + subNudge);
  const now = state.turn || 0;
  const tsc = {};
  for (const slot of changed) {
    const first = ((state.body._slot_first_turn || {})[slot]) ?? now;
    tsc[slot] = now - first;
  }
  return {
    birth, current: ug, unified: _isUnified(state),
    ab, cb, rb, rb_raw: rbRaw, ss, eff_ss: effSs, cs, wb,
    identity: _identityCategory(state._sex_label || ''),
    changed, turns_since_change: tsc, con_window: conWindow,
    bon_mod: bonMod, wil_mod: wilMod, sub_mod: subMod,
    con_mod: conMod, dom_mod: domMod, stats,
    measurements: state.measurements || {},
    resistance: state.resistance, loyalty: state.loyalty, turn: now,
    orgasms: state.orgasms.session,
    pregnant: state.pregnancy.pregnant,
    collared: state.bindings.collared,
    branded: state.bindings.branded
  };
}

function _freshChange(ctx, slots, within = 4) {
  const target = slots || ctx.changed;
  const w = within * (ctx.con_window || 1);
  return target.some(s => (ctx.turns_since_change[s] ?? 999) < w);
}

function _allFresh(ctx, within = 4) {
  const w = within * (ctx.con_window || 1);
  return ctx.changed.length > 0 && ctx.changed.every(s => (ctx.turns_since_change[s] ?? 999) < w);
}

function _genitalsChanged(ctx) { return ctx.changed.includes('genitals'); }
function _genitalsFresh(ctx, within = 4) {
  const w = within * (ctx.con_window || 1);
  return ctx.changed.includes('genitals') && (ctx.turns_since_change.genitals ?? 999) < w;
}

function _recognizesChange(ctx) {
  if (ctx.identity === 'trans_mtf' && ctx.current === 'female') return true;
  if (ctx.identity === 'trans_ftm' && ctx.current === 'male') return true;
  return false;
}

function _opposesChange(ctx) {
  if (ctx.identity === 'cis_male' && ctx.current === 'female') return true;
  if (ctx.identity === 'cis_female' && ctx.current === 'male') return true;
  return false;
}

const _FRAGMENTS = [
  // SHOCK
  { stat:'WIL', dc:10, group:'shock', priority:10, once:true,
    text_pass:"The genitals are different. The mind registered it before the body did and neither of them have caught up.",
    text_fail:"The genitals are different. She knows before she finishes the thought and cannot stop knowing.",
    fires_if:(s,c) => _genitalsFresh(c,2) && _opposesChange(c) && c.cb < 3 },
  { stat:'CON', dc:10, group:'shock', priority:9, once:true,
    text_pass:"Something is wrong below the waist. Or not wrong — different. She files it. The filing does not help.",
    text_fail:"Something is wrong below the waist. Or not wrong — but different. The wrongness is everywhere at once.",
    fires_if:(s,c) => _genitalsFresh(c,2) && ['unknown','nb'].includes(c.identity) && c.cb < 3 },
  { stat:'WIL', dc:9, group:'shock', priority:8, once:true,
    text_pass:"The chest is different. She notices it and files it. The noticing does not stop.",
    text_fail:"The chest is different. She keeps noticing it in the corner of her vision.",
    fires_if:(s,c) => c.changed.includes('chest') && (c.turns_since_change.chest ?? 999) < 2 && c.identity === 'cis_male' && c.cb < 3 },
  { stat:'WIL', dc:12, group:'shock', priority:10, once:true,
    text_pass:"Every part of her is wrong. The wrongness is complete — and she is holding that knowledge without letting it go anywhere.",
    text_fail:"Every part of her is wrong. The wrongness is complete and she does not know where to put it.",
    fires_if:(s,c) => c.changed.length >= 2 && _allFresh(c,2) && _opposesChange(c) },
  // DISORIENTATION
  { stat:'CON', dc:11, group:'disorientation', priority:8,
    text_pass:"He keeps almost reaching for something that isn't there. He catches himself. Does not reach.",
    text_fail:"He keeps reaching for something that isn't there anymore. He does not always catch it.",
    fires_if:(s,c) => _genitalsChanged(c) && ['cis_male','unknown'].includes(c.identity) && (c.turns_since_change.genitals ?? 999) < 6 && c.ss < 2 && c.cs < 2 },

  { stat:'CON', dc:10, group:'disorientation', priority:5,
    text_pass:"The body moves differently now. She is learning it faster than expected.",
    text_fail:"The body keeps moving in ways she hasn't learned yet. Reaching, sitting, standing — all slightly wrong.",
    fires_if:(s,c) => c.changed.length >= 2 && _freshChange(c, null, 5) && c.ss < 2 },
  { stat:'WIL', dc:12, group:'disorientation', priority:7,
    text_pass:"There is a cock that is not there. His hands almost check and then stop themselves.",
    text_fail:"There is a cock that is not there and his hands keep almost checking. He cannot make them stop.",
    fires_if:(s,c) => _genitalsChanged(c) && c.identity === 'cis_male' && c.stats && c.stats.WIL !== undefined && (c.turns_since_change.genitals ?? 999) < 8 * c.con_window && c.eff_ss < 2 },
  // GRIEF
  { stat:'WIL', dc:11, group:'grief', priority:7,
    text_pass:"She is starting to understand what she has lost. She is holding the understanding without letting it show.",
    text_fail:"She is starting to understand what she has lost. The understanding is arriving without her permission.",
    fires_if:(s,c) => _opposesChange(c) && c.changed.length >= 1 && c.changed.some(sl => { const t = c.turns_since_change[sl] ?? 999; return t >= 3 && t <= 12 * c.con_window; }) && c.ss < (2 + (c.wil_mod >= 2 ? 1 : 0)) && c.ab < 3 },
  { stat:'WIL', dc:12, group:'grief', priority:6,
    text_pass:"She does not miss the cock exactly. She misses knowing what she was. She is holding that separately.",
    text_fail:"She does not miss the cock exactly. She misses knowing what she was without having to check.",
    fires_if:(s,c) => _genitalsChanged(c) && c.identity === 'cis_male' && c.ss < 3 && c.ab < 2 && c.bon_mod <= 1 },
  { stat:'WIL', dc:10, group:'grief', priority:4,
    text_pass:"He is adjusting. That is the word he is using. He does not think adjusting covers what is happening.",
    text_fail:"He is adjusting. That is the word he is using. He is not sure yet whether it means anything.",
    fires_if:(s,c) => _opposesChange(c) && c.changed.length >= 1 && c.changed.some(sl => (c.turns_since_change[sl] ?? 999) >= 5) && c.eff_ss >= 1 && c.eff_ss <= 2 },
  // CURIOSITY
  { stat:'WIL', dc:11, group:'curiosity', priority:7,
    text_pass:"She is mapping the new genitals without fully deciding to. She notices that. She keeps going.",
    text_fail:"She is mapping the new genitals without fully deciding to. The information keeps coming in.",
    fires_if:(s,c) => _genitalsChanged(c) && c.ab >= 1 && c.eff_ss < 2 && c.cs < 2 && ['cis_male','unknown'].includes(c.identity) && c.bon_mod >= -1 },
  { stat:'WIL', dc:10, group:'curiosity', priority:6,
    text_pass:"The breasts are strange. She keeps noticing their weight and sensitivity without meaning to.",
    text_fail:"The breasts are strange. She keeps accidentally noticing what they feel like when she moves.",
    fires_if:(s,c) => c.changed.includes('chest') && c.ab >= 1 && c.eff_ss < 2 && ['cis_male','unknown'].includes(c.identity) && c.bon_mod >= -1 },
  // RECOGNITION
  { stat:'BON', dc:10, group:'recognition', priority:10, once:true,
    text_pass:"This is what she was supposed to be. The body finally makes sense. She is not going to say that.",
    text_fail:"This is what she was supposed to be. The body finally makes sense. She has not said that.",
    fires_if:(s,c) => _recognizesChange(c) && c.changed.length >= 2 && _allFresh(c,3) },
  { stat:'WIL', dc:11, group:'recognition', priority:9,
    text_pass:"The genitals are right. She knows it. She is not ready to let that mean anything yet.",
    text_fail:"The genitals are right. She has not said it out loud but the knowledge is there.",
    fires_if:(s,c) => _genitalsChanged(c) && _recognizesChange(c) && c.ss < 3 },
  // IDENTITY DRIFT
  { stat:'WIL', dc:13, group:'identity_drift', priority:7,
    text_pass:"She has noticed herself thinking of herself as she. She catches it each time.",
    text_fail:"She has stopped correcting herself when she thinks of herself as she. She noticed that stopping.",
    fires_if:(s,c) => _opposesChange(c) && c.unified && c.eff_ss >= 2 && c.changed.some(sl => (c.turns_since_change[sl] ?? 0) >= 8 / c.con_window) },
  { stat:'WIL', dc:14, group:'identity_drift', priority:6,
    text_pass:"The body has been female long enough that male feels distant. She is aware of the distance.",
    text_fail:"The body has been female long enough that male feels like a past tense. She noticed when that happened.",
    fires_if:(s,c) => _opposesChange(c) && c.unified && c.changed.some(sl => (c.turns_since_change[sl] ?? 0) >= 12 / c.con_window) && c.eff_ss >= 1 && c.wil_mod < 3 },
  // RELUCTANCE
  { stat:'WIL', dc:12, group:'reluctance', priority:7,
    text_pass:"The wanting is happening without permission and she resents it. The resentment does not stop it.",
    text_fail:"The wanting is happening without permission and she resents it clearly and without effect.",
    fires_if:(s,c) => c.rb >= 3 && c.cs === 0 && c.ss < 2 },
  { stat:'WIL', dc:11, group:'reluctance', priority:6,
    text_pass:"The body is ahead of where the mind is willing to be. She is maintaining the gap.",
    text_fail:"The body is well ahead of where the mind is willing to be and she has stopped closing the distance.",
    fires_if:(s,c) => c.rb >= 2 && c.cs === 0 && c.eff_ss >= 1 && c.eff_ss <= 2 },
  // CRAVING
  { stat:'WIL', dc:13, group:'craving', priority:8,
    text_pass:"The wanting has a target now. It is him specifically. She is aware of its target.",
    text_fail:"The wanting has a target now. It is him specifically and the specificity is the worst part.",
    fires_if:(s,c) => c.cs >= 2 && c.ab >= 1 && c.ss < 3 },
  { stat:'WIL', dc:14, group:'craving', priority:7,
    text_pass:"She craves him. She knows it is manufactured. She knows and it still does not help.",
    text_fail:"She craves him in a way that feels like a fact about her body rather than something done to her.",
    fires_if:(s,c) => c.cs >= 3 && c.ss < 3 },
  { stat:'WIL', dc:16, group:'craving', priority:10,
    text_pass:"The need for him is the deepest thing. She still knows that. Knowing is the grief of it.",
    text_fail:"The need for him is the deepest thing. Everything else is on top of it.",
    fires_if:(s,c) => c.cs >= 4 },
  // SURRENDER
  { stat:'WIL', dc:10, group:'surrender', priority:6,
    text_pass:"The defiance is still there but it has stopped feeling like solid ground.",
    text_fail:"The defiance is still there but it has stopped feeling like solid ground and she noticed.",
    fires_if:(s,c) => c.eff_ss === 1 && c.rb >= 1 },
  { stat:'WIL', dc:11, group:'surrender', priority:7,
    text_pass:"She obeys and then wonders after the fact whether she decided to. She is not sure she did.",
    text_fail:"She obeys and then wonders after the fact whether she decided to. The gap between is closing.",
    fires_if:(s,c) => c.eff_ss === 2 },
  { stat:'BON', dc:10, group:'surrender', priority:8,
    text_pass:"The resistance is gone. What is left is orientation toward him. She has looked at that directly.",
    text_fail:"The resistance is gone. What is left is not empty — it is oriented. Toward him.",
    fires_if:(s,c) => c.eff_ss >= 3 && c.cs < 2 },
  { stat:'BON', dc:10, group:'surrender', priority:9,
    text_pass:"She wants to be here. That want is hers — she has checked, and it is hers.",
    text_fail:"She wants to be here. That want is hers — she has checked.",
    fires_if:(s,c) => c.eff_ss >= 4 && c.cs < 3 },
  // AFTERMATH ECHO
  { stat:'CON', dc:10, group:'aftermath_echo', priority:5,
    text_pass:"The orgasm is still present at the edges. She is pushing it back. It is smaller than it was.",
    text_fail:"The orgasm is still present at the edges. The body has not fully let it go.",
    fires_if:(s,c) => (s._aftermath_turn ?? -1) >= c.turn - 2 && s.orgasms.session >= 1 && c.ab < 2 },
  { stat:'WIL', dc:11, group:'aftermath_echo', priority:6,
    text_pass:"She is softer in the aftermath. She knows it. She is working on getting back.",
    text_fail:"She is softer in the aftermath. The edges have not come back yet.",
    fires_if:(s,c) => (s._aftermath_turn ?? -1) >= c.turn - 2 && s.orgasms.session >= 1 && c.ss >= 1 },
];

function _collectFragments(state, rs, maxFrags = 3) {
  const ctx = _buildFragmentCtx(state, rs);
  if (!state._seen_frags) state._seen_frags = new Set();
  const seen = state._seen_frags;
  const byGroup = {};
  _FRAGMENTS.forEach((frag, i) => {
    try {
      if (!frag.fires_if(state, ctx)) return;
    } catch(e) { return; }
    if (frag.once && seen.has(i)) return;
    const g = frag.group || `_ungrouped_${i}`;
    const pri = frag.priority || 0;
    if (!byGroup[g] || pri > byGroup[g][0]) byGroup[g] = [pri, i, frag];
  });
  const candidates = Object.values(byGroup).sort((a,b) => b[0]-a[0]);
  const result = [];
  for (const [, i, frag] of candidates) {
    const statKey = frag.stat || 'WIL';
    const dc = frag.dc || 12;
    const statVal = (state.stats || {})[statKey] || 10;
    const mod = Math.floor((statVal-10)/2);
    const roll = _d20();
    const passed = (roll + mod) >= dc;
    const text = passed ? frag.text_pass : frag.text_fail;
    result.push(text);
    if (frag.once) seen.add(i);
    if (result.length >= maxFrags) break;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BODY FLAVOR TABLES
// ═══════════════════════════════════════════════════════════════════════════════

const _UNIFIED_STATE = {
  'male,male,0': null,
  'male,male,1': "Something has woken. The body is noting his presence without declaring anything.",
  'male,male,2': "He is hard and aware and doing his best not to show it.",
  'male,male,3': "His whole body is in it — aching, restless, the want pressing against the places he is trying to hold.",
  'male,male,4': "His body has been running ahead of him long enough that the mind has stopped pretending otherwise.",
  'male,male,5': "He is Master's whether he has finished deciding that or not. The body has already decided.",
  'female,female,0': null,
  'female,female,1': "A faint warmth moving through her — the body noting something without her permission.",
  'female,female,2': "She is warm and slick and aware of herself in a way that will not quiet.",
  'female,female,3': "Her whole body is aching. The want is everywhere at once and there is no closing it.",
  'female,female,4': "She is barely holding anything back. The body has been ahead of the mind for too long.",
  'female,female,5': "She is entirely open. There is no will left to close her.",
  'male,female,0': "She carries the shape he gave her. The body is new and the newness is still arriving.",
  'male,female,1': "Warmth moves through the body he made for her — feminine heat, unfamiliar and real.",
  'male,female,2': "She is warm and slick in a body that is not what she was born to. The body does not care.",
  'male,female,3': "Her whole remade body is aching in ways she was not built to feel. She is built to feel them now.",
  'male,female,4': "She is desperate in a form built for this. Everything in the body has been aimed at this.",
  'male,female,5': "She is entirely open — the body he made fits her completely now. There is nowhere left to hide.",
  'female,male,0': "He carries the shape that was made for him. The body is different and the difference is present.",
  'female,male,1': "Something stirs in the body that was given to him — a directness he is still learning.",
  'female,male,2': "He is hard in a body that is not what he was born to. The want is here regardless.",
  'female,male,3': "His whole remade body is aching. She was not built to feel this. He is built to feel it now.",
  'female,male,4': "He is desperate in a form that has taken over the argument. The body is winning.",
  'female,male,5': "His body has no refusal left. The form he was given fits the want completely."
};

const _SLOT_BASE = {
  'genitals,female,0':null,'genitals,female,1':"She is barely damp",'genitals,female,2':"She is wet",
  'genitals,female,3':"She is slick and aching",'genitals,female,4':"She is dripping and desperate",
  'genitals,female,5':"She is soaking, barely present below the waist",
  'genitals,male,0':null,'genitals,male,1':"His cock has stirred",'genitals,male,2':"He is hard",
  'genitals,male,3':"He is hard and aching",'genitals,male,4':"He is throbbing and desperate",
  'genitals,male,5':"His cock is unbearable",
  'chest,female,0':null,'chest,female,1':"Her nipples have stiffened",'chest,female,2':"Her breasts are warm and heavy",
  'chest,female,3':"Her chest aches, nipples raw with want",'chest,female,4':"Her breasts are desperate for contact",
  'chest,female,5':"Her chest contributes its own ache to everything",
  'chest,male,0':null,'chest,male,1':null,'chest,male,2':null,
  'chest,male,3':"His chest tightens",'chest,male,4':"His chest is exposed and oversensitive",
  'chest,male,5':"Even his chest aches now",

};

const _PSYCH_COLOR = {
  '0,0':null,'1,0':"— the body slightly ahead of the mind",'2,0':"— and it will not close",
  '3,0':"— with nowhere to put it",'4,0':"— the shame and the wanting together",
  '5,0':"— wanting to stop and unable to",
  '0,1':"— a pull toward him that hasn't been named yet",'1,1':"— the body ahead, and something pulling it toward him",
  '2,1':"— the body ahead and a new pull giving it direction",'3,1':"— the body well ahead and the corruption giving it a target",
  '4,1':"— wanting and unable to close and the pull making it specific",
  '5,1':"— wanting to stop and the corruption making sure it won't",
  '0,2':"— the want has a direction now. The body knows who it wants.",'1,2':"— the body ahead and the want aimed at him specifically",
  '2,2':"— the body ahead of the mind, the want aimed at him",'3,2':"— it is him specifically. The knowing won't stop.",
  '4,2':"— wanting him specifically, unable to close, unable to stop knowing",
  '5,2':"— the body fully ahead and pointed directly at him and the shame changes nothing.",
  '0,3':"— the craving for him is a need, not a want. The body knows the difference.",
  '1,3':"— the craving is winning the argument",'2,3':"— the craving for him is winning",
  '3,3':"— fighting a need the corruption has made into physical fact",
  '4,3':"— the wanting for him and the shame of it are the same thing",
  '5,3':"— unable to stop wanting him and unable to forgive it",
  '0,4':"— the need for his seed is deeper than thought. There is no arguing with it.",
  '1,4':"— the need for his seed is a physical certainty",'2,4':"— the deepest want is winning everything",
  '3,4':"— fighting what has become the body's most fundamental truth",
  '4,4':"— the body's most fundamental need, and the mind has been losing this argument for a long time",
  '5,4':"— the body is entirely his. The need for his seed is the only thought left."
};

function _buildBodyFlavor(state, rs) {
  const lines = [];
  const changed = _changedSlots(state);
  const original = _originalSlots(state);
  const unified = _isUnified(state);
  const birth = state.body.birth_sex || 'female';
  const ug = _unifiedGender(state);
  const ar = state.arousal.current;
  const ab = _arousalBand(ar);
  const ss = state.submission.stage;
  const cs = state.corruption.stage;
  const wb = state.flags.will_broken;
  const cb = _compositeBand(ab, ss, cs, wb);
  const rb = _reluctanceBand(ab, ss);

  if (changed.length) {
    lines.push('BODY:');
    for (const slot of changed) {
      const sd = state.body.slots[slot];
      const locked = sd.locked ? ' [LOCKED]' : '';
      lines.push(`  ${slot} remade (${sd.birth}→${sd.current})${locked}`);
    }
    if (original.length) lines.push(`  ${original.join(', ')} unchanged.`);
  }

  if (unified) {
    const fl = _UNIFIED_STATE[`${birth},${ug},${cb}`];
    if (fl) { lines.push(''); lines.push(`STATE: ${fl}`); }
  } else {
    const slotLines = [];
    for (const slot of changed) {
      const g = state.body.slots[slot].current;
      const base = _SLOT_BASE[`${slot},${g},${ab}`];
      if (!base) continue;
      const color = _PSYCH_COLOR[`${rb},${cs}`];
      slotLines.push(`  ${base}${color ? ' ' + color : '.'}`);
    }
    if (slotLines.length) {
      lines.push(''); lines.push('STATE:');
      lines.push(...slotLines.slice(0,4));
    }
  }

  // Aftermath
  if ((state._aftermath_turn ?? -1) === state.turn) {
    const orgType = state._last_orgasm_type || 'forced';
    lines.push('');
    if (unified) {
      lines.push(orgType === 'forced'
        ? "AFTERMATH: The orgasm is still moving through her. The body has not let it go."
        : "AFTERMATH: The body is settling. The pleasure was real and is still present at the edges.");
    } else if (changed.length) {
      lines.push("AFTERMATH:");
      lines.push("  The new body responded through the whole of it. The unfamiliar parts made it stranger.");
    }
  }

  const anyState = changed.length > 0 || cb > 0 || (state._aftermath_turn ?? -1) === state.turn;
  return anyState ? lines : [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD_HEADER FLAVOR TABLES
// ═══════════════════════════════════════════════════════════════════════════════

const _WILL_FLAVOR = {
  'male,0':null,'female,0':null,
  'male,1':"WILL: Intact but the domain presses on it. He feels the weight of this place.",
  'female,1':"WILL: Present but the domain weighs on her. She feels it.",
  'male,2':"WILL: Cracking. He fights but each refusal costs him. The resistance is thinning.",
  'female,2':"WILL: Cracking. Resistance is thin. She fights but the fight costs her. Every turn.",
  'male,3':"WILL: Nearly gone. He resists in flashes — impulse, not conviction. The will is almost used up.",
  'female,3':"WILL: Nearly gone. She can resist in flashes — impulse, not conviction. The will is almost gone.",
  'male,4':"WILL: A thread. He remembers what it was to refuse clearly. That clarity is almost gone.",
  'female,4':"WILL: Hanging by a thread. She is almost entirely Master's. What remains is reflex.",
  'male,5':"WILL: Gone. He can speak, can feel — but he cannot refuse. The will has broken.",
  'female,5':"WILL: Gone. She remembers resisting — the memory is intact. The ability is not."
};

const _SUB_FLAVOR = {
  'male,0':null,'female,0':null,
  'male,1':"SUBMISSION — WAVERING: The defiance has cracks. He still resists but not cleanly.",
  'female,1':"SUBMISSION — WAVERING: The defiance has cracks. She still resists but not cleanly.",
  'male,2':"SUBMISSION — YIELDING: The defiance is performative now. He obeys before he decides to.",
  'female,2':"SUBMISSION — YIELDING: Not broken. But the defiance is performance now — she obeys before she decides.",
  'male,3':"SUBMISSION — BROKEN: The resistance is gone. He may still speak, still push — but he cannot hold.",
  'female,3':"SUBMISSION — BROKEN: The resistance is gone. She may still speak, still push — but she cannot hold.",
  'male,4':"SUBMISSION — DEVOTED: He does not resist. He does not want to. Whatever brought him here is complete.",
  'female,4':"SUBMISSION — DEVOTED: She does not resist. She does not want to. This is what she is now."
};

const _CORRUPT_FLAVOR = {
  'male,0':null,'female,0':null,
  'male,1':"CORRUPTION — TOUCHED: Something unfamiliar has taken root. A warmth, a want, nothing he can name yet.",
  'female,1':"CORRUPTION — TOUCHED: Something unfamiliar has taken root. A warmth, a want, nothing she can name yet.",
  'male,2':"CORRUPTION — FOGGED: His thoughts blur when Master is near. Refusals feel delayed, uncertain.",
  'female,2':"CORRUPTION — FOGGED: Her thoughts blur when Master is near. Refusals feel delayed, uncertain.",
  'male,3':"CORRUPTION — BOUND: He cannot fully refuse Master's direct commands — the corruption intercepts the refusal.",
  'female,3':"CORRUPTION — BOUND: She cannot fully refuse Master's direct commands — the corruption intercepts.",
  'male,4':"CORRUPTION — BROODBOUND: He is fully himself — memories, identity, will intact. The need for Master's seed is simply the deepest truth.",
  'female,4':"CORRUPTION — BROODBOUND: She is fully herself — memories, personality, identity intact. The need for his seed is simply the deepest truth."
};

const _CORRUPT_COMPULSION = {
  'male,1':"CORRUPTION STAGE 1: Character experiences unfamiliar warmth and subtle pull toward Master. Not compelled — drawn.",
  'female,1':"CORRUPTION STAGE 1: Character experiences unfamiliar warmth and subtle pull toward Master. Not compelled — drawn.",
  'male,2':"CORRUPTION STAGE 2: Character's thoughts fog when Master is near. They cannot fully form refusals in his presence.",
  'female,2':"CORRUPTION STAGE 2: Character's thoughts fog when Master is near. They cannot fully form refusals in his presence.",
  'male,3':"CORRUPTION STAGE 3: Character cannot fully refuse Master's direct commands. The craving for him is a physical fact.",
  'female,3':"CORRUPTION STAGE 3: Character cannot fully refuse Master's direct commands. The craving for him is a physical fact.",
  'male,4':"CORRUPTION STAGE 4: Character is fully themselves — but the need for Master's seed is the body's deepest imperative. It shapes every action.",
  'female,4':"CORRUPTION STAGE 4: Character is fully themselves — but the need for Master's seed is the body's deepest imperative. It shapes every action."
};

const _PREG_FLAVOR = {
  'male,1':"PREGNANT — early. His body is doing something his mind has not fully accepted yet.",
  'female,1':"PREGNANT — early. She may not know yet. The body has already begun.",
  'male,2':"PREGNANT — showing. The change is visible now, undeniable. His body is doing what it was made for.",
  'female,2':"PREGNANT — showing. The change is visible. Her body is doing what it was made for.",
  'male,3':"PREGNANT — late term. He is full with Master's child. Birth is close.",
  'female,3':"PREGNANT — late term. She is full with Master's child. Birth is close. The waiting is almost over."
};

const _BINDING_FLAVOR = {
  collared: {
    male: "COLLARED: He wears Master's claim visibly. The collar announces what he is here.",
    female: "COLLARED: She wears Master's claim visibly. The collar announces what she is here."
  },
  branded: {
    male: "BRANDED: The mark is permanent. It will outlast everything else that happens to him.",
    female: "BRANDED: The mark is permanent. It will outlast everything else that happens to her."
  },
  bloodline_sealed: {
    male: "BLOODLINE SEALED: He is entirely Master's — in body, in blood, in every possible way.",
    female: "BLOODLINE SEALED: She is entirely Master's — in body, in blood, in every possible way."
  }
};

const _BOND_FLAVOR = [
  [80,100,
   "BOND: He wants to be here. Whether that want was always his or was made for him — he has stopped asking.",
   "BOND: She wants to be here. Whether that want was always hers or was made for her — she has stopped asking."],
  [60,79,
   "BOND: Something has shifted. What he feels toward Master no longer reads clearly as captivity.",
   "BOND: Something has shifted. What she feels toward Master no longer reads clearly as captivity."],
  [40,59,
   "BOND: He is becoming familiar with this place, with him. Resistance and comfort are braided now.",
   "BOND: She is becoming familiar with this place, with him. Resistance and comfort are braided now."],
  [20,39,
   "BOND: He does not yet trust him. But he has begun to notice things — patterns, moods, what matters.",
   "BOND: She does not yet trust him. But she has begun to notice things — patterns, moods, what matters."],
  [1,19,
   "BOND: He is new here. Everything about this place is unfamiliar. He is reading it for threat.",
   "BOND: She is new here. Everything about this place is unfamiliar. She is reading it for threat."]
];

const _CASTLE_FLAVOR = {
  '1,male': "CASTLE — stirring. The walls are aware of him. Something in the stone has taken interest.",
  '1,female': "CASTLE — stirring. The walls are aware of her. Something in the stone is paying attention.",
  '2,male': "CASTLE — active. The room has opinions. Restraints are available. The furniture is arranged.",
  '2,female': "CASTLE — active. The room has opinions. Restraints are available. The furniture is arranged.",
  '3,male': "CASTLE — aggressive. The keep is working. Chains are present. The room is trying.",
  '3,female': "CASTLE — aggressive. The keep is working. Chains are present. The room responds to her.",
  '4,male': "CASTLE — relentless. Everything in this place has joined in. He has no neutral ground.",
  '4,female': "CASTLE — relentless. Everything in this place is joined in. She has no neutral ground.",
  '5,male': "CASTLE — fully engaged. The keep owns this scene. His will is gone and the castle knows it.",
  '5,female': "CASTLE — fully engaged. The keep owns this scene. Her will is gone and the castle knows it."
};

function _castleFlavor(intensity, gender) {
  if (intensity <= 0) return null;
  return _CASTLE_FLAVOR[`${intensity},${gender}`] || _CASTLE_FLAVOR[`${intensity},female`] || null;
}

function buildSystemPrompt(systemText) {
  const prefix = [
    '═══════════════════════════════════════════════════════════════════════════════',
    "SETTING — THE OTHERWORLD (MASTER'S DOMAIN)",
    '═══════════════════════════════════════════════════════════════════════════════',
    '',
    'Time moves differently here. The world outside has already moved on — years or centuries.',
    'There is no rescue coming. Whatever this character was before the forest, that life is gone.',
    "The Master's keep is a living thing. The domain responds to his will and to their state.",
    '',
    'THE MASTER: DOM 20 | WIL 20 | CON 18 | INT 20 | DES 12',
    'He does not resist spells. He does not fail saves. He is the origin of the magic here.',
    '',
    '═══════════════════════════════════════════════════════════════════════════════',
    '',
    ''
  ].join('\n');
  // Strip any scenario field from the card — we own the scenario
  const stripped = (systemText || '')
    .replace(/^Scenario:.*?(?=\n[A-Z]|\n\n|\[|\{|$)/ims, '')
    .replace(/<scenario>[\s\S]*?<\/scenario>\s*/i, '')
    .trim();
  return prefix + stripped;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD HEADER
// ═══════════════════════════════════════════════════════════════════════════════

function buildHeader(name, state, rs) {
  const loc = state.flags.location;
  const turn = state.turn;
  const res = state.resistance;
  const lines = [`[STATE — ${name} | ${loc} | turn ${turn}]`, ''];

  const ug = _unifiedGender(state);
  const g = ug || (state.body.birth_sex || 'female');

  const bodyFlavor = _buildBodyFlavor(state, rs);
  if (bodyFlavor.length) { lines.push(...bodyFlavor); lines.push(''); }

  // WILL
  const rb = _resistanceBand(res);
  const willText = state.flags.will_broken
    ? _WILL_FLAVOR[`${g},5`]
    : _WILL_FLAVOR[`${g},${rb}`];
  if (willText) { lines.push(willText); lines.push(''); }

  // CORRUPTION
  const cs = state.corruption.stage;
  if (cs > 0) {
    const fl = _CORRUPT_FLAVOR[`${g},${cs}`];
    if (fl) { lines.push(fl); lines.push(''); }
  }

  // SUBMISSION
  const ss = state.submission.stage;
  if (ss > 0) {
    const fl = _SUB_FLAVOR[`${g},${ss}`];
    if (fl) { lines.push(fl); lines.push(''); }
  }

  // PREGNANCY
  if (state.pregnancy.pregnant) {
    const tri = state.pregnancy.trimester;
    const pg = state.body.birth_sex || 'female';
    const fl = _PREG_FLAVOR[`${pg},${tri}`];
    if (fl) { lines.push(fl); lines.push(''); }
  }

  // BINDINGS
  for (const [key, flavorDict] of Object.entries(_BINDING_FLAVOR)) {
    if (state.bindings[key]) {
      const fl = flavorDict[g] || flavorDict.female;
      if (fl) { lines.push(fl); lines.push(''); }
    }
  }

  // CASTLE
  const ci = _castleIntensity(res);
  const cf = _castleFlavor(ci, g);
  if (cf) { lines.push(cf); lines.push(''); }

  // BOND
  const loy = state.loyalty;
  for (const [lo, hi, mText, fText] of _BOND_FLAVOR) {
    if (lo <= loy && loy <= hi) {
      lines.push(g === 'male' ? mText : fText);
      lines.push('');
      break;
    }
  }

  // FOREST
  if (loc === 'forest') {
    const forestText = g === 'male'
      ? "FOREST: The trees are watching. Thought comes slower here. The path behind him is already gone."
      : "FOREST: The trees are watching. Thought comes slower here. The path behind her is already gone.";
    lines.push(forestText);
    lines.push('');
  }

  // ENCHANTMENTS
  for (const e of state.enchantments) {
    lines.push(`ENCHANTMENTS: ${e.name}${e.locked ? ' (permanent)' : ''}`);
  }
  if (state.enchantments.length) lines.push('');

  // ROSTER
  if (state.active_roster.length) {
    lines.push(`PRESENT [${loc}]:`);
    for (const r of state.active_roster) {
      const sl = r.summary ? r.summary.split('\n')[0] : `${r.name} — ${r.fate || 'visitor'}`;
      lines.push(`  ${sl}`);
    }
    lines.push('');
  }

  lines.push('[/STATE]');
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD BRIEF
// ═══════════════════════════════════════════════════════════════════════════════

function buildBrief(name, state, events, rs) {
  const lines = [];
  const ug = _unifiedGender(state);
  const g = ug || (state.body.birth_sex || 'female');

  // Events this turn
  const evtList = [];
  const spell = events.spell || {};
  if ((spell.tier || 0) > 0) {
    const dir = spell.direction ? ` (${spell.direction})` : '';
    const slots = (spell.slots || []).length;
    evtList.push(`Tier ${spell.tier} spell${dir} — ${slots > 0 ? slots + ' slot(s) targeted' : 'unbound enchantment'}`);
  }
  if (events.orgasm)  evtList.push('Orgasm triggered');
  if (events.dose)    evtList.push('Corruption dose absorbed');
  if (events.collared) evtList.push('Collar applied this turn');
  if (events.branded)  evtList.push('Brand applied this turn');
  if (events.tokens?.length) evtList.push(`Tokens: ${events.tokens.join(', ')}`);

  if (evtList.length) {
    lines.push('EVENTS THIS TURN:');
    for (const e of evtList) lines.push(`  • ${e}`);
    lines.push('');
  }

  // Roll outcomes with narrative
  const rollLines = _rollFlavorLines(state, rs);
  if (rollLines.length) {
    lines.push('OUTCOMES:');
    for (const r of rollLines) lines.push(`  ${r}`);
    lines.push('');
  }

  // Interior state — fragments
  const frags = _collectFragments(state, rs, 3);
  if (frags.length) {
    lines.push('INTERIOR:');
    for (const f of frags) lines.push(`  ${f}`);
    lines.push('');
  }

  // Compulsion — hard behavioral constraint, model must honor this
  const cs = state.corruption.stage;
  if (cs >= 1) {
    const fl = _CORRUPT_COMPULSION[`${g},${cs}`];
    if (fl) {
      lines.push('COMPULSION:');
      lines.push(`  ${fl}`);
      lines.push('');
    }
  }

  if (!lines.length) return null;
  return lines.join('\n').trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS TURN
// ═══════════════════════════════════════════════════════════════════════════════

function processTurn({systemText, messages, state, personaState, config, charNameHint, personaName}) {
  const rs = config;
  if (!rs || typeof rs !== 'object') return {ok: false, error: 'no_ruleset'};

  // Extract identity
  const cardText = _cardSection(systemText || '');
  let name = extractCardName(cardText, rs);
  let sex = extractCardSex(cardText, rs);

  if (!name) {
    name = charNameHint || (state._card_name) || 'Visitor';
  }
  if (!sex) sex = state._card_sex || 'female';

  // Init state if needed
  if (!state.stats) {
    Object.assign(state, defaultState(rs));
  }

  const debug = !!(config._debug);

  // Regen detection
  const lastUser = [...(messages || [])].reverse().find(m => m.role === 'user')?.content || '';
  let h = 0;
  const s500 = lastUser.slice(0,500);
  for (let i = 0; i < s500.length; i++) { h = ((h<<5)-h) + s500.charCodeAt(i); h |= 0; }
  const hashStr = h.toString(16);
  const isRegen = hashStr === state._last_user_hash;
  if (!isRegen) {
    state.turn = (state.turn || 0) + 1;
    state._roll_results = [];
    state._last_user_hash = hashStr;
  }

  // Statgen on first turn
  if (!state.flags.statgen_done) {
    _runStatgen(state, systemText || '', rs, debug, name);
    _dbg(debug, `WORLD MOVER: ${name} enters — WIL=${state.stats.WIL} resistance=${state.resistance}`);
  }

  if (isRegen) {
    _dbg(debug, 'REGEN — skipping');
    const header = buildHeader(name, state, rs);
    return {
      ok: true, name, sex, state,
      persona_state: personaState || {},
      events: {},
      header,
      brief: null,
      systemPrompt: buildSystemPrompt(systemText || ''),
      inject: [{text: header, position: 'before_last_user'}]
    };
  }

  // Sync lifetime counters
  if (personaState && 'lifetime_orgasms' in personaState) {
    state.orgasms.lifetime = personaState.lifetime_orgasms;
    state.orgasms.forced = personaState.forced_orgasms || 0;
    state.orgasms.corruption_linked = personaState.corruption_linked || 0;
  }

  const toks = _tokens(lastUser);
  const events = {};

  // Phase 1 — ambient (skip turn 1)
  if (state.turn > 1) _applyAmbient(state, debug, rs);

  // Token processing
  if (toks.length) {
    _applyTokens(state, personaState || {}, toks, debug, rs);
    events.tokens = toks;
  }

  // Phase 2 — prose scans on last assistant message
  const lastAssistant = [...(messages || [])].reverse().find(m => m.role === 'assistant')?.content || '';
  if (lastAssistant && state.turn > 1) {
    const t = lastAssistant;

    // Arousal
    const ad = _scanArousal(t, state, debug, rs);
    if (ad) {
      state.arousal.current = _clamp(state.arousal.current + ad, state.arousal.floor, 60);
      const ab = _arousalBand(state.arousal.current);
      _triggerRoll(state, 'arousal', 'WIL', 8 + ab*2, debug);
    }

    // Spells
    const spell = _scanSpells(t, rs);
    events.spell = spell;
    if (spell.tier > 0 && spell.slots.length) {
      for (const sl of spell.slots) {
        _advanceSlot(state, sl, spell.tier, spell.instant, debug, spell.direction, t);
      }
      _triggerRoll(state, 'spell', 'CON', 8 + spell.tier*3, debug);
    } else if (spell.tier > 0) {
      state.enchantments.push({name:'working (unbound)', source:`tier${spell.tier}`, turn:state.turn, locked:spell.tier===3});
    }

    // Orgasm
    const orgasm = _kw(t, rs.orgasm_kw.primary) || _kw(t, rs.orgasm_kw.secondary);
    if (orgasm) {
      _applyOrgasm(state, debug, rs);
      events.orgasm = true;
      _triggerRoll(state, 'orgasm', 'WIL', 12, debug);
    }

    // Corruption dose
    if (_kw(t, rs.corruption_kw)) {
      _addDose(state, debug, rs);
      events.dose = true;
      _triggerRoll(state, 'dose', 'WIL', 10 + state.corruption.stage*3, debug);
    }

    // Pregnancy
    if (_kw(t, rs.pregnancy_kw)) _tryPregnancy(state, debug);
    if (state.pregnancy.pregnant) {
      if (_kw(t, rs.trimester_nudge_kw)) {
        const tri = state.pregnancy.trimester;
        if (tri < 3) state.pregnancy.trimester = tri + 1;
      }
      state.pregnancy.turns_pregnant = (state.pregnancy.turns_pregnant || 0) + 1;
      if (state.pregnancy.turns_pregnant % 10 === 0) {
        const tri = state.pregnancy.trimester;
        if (tri < 3) state.pregnancy.trimester = tri + 1;
      }
      if (_kw(t, rs.birth_kw) && state.pregnancy.trimester === 3) {
        _doBirth(state, personaState || {}, debug, rs);
      }
    }

    // Bindings from prose
    const tl = t.toLowerCase();
    if (tl.includes('collar') && !state.bindings.collared) {
      state.bindings.collared = true;
      state.submission.score = _clamp(state.submission.score + 8, 0, 100);
      const gain = _d20() >= (10 - _bonMod(state.stats.BON)) ? 10 : 5;
      state.loyalty = _clamp(state.loyalty + gain, 0, 100);
      events.collared = true;
      _triggerRoll(state, 'collar', 'BON', 10, debug);
    }
    if (tl.includes('brand') && !state.bindings.branded) {
      state.bindings.branded = true;
      state.submission.score = _clamp(state.submission.score + 8, 0, 100);
      const gain = _d20() >= (10 - _bonMod(state.stats.BON)) ? 10 : 5;
      state.loyalty = _clamp(state.loyalty + gain, 0, 100);
      events.branded = true;
      _triggerRoll(state, 'brand', 'BON', 10, debug);
    }

    // Kneeling
    if (_kw(t, rs.kneel_kw)) {
      state.submission.score = _clamp(state.submission.score + 2, 0, 100);
      _triggerRoll(state, 'kneel', 'DOM', 10, debug);
    }

    // Location
    _scanLocation(t, state, rs);

    // Phase 3 — resistance check
    if (spell.tier >= 2) {
      _resistanceCheck(state, spell.tier, !!events.orgasm, debug);
    }
  }

  // Roster tick (simplified — no DB)
  state.active_roster = state.active_roster
    .map(r => ({...r, turns_remaining: r.turns_remaining - 1}))
    .filter(r => r.turns_remaining > 0);
  if (lastAssistant) {
    for (const r of state.active_roster) {
      if (lastAssistant.toLowerCase().includes(r.name.toLowerCase())) r.turns_remaining = 3;
    }
  }

  // Phase 4 — clamp + thresholds
  state.resistance = _clamp(state.resistance, 0, 100);
  state.loyalty = _clamp(state.loyalty, 0, 100);
  state.submission.score = _clamp(state.submission.score, 0, 100);
  state.arousal.current = _clamp(state.arousal.current, state.arousal.floor, 60);
  _checkThresholds(state, debug, rs);

  // Sync back
  if (personaState) {
    personaState.lifetime_orgasms = state.orgasms.lifetime;
    personaState.forced_orgasms = state.orgasms.forced;
    personaState.corruption_linked = state.orgasms.corruption_linked;
  }

  // Build outputs
  const header = buildHeader(name, state, rs);
  const brief = buildBrief(name, state, events, rs);

  return {
    ok: true, name, sex, state,
    persona_state: personaState || {},
    events,
    header,
    brief,
    systemPrompt: buildSystemPrompt(systemText || ''),
    inject: [{text: header, position: 'before_last_user'}]
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLE RESPONSE
// ═══════════════════════════════════════════════════════════════════════════════

function handleResponse({assistantText, state, events, config}) {
  if (!assistantText) return {ok: true, state};
  const rs = config || {};
  const t = assistantText.toLowerCase();

  // Update desc for slot that changed this turn
  const spell = events?.spell || {};
  if (spell.slot && (spell.tier || 0) >= 1) {
    const slot = spell.slot;
    if (state.body.slots[slot]) {
      for (const kw of (rs.slot_keywords || {})[slot] || []) {
        const pat = new RegExp('[^.!?]*\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b[^.!?]*[.!?]', 'i');
        const m = pat.exec(assistantText);
        if (m) { state.body.desc[slot] = m[0].trim().slice(0,200); break; }
      }
    }
  }

  // Permanent language → lock slot
  if (['you are now permanently','can never be undone','sealed forever','forever changed','irreversibly'].some(ph => t.includes(ph))) {
    for (const slot of BODY_SLOTS) {
      const sd = state.body.slots[slot];
      if (sd.current !== sd.birth && !sd.locked) {
        if ((rs.slot_keywords?.[slot] || []).some(kw => t.includes(kw))) sd.locked = true;
      }
    }
  }

  // Bond language → small loyalty bump
  if (['you feel warmth','you trust','you want to please','feels safe','something shifts','wants to stay'].some(ph => t.includes(ph))) {
    state.loyalty = _clamp(state.loyalty + 2, 0, 100);
  }

  return {ok: true, state};
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG INFO
// ═══════════════════════════════════════════════════════════════════════════════

function getDebugInfo(state, events, config, personaState) {
  if (!state) return 'No state.';
  const s = state.stats || {};
  const SUB_LABELS = ['Defiant','Wavering','Yielding','Broken','Devoted'];
  const COR_LABELS = ['Clean','Touched','Fogged','Bound','Broodbound'];
  const lines = [
    `Turn: ${state.turn} | Loc: ${state.flags?.location} | Will: ${state.flags?.will_broken ? 'BROKEN' : `${state.resistance}/100`}`,
    `Stats: WIL=${s.WIL} DOM=${s.DOM} SUB=${s.SUB} BON=${s.BON} CON=${s.CON}`,
    `Arousal: ${state.arousal?.current}/60 (floor ${state.arousal?.floor})`,
    `Submission: ${state.submission?.score}/100 stage=${state.submission?.stage} [${SUB_LABELS[state.submission?.stage] || '?'}]`,
    `Corruption: doses=${state.corruption?.doses} stage=${state.corruption?.stage} [${COR_LABELS[state.corruption?.stage] || '?'}]`,
    `Loyalty: ${state.loyalty}/100 | Resistance DC: ${state.resistance_dc?.current}`,
    `Orgasms: session=${state.orgasms?.session} lifetime=${state.orgasms?.lifetime} forced=${state.orgasms?.forced}`,
    `Body: ${_isUnified(state) ? `UNIFIED (${_unifiedGender(state)})` : 'mixed'}`,
    ..._changedSlots(state).map(sl => {
      const sd = state.body.slots[sl];
      return `  ${sl}: ${sd.birth}→${sd.current}${sd.locked ? ' LOCKED' : ''}`;
    }),
    `Events: ${Object.keys(events || {}).join(', ') || 'none'}`,
    `Pregnant: ${state.pregnancy?.pregnant ? `T${state.pregnancy.trimester}` : 'no'}`,
    `Bindings: ${Object.entries(state.bindings || {}).filter(([,v])=>v).map(([k])=>k).join(', ') || 'none'}`,
    state.fate ? `Fate: ${state.fate}` : '',
    `Enchantments: ${state.enchantments?.length || 0}`
  ].filter(Boolean);
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT (compiles ruleset from lore data)
// ═══════════════════════════════════════════════════════════════════════════════

function init(loreData) {
  const rs = Object.assign({}, loreData || LORE_DATA);
  // Compile regex from card_format patterns
  const fp = rs.card_format?.field_patterns || {};
  if (fp.name) rs._card_name_re = new RegExp(fp.name, 'm');
  if (fp.sex)  rs._card_sex_re  = new RegExp(fp.sex,  'm');
  // baseline_kw is part of the ruleset used in _extractBaselines
  rs.baseline_kw = rs.baseline_kw || {
    genitals: ['sex','male','female','anatomy','penis','vagina','cock','pussy','genitals','groin','womanhood','manhood','intersex'],
    face: ['face','eyes','jaw','cheeks','lips','nose','brow','features','expression'],
    body: ['height','weight','build','chest','breasts','hips','waist','figure','frame','shape','torso','curves','thighs','ass','tall','short','slim','muscular','toned','athletic'],
    cosmetic: ['hair','skin','eye color','fur','scales','nails','complexion','hue','blonde','brunette','redhead','silver hair','white hair','black hair'],
    voice: ['voice','tone','speech','pitch','accent','soft-spoken','deep voice']
  };
  console.log(`[MASTER_WORLD] v${_VERSION} loaded`);
  return rs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  name: 'Master World',
  version: _VERSION,
  author: 'Cody',
  description: 'Lore engine for the Otherworld / Master setting. Transformation, corruption, and submission tracking.',
  data: LORE_DATA,
  init,
  processTurn,
  handleResponse,
  getDebugInfo,
};
