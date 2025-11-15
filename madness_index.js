/************************************************************
 * Madness Index v3.0 — Scoring & Prediction Engine
 * Source of truth: project Word docs (Core Traits, Breadth,
 * Resume Context Score, Interaction Metrics, Profile Marks,
 * Madness Index v3.0 master).
 *
 * No legacy rule-based logic. All scoring is:
 * - Field-normalized (z-scores)
 * - Directional (higher = better after orientation)
 * - Tier-calibrated
 ************************************************************/

// Global containers
let RAW_ROWS = [];
let TEAMS = {};          // key: team name -> team object
let FIELD_STATS = {};    // key: metric -> { mean, sd }
let TEAM_LIST = [];

// ---------- Config: Metric Aliases ----------
// Allows flexible CSV headers while mapping into canonical keys.
const ALIASES = {
  team: ['Team','TEAM','team','School','Team Name','TeamName','Team_Name','School Name','SchoolName','School_Name'],
  seed: ['Seed', 'seed'],

  // Core metrics
  offeff: ['OffEff', 'offeff', 'AdjOE', 'AdjO', 'Offensive Efficiency'],
  defeff: ['DefEff', 'defeff', 'AdjDE', 'AdjD', 'Defensive Efficiency'],
  adjem: ['AdjEM', 'adjem', 'AdjEMargin', 'AdjEMarg', 'Efficiency Margin'],
  ts: ['TS', 'TS%', 'ts', 'TS_pct', 'True Shooting %'],
  efg: ['eFG', 'eFG%', 'efg'],
  tempo: ['Tempo', 'tempo', 'Pace'],
  epr: ['EPR', 'epr', 'Effective Possession Ratio'],
  to: ['TO%', 'TOV%', 'to', 'to_pct', 'TO_pct', 'TO pct'],

  // Resume / SOS
  w: ['W', 'Wins'],
  l: ['L', 'Losses'],
  sos: ['SOS', 'sos', 'Sos'],

  // Shooting / FT / distribution
  threepr: ['3P Rate', '3P_Rate', '3PR', '3P_Att_Rate', '3PAr'],
  threepp: ['3P%', '3P', '3P_pct', '3P_Pct'],
  pct_pts_3: ['%Pts3', '%Pts from 3', 'PctPts3', '% of Points from 3'],
  pct_pts_2: ['%Pts2', '%Pts from 2', 'PctPts2', '% of Points from 2'],
  pct_pts_ft: ['%PtsFT', '%Pts from FT', 'PctPtsFT', '% of Points from FT'],
  ft_pct: ['FT%', 'FT', 'FT_pct'],

  // Opponent / defensive shooting
  opp_3pr: ['Opp3PR', 'Opp 3P Rate', 'Opp3P_Rate'],
  opp_3pp: ['Opp3P%', 'Opp 3P%', 'Opp. 3PT%', 'Opp. 3PT pct'],
  def_efg: ['Def. eFG %', 'DEFG%', 'Opp eFG%', 'Opp eFG', 'Def. eFG_pct', 'Def. eFG pct'],
  opp_2p_pct: ['Opp2P%', 'Opp 2P%'],

  // Foul / FT rate
  ftr: ['FTR', 'FT Rate', 'FTr'],
  opp_ftr: ['OppFTR', 'Opp FTR', 'Opp FT Rate'],

  // Paint & rim
  nb2: ['NB2', 'NB2%', 'NonBlock2%', 'NonBlock2P%'],
  blk: ['BLK%', 'Blk%', 'BLK', 'Block%'],

  // Turnover / pressure
  spp: ['SPP', 'StlPoss', 'Steals/poss', 'Stl%'],
  otpp: ['OTPP', 'OppTOPoss', 'Opp TO/poss', 'Opp TOV%'],

  // Rebounding / extra chances
  orb: ['ORB%', 'OR%', 'ORB'],
  drb: ['DRB%', 'DR%', 'DRB'],
  scpg: ['SCPG', 'ExtraChances', '2ndChance', '2nd Chance', 'Extra Scoring Chances/game'],

};

// Helper: normalize percent-like numbers to 0–1 range
function normalizePercentMaybe(v) {
  if (v == null || isNaN(v)) return v;
  if (v > 1.0001 && v <= 100.0) return v / 100.0;
  return v;
}

// Metrics that require field stats for z-scoring
const METRICS_FOR_Z = [
  'offeff', 'defeff', 'adjem', 'ts', 'efg', 'tempo', 'epr', 'to',
  'threepr', 'threepp', 'pct_pts_3', 'pct_pts_2', 'pct_pts_ft',
  'opp_3pr', 'opp_3pp', 'ftr', 'opp_ftr', 'ft_pct',
  'nb2', 'def_efg', 'blk',
  'spp', 'otpp',
  'orb', 'drb', 'scpg',
];

// ---------- Utility Functions ----------

function findHeaderIndex(headers, candidates) {
  for (const name of candidates) {
    const idx = headers.findIndex(h => h.trim().toLowerCase() === name.trim().toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

function getValue(row, headers, key) {
  const aliases = ALIASES[key];
  if (!aliases) return null;
  const idx = findHeaderIndex(headers, aliases);
  if (idx === -1) return null;
  const raw = row[idx];
  if (raw === undefined || raw === null || raw === '') return null;
  const v = parseFloat(raw);
  return isNaN(v) ? null : v;
}

function computeMean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function computeSD(arr, mean) {
  if (!arr.length) return 0;
  const v = arr.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / arr.length;
  return Math.sqrt(v);
}

function zScore(val, mean, sd) {
  if (val === null || val === undefined || sd === 0) return 0;
  return (val - mean) / sd;
}

// Defensive orientation: convert "lower is better" into "higher is better" BEFORE z-scoring
function orientAndZ(team, key, orientation = 'normal') {
  const fs = FIELD_STATS[key];
  if (!fs) return 0;
  let v = team[key];
  if (v === null || v === undefined) return 0;

  if (orientation === 'invert') {
    // For things like DefEff, TO%, Opp eFG% etc. when we store raw values
    v = fs.mean * 2 - v; // simple reflection around mean (works since we only need monotonic inversion)
  }

  return zScore(v, fs.mean, fs.sd);
}

// Helper: safe z on arbitrary metric with control over inversion
function getZ(team, key, inverted = false) {
  const fs = FIELD_STATS[key];
  if (!fs) return 0;
  const v = team[key];
  if (v === null || v === undefined) return 0;
  const val = inverted ? (fs.mean * 2 - v) : v;
  return zScore(val, fs.mean, fs.sd);
}

// Tier points for Core traits (used for Explain + Breadth)
function getTierPointsFromZ(z) {
  if (z >= 1.20) return 2.0;      // Elite
  if (z >= 1.00) return 1.5;      // Excellent
  if (z >= 0.80) return 1.0;      // Above Average
  if (z >= 0.50) return 0.5;      // Slightly Above Average
  return 0.0;                     // Baseline
}

// ---------- CSV Parsing & Initialization ----------
function parseCSV(text) {
  // Strip BOM if present
  if (text && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let cur = '', row = [], inQuotes = false;

  const pushCell = () => {
    // Unwrap quotes, unescape ""
    row.push(cur.replace(/^"(.*)"$/s, '$1').replace(/""/g, '"').trim());
    cur = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      pushCell();
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      pushCell();
      rows.push(row);
      row = [];
    } else {
      cur += ch;
    }
  }
  if (cur.length || row.length) { pushCell(); rows.push(row); }

  const headers = (rows.shift() || []).map(h => h.trim());
  return { headers, rows };
}

function detectTeamNameIndex(headers, rows) {
  // 1) Try exact alias matches (case-insensitive)
  const aliasIdx = findHeaderIndex(headers, ALIASES.team || ['Team']);
  if (aliasIdx !== -1) return aliasIdx;

  // 2) Try loose regex match on header text
  //    (covers things like "Team Name", "School (D1)", "TEAM/SCHOOL", etc.)
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] || '').toLowerCase().replace(/[\s_\-\/().]+/g, '');
    if (h.includes('team') || h.includes('school')) return i;
  }

  // 3) Heuristic: pick the column that looks most like names in first 30 rows
  const sampleN = Math.min(rows.length, 30);
  let bestIdx = -1, bestScore = -1;
  for (let c = 0; c < headers.length; c++) {
    let score = 0;
    for (let r = 0; r < sampleN; r++) {
      const v = (rows[r] && rows[r][c] || '').trim();
      if (!v) continue;
      const hasLetters = /[A-Za-z]/.test(v);
      const looksNumber = /^[\d.\-]+$/.test(v);
      const hasPercent = /%/.test(v);
      // reward typical team-name patterns (letters + spaces, not pure numbers/percents)
      if (hasLetters && !looksNumber && !hasPercent && v.length <= 60) score++;
      // minor bonus if it contains a space (two words like "Saint Mary’s")
      if (/\s/.test(v)) score += 0.25;
    }
    if (score > bestScore) { bestScore = score; bestIdx = c; }
  }
  return bestScore >= 5 ? bestIdx : -1;
}

// Normalize a header (trim, lowercase, strip punctuation/spaces)
function _normHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/[%]/g, 'pct')
    .replace(/[.\-_/]/g, ' ')      // dots and punctuation -> spaces
    .replace(/\s+/g, ' ')          // collapse spaces
    .trim();
}

// EXACT map for "Official MM Sheet 2.csv"
const HEADER_MAP = new Map([
  // identity
  ['team',                    'name'],
  ['seed',                    'seed'],

  // core 8
  ['off eff',                 'offeff'],
  ['def eff',                 'defeff'],
  ['efficiency margin',       'adjem'],
  ['true shooting pct',       'ts'],
  ['efg',                     'efg'],
  ['tempo',                   'tempo'],
  ['effective possession ratio','epr'],
  ['to pct',                  'to'],

  // defensive eFG
  ['def efgpct',               'def_efg'],   // for "Def. eFG%"
  ['def efg pct',              'def_efg'],   // for "Def. eFG pct" style headers

  // distribution (points share)
  ['pct of points from 2',    'pct_pts_2'],  // note: CSV header had a trailing space — normalizer strips it
  ['pct of points from 3',    'pct_pts_3'],
  ['pct of points from ft',   'pct_pts_ft'],

  // shooting + rates used by interactions
  ['3p pct',                  'threepp'],
  ['3p rate',                 'threepr'],
  ['ftr',                     'ftr'],

  // extras used in breadth / interactions / marks
  ['extra scoring chances game', 'scpg'],
  ['non blocked 2pt pct',     'nb2'],
  ['orb pct',                 'orb'],
  ['drb pct',                 'drb'],
  ['block pct',               'blk'],
  ['steals per possession',   'spp'],
  ['opp asst poss',           'opp_ast_poss'],
  ['opp to poss',             'otpp'],
  ['opp fta fga',             'opp_ftr'],
  ['opp 3pt pct',             'opp_3pp'],
  ['opp 3p rate',             'opp_3pr'],

  // résumé bits
  ['close game win pct',      'close_win_pct'],
  ['wins',                    'w'],
  ['losses',                  'l'],
  ['strength of schedule',    'sos'],
]);

// Build index: CSV header -> internal key
function makeHeaderIndex(headers) {
  const index = {};
  const normed = headers.map(_normHeader);

  normed.forEach((h, i) => {
    const key = HEADER_MAP.get(h);
    if (key) index[key] = i;
  });

  // for sanity: team/name MUST exist
  if (index.name == null) index.name = normed.indexOf('team');

  // store for debugging
  index.__raw = headers;
  index.__norm = normed;
  return index;
}

function buildTeamsFromCSV(headers, rows) {
  const H = makeHeaderIndex(headers);

  function getNum(row, key) {
    const i = H[key];
    if (i == null || i < 0) return null;
    let v = row[i];
    if (v == null || v === '') return null;
    if (typeof v === 'string') v = v.replace(/,/g,'').trim();
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function getStr(row, key) {
    const i = H[key];
    if (i == null || i < 0) return '';
    return String(row[i]).trim();
  }

  TEAMS = {};
  TEAM_LIST = [];

  for (const row of rows) {
    const team = {
      name:   getStr(row, 'name'),
      seed:   getNum(row, 'seed'),

      // core 8
      offeff: getNum(row, 'offeff'),
      defeff: getNum(row, 'defeff'),
      adjem:  getNum(row, 'adjem'),
      ts:     getNum(row, 'ts'),
      efg:    getNum(row, 'efg'),
      tempo:  getNum(row, 'tempo'),
      epr:    getNum(row, 'epr'),
      to:     getNum(row, 'to'),
      def_efg:getNum(row, 'def_efg'),

      // distribution
      pct_pts_2:  getNum(row, 'pct_pts_2'),
      pct_pts_3:  getNum(row, 'pct_pts_3'),
      pct_pts_ft: getNum(row, 'pct_pts_ft'),

      // interactions/extras
      threepp:       getNum(row, 'threepp'),
      threepr:       getNum(row, 'threepr'),
      ftr:           getNum(row, 'ftr'),
      scpg:          getNum(row, 'scpg'),
      nb2:           getNum(row, 'nb2'),
      orb:           getNum(row, 'orb'),
      drb:           getNum(row, 'drb'),
      blk:           getNum(row, 'blk'),
      spp:           getNum(row, 'spp'),
      opp_ast_poss:  getNum(row, 'opp_ast_poss'),
      otpp:          getNum(row, 'otpp'),
      opp_ftr:       getNum(row, 'opp_ftr'),
      opp_3pp:       getNum(row, 'opp_3pp'),
      opp_3pr:       getNum(row, 'opp_3pr'),

      // résumé
      close_win_pct: getNum(row, 'close_win_pct'),
      w:             getNum(row, 'w'),
      l:             getNum(row, 'l'),
      sos:           getNum(row, 'sos'),
    };

    if (!team.name) continue; // skip empties

    TEAMS[team.name] = team;
    TEAM_LIST.push(team.name);
  }

  computeFieldStats(); // your existing function
  computeAllTeamLayers();
  populateTeamDropdowns(); // your existing function
}

function computeFieldStats() {
  FIELD_STATS = {};

  METRICS_FOR_Z.forEach(key => {
    const vals = Object.values(TEAMS)
      .map(t => t[key])
      .filter(v => v !== null && v !== undefined && !isNaN(v));
    if (!vals.length) return;
    const mean = computeMean(vals);
    const sd = computeSD(vals, mean);
    FIELD_STATS[key] = { mean, sd };
  });

  // wp & P for resume / resume-pressure
  const wpArr = [];
  const pArr = [];
  const sosArr = [];

  Object.values(TEAMS).forEach(t => {
    if (t.w != null && t.l != null) {
      const total = t.w + t.l;
      if (total > 0) {
        t.wp = t.w / total;
        wpArr.push(t.wp);
      }
    }
    if (t.sos != null) {
      sosArr.push(t.sos);
    }
  });

  if (sosArr.length) {
    // Convert SOS rank/index into hardness percentile P: lower SOS -> tougher -> higher P
    const minSOS = Math.min(...sosArr);
    const maxSOS = Math.max(...sosArr);
    Object.values(TEAMS).forEach(t => {
      if (t.sos != null && maxSOS > minSOS) {
        const norm = (t.sos - minSOS) / (maxSOS - minSOS); // 0 = toughest, 1 = weakest
        t.P = 1 - norm; // 1 = toughest schedule
        pArr.push(t.P);
      }
    });
  }

  if (wpArr.length) {
    const mean = computeMean(wpArr);
    const sd = computeSD(wpArr, mean);
    FIELD_STATS.wp = { mean, sd };
  }

  if (pArr.length) {
    const mean = computeMean(pArr);
    const sd = computeSD(pArr, mean);
    FIELD_STATS.P = { mean, sd };
  }
}

// ---------- Core Metric Layer + Breadth ----------

function computeCoreForTeam(team) {
  const zOff   = getZ(team, 'offeff', false);
  const zDef   = getZ(team, 'defeff', true);  // lower DefEff better
  const zAdjEM = getZ(team, 'adjem',  false);
  const zTS    = getZ(team, 'ts',     false);
  const zEFG   = getZ(team, 'efg',    false);
  const zTempo = getZ(team, 'tempo',  false);
  const zEPR   = getZ(team, 'epr',    false);
  const zTO    = getZ(team, 'to',     true);  // lower TO% better

  team.coreZ = {
    offeff: zOff,
    defeff: zDef,
    adjem:  zAdjEM,
    ts:     zTS,
    efg:    zEFG,
    tempo:  zTempo,
    epr:    zEPR,
    to:     zTO,
  };

  // Tier points still used for Breadth
  team.coreTierPts = {};
  Object.keys(team.coreZ).forEach(k => {
    team.coreTierPts[k] = getTierPointsFromZ(team.coreZ[k]);
  });

  // Weighted composite (MIBS) — unchanged
  const mibs =
    0.30 * zOff   +
    0.25 * zDef   +
    0.15 * zEFG   +
    0.10 * zTO    +
    0.10 * zEPR   +
    0.05 * zTempo +
    0.05 * zAdjEM;
  // TS% contributes indirectly; no direct weight.

  team.mibs = mibs;

  // ---------- Per-stat rows for the Core Traits table ----------
  const fsOff   = FIELD_STATS.offeff || {};
  const fsDef   = FIELD_STATS.defeff || {};
  const fsAdjEM = FIELD_STATS.adjem  || {};
  const fsTS    = FIELD_STATS.ts     || {};
  const fsEFG   = FIELD_STATS.efg    || {};
  const fsTempo = FIELD_STATS.tempo  || {};
  const fsEPR   = FIELD_STATS.epr    || {};
  const fsTO    = FIELD_STATS.to     || {};

  const L = getTierLabelFromZ;

  team.coreDetails = [
    {
      key:   'offeff',
      label: 'Offensive Efficiency',
      mean:  fsOff.mean,
      sd:    fsOff.sd,
      value: team.offeff,
      z:     zOff,
      tier:  L(zOff),
      points: 0.30 * zOff,
    },
    {
      key:   'defeff',
      label: 'Defensive Efficiency',
      mean:  fsDef.mean,
      sd:    fsDef.sd,
      value: team.defeff,
      z:     zDef,
      tier:  L(zDef),
      points: 0.25 * zDef,
    },
    {
      key:   'adjem',
      label: 'Efficiency Margin',
      mean:  fsAdjEM.mean,
      sd:    fsAdjEM.sd,
      value: team.adjem,
      z:     zAdjEM,
      tier:  L(zAdjEM),
      points: 0.05 * zAdjEM,
    },
    {
      key:   'ts',
      label: 'True Shooting %',
      mean:  fsTS.mean,
      sd:    fsTS.sd,
      value: team.ts,
      z:     zTS,
      tier:  L(zTS),
      points: 0.00 * zTS,
    },
    {
      key:   'efg',
      label: 'Effective FG %',
      mean:  fsEFG.mean,
      sd:    fsEFG.sd,
      value: team.efg,
      z:     zEFG,
      tier:  L(zEFG),
      points: 0.15 * zEFG,
    },
    {
      key:   'tempo',
      label: 'Tempo',
      mean:  fsTempo.mean,
      sd:    fsTempo.sd,
      value: team.tempo,
      z:     zTempo,
      tier:  L(zTempo),
      points: 0.05 * zTempo,
    },
    {
      key:   'epr',
      label: 'Effective Possession Ratio (EPR)',
      mean:  fsEPR.mean,
      sd:    fsEPR.sd,
      value: team.epr,
      z:     zEPR,
      tier:  L(zEPR),
      points: 0.10 * zEPR,
    },
    {
      key:   'to',
      label: 'Turnover %',
      mean:  fsTO.mean,
      sd:    fsTO.sd,
      value: team.to,
      z:     zTO,
      tier:  L(zTO),
      points: 0.10 * zTO,
    },
  ];
}

// Tier labels for UI only (does NOT affect scoring)
function getTierLabelFromZ(z) {
  if (z >= 1.50) return 'Elite';
  if (z >= 0.75) return 'Strong';
  if (z >= 0.25) return 'Above Average';
  if (z > -0.25) return 'Average';
  if (z > -0.75) return 'Weak';
  return 'Fragile';
}

function computeBreadthForTeam(team) {
  const tp = team.coreTierPts;

  // A "hit" is z >= 0.60 (Above Avg or better in spirit)
  const isHit = (z) => z >= 0.60;

  const z = team.coreZ;

  // Efficiency Trio: OffEff, -DefEff, AdjEM
  let effHits = 0;
  if (isHit(z.offeff)) effHits++;
  if (isHit(z.defeff)) effHits++;
  if (isHit(z.adjem))  effHits++;
  let effBonus = 0;
  if (effHits === 1) effBonus = 0.10;
  else if (effHits === 2) effBonus = 0.20;
  else if (effHits === 3) effBonus = 0.25;

  // Shooting Pair: TS%, eFG%
  let shootHits = 0;
  if (isHit(z.ts))  shootHits++;
  if (isHit(z.efg)) shootHits++;
  let shootBonus = 0;
  if (shootHits === 1) shootBonus = 0.15;
  else if (shootHits === 2) shootBonus = 0.25;

  // Possession Pair: EPR, -TO%
  let possHits = 0;
  if (isHit(z.epr)) possHits++;
  if (isHit(z.to))  possHits++; // already inverted in z
  let possBonus = 0;
  if (possHits === 1) possBonus = 0.15;
  else if (possHits === 2) possBonus = 0.25;

  // Tempo Solo
  let tempoBonus = 0;
  const tempoHit = isHit(z.tempo) ? 1 : 0;
  if (tempoHit) tempoBonus = 0.25;

  const breadth = effBonus + shootBonus + possBonus + tempoBonus;
  team.breadth = breadth;                 // BreadthWeight = 1.00
  team.breadthHits = effHits + shootHits + possHits + tempoHit;
}

// ---------- Neutral Modifier #1 — Résumé Context Score (R) ----------

function computeResumeContextForTeam(team) {
  if (!FIELD_STATS.wp || !FIELD_STATS.P || team.wp == null || team.P == null) {
    team.resumeR = 0;
    team.resumeRTier = 'Average';
    return;
  }

  const z_wp = zScore(team.wp, FIELD_STATS.wp.mean, FIELD_STATS.wp.sd || 0.00001);
  const z_P = zScore(team.P, FIELD_STATS.P.mean, FIELD_STATS.P.sd || 0.00001);
  const R = (z_wp + z_P) / 2;

  let adj = 0;
  let tier = 'Average';

  if (R >= 1.00) {
    adj = 0.15; tier = 'Elite';
  } else if (R >= 0.60) {
    adj = 0.10; tier = 'Strong';
  } else if (R >= 0.20) {
    adj = 0.05; tier = 'Above Average';
  } else if (R <= -0.60) {
    adj = -0.10; tier = 'Fragile';
  } else if (R <= -0.20) {
    adj = -0.05; tier = 'Weak';
  }

  team.resumeR = adj;
  team.resumeRTier = tier;
}

// ---------- Interaction Metrics (Directional, Tiered, Half-Mirrored) ----------
// expects: getZ(team, key, invert=false), FIELD_STATS with wp/P for resume
// note: 3P keys = threepr (rate), threepp (pct); Glass uses scpg (extra scoring chances)

// Tier map used by all half-mirrored interactions
function halfMirroredAdjust(gap) {
  const mag = Math.abs(gap);
  if (mag < 0.50) return 0;
  if (mag < 1.00) return 0.25;
  return 0.50;
}

// Shared interaction accumulator (reset in computeInteractions)
let __INT = { a: 0, b: 0, breakdown: {} };

// Small helpers to apply mirrored adjustments and record a breakdown entry
function _applyToA(base, tag) {
  if (!base) return;
  __INT.a += base;
  __INT.b -= base;
  __INT.breakdown[tag] = (__INT.breakdown[tag] || 0) + base;
}
function _applyToB(base, tag) {
  if (!base) return;
  __INT.b += base;
  __INT.a -= base;
  __INT.breakdown[tag] = (__INT.breakdown[tag] || 0) - base;
}

/* 1) 3PT Tension */
function interaction3PT(a, b) {
  const offA = (getZ(a, 'threepr') + getZ(a, 'threepp') + getZ(a, 'pct_pts_3')) / 3;
  const offB = (getZ(b, 'threepr') + getZ(b, 'threepp') + getZ(b, 'pct_pts_3')) / 3;

  // Defensive perimeter resistance (invert: lower opp values = stronger defense)
  const defA = (getZ(a, 'opp_3pr', true) + getZ(a, 'opp_3pp', true)) / 2;
  const defB = (getZ(b, 'opp_3pr', true) + getZ(b, 'opp_3pp', true)) / 2;

  const gapA = offA - defB; // A offense vs B perimeter D
  const gapB = offB - defA; // B offense vs A perimeter D

  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (gapA > 0) _applyToA(base, '3pt'); else _applyToB(base, '3pt');
  } else {
    const base = halfMirroredAdjust(gapB);
    if (gapB > 0) _applyToB(base, '3pt'); else _applyToA(base, '3pt');
  }
}

/* 2) Free Throw Reliance (with FT% throttle) */
function interactionFT(a, b) {
  const gap = (a.ftr ?? 0) - (b.ftr ?? 0);
  let base = 0.25;
  const amag = Math.abs(gap);
  if (amag > 0.04) base = 0.50;
  if (amag < 0.02) base = 0;

  // Throttle by the FT% of the advantaged team (if present)
  function throttle(baseIn, ft) {
    if (ft == null) return baseIn;           // no FT% provided → no throttle
    if (ft < 0.70) return 0;                 // poor FT negates advantage
    if (ft < 0.75) return baseIn === 0.50 ? 0.25 : baseIn; // trim big edge
    return baseIn;
  }

  if (base === 0) return;

  if (gap > 0) {
    base = throttle(base, a.ft_pct);
    if (base) _applyToA(base, 'ft');
  } else if (gap < 0) {
    base = throttle(base, b.ft_pct);
    if (base) _applyToB(base, 'ft');
  }
}

/* 3) Paint Presence (2P profile vs rim protection) */
function interactionPaint(a, b) {
  const offA = (getZ(a, 'pct_pts_2') + getZ(a, 'nb2')) / 2;
  const offB = (getZ(b, 'pct_pts_2') + getZ(b, 'nb2')) / 2;

  // Rim protection: invert def_efg (lower = better), blk is normal
  const rimDefA = (getZ(a, 'def_efg', true) + getZ(a, 'blk')) / 2;
  const rimDefB = (getZ(b, 'def_efg', true) + getZ(b, 'blk')) / 2;

  const gapA = offA - rimDefB;
  const gapB = offB - rimDefA;

  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (gapA > 0) _applyToA(base, 'paint'); else _applyToB(base, 'paint');
  } else {
    const base = halfMirroredAdjust(gapB);
    if (gapB > 0) _applyToB(base, 'paint'); else _applyToA(base, 'paint');
  }
}

/* 4) Turnover Creation (pressure vs ball security) */
function interactionTO(a, b) {
  const pressA = (getZ(a, 'spp') + getZ(a, 'otpp')) / 2;  // higher = more chaos
  const pressB = (getZ(b, 'spp') + getZ(b, 'otpp')) / 2;

  const secA = getZ(a, 'to', true); // invert TO% so higher = safer
  const secB = getZ(b, 'to', true);

  const gapA = pressA - secB; // A defense vs B offense
  const gapB = pressB - secA; // B defense vs A offense

  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (gapA > 0) _applyToA(base, 'to'); else _applyToB(base, 'to');
  } else {
    const base = halfMirroredAdjust(gapB);
    if (gapB > 0) _applyToB(base, 'to'); else _applyToA(base, 'to');
  }
}

/* 5) Possession Manager (second chances vs denial) */
function interactionGlass(a, b) {
  // Use 'scpg' for extra scoring chances per game
  const offGlassA = (getZ(a, 'orb') + getZ(a, 'scpg')) / 2;
  const offGlassB = (getZ(b, 'orb') + getZ(b, 'scpg')) / 2;
  const defGlassA = getZ(a, 'drb');
  const defGlassB = getZ(b, 'drb');

  const gapA = offGlassA - defGlassB;
  const gapB = offGlassB - defGlassA;

  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (gapA > 0) _applyToA(base, 'glass'); else _applyToB(base, 'glass');
  } else {
    const base = halfMirroredAdjust(gapB);
    if (gapB > 0) _applyToB(base, 'glass'); else _applyToA(base, 'glass');
  }
}

/* 6) Resume Pressure (matchup version) */
function interactionResume(a, b) {
  if (!FIELD_STATS.wp || !FIELD_STATS.P || a.wp == null || b.wp == null || a.P == null || b.P == null) return;

  const z_wp_a = zScore(a.wp, FIELD_STATS.wp.mean, FIELD_STATS.wp.sd || 1e-5);
  const z_P_a  = zScore(a.P,  FIELD_STATS.P.mean,  FIELD_STATS.P.sd  || 1e-5);
  const idxA   = (z_wp_a + z_P_a) / 2;

  const z_wp_b = zScore(b.wp, FIELD_STATS.wp.mean, FIELD_STATS.wp.sd || 1e-5);
  const z_P_b  = zScore(b.P,  FIELD_STATS.P.mean,  FIELD_STATS.P.sd  || 1e-5);
  const idxB   = (z_wp_b + z_P_b) / 2;

  const gap = idxA - idxB;
  const base = halfMirroredAdjust(gap);
  if (gap > 0) _applyToA(base, 'resume'); else if (gap < 0) _applyToB(base, 'resume');
}

/* Bundle all interactions */
function computeInteractions(a, b) {
  __INT = { a: 0, b: 0, breakdown: {} }; // reset

  interaction3PT(a, b);
  interactionFT(a, b);
  interactionPaint(a, b);
  interactionTO(a, b);
  interactionGlass(a, b);
  interactionResume(a, b);

  return { a: __INT.a, b: __INT.b, breakdown: __INT.breakdown };
}

// ---------- Profile Marks (Diagnostic Only) ----------

function computeProfileMarks(team) {
  const marks = [];

  // 1. Offensive Rigidity
  const s2 = team.pct_pts_2 || 0;
  const s3 = team.pct_pts_3 || 0;
  const sft = team.pct_pts_ft || 0;
  const primaryShare = Math.max(s2, s3, sft);
  const primary = (primaryShare === s2) ? '2P' : (primaryShare === s3 ? '3P' : 'FT');

  let planBZs = [];
  if (primaryShare >= 0.50) {
    if (primary === '2P') {
      planBZs.push(getZ(team, 'threepp'));
      planBZs.push(getZ(team, 'ft_pct'));
    } else if (primary === '3P') {
      planBZs.push(getZ(team, 'nb2'));
      planBZs.push(getZ(team, 'ft_pct'));
    } else {
      planBZs.push(getZ(team, 'nb2'));
      planBZs.push(getZ(team, 'threepp'));
    }
    const planB = (planBZs[0] + planBZs[1]) / 2;
    if (primaryShare >= 0.55 && planB <= -0.50) {
      marks.push('Offensive Rigidity — Severe');
    } else if (planB <= -0.25) {
      marks.push('Offensive Rigidity — Moderate');
    }
  }

  // 2. Unstable Perimeter Profile
  if (team.threepr != null && team.threepp != null) {
    const vol = team.threepr;
    const acc = team.threepp;
    const gap = Math.abs(vol - acc);
    if (vol >= 0.40) {
      if (gap >= 0.10) marks.push('Unstable Perimeter Profile — Severe');
      else if (gap >= 0.06) marks.push('Unstable Perimeter Profile — Moderate');
    }
  }

  // 3. Cold Arc Team
  if (FIELD_STATS.threepp && team.threepp != null) {
    const z = getZ(team, 'threepp');
    if (z < -0.67) marks.push('Cold Arc Team — Severe');
    else if (z < 0 && z >= -0.67) marks.push('Cold Arc Team — Moderate');
  }

  // 4. Undisciplined Defense
  if (FIELD_STATS.spp && FIELD_STATS.otpp && FIELD_STATS.opp_ftr && team.spp != null && team.otpp != null && team.opp_ftr != null) {
    const pressure = getZ(team, 'spp') + getZ(team, 'otpp');
    const discipline = -getZ(team, 'opp_ftr'); // higher OppFTR = worse discipline
    const disorder = pressure - discipline;
    if (disorder >= 1.00) marks.push('Undisciplined Defense — Severe');
    else if (disorder >= 0.50) marks.push('Undisciplined Defense — Moderate');
  }

  // 5. Soft Interior
  if (FIELD_STATS.def_efg && FIELD_STATS.blk && team.def_efg != null && team.blk != null) {
    const resistance = (-getZ(team, 'def_efg') + getZ(team, 'blk')) / 2;
    if (resistance < -0.75) marks.push('Soft Interior — Severe');
    else if (resistance < -0.25) marks.push('Soft Interior — Moderate');
  }

  // 6. Perimeter Leakage
  if (FIELD_STATS.opp_3pr && FIELD_STATS.opp_3pp && team.opp_3pr != null && team.opp_3pp != null) {
    const exposure = getZ(team, 'opp_3pr') + getZ(team, 'opp_3pp');
    if (exposure >= 1.00) marks.push('Perimeter Leakage — Severe');
    else if (exposure >= 0.50) marks.push('Perimeter Leakage — Moderate');
  }

  // 7. Erratic Tempo
  if (FIELD_STATS.tempo && FIELD_STATS.adjem && team.tempo != null && team.adjem != null) {
    const zTempo = getZ(team, 'tempo');
    const zAdj = getZ(team, 'adjem');
    const mismatch = Math.abs(zTempo) - zAdj;
    if (mismatch >= 1.00) marks.push('Erratic Tempo — Severe');
    else if (mismatch >= 0.50) marks.push('Erratic Tempo — Moderate');
  }

  // 8. Turnover Fragility
  if (FIELD_STATS.to && FIELD_STATS.epr && team.to != null && team.epr != null) {
    const stability = (-getZ(team, 'to') + getZ(team, 'epr')) / 2;
    const frag = -stability;
    if (frag >= 1.00) marks.push('Turnover Fragility — Severe');
    else if (frag >= 0.50) marks.push('Turnover Fragility — Moderate');
  }

  team.profileMarks = marks;
}

// ---------- Full Team Layer Computation ----------

function computeAllTeamLayers() {
  Object.values(TEAMS).forEach(team => {
    computeCoreForTeam(team);
    computeBreadthForTeam(team);
    computeResumeContextForTeam(team);
    computeProfileMarks(team);
  });
}

// ---------- Final Madness Index & Matchup ----------

function computeFinalMI(team, interactionAdj) {
  return team.mibs + team.breadth + team.resumeR + interactionAdj;
}

function getTeamByName(name) {
  return TEAMS[name] || null;
}

// Main matchup function
function compareTeams(teamAName, teamBName) {
  const a = getTeamByName(teamAName);
  const b = getTeamByName(teamBName);

  if (!a || !b) {
    console.error('Invalid team selection:', teamAName, teamBName);
    return;
  }

  // Interactions first
  const interactions = computeInteractions(a, b);

  // Final MI = MIBS + Breadth + ResumeR + interaction adj
  const miA = computeFinalMI(a, interactions.a);
  const miB = computeFinalMI(b, interactions.b);

  const diff = miA - miB;
  const predicted = diff > 0 ? a.name : (diff < 0 ? b.name : 'Push');

  const result = { a, b, miA, miB, diff, predicted, interactions };

  // Save for debugging in console
  window.LAST_RESULT = result;

  // Render UI
  renderTeamCards(result);          // Core traits + neutral subtotals
  renderProfileMarks(a, "inlineMarksA");  // inline tile under Résumé (Team A)  
  renderProfileMarks(b, "inlineMarksB");  // inline tile under Résumé (Team B)
  renderProfileMarks(a, "marksA");  // Team A profile badges
  renderProfileMarks(b, "marksB");  // Team B profile badges
  renderInteractionsTable(result);  // New interaction table
  renderSummary(result);            // Final MI summary (last card)

  console.log(result);
  return result;
}

// ---------- DOM Hooks ----------

function populateTeamDropdowns() {
  const selectA =
    document.getElementById('teamA') ||
    document.getElementById('teamASelect') ||
    document.getElementById('cindTeamSelect');
  const selectB =
    document.getElementById('teamB') ||
    document.getElementById('teamBSelect') ||
    document.getElementById('favTeamSelect');

  if (!selectA || !selectB) return;

  selectA.innerHTML = '';
  selectB.innerHTML = '';

  TEAM_LIST.sort().forEach(name => {
    const optA = document.createElement('option');
    optA.value = name;
    optA.textContent = name;
    selectA.appendChild(optA);

    const optB = document.createElement('option');
    optB.value = name;
    optB.textContent = name;
    selectB.appendChild(optB);
  });
}

function renderSummary({ a, b, miA, miB, diff, predicted, interactions }) {
  const el = document.getElementById('summaryContent');
  if (!el) return;

  const lean =
    diff > 0 ? `${a.name} lean` :
    diff < 0 ? `${b.name} lean` : 'Even';

  el.innerHTML = `
    <div class="summary-col">
      <div class="team-name">${a.name}</div>
      <div class="mi-score">MI: ${miA.toFixed(3)}</div>
    </div>
    <div class="summary-col center">
      <div class="diff">Δ: ${diff.toFixed(3)}</div>
      <div class="pred">Predicted: <strong>${predicted}</strong></div>
      <div class="lean">${lean}</div>
    </div>
    <div class="summary-col">
      <div class="team-name">${b.name}</div>
      <div class="mi-score">MI: ${miB.toFixed(3)}</div>
    </div>
  `;

  // New: also fill the little text rows
  const miASpan = document.getElementById('miA');
  const miBSpan = document.getElementById('miB');
  const predSpan = document.getElementById('predictedWinner');

  if (miASpan) miASpan.textContent = miA.toFixed(3);
  if (miBSpan) miBSpan.textContent = miB.toFixed(3);
  if (predSpan) predSpan.textContent = predicted;

  const summarySection = document.getElementById('summarySection');
  if (summarySection) {
    summarySection.classList.add('visible');
  }
}

function renderInteractionsTable(result) {
  const table = document.getElementById('interactionsTable');
  if (!table) return;

  const labels = {
    '3pt':   '3PT Tension',
    'ft':    'FT Pressure',
    'paint': 'Paint Tension',
    'to':    'Turnover Pressure',
    'glass': 'Glass Tension',
    'resume': 'Résumé Pressure',
  };

  const breakdown = result.interactions?.breakdown || {};

  const header = `
    <thead>
      <tr>
        <th>Interaction</th>
        <th>Adj to Team A</th>
        <th>Adj to Team B</th>
      </tr>
    </thead>
  `;

  const rows = Object.entries(labels).map(([key, label]) => {
    const val = breakdown[key] || 0;
    const aAdj = val;
    const bAdj = -val;
    return `
      <tr>
        <td>${label}</td>
        <td>${fmt(aAdj, 3)}</td>
        <td>${fmt(bAdj, 3)}</td>
      </tr>
    `;
  }).join('');

  const totalA = result.interactions?.a || 0;
  const totalB = result.interactions?.b || 0;

  const totalsRow = `
    <tr class="breadth-row">
      <td><strong>Total Interaction Leverage</strong></td>
      <td><strong>${fmt(totalA, 3)}</strong></td>
      <td><strong>${fmt(totalB, 3)}</strong></td>
    </tr>
  `;

  table.innerHTML = header + rows + totalsRow;
}

// ========== RENDER PROFILE MARK BADGES ==========
function renderProfileMarks(team, containerId) {
  const el = document.getElementById(containerId);
  if (!el || !team || !Array.isArray(team.profileMarks)) return;

  el.innerHTML = '';

  const BADGE_MAP = {
    "Offensive Rigidity — Moderate": "badge_offensive_rigidity_moderate.svg",
    "Offensive Rigidity — Severe":   "badge_offensive_rigidity_severe.svg",

    "Unstable Perimeter Profile — Moderate": "badge_unstable_perimeter_moderate.svg",
    "Unstable Perimeter Profile — Severe":   "badge_unstable_perimeter_severe.svg",

    "Cold Arc Team — Moderate": "badge_cold_arc_moderate.svg",
    "Cold Arc Team — Severe":   "badge_cold_arc_severe.svg",

    "Undisciplined Defense — Moderate": "badge_undisciplined_defense_moderate.svg",
    "Undisciplined Defense — Severe":   "badge_undisciplined_defense_severe.svg",

    "Soft Interior — Moderate": "badge_soft_interior_moderate.svg",
    "Soft Interior — Severe":   "badge_soft_interior_severe.svg",

    "Perimeter Leakage — Moderate": "badge_perimeter_leakage_moderate.svg",
    "Perimeter Leakage — Severe":   "badge_perimeter_leakage_severe.svg",

    "Erratic Tempo — Moderate": "badge_erratic_tempo_moderate.svg",
    "Erratic Tempo — Severe":   "badge_erratic_tempo_severe.svg",

    "Turnover Fragility — Moderate": "badge_turnover_fragility_moderate.svg",
    "Turnover Fragility — Severe":   "badge_turnover_fragility_severe.svg",
  };

  team.profileMarks.forEach(mark => {
    const filename = BADGE_MAP[mark];
    if (!filename) return;
    const img = document.createElement('img');
    img.src = filename;
    img.className = 'mark-badge';
    img.title = mark;
    el.appendChild(img);
  });
}

// ========== SMALL HELPERS FOR RENDERING ==========

function fmt(val, digits) {
  if (val === null || val === undefined || isNaN(val)) return '—';
  return Number(val).toFixed(digits);
}

function renderCoreProfileTable(team, tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;

  const rows = team.coreDetails || [];
  if (!rows.length) {
    table.innerHTML = '<tr><td colspan="5">No core trait data.</td></tr>';
    return;
  }

  const header = `
    <tr class="table-header">
      <th>Category</th>
      <th>Thresholds</th>
      <th>Team Value</th>
      <th>Tier</th>
      <th>Points Given</th>
    </tr>
  `;

  const body = rows.map(r => `
    <tr>
      <td>${r.label}</td>
      <td>Mean = ${fmt(r.mean, 3)}<br/>SD = ${fmt(r.sd, 3)}</td>
      <td>${fmt(r.value, 3)}</td>
      <td>${r.tier}</td>
      <td>${fmt(r.points, 3)}</td>
    </tr>
  `).join('');

  const hits    = team.breadthHits != null ? team.breadthHits : 0;
  const breadth = team.breadth     != null ? team.breadth     : 0;

  const breadthRow = `
    <tr class="breadth-row">
      <td>Breadth Bonus</td>
      <td>
        Bonus scales with total "hits"<br/>
        across Efficiency, Shooting, Possession, Tempo
      </td>
      <td>${hits} hits</td>
      <td>Tier placement skipped</td>
      <td>${fmt(breadth, 3)}</td>
    </tr>
  `;

  table.innerHTML = header + body + breadthRow;
}

function renderNeutralTable(team, mi, interactionsTotal, tableId, subtotalSpanId) {
  const table = document.getElementById(tableId);
  const subtotalSpan = document.getElementById(subtotalSpanId);
  if (!table || !subtotalSpan) return;

  const core    = team.mibs    || 0;
  const breadth = team.breadth || 0;
  const resume  = team.resumeR || 0;

  // interactionAdj = whatever is left after core + breadth + resume
  const interactionAdj = (mi || 0) - (core + breadth + resume);

  // Use the explicit interactions.a / interactions.b if available for display
  const shownInt = (interactionsTotal != null ? interactionsTotal : interactionAdj);

  const neutralSubtotal = resume + interactionAdj;

  table.innerHTML = `
    <tr class="table-header">
      <th>Category</th>
      <th>Thresholds</th>
      <th>Team Value</th>
      <th>Tier</th>
      <th>Points Given</th>
    </tr>
    <tr>
      <td>Résumé Context (R)</td>
      <td>Field-relative W/L &amp; Schedule</td>
      <td>${fmt(resume, 3)}</td>
      <td>${resume >= 0 ? 'Favorable' : 'Skeptical'}</td>
      <td>${fmt(resume, 3)}</td>
    </tr>
    <tr>
      <td>Interaction Metrics</td>
      <td>3P, FT, Paint, TO, Glass, Résumé Pressure</td>
      <td>${fmt(shownInt, 3)}</td>
      <td>${interactionAdj >= 0 ? 'Leverage' : 'Headwind'}</td>
      <td>${fmt(interactionAdj, 3)}</td>
    </tr>
  `;

  subtotalSpan.textContent = fmt(neutralSubtotal, 3);
}

function renderTeamSide(side, result) {
  const isA   = side === 'A';
  const team  = isA ? result.a   : result.b;
  const mi    = isA ? result.miA : result.miB;
  const intTot= isA ? result.interactions.a : result.interactions.b;

  if (!team) return;

  const titleEl           = document.getElementById(isA ? 'teamATitle'    : 'teamBTitle');
  const seedEl            = document.getElementById(isA ? 'teamASeed'     : 'teamBSeed');
  const profileSubtotalEl = document.getElementById(isA ? 'cindSubtotalA' : 'favSubtotalB');
  const teamTotalEl       = document.getElementById(isA ? 'teamTotalA'    : 'teamTotalB');
  const coreTableId       = isA ? 'cindProfileTableA' : 'favProfileTableB';
  const neutralTableId    = isA ? 'neutralTableA'     : 'neutralTableB';
  const neutralSubtotalId = isA ? 'neutralSubtotalA'  : 'neutralSubtotalB';

  const core    = team.mibs    || 0;
  const breadth = team.breadth || 0;
  const resume  = team.resumeR || 0;

  const profileSubtotal = core + breadth;
  const total           = mi || 0;

  if (titleEl)           titleEl.textContent           = team.name || (isA ? 'Team A' : 'Team B');
  if (seedEl)            seedEl.textContent            = (team.seed != null && team.seed !== '') ? `Seed ${team.seed}` : '';
  if (profileSubtotalEl) profileSubtotalEl.textContent = fmt(profileSubtotal, 3);
  if (teamTotalEl)       teamTotalEl.textContent       = fmt(total, 3);

  // Résumé context mini-tile
  const resumeTile   = document.getElementById(isA ? 'resumeTileA' : 'resumeTileB');
  const resumeAdjEl  = document.getElementById(isA ? 'resumeAdjA'  : 'resumeAdjB');
  const resumeTierEl = document.getElementById(isA ? 'resumeTierA' : 'resumeTierB');

  if (resumeTile && resumeAdjEl && resumeTierEl) {
    resumeAdjEl.textContent = fmt(resume, 3);

    const tier = team.resumeRTier ||
      (resume >= 0.10 ? 'Strong' :
       resume >= 0.05 ? 'Above Average' :
       resume <= -0.10 ? 'Fragile' :
       resume <= -0.05 ? 'Weak' : 'Average');

    resumeTierEl.textContent = tier;

    resumeTile.classList.remove('context-positive', 'context-negative', 'context-neutral');

    let stateClass = 'context-neutral';
    if (resume > 0.0001) stateClass = 'context-positive';
    else if (resume < -0.0001) stateClass = 'context-negative';

    resumeTile.classList.add(stateClass);
  }

  // Core Traits big table
  renderCoreProfileTable(team, coreTableId);

  // Neutral Modifiers table (Résumé + Interactions)
  renderNeutralTable(team, mi, intTot, neutralTableId, neutralSubtotalId);
}

function renderTeamCards(result) {
  renderTeamSide('A', result);
  renderTeamSide('B', result);
}

// ========== EVENT WIRING & DOM READY ==========

function setupEventListeners() {
  // ---- CSV upload ----
  const fileInput =
    document.getElementById('csvFile') ||
    document.getElementById('csvUpload') ||
    document.getElementById('dataFile') ||
    document.querySelector('input[type="file"]');

  const statusEl = document.getElementById('status');

  if (!fileInput) {
    console.warn('[MI] No file input found.');
    if (statusEl) {
      statusEl.className = 'status error';
      statusEl.textContent = 'No file input found in HTML.';
    }
  } else {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const { headers, rows } = parseCSV(ev.target.result);
          console.log('[MI] CSV headers:', headers);
          console.log('[MI] First data row:', rows[0]);

          buildTeamsFromCSV(headers, rows);

          const count = (TEAM_LIST || []).length;
          console.log('[MI] Teams parsed:', count);

          if (statusEl) {
            if (count > 0) {
              statusEl.className = 'status ok';
              statusEl.textContent = `Loaded ${count} teams`;
            } else {
              statusEl.className = 'status warn';
              statusEl.textContent = 'CSV parsed, but 0 teams detected. Check the Team column header.';
            }
          }
        } catch (err) {
          console.error('[MI] CSV parse error:', err);
          if (statusEl) {
            statusEl.className = 'status error';
            statusEl.textContent = `CSV parse error: ${err.message}`;
          }
        }
      };
      reader.readAsText(file);
    });
  }

  // ---- Compare button ----
  const compareBtn =
    document.getElementById('compareBtn') ||
    document.getElementById('runCompare');

  if (compareBtn) {
    compareBtn.addEventListener('click', () => {
      const selectA =
        document.getElementById('teamA') ||
        document.getElementById('teamASelect') ||
        document.getElementById('cindTeamSelect');

      const selectB =
        document.getElementById('teamB') ||
        document.getElementById('teamBSelect') ||
        document.getElementById('favTeamSelect');

      if (!selectA?.value || !selectB?.value) return;

      console.log('[MI] Compare click:', { teamA: selectA.value, teamB: selectB.value });
      compareTeams(selectA.value, selectB.value);
    });
  }

  // ---- Swap Teams button ----
  const swapBtn = document.getElementById('swapBtn');
  if (swapBtn) {
    swapBtn.addEventListener('click', () => {
      const A =
        document.getElementById('teamA') ||
        document.getElementById('teamASelect') ||
        document.getElementById('cindTeamSelect');

      const B =
        document.getElementById('teamB') ||
        document.getElementById('teamBSelect') ||
        document.getElementById('favTeamSelect');

      if (!A || !B) return;
      const tmp = A.value;
      A.value = B.value;
      B.value = tmp;
    });
  }

  // ---- Debug toggle button ----
  const toggleDebugBtn = document.getElementById('toggleDebugBtn');
  if (toggleDebugBtn) {
    toggleDebugBtn.addEventListener('click', () => {
      const panel = document.getElementById('debugPanel');
      if (!panel) return;
      panel.classList.toggle('hidden');

      const dc = document.getElementById('debugContent');
      if (dc) {
        dc.textContent = JSON.stringify(
          { TEAMS: TEAMS, FIELD_STATS: FIELD_STATS },
          null,
          2
        );
      }
    });
  }

  // ---- Badge Legend collapsible toggle ----
  const badgeCard    = document.getElementById('badgeKeyCard');
  const badgeContent = document.getElementById('badgeKeyContent');
  const badgeToggle  = document.getElementById('toggleBadgeKey');

  if (badgeCard && badgeContent && badgeToggle) {
    badgeToggle.addEventListener('click', () => {
      const collapsed = badgeCard.classList.toggle('collapsed');
      badgeToggle.textContent = collapsed ? 'Show Legend' : 'Hide Legend';
    });
  }
}

// ---- ONE dom-ready block (outside the function) ----
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupEventListeners);
} else {
  setupEventListeners();
}
