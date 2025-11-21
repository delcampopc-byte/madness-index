/************************************************************
 * Madness Index v3.2 — Scoring & Prediction Engine
 * Source of truth: project Word docs (Core Traits, Breadth,
 * Resume Context Score, Interaction Metrics, Profile Marks,
 * Madness Index v3.2 master).
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
let CURRENT_ROUND = null;
let SANDBOX_MODE = false;

// ========== SEED / BRACKET LOGIC HELPERS ==========
//
// We treat seeds 1–16 as if they belong to the standard NCAA region structure:
//
//  Pod A (top-top):    {1, 16, 8, 9}
//  Pod B (top-bottom): {5, 12, 4, 13}
//  Pod C (bot-top):    {6, 11, 3, 14}
//  Pod D (bot-bottom): {7, 10, 2, 15}
//
// Within a single region, two seeds have a uniquely-defined meeting round:
//   - R64: same first-round game
//   - R32: same pod but not direct R64
//   - S16: different pods, same half (A↔B or C↔D)
//   - E8:  different halves (A/B vs C/D)
//
// Across different regions, any pair of seeds can only meet in:
//   - Final Four (F4)
//   - Championship (Champ)
//
// For *distinct* seeds, both "same region" and "different region" layouts
// are possible across different years, so the possible rounds are:
//   { intra-region round } ∪ { F4, Champ }.
// For *equal* seeds (e.g., 1 vs 1), they can never share a region
// (only one #1 per region), so only { F4, Champ } are possible.

const R64_PAIRINGS = [
  [1, 16], [8, 9],
  [5, 12], [4, 13],
  [6, 11], [3, 14],
  [7, 10], [2, 15],
];

// Map seed → pod label
function getSeedPod(seed) {
  const s = Number(seed);
  if ([1, 16, 8, 9].includes(s))  return 'A'; // top-top
  if ([5, 12, 4, 13].includes(s)) return 'B'; // top-bottom
  if ([6, 11, 3, 14].includes(s)) return 'C'; // bottom-top
  if ([7, 10, 2, 15].includes(s)) return 'D'; // bottom-bottom
  return null;
}

// Pod → half of region
function getPodHalf(pod) {
  if (pod === 'A' || pod === 'B') return 'top';
  if (pod === 'C' || pod === 'D') return 'bottom';
  return null;
}

// Are these seeds a direct Round of 64 game?
function isFirstRoundPair(seedA, seedB) {
  const a = Number(seedA);
  const b = Number(seedB);
  return R64_PAIRINGS.some(([x, y]) =>
    (a === x && b === y) || (a === y && b === x)
  );
}

// If two seeds were placed in the *same region*,
// what is the unique round where they would meet?
function getIntraRegionRound(seedA, seedB) {
  const a = Number(seedA);
  const b = Number(seedB);

  // Same seed cannot share a region (one slot per seed per region)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;

  const podA = getSeedPod(a);
  const podB = getSeedPod(b);
  if (!podA || !podB) return null;

  if (isFirstRoundPair(a, b)) return 'R64';

  if (podA === podB) return 'R32';

  const halfA = getPodHalf(podA);
  const halfB = getPodHalf(podB);

  if (halfA && halfB && halfA === halfB) return 'S16';

  // Different halves of the same region
  return 'E8';
}

// Global order for sorting rounds
const ROUND_ORDER = ['R64', 'R32', 'S16', 'E8', 'F4', 'Champ'];

// All possible rounds this *pair of seeds* can meet in,
// across all valid bracket layouts (same region vs different region).
function getPossibleRoundsForSeeds(seedA, seedB) {
  const a = Number(seedA);
  const b = Number(seedB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [];

  const possible = new Set();

  if (a !== b) {
    const intra = getIntraRegionRound(a, b);
    if (intra) possible.add(intra);
  }

  // Cross-region possibilities (any pair can be separated across regions)
  possible.add('F4');
  possible.add('Champ');

  // Return sorted by natural tournament order
  return Array.from(possible).sort((r1, r2) =>
    ROUND_ORDER.indexOf(r1) - ROUND_ORDER.indexOf(r2)
  );
}

// Convenience wrapper for checking a specific round
function isRoundPossibleForSeeds(seedA, seedB, roundCode) {
  const possible = getPossibleRoundsForSeeds(seedA, seedB);
  return possible.includes(roundCode);
}

// Build a small descriptor we can attach to the matchup result
function getSeedRoundMeta(seedA, seedB, roundCode) {
  const a = Number(seedA);
  const b = Number(seedB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  const possible = getPossibleRoundsForSeeds(a, b);
  const isAllowed = possible.includes(roundCode);
  const earliest = possible.length
    ? possible[0]
    : null;

  return {
    seedA: a,
    seedB: b,
    possible,    // e.g. ['R32','F4','Champ']
    isAllowed,   // true if current round is compatible with these seeds
    earliest,    // earliest possible round in standard bracket order
  };
}

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
  cgw: ['CGW%', 'CGW_pct', 'CGW pct', 'Close Game Win %'],

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
  oapp: ['Opp. Asst./Poss.', 'Opp Asst/Poss',],

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
  'spp', 'otpp', 'opp_ast_poss',
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

// v3.2 unified tier table
function getTierPointsFromZ(z) {
  if (z >= 1.00) return 2.0;                  // Elite
  if (z >= 0.80) return 1.5;                  // Strong
  if (z >= 0.60) return 1.0;                  // Above Average
  if (z >= 0.00) return 0.5;                  // Slightly Above / Average
  if (z >= -0.80) return 0.0;                 // Weak
  return 0.0;                                 // Fragile (z < -0.80)
}

// Tier labels for UI only (same ranges as tier points)
function getTierLabelFromZ(z) {
  if (z >= 1.00) return 'Elite';
  if (z >= 0.80) return 'Strong';
  if (z >= 0.60) return 'Above Average';
  if (z >= 0.00) return 'Slightly Above / Average';
  if (z >= -0.80) return 'Weak';
  return 'Fragile';
}

function updateInteractionHeadersFromSelections() {
  const selectA = document.getElementById('teamA');
  const selectB = document.getElementById('teamB');
  const adjAHeader = document.getElementById('adjAHeader');
  const adjBHeader = document.getElementById('adjBHeader');

  const aTeam = selectA?.value ? getTeamByName(selectA.value) : null;
  const bTeam = selectB?.value ? getTeamByName(selectB.value) : null;

  if (adjAHeader) adjAHeader.textContent = `Adj to ${aTeam?.name || 'Team A'}`;
  if (adjBHeader) adjBHeader.textContent = `Adj to ${bTeam?.name || 'Team B'}`;
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
  ['ft_pct',                  'ft_pct'],

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
      ft_pct:        getNum(row, 'ft_pct'),


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
  computeStaticIdentities();
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
  // 1) Core z-scores (v3.2 Core set: 8 metrics, Tempo removed)
  const zOff    = getZ(team, 'offeff',  false);
  const zDef    = getZ(team, 'defeff',  true);   // lower DefEff better
  const zAdjEM  = getZ(team, 'adjem',   false);
  const zTS     = getZ(team, 'ts',      false);
  const zEFG    = getZ(team, 'efg',     false);
  const zDefEFG = getZ(team, 'def_efg', true);   // lower Def eFG% better
  const zEPR    = getZ(team, 'epr',     false);
  const zTO     = getZ(team, 'to',      true);   // lower TO% better

  // Store for downstream layers (Breadth, Profile Marks, Interactions)
  team.coreZ = {
    offeff:  zOff,
    defeff:  zDef,
    adjem:   zAdjEM,
    ts:      zTS,
    efg:     zEFG,
    def_efg: zDefEFG,
    epr:     zEPR,
    to:      zTO,
  };

  // Core tier points (explain-mode only; do not affect MIBS)
  team.coreTierPts = {};
  Object.keys(team.coreZ).forEach((key) => {
    team.coreTierPts[key] = getTierPointsFromZ(team.coreZ[key]);
  });

  // 2) Core weighted composite — MIBS (v3.2 weights)
  // OffEff + -DefEff = 45%
  // TS% + eFG% + -Def eFG% = 35%
  // EPR + -TO% = 20%
  // AdjEM = stabilizer lane
  const wOffDef = 0.45 / 2.0;  // 0.225 each
  const wShoot  = 0.35 / 3.0;  // ≈0.1167 each
  const wPoss   = 0.20 / 2.0;  // 0.10 each
  const wAdjEM  = 0.10;        // stabilizer

  const mibsCore =
    wOffDef * zOff +
    wOffDef * zDef +
    wShoot  * zTS +
    wShoot  * zEFG +
    wShoot  * zDefEFG +
    wPoss   * zEPR +
    wPoss   * zTO;

  const mibs = mibsCore + wAdjEM * zAdjEM;
  team.mibs = mibs;

  // 3) Per-stat rows for the Core Traits table (UI only)
  const fsOff    = FIELD_STATS.offeff  || {};
  const fsDef    = FIELD_STATS.defeff  || {};
  const fsAdjEM  = FIELD_STATS.adjem   || {};
  const fsTS     = FIELD_STATS.ts      || {};
  const fsEFG    = FIELD_STATS.efg     || {};
  const fsDefEFG = FIELD_STATS.def_efg || {};
  const fsEPR    = FIELD_STATS.epr     || {};
  const fsTO     = FIELD_STATS.to      || {};

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
      weight: wOffDef,
      points: wOffDef * zOff,
    },
    {
      key:   'defeff',
      label: 'Defensive Efficiency',
      mean:  fsDef.mean,
      sd:    fsDef.sd,
      value: team.defeff,
      z:     zDef,
      tier:  L(zDef),
      weight: wOffDef,
      points: wOffDef * zDef,
    },
    {
      key:   'adjem',
      label: 'Adj. Efficiency Margin',
      mean:  fsAdjEM.mean,
      sd:    fsAdjEM.sd,
      value: team.adjem,
      z:     zAdjEM,
      tier:  L(zAdjEM),
      weight: wAdjEM,
      points: wAdjEM * zAdjEM,
    },
    {
      key:   'ts',
      label: 'True Shooting %',
      mean:  fsTS.mean,
      sd:    fsTS.sd,
      value: team.ts,
      z:     zTS,
      tier:  L(zTS),
      weight: wShoot,
      points: wShoot * zTS,
    },
    {
      key:   'efg',
      label: 'Effective FG %',
      mean:  fsEFG.mean,
      sd:    fsEFG.sd,
      value: team.efg,
      z:     zEFG,
      tier:  L(zEFG),
      weight: wShoot,
      points: wShoot * zEFG,
    },
    {
      key:   'def_efg',
      label: 'Defensive eFG %',
      mean:  fsDefEFG.mean,
      sd:    fsDefEFG.sd,
      value: team.def_efg,
      z:     zDefEFG,
      tier:  L(zDefEFG),
      weight: wShoot,
      points: wShoot * zDefEFG,
    },
    {
      key:   'epr',
      label: 'Effective Possession Ratio (EPR)',
      mean:  fsEPR.mean,
      sd:    fsEPR.sd,
      value: team.epr,
      z:     zEPR,
      tier:  L(zEPR),
      weight: wPoss,
      points: wPoss * zEPR,
    },
    {
      key:   'to',
      label: 'Turnover %',
      mean:  fsTO.mean,
      sd:    fsTO.sd,
      value: team.to,
      z:     zTO,
      tier:  L(zTO),
      weight: wPoss,
      points: wPoss * zTO,
    },
  ];
}

function computeBreadthForTeam(team) {
  const z = team.coreZ || {};

  // v3.2 hit criterion: z ≥ 0.60
  const isHit = (val) => typeof val === 'number' && val >= 0.60;

  // A. Efficiency Quartet (OffEff, -DefEff, AdjEM, -Def eFG%) — max +0.40
  let effHits = 0;
  if (isHit(z.offeff))  effHits++;
  if (isHit(z.defeff))  effHits++;
  if (isHit(z.adjem))   effHits++;
  if (isHit(z.def_efg)) effHits++;

  let effBonus = 0;
  if (effHits === 1)      effBonus = 0.10;
  else if (effHits === 2) effBonus = 0.20;
  else if (effHits === 3) effBonus = 0.30;
  else if (effHits === 4) effBonus = 0.40;

  // B. Shooting Pair (TS%, eFG%) — max +0.30
  let shootHits = 0;
  if (isHit(z.ts))  shootHits++;
  if (isHit(z.efg)) shootHits++;

  let shootBonus = 0;
  if (shootHits === 1)      shootBonus = 0.15;
  else if (shootHits === 2) shootBonus = 0.30;

  // C. Possession Stability Pair (EPR, -TO%) — max +0.30
  let possHits = 0;
  if (isHit(z.epr)) possHits++;
  if (isHit(z.to))  possHits++; // already inverted in z

  let possBonus = 0;
  if (possHits === 1)      possBonus = 0.15;
  else if (possHits === 2) possBonus = 0.30;

  const breadth = effBonus + shootBonus + possBonus;

  // For debugging / UI
  team.breadthEffHits   = effHits;
  team.breadthShootHits = shootHits;
  team.breadthPossHits  = possHits;
  team.breadthTotalHits = effHits + shootHits + possHits;

  team.breadth = breadth;                   // BreadthWeight = 1.00
  team.breadthHits = team.breadthTotalHits; // backwards-compatible
}

// ---------- Résumé Context Score (R) — MI_base Component ----------

function computeResumeContextForTeam(team) {
  // If we’re missing résumé data or field stats, treat as neutral résumé.
  if (!FIELD_STATS.wp || !FIELD_STATS.P || team.wp == null || team.P == null) {
    team.resumeIndex = 0;          // underlying R index
    team.resumeR     = 0;          // adjustment actually added to MI_base
    team.resumeRTier = 'Average';

    // Keep MI_base well-defined even if résumé is neutral
     computeMIBase(team);
    return;
  }

  // 1) Field-normalized record and schedule
  const z_wp = zScore(team.wp, FIELD_STATS.wp.mean, FIELD_STATS.wp.sd || 0.00001);
  const z_P  = zScore(team.P,  FIELD_STATS.P.mean,  FIELD_STATS.P.sd  || 0.00001);

  const R = (z_wp + z_P) / 2;

  // 3) Map R into global z-tier bands (same system used elsewhere),
  //    then convert tier → adjustment in the ±0.15 range.
  //
  // Tiers (R):
  //   Elite      : R ≥ +1.00        → +0.15
  //   Strong     : +1.00 > R ≥ 0.80 → +0.10
  //   Above Avg  : +0.80 > R ≥ 0.60 → +0.05
  //   Average    : +0.60 > R ≥ 0.00 →  0.00
  //   Weak       :  0.00 > R ≥ –0.80 → –0.05
  //   Fragile    : R < –0.80        → –0.10

  let adj  = 0;
  let tier = 'Average';

  if (R >= 1.00) {
    adj = 0.15; tier = 'Elite';
  } else if (R >= 0.80) {
    adj = 0.10; tier = 'Strong';
  } else if (R >= 0.60) {
    adj = 0.05; tier = 'Above Average';
  } else if (R < -0.80) {
    adj = -0.10; tier = 'Fragile';
  } else if (R < 0.00) {
    adj = -0.05; tier = 'Weak';
  }

  // 4) Store all résumé pieces on the team object
  team.resumeIndex = R;    // the underlying R index (z-like)
  team.resumeR     = adj;  // the actual MI_base adjustment
  team.resumeRTier = tier;

  // 5) Update MI_base now that Core, Breadth, and Résumé are known
  computeMIBase(team);
}

// ---------- Interaction Metrics (Directional, Tiered, Half-Mirrored) ----------

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

/* 2) FT Pressure (FT% + FTR + %Pts from FT vs foul discipline) */
function interactionFT(a, b) {
  // Offensive FT score: blend FTR, FT%, and % of points from FT (all z-scored)
  const offFTA =
    (getZ(a, 'ftr') + getZ(a, 'ft_pct') + getZ(a, 'pct_pts_ft')) / 3;
  const offFTB =
    (getZ(b, 'ftr') + getZ(b, 'ft_pct') + getZ(b, 'pct_pts_ft')) / 3;

  // Defensive FT discipline: lower OppFTR = better, so invert
  const defFTA = getZ(a, 'opp_ftr', true);
  const defFTB = getZ(b, 'opp_ftr', true);

  // Tension gaps: offense vs the *other* team’s FT discipline
  const gapA = offFTA - defFTB; // Team A offense vs Team B FT defense
  const gapB = offFTB - defFTA; // Team B offense vs Team A FT defense

  // Choose the side with the stronger leverage signal
  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (base) {
      if (gapA > 0) _applyToA(base, 'ft');
      else          _applyToB(base, 'ft');
    }
  } else {
    const base = halfMirroredAdjust(gapB);
    if (base) {
      if (gapB > 0) _applyToB(base, 'ft');
      else          _applyToA(base, 'ft');
    }
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

/* 4) Turnover Pressure (ball pressure + disruption vs ball security) */
function interactionTO(a, b) {
  // Defensive pressure: steals, forced TOs, and limiting assisted possessions
  const pressA = (
    getZ(a, 'spp') +                 // steals / possession
    getZ(a, 'otpp') +                // opponent TO / possession
    getZ(a, 'opp_ast_poss', true)    // invert: lower opp AST/poss = more disruption
  ) / 3;

  const pressB = (
    getZ(b, 'spp') +
    getZ(b, 'otpp') +
    getZ(b, 'opp_ast_poss', true)
  ) / 3;

  // Offensive ball security (already inverted in Core): higher = safer
  const secA = getZ(a, 'to', true);
  const secB = getZ(b, 'to', true);

  const gapA = pressA - secB; // A defense vs B offense
  const gapB = pressB - secA; // B defense vs A offense

  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (base) {
      if (gapA > 0) _applyToA(base, 'to');
      else          _applyToB(base, 'to');
    }
  } else {
    const base = halfMirroredAdjust(gapB);
    if (base) {
      if (gapB > 0) _applyToB(base, 'to');
      else          _applyToA(base, 'to');
    }
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

/* 7) Physicality / Contact Tolerance */
function interactionPhysicality(a, b) {
  // Offensive physicality: lives in contact and the paint
  const physOffA = (
    getZ(a, 'ftr') +          // draw fouls
    getZ(a, 'pct_pts_2') +    // % of points from 2s
    getZ(a, 'nb2')            // non-blocked 2s
  ) / 3;

  const physOffB = (
    getZ(b, 'ftr') +
    getZ(b, 'pct_pts_2') +
    getZ(b, 'nb2')
  ) / 3;

  // Defensive contact tolerance: rim resistance + foul discipline
  const tolDefA = (
    getZ(a, 'blk') +              // rim challenge
    getZ(a, 'def_efg', true) +    // invert: lower Def eFG% = better
    getZ(a, 'opp_ftr', true)      // invert: lower OppFTR = better discipline
  ) / 3;

  const tolDefB = (
    getZ(b, 'blk') +
    getZ(b, 'def_efg', true) +
    getZ(b, 'opp_ftr', true)
  ) / 3;

  const gapA = physOffA - tolDefB; // A's physical style vs B's tolerance
  const gapB = physOffB - tolDefA; // B's physical style vs A's tolerance

  // Choose the stronger directional signal, then half-mirror
  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (!base) return;
    if (gapA > 0) _applyToA(base, 'phys');  // A's physicality stresses B
    else          _applyToB(base, 'phys');  // B's interior toughness wins
  } else {
    const base = halfMirroredAdjust(gapB);
    if (!base) return;
    if (gapB > 0) _applyToB(base, 'phys');
    else          _applyToA(base, 'phys');
  }
}

/* 8) Shot Quality / Shot Discipline */
function interactionShotQuality(a, b) {
  // Offensive shot quality: efficiency + geometry + clean interior looks
  const sqA = (
    getZ(a, 'efg') +          // overall shot efficiency
    getZ(a, 'threepr') +      // 3P rate (spacing / geometry)
    getZ(a, 'nb2')            // non-blocked 2s (clean paint looks)
  ) / 3;

  const sqB = (
    getZ(b, 'efg') +
    getZ(b, 'threepr') +
    getZ(b, 'nb2')
  ) / 3;

  // Defensive shot discipline: suppress eFG and assisted, in-rhythm looks
  const sdA = (
    getZ(a, 'def_efg', true) +      // invert: lower Def eFG% = better
    getZ(a, 'opp_ast_poss', true)   // invert: lower opp AST/poss = more disruption
  ) / 2;

  const sdB = (
    getZ(b, 'def_efg', true) +
    getZ(b, 'opp_ast_poss', true)
  ) / 2;

  const gapA = sqA - sdB; // A's shot diet vs B's ability to distort it
  const gapB = sqB - sdA; // B's shot diet vs A's disruption

  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (!base) return;
    if (gapA > 0) _applyToA(base, 'shotq'); // A keeps its shot diet intact
    else          _applyToB(base, 'shotq'); // B meaningfully distorts A
  } else {
    const base = halfMirroredAdjust(gapB);
    if (!base) return;
    if (gapB > 0) _applyToB(base, 'shotq');
    else          _applyToA(base, 'shotq');
  }
}

/* 9) Variance Sensitivity */
function interactionVariance(a, b) {
  // --- Helper: Turnover Fragility index (same logic as the mark, but numeric)
  function getTurnoverFragility(team) {
    // stability = good if -TO% high and EPR high
    const stability = (-getZ(team, 'to') + getZ(team, 'epr')) / 2;
    // fragility = inverse of stability
    return -stability;
  }

  // --- Helper: small bonus for shot-volatility marks
  function getVarianceMarkBonus(team) {
    const marks = Array.isArray(team.profileMarks) ? team.profileMarks : [];
    let bonus = 0;

    if (marks.includes('Unstable Perimeter Profile — Severe')) bonus += 0.10;
    else if (marks.includes('Unstable Perimeter Profile — Moderate')) bonus += 0.05;

    if (marks.includes('Cold Arc Team — Severe')) bonus += 0.10;
    else if (marks.includes('Cold Arc Team — Moderate')) bonus += 0.05;

    return bonus;
  }

  // Variance Exposure Index (VEI): how volatile this team's style is
  function getVEI(team) {
    const threeVol   = getZ(team, 'threepr');        // high 3P rate → more variance
    const lowFTR     = getZ(team, 'ftr', true);      // low FTR → fewer stabilizing FTs
    const lowORB     = getZ(team, 'orb', true);      // low ORB → fewer extra chances
    const toFrag     = getTurnoverFragility(team);   // bad TO/EPR mix → volatility
    const markBonus  = getVarianceMarkBonus(team);   // add small boost for bad marks

    return (
      0.40 * threeVol +
      0.20 * lowFTR +
      0.20 * lowORB +
      0.20 * toFrag +
      markBonus
    );
  }

  // Opponent Stabilization Index (OSI): how much this team suppresses volatility
  function getOSI(team) {
    const press     = getZ(team, 'otpp');          // forces TOs → punishes fragile styles
    const dReb      = getZ(team, 'drb');           // strong DRB → removes 2nd-chance safety
    const ftDisc    = getZ(team, 'opp_ftr', true); // invert: lower OppFTR = fewer free points
    const perimDisc = getZ(team, 'opp_3pp', true); // invert: lower Opp3P% = stabilizes 3-happy foes

    return (press + dReb + ftDisc + perimDisc) / 4;
  }

  const veiA = getVEI(a);
  const veiB = getVEI(b);
  const osiA = getOSI(a);
  const osiB = getOSI(b);

  // "Risk exposure" for each side: how much their volatility is *exposed* by this opponent
  const riskA = veiA - osiB;
  const riskB = veiB - osiA;

  // We treat higher risk as a liability and award leverage to the more stable side
  if (Math.abs(riskA) >= Math.abs(riskB)) {
    const base = halfMirroredAdjust(riskA);
    if (!base) return;

    if (riskA > 0) {
      // A's volatility is exposed by B → favors B
      _applyToB(base, 'var');
    } else if (riskA < 0) {
      // B cannot meaningfully punish A's volatility → favors A (A effectively more stable here)
      _applyToA(base, 'var');
    }
  } else {
    const base = halfMirroredAdjust(riskB);
    if (!base) return;

    if (riskB > 0) {
      // B's volatility is exposed by A → favors A
      _applyToA(base, 'var');
    } else if (riskB < 0) {
      // A cannot meaningfully punish B's volatility → favors B
      _applyToB(base, 'var');
    }
  }
}

function computeInteractions(a, b) {
  __INT = { a: 0, b: 0, breakdown: {} }; // reset

  interaction3PT(a, b);
  interactionFT(a, b);
  interactionPaint(a, b);
  interactionTO(a, b);
  interactionGlass(a, b);
  interactionResume(a, b);
  interactionPhysicality(a, b);
  interactionShotQuality(a, b);
  interactionVariance(a, b);

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

  // 7. Tempo Strain 
  if (FIELD_STATS.tempo && FIELD_STATS.epr && FIELD_STATS.to &&
      team.tempo != null && team.epr != null && team.to != null) {

    const zTempo = getZ(team, 'tempo');      // pace identity (fast/slow)
    const zEPR   = getZ(team, 'epr');        // possession resilience
    const zInvTO = getZ(team, 'to', true);   // inverted TO% (higher = safer)

    // Step 1 — Tempo extremity (fast OR slow)
    const tempoExtremity = Math.abs(zTempo);

    // Step 2 — Possession fragility (positive when fundamentals are poor)
    const possFragRaw = (-zEPR + -zInvTO) / 2;   // penalize low EPR and low -TO
    const possFrag = Math.max(0, possFragRaw);   // ignore if possession is actually solid

    // Step 3 — Tempo Strain Index
    const strainIndex = tempoExtremity + possFrag;

    // Step 4 — Thresholds (aligned with global z-tier bands)
    if (strainIndex >= 1.00) {
      marks.push('Tempo Strain — Severe');
    } else if (strainIndex >= 0.60) {
      marks.push('Tempo Strain — Moderate');
    }
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

// ---------- CIS / FAS Static Identity Profiles (v4.0) ----------

// Small helper: count strong/weak cores from team.coreZ
function getCoreFractions(team) {
  const z = team.coreZ || {};
  const keys = Object.keys(z);
  if (!keys.length) {
    return {
      fStrong: 0,
      fWeak: 0,
      strongCount: 0,
      weakCount: 0
    };
  }

  let strongCount = 0;
  let weakCount   = 0;

  keys.forEach(k => {
    const val = z[k];
    if (typeof val !== 'number') return;
    if (val >= 0.80) strongCount++;
    else if (val < 0.50) weakCount++;
  });

  const total = keys.length;
  return {
    fStrong: strongCount / total,
    fWeak:   weakCount   / total,
    strongCount,
    weakCount
  };
}

// Compute CIS_static and FAS_static for every team once per CSV load
function computeStaticIdentities() {
  const teams = Object.values(TEAMS || {});
  const n = teams.length;
  if (!n) return;

  // 1) Make sure MI_base is populated and collect values
  const miValues = [];
  teams.forEach(t => {
    if (typeof t.mi_base !== 'number') {
      computeMIBase(t);
    }
    miValues.push(t.mi_base || 0);
  });

  // 2) Performance percentile P via rank-percentile of MI_base
  const sorted = [...teams].sort((a, b) => (a.mi_base || 0) - (b.mi_base || 0));
  const perfMap = new Map();
  sorted.forEach((t, idx) => {
    // rank-percentile: lower MI_base = lower percentile
    const P = (idx + 0.5) / n;
    perfMap.set(t.name, P);
  });

  // 3) Compute raw CIS/FAS
  let cisRawMax = 0;
  let fasRawMax = 0;

  teams.forEach(team => {
    const s = team.seed;
    if (s == null) {
      team.cis_raw = 0;
      team.fas_raw = 0;
      return;
    }

    const P = perfMap.get(team.name) ?? 0.5;
    team.performancePercentile = P;

  // 1–99 Madness Index Rating (cosmetic, based on MI_base percentile)
  let rating = Math.round(P * 100);
  if (rating < 1) rating = 1;
  if (rating > 99) rating = 99;
  team.mi_rating = rating;    

    const Sf = (17 - s) / 16; // favorite-side index
    const Su = (s - 1) / 16;  // underdog-side index

    const delta = P - Sf;
    const deltaPlus = Math.max(0, delta); // for CIS
    const APrime = 1 - Math.abs(delta);   // for FAS alignment

    const { fStrong, fWeak, strongCount, weakCount } = getCoreFractions(team);
    team.coreStrongCount = strongCount;
    team.coreWeakCount   = weakCount;
    team.coreStrongFrac  = fStrong;
    team.coreWeakFrac    = fWeak;

    const bCoreCIS = Math.max(0, fStrong - 0.5 * fWeak);
    const bCoreFAS = fStrong * (1 - fWeak);

    const R      = (typeof team.resumeR === 'number') ? team.resumeR : 0;
    const Rplus  = 0.5 + R / 4;

    const xCIS = 0.60 * deltaPlus +
                 0.25 * bCoreCIS +
                 0.15 * Rplus;

    const xFAS = 0.50 * APrime +
                 0.30 * bCoreFAS +
                 0.20 * Rplus;

    const cisRaw = Su * xCIS;
    const fasRaw = Sf * xFAS;

    team.cis_raw = cisRaw;
    team.fas_raw = fasRaw;

    if (cisRaw > cisRawMax) cisRawMax = cisRaw;
    if (fasRaw > fasRawMax) fasRawMax = fasRaw;
  });

  // 4) Normalize to 0–100 static scores
  const EPS = 1e-6;
  teams.forEach(team => {
    const cisRaw = team.cis_raw || 0;
    const fasRaw = team.fas_raw || 0;

    const cis = (cisRawMax > EPS && cisRaw > 0)
      ? (cisRaw / cisRawMax) * 100
      : 0;

    const fas = (fasRawMax > EPS && fasRaw > 0)
      ? (fasRaw / fasRawMax) * 100
      : 0;

    team.cisStatic = cis;
    team.fasStatic = fas;
  });
}

// ---------- Baseline Madness Index (MI_base) ----------
function computeMIBase(team) {
  const mibs      = (typeof team.mibs === 'number') ? team.mibs : 0;
  const breadth   = (typeof team.breadth === 'number') ? team.breadth : 0;
  const resumeAdj = (typeof team.resumeR === 'number') ? team.resumeR : 0;

  const miBase = mibs + breadth + resumeAdj;

  team.mi_base = miBase;  // keep on the object for UI / downstream use
  return miBase;
}

// ---------- Matchup Madness Index (MI_matchup) ----------

function computeFinalMI(team, interactionAdj) {
  // Safeguard: ensure MI_base exists
  const base = (typeof team.mi_base === 'number')
    ? team.mi_base
    : ((team.mibs || 0) + (team.breadth || 0) + (team.resumeR || 0));

  const intAdj = interactionAdj || 0;

  const mi_matchup = base + intAdj;

  // Optional: store for debugging / Explain Mode
  team.mi_matchup = mi_matchup;
  team.mi_int     = intAdj;   // total INT for this matchup direction

  return mi_matchup;
}

function getTeamByName(name) {
  return TEAMS[name] || null;
}

function compareTeams(teamAName, teamBName) {
  const a = getTeamByName(teamAName);
  const b = getTeamByName(teamBName);

  if (!a || !b) {
    console.error('Invalid team selection:', teamAName, teamBName);
    return;
  }

  // Interactions first
  const interactions = computeInteractions(a, b);

  // 🔹 Active round from the global selector
  const activeRound = CURRENT_ROUND;  // e.g., "R64", "S16", etc.

  // 🔹 Seed-aware bracket metadata
  const seedMeta = getSeedRoundMeta(a.seed, b.seed, activeRound);

  const miA = computeFinalMI(a, interactions.a);
  const miB = computeFinalMI(b, interactions.b);

  const diff = miA - miB;
  const predicted = diff > 0 ? a.name : (diff < 0 ? b.name : 'Push');

  const result = { 
    a, 
    b, 
    miA, 
    miB, 
    diff, 
    predicted, 
    interactions,
    round: activeRound,
    seedMeta,          // 🔹 bracket-aware metadata travels with the result
  };

  window.LAST_RESULT = result;

  renderTeamCards(result);
  renderProfileMarks(a, "inlineMarksA");
  renderProfileMarks(b, "inlineMarksB");
  renderInteractionsTable(result);
  renderSummary(result);
  updateMatchupBarFromDOM();

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

  // When teams change, re-calc which rounds are possible
  const onTeamChange = () => {
    updateRoundOptionsForCurrentSeeds();
    updateInteractionHeadersFromSelections();
  };

  selectA.addEventListener('change', onTeamChange);
  selectB.addEventListener('change', onTeamChange);

  // Also run once after initial population (if dropdowns have default values)
  updateRoundOptionsForCurrentSeeds();
}

function getRoundLabelFromCode(code) {
  switch (code) {
    case "R64":   return "Round of 64";
    case "R32":   return "Round of 32";
    case "S16":   return "Sweet Sixteen";
    case "E8":    return "Elite Eight";
    case "F4":    return "Final Four";
    case "Champ": return "Championship";
    default:      return "Select Round";
  }
}

// ---------- Identity Role Resolver (Favorite / Cinderella / Neutral) ----------

function getIdentityRoleForGame(team, opponent, roundCode) {
  if (!team || !opponent) return 'NEUTRAL';

  const s    = team.seed;
  const sOpp = opponent.seed;

  if (s == null || sOpp == null) return 'NEUTRAL';

  const a = Math.min(s, sOpp);
  const b = Math.max(s, sOpp);
  const pairKey = `${a}-${b}`;
  const round = roundCode || CURRENT_ROUND || "R64";

  // 1) Round of 64 absolute rules for canonical pairs
  if (round === "R64") {
    switch (pairKey) {
      case "1-16":
      case "2-15":
      case "3-14":
      case "4-13":
      case "5-12":
        return (s === a) ? "FAVORITE" : "CINDERELLA";

      case "6-11":
        if (s === 6)  return "FAVORITE";
        if (s === 11) return "CINDERELLA";
        return "NEUTRAL";

      case "7-10":
        if (s === 7)  return "FAVORITE";
        if (s === 10) return "CINDERELLA";
        return "NEUTRAL";

      case "8-9":
        // 8–9 R64 is explicitly neutral in the identity layer
        return "NEUTRAL";

      default:
        // Non-canonical R64 matchup → fall through to general rules
        break;
    }
  }

  // 2) General rules for non-R64 or custom matchups
  if (s === sOpp) {
    // Same seed -> treat as neutral for identity purposes
    return "NEUTRAL";
  }

  const lowerSeed  = (s < sOpp) ? s    : sOpp;
  const higherSeed = (s < sOpp) ? sOpp : s;

  const teamIsFavorite = (s === lowerSeed);
  const deepRound =
    round === "S16" ||
    round === "E8"  ||
    round === "F4"  ||
    round === "C"   || round === "Champ";

  if (teamIsFavorite) {
    // Lower seed → default favorite identity
    return "FAVORITE";
  } else {
    // Team is the underdog
    if (s >= 7) {
      // Classic Cinderella territory (7+)
      return "CINDERELLA";
    }
    if (s === 6 && deepRound) {
      // Pivot seed becomes Cinderella only in deeper rounds vs stronger seeds
      return "CINDERELLA";
    }
    // Otherwise just underdog without strong Cinderella identity
    return "NEUTRAL";
  }
}

// ---------- Lean band helper (for ΔMI) ----------
function getLeanBand(diff) {
  const d = Math.abs(diff);
  if (d < 0.10) return 'Toss-Up';
  if (d < 0.25) return 'Very Slight Lean';
  if (d < 0.50) return 'Lean';
  if (d < 0.80) return 'Strong Lean';
  return 'Heavy Lean';
}

function renderSummary({ a, b, miA, miB, diff, predicted, interactions, round, seedMeta }) {
  const table = document.getElementById('summaryTable');
  if (!table) return;

  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  // Lean band + text
  const band = getLeanBand(diff);
  let leanText;

  if (diff === 0) {
    leanText = 'Toss-Up (Even Matchup)';
  } else {
    const winnerName = diff > 0 ? a.name : b.name;
    leanText = `${band} toward ${winnerName}`;
  }

  // Update header cells to show team names
  const headA = document.getElementById('summaryTeamAHeader');
  const headB = document.getElementById('summaryTeamBHeader');
  if (headA) headA.textContent = a.name;
  if (headB) headB.textContent = b.name;

  // Baseline vs matchup values
  const baseA = typeof a.mi_base === 'number' ? a.mi_base : computeMIBase(a);
  const baseB = typeof b.mi_base === 'number' ? b.mi_base : computeMIBase(b);
  const intA  = interactions?.a || 0;
  const intB  = interactions?.b || 0;

  // Single clean matchup row using "mini cards" in each cell
  tbody.innerHTML = `
    <tr>
      <!-- Team A summary -->
      <td>
        <div class="summary-block">
          <div class="summary-team-label">Cinderella</div>
          <div class="summary-team-name">${a.name}</div>
          <div class="summary-mi-line">Baseline MI: ${fmt(baseA, 3)}</div>
          <div class="summary-mi-line">Matchup MI: ${fmt(miA, 3)}</div>
          <div class="summary-int-line">
            Interaction Leverage: ${fmt(intA, 3)}
          </div>
        </div>
      </td>

      <!-- Center ΔMI + prediction card -->
      <td>
        <div class="summary-block summary-lean">
          <div class="summary-delta-label">Matchup Edge</div>
          <div class="summary-delta-value">ΔMI: ${fmt(diff, 3)}</div>
          <div class="summary-pred-line">
            Predicted Winner: <strong>${predicted}</strong>
          </div>
          <div class="summary-lean-text">
            ${leanText}
          </div>
        </div>
      </td>

      <!-- Team B summary -->
      <td>
        <div class="summary-block">
          <div class="summary-team-label">Favorite</div>
          <div class="summary-team-name">${b.name}</div>
          <div class="summary-mi-line">Baseline MI: ${fmt(baseB, 3)}</div>
          <div class="summary-mi-line">Matchup MI: ${fmt(miB, 3)}</div>
          <div class="summary-int-line">
            Interaction Leverage: ${fmt(intB, 3)}
          </div>
        </div>
      </td>
    </tr>
  `;

  // Update round pill
  const roundSpan = document.getElementById('currentRoundLabel');
  if (roundSpan) {
    roundSpan.textContent = getRoundLabelFromCode(round || CURRENT_ROUND);
  }

  // Legacy spans (safe no-ops if not present)
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

  // ----- Seed / bracket compatibility note -----
  const seedNoteEl = document.getElementById('summarySeedNote');
  if (seedNoteEl && seedMeta && typeof a.seed === 'number' && typeof b.seed === 'number') {
    const { seedA, seedB, possible, isAllowed, earliest } = seedMeta;

    const friendlyRounds = possible.map(getRoundLabelFromCode);
    const currentLabel = getRoundLabelFromCode(round || CURRENT_ROUND);
    const earliestLabel = earliest ? getRoundLabelFromCode(earliest) : null;

    if (!possible.length) {
      seedNoteEl.textContent = '';
    } else if (isAllowed) {
      // Current round is compatible with these seeds
      seedNoteEl.textContent =
        `Bracket note: As seeds ${seedA} and ${seedB}, these teams ` +
        `can meet in ${friendlyRounds.join(', ')}. ` +
        `${currentLabel} is a valid meeting round.`;
    } else {
      // Current round is *not* compatible with standard bracket structure
      seedNoteEl.textContent =
        `Bracket note: As seeds ${seedA} and ${seedB}, these teams ` +
        `can meet in ${friendlyRounds.join(', ')}. ` +
        `${currentLabel} is *not* a valid meeting round in a standard 64-team bracket.`;
    }
  }
}

function renderInteractionsTable(result) {
  const table = document.getElementById('interactionsTable');
  const totalsBar = document.getElementById('interactionTotalsBar');
  if (!table) return;

  // ==== Full canonical interaction list (ALWAYS displayed) ====
  const ORDER = [
    '3pt', 'ft', 'paint', 'to', 'glass', 'resume', 'phys', 'shotq', 'var'
  ];

  const LABEL = {
    '3pt':   '3PT Tension',
    'ft':    'FT Pressure',
    'paint': 'Paint Tension',
    'to':    'Turnover Pressure',
    'glass': 'Glass Tension',
    'resume':'Résumé Pressure',
    'phys':  'Physicality / Contact Tolerance',
    'shotq': 'Shot Quality / Discipline',
    'var':   'Variance Sensitivity',
  };

  const DOMAIN = {
    '3pt':   'Shooting',
    'ft':    'Pressure',
    'paint': 'Pressure',
    'to':    'Pressure',
    'glass': 'Glass',
    'resume':'Résumé',
    'phys':  'Physicality',
    'shotq': 'Shooting',
    'var':   'Variance',
  };

  const intensityLabel = (val) => {
    const x = Math.abs(val);
    if (x >= 0.50) return 'Major';
    if (x >= 0.25) return 'Moderate';
    return 'Minor';
  };

  // ===== Team names (robust fallback) =====
  const aName = result?.a?.name || result?.teamA?.name || result?.a?.team || "Team A";
  const bName = result?.b?.name || result?.teamB?.name || result?.b?.team || "Team B";

  // ===== Update table headers =====
  const adjAHeader = document.getElementById("adjAHeader");
  const adjBHeader = document.getElementById("adjBHeader");
  if (adjAHeader) adjAHeader.textContent = `Adj to ${aName}`;
  if (adjBHeader) adjBHeader.textContent = `Adj to ${bName}`;

  const breakdown = result.interactions?.breakdown || {};
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";

  // ===== Always render ALL interactions =====
  ORDER.forEach((key, i) => {
    const raw = breakdown[key];   // may be undefined, numeric, or object
    let aAdj = 0, bAdj = 0, edgeText = 'EVEN';

    if (typeof raw === 'number') {
      aAdj = raw;
      bAdj = -raw;
      if (raw > 0) edgeText = `FAVORS ${aName}`;
      else if (raw < 0) edgeText = `FAVORS ${bName}`;
    }
    else if (raw && typeof raw === 'object') {
      aAdj = raw.aAdj ?? 0;
      bAdj = raw.bAdj ?? 0;
      edgeText = raw.edge || 'EVEN';
    }

    const intensity = intensityLabel(aAdj);

    let pillClass = 'int-edge-even';
    if (aAdj > 0) pillClass = 'int-edge-A';
    if (aAdj < 0) pillClass = 'int-edge-B';

    const rowClass = i % 2 === 0 ? "int-row-even" : "int-row-odd";

    tbody.innerHTML += `
      <tr class="${rowClass}">
        <td class="int-name">${LABEL[key]}</td>
        <td class="col-domain">${DOMAIN[key]}</td>
        <td class="int-edge"><span class="int-edge-pill ${pillClass}">${edgeText}</span></td>
        <td class="col-intensity">${intensity}</td>
        <td class="int-adj ${aAdj >= 0 ? 'pos' : 'neg'}">${fmt(aAdj, 3)}</td>
        <td class="int-adj ${bAdj >= 0 ? 'pos' : 'neg'}">${fmt(bAdj, 3)}</td>
      </tr>
    `;
  });

  // ===== Totals Bar =====
  const totalA = result.interactions?.a || 0;
  const totalB = result.interactions?.b || 0;

  if (totalsBar) {
    const favored =
      totalA > totalB ? aName :
      totalB > totalA ? bName :
      'EVEN';

    totalsBar.innerHTML = `
      <div class="totals-left">
        <div class="totals-title">Total Interaction Leverage</div>
        <div class="totals-favored">FAVORS <span>${favored}</span></div>
      </div>
      <div class="totals-right">
        <div class="totals-val ${totalA >= 0 ? 'pos' : 'neg'}">${fmt(totalA, 3)}</div>
        <div class="totals-sep">/</div>
        <div class="totals-val ${totalB >= 0 ? 'pos' : 'neg'}">${fmt(totalB, 3)}</div>
      </div>
    `;
  }
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

    "Tempo Strain — Moderate": "badge_tempo_strain_moderate.svg",
    "Tempo Strain — Severe":   "badge_tempo_strain_severe.svg",

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

// ========== MATCHUP BAR TOGGLING ==========

function updateMatchupBarFromDOM() {
  const matchupBar = document.getElementById('matchupBar');
  const topBar     = document.querySelector('.top-bar');
  if (!matchupBar || !topBar) return;

  const teamANameEl = document.getElementById('teamATitle');
  const teamBNameEl = document.getElementById('teamBTitle');
  const seedAEl     = document.getElementById('teamASeed');
  const seedBEl     = document.getElementById('teamBSeed');
  const roundLabelEl = document.getElementById('currentRoundLabel');

  const cName = teamANameEl ? teamANameEl.textContent.trim() : 'Team A';
  const fName = teamBNameEl ? teamBNameEl.textContent.trim() : 'Team B';
  const cSeed = seedAEl ? seedAEl.textContent.trim() : '';
  const fSeed = seedBEl ? seedBEl.textContent.trim() : '';
  const round = roundLabelEl ? roundLabelEl.textContent.trim() : 'Round of 64';

  const cNameOut = document.getElementById('matchupCinderName');
  const fNameOut = document.getElementById('matchupFavoriteName');
  const cSeedOut = document.getElementById('matchupCinderSeed');
  const fSeedOut = document.getElementById('matchupFavoriteSeed');
  const roundOut = document.getElementById('matchupRoundPill');

  if (cNameOut) cNameOut.textContent = cName;
  if (fNameOut) fNameOut.textContent = fName;
  if (cSeedOut) cSeedOut.textContent = cSeed ? `(${cSeed})` : '';
  if (fSeedOut) fSeedOut.textContent = fSeed ? `(${fSeed})` : '';
  if (roundOut) roundOut.textContent = round;

  matchupBar.classList.add('visible');
  topBar.classList.add('collapsed');
}

function hideMatchupBar() {
  const matchupBar = document.getElementById('matchupBar');
  const topBar     = document.querySelector('.top-bar');
  if (!matchupBar || !topBar) return;

  matchupBar.classList.remove('visible');
  topBar.classList.remove('collapsed');
}

function renderCoreProfileTable(team, tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;

  const rows = team.coreDetails || [];
  if (!rows.length) {
    table.innerHTML = `
      <thead>
        <tr class="table-header">
          <th>Category</th>
          <th>Thresholds</th>
          <th>Team Value</th>
          <th>Tier</th>
          <th>Points Given</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td colspan="5">No core trait data.</td>
        </tr>
      </tbody>
    `;
    return;
  }

  const header = `
    <thead>
      <tr class="table-header">
        <th>Category</th>
        <th>Thresholds</th>
        <th>Team Value</th>
        <th>Tier</th>
        <th>Points Given</th>
      </tr>
    </thead>
  `;

  const bodyRows = rows.map(r => {
    const tierClass = r.tier
      ? `tier-${r.tier.replace(/[\s/]+/g, '')}`   // e.g. "Slightly Above / Average" -> "tier-SlightlyAboveAverage"
      : '';

    return `
      <tr>
        <td>${r.label}</td>
        <td>Mean = ${fmt(r.mean, 3)}<br/>SD = ${fmt(r.sd, 3)}</td>
        <td class="metric-block">${fmt(r.value, 3)}</td>
        <td class="metric-block ${tierClass}">${r.tier}</td>
        <td class="metric-block">${fmt(r.points, 3)}</td>
      </tr>
    `;
  }).join('');

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

  table.innerHTML = header + `<tbody>` + bodyRows + breadthRow + `</tbody>`;
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

function buildTeamSummary(team, opponent, result, side) {
  const isA = side === 'A';

  const coreRows = team.coreDetails || [];
  let strongest = null, weakest = null;
  if (coreRows.length) {
    strongest = coreRows.reduce((best, r) => r.points > (best?.points ?? -Infinity) ? r : best, null);
    weakest   = coreRows.reduce((worst, r) => r.points < (worst?.points ?? Infinity) ? r : worst, null);
  }

  const breadthHits = team.breadthHits ?? 0;
  const breadthScore = team.breadth ?? 0;
  const resumeScore  = team.resumeR ?? 0;
  const resumeTier   = team.resumeRTier || 'Average';

  const marks = Array.isArray(team.profileMarks) ? team.profileMarks : [];
  const severeCount   = marks.filter(m => m.includes('Severe')).length;
  const moderateCount = marks.filter(m => m.includes('Moderate')).length;

  // If you have interactions labeled with swings, grab top 1–2
  const intSide = isA ? result.interactions.a : result.interactions.b;
  const topInts = (intSide?.details || [])
    .slice()
    .sort((x, y) => Math.abs(y.points) - Math.abs(x.points))
    .slice(0, 2);

  // Opponent context (seed / MI gap etc if you want)
  const oppSeed = opponent?.seed;
  const mySeed  = team?.seed;

  // Build short clauses
  const coreClause = (strongest && weakest)
    ? `${strongest.label} is the main edge, while ${weakest.label} is the soft spot.`
    : `Core Traits show this team’s main statistical shape.`;

  const breadthClause = (breadthScore > 0)
    ? `${breadthHits} Above-Average hits earn a Breadth Bonus of +${fmt(breadthScore,3)}.`
    : `Breadth is neutral — strengths are concentrated rather than spread out.`;

  const resumeClause = (resumeScore > 0.0001)
    ? `${resumeTier} résumé adds +${fmt(resumeScore,3)}.`
    : (resumeScore < -0.0001)
      ? `${resumeTier} résumé subtracts ${fmt(resumeScore,3)}.`
      : `${resumeTier} résumé is neutral.`;

  const marksClause = (!marks.length)
    ? `No Profile Marks — clean structural profile.`
    : (severeCount > 0)
      ? `${severeCount} Severe / ${moderateCount} Moderate marks flag volatility or structural risk.`
      : `${moderateCount} Moderate marks flag matchup-sensitive weaknesses.`;

  const interactionClause = (topInts.length)
    ? `Biggest matchup swing: ${topInts.map(i => `${i.label} (${fmt(i.points,3)})`).join(', ')}.`
    : `No major matchup leverage flagged.`;

  return {
    strongest,
    weakest,
    coreClause,
    breadthClause,
    resumeClause,
    marksClause,
    interactionClause,
    severeCount,
    moderateCount,
    breadthHits
  };
}

function renderTeamSide(side, result) {
  const isA   = side === 'A';
  const team  = isA ? result.a   : result.b;
  const mi    = isA ? result.miA : result.miB;              // matchup MI (still used elsewhere if needed)
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
  const opponent = isA ? result.b : result.a;
  const summary = buildTeamSummary(team, opponent, result, side);

  // Baseline profile subtotal and MI_base
  const profileSubtotal = core + breadth;

  // Ensure MI_base is present; fall back to computing if needed
  const miBase = (typeof team.mi_base === 'number')
    ? team.mi_base
    : computeMIBase(team);

  if (titleEl)           titleEl.textContent           = team.name || (isA ? 'Team A' : 'Team B');
  if (seedEl)            seedEl.textContent            = (team.seed != null && team.seed !== '') ? `Seed ${team.seed}` : '';
  if (profileSubtotalEl) profileSubtotalEl.textContent = fmt(profileSubtotal, 3);
  if (teamTotalEl)       teamTotalEl.textContent       = fmt(miBase, 3);

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

    // Identity tile (CIS / FAS)
  const identityTile    = document.getElementById(isA ? 'identityTileA'    : 'identityTileB');
  const identityScoreEl = document.getElementById(isA ? 'identityScoreA'   : 'identityScoreB');
  const identityRoleEl  = document.getElementById(isA ? 'identityRoleA'    : 'identityRoleB');
  const identityDetailEl= document.getElementById(isA ? 'identityDetailA'  : 'identityDetailB');
  const backIdentityEl  = document.getElementById(isA ? 'backIdentityA'    : 'backIdentityB');

  if (identityTile && identityScoreEl && identityRoleEl && identityDetailEl) {
    const opponent = isA ? result.b : result.a;
    const roundCode = result.round || CURRENT_ROUND || "R64";
    const role = getIdentityRoleForGame(team, opponent, roundCode);

    const cis = (typeof team.cisStatic === 'number') ? team.cisStatic : 0;
    const fas = (typeof team.fasStatic === 'number') ? team.fasStatic : 0;

    let activeScore = null;
    let label       = 'Neutral';
    let desc        = '';
    let tileClass   = 'identity-neutral';

    const roundLabel = (typeof getRoundLabelFromCode === 'function')
      ? getRoundLabelFromCode(roundCode)
      : roundCode;

    if (role === 'FAVORITE') {
      activeScore = fas;
      label       = 'Favorite';
      desc        = `Favorite Authenticity: ${Math.round(fas)} • Cinderella Identity: ${Math.round(cis)}`;
      tileClass   = 'identity-favorite';
    } else if (role === 'CINDERELLA') {
      activeScore = cis;
      label       = 'Cinderella';
      desc        = `Cinderella Identity: ${Math.round(cis)} • Favorite Authenticity: ${Math.round(fas)}`;
      tileClass   = 'identity-cinderella';
    } else {
      activeScore = null;
      label       = 'Neutral';
      desc        = `CIS: ${Math.round(cis)} • FAS: ${Math.round(fas)}`;
      tileClass   = 'identity-neutral';
    }

    identityScoreEl.textContent = (activeScore != null)
      ? fmt(activeScore, 0)
      : '—';

    identityRoleEl.textContent   = label;
    identityDetailEl.textContent = desc;

    identityTile.classList.remove('identity-favorite', 'identity-cinderella', 'identity-neutral');
    identityTile.classList.add('identity-tile', tileClass);

    if (backIdentityEl) {
      let expl;
      if (role === 'FAVORITE') {
        expl =
          `${team.name} is treated as the Favorite in this ${roundLabel} matchup `
          + `based on seeding and context. The highlighted score (${Math.round(fas)}) `
          + `is this team's Favorite Authenticity (FAS). Cinderella Identity `
          + `(CIS = ${Math.round(cis)}) is shown for context only.`;
      } else if (role === 'CINDERELLA') {
        expl =
          `${team.name} is treated as the Cinderella in this ${roundLabel} matchup. `
          + `The highlighted score (${Math.round(cis)}) is this team's Cinderella `
          + `Identity (CIS). Favorite Authenticity (FAS = ${Math.round(fas)}) remains `
          + `visible for reference.`;
      } else {
        expl =
          `In this matchup, neither team has a clear Cinderella or Favorite `
          + `identity for this round (for example, an 8 vs 9 game in the Round of 64). `
          + `Both CIS (${Math.round(cis)}) and FAS (${Math.round(fas)}) are shown as `
          + `background profile metrics.`;
      }
      backIdentityEl.textContent = expl;
    }
  }

  // Core Traits big table
  renderCoreProfileTable(team, coreTableId);

  // Neutral Modifiers table (Résumé + Interactions)
  renderNeutralTable(team, mi, intTot, neutralTableId, neutralSubtotalId);
    // ----- Back-of-card EXPLANATION content -----
  const formulaEl  = document.getElementById(isA ? 'backFormulaA'  : 'backFormulaB');
  const coreEl     = document.getElementById(isA ? 'backCoreA'     : 'backCoreB');
  const breadthEl  = document.getElementById(isA ? 'backBreadthA'  : 'backBreadthB');
  const resumeEl   = document.getElementById(isA ? 'backResumeA'   : 'backResumeB');
  const marksEl    = document.getElementById(isA ? 'backMarksA'    : 'backMarksB');

  const coreScore   = core;
  const breadthScore= breadth;
  const resumeScore = resume;
  const totalMI     = mi;
  const intScore    = intTot || 0;
  const baseForBack = miBase; // reuse the already computed MI_base

  // 1) Overall formula explanation
  if (formulaEl) {
    formulaEl.textContent =
      `Team Total (${fmt(totalMI, 3)}) = Core Traits (${fmt(coreScore, 3)}) `
      + `+ Breadth Bonus (${fmt(breadthScore, 3)}) `
      + `+ Résumé Context (${fmt(resumeScore, 3)}) `
      + `+ Matchup Interactions (${fmt(intScore, 3)}).`;
  }

  // 2) Core Traits explanation (the big table on the front)
  if (coreEl) {
    const rows = team.coreDetails || [];
    let strongest = null;
    let weakest   = null;

    if (rows.length) {
      strongest = rows.reduce((best, r) => (r.points > (best?.points ?? -Infinity) ? r : best), null);
      weakest   = rows.reduce((worst, r) => (r.points < (worst?.points ?? Infinity) ? r : worst), null);
    }

    if (strongest && weakest) {
      coreEl.textContent =
        `The Core Traits table shows the eight field-normalized strength metrics. `
        + `Here, ${strongest.label} contributes the most positive value to the scorecard, `
        + `while ${weakest.label} is this team’s weakest core area.`;
    } else {
      coreEl.textContent =
        `The Core Traits table summarizes eight field-normalized strength metrics that combine into the Core score shown on the front.`;
    }
  }

  // 3) Breadth Bonus explanation (Breadth row at the bottom of the table)
  if (breadthEl) {
    const hits = team.breadthHits != null ? team.breadthHits : 0;

    if (breadthScore > 0) {
      breadthEl.textContent =
        `The Breadth Bonus rewards this team for having ${hits} Above-Average strengths `
        + `across Efficiency, Shooting, and Possession Stability, adding +${fmt(breadthScore, 3)} on top of the Core score.`;
    } else {
      breadthEl.textContent =
        `No Breadth Bonus is applied here, which means this team’s strengths are more concentrated instead of spread across multiple domains.`;
    }
  }

  // 4) Résumé Context tile explanation (the small tile under the profile section)
  if (resumeEl) {
    const tier = team.resumeRTier || 'Average';
    if (resumeScore > 0) {
      resumeEl.textContent =
        `The Résumé Context tile reflects how the win–loss record holds up against schedule strength. `
        + `A ${tier} résumé adds a small positive adjustment (${fmt(resumeScore, 3)}) to the baseline Madness Index.`;
    } else if (resumeScore < 0) {
      resumeEl.textContent =
        `The Résumé Context tile suggests this record is a bit inflated relative to schedule. `
        + `A ${tier} résumé subtracts a small amount (${fmt(resumeScore, 3)}) from the baseline Madness Index.`;
    } else {
      resumeEl.textContent =
        `The Résumé Context tile is neutral here. This record and schedule balance out to an ${tier} résumé with no extra adjustment.`;
    }
  }

  // 5) Profile Marks explanation (the strip of badges under the résumé)
  if (marksEl) {
    const marks = Array.isArray(team.profileMarks) ? team.profileMarks : [];

    if (!marks.length) {
      marksEl.textContent =
        `The Profile Marks strip is empty, meaning this team has no flagged structural weaknesses based on the v3.2 Profile Marks system.`;
    } else {
      const severeCount   = marks.filter(m => m.includes('Severe')).length;
      const moderateCount = marks.filter(m => m.includes('Moderate')).length;

      let levelText = '';
      if (severeCount > 0) {
        levelText = `${severeCount} Severe and ${moderateCount} Moderate marks highlight higher volatility or structural risk areas.`;
      } else {
        levelText = `${moderateCount} Moderate marks highlight some style- or matchup-sensitive weaknesses.`;
      }

      marksEl.textContent =
        `Each icon in the Profile Marks strip represents a non-scoring diagnostic flag. `
        + levelText;
    }
  }
  // ============================================================
  // MINI-TILE BACKS (Core mini tile, Résumé mini tile, Marks mini tile)
  // ============================================================

  // ----- Core Traits Mini Tile Back -----
  const coreTileBackEl     = document.getElementById(isA ? 'backCoreTileA'     : 'backCoreTileB');
  const breadthTileBackEl  = document.getElementById(isA ? 'backBreadthTileA'  : 'backBreadthTileB');

  if (coreTileBackEl) {
    const rows = team.coreDetails || [];
    let strongest = null;
    let weakest   = null;

    if (rows.length) {
      strongest = rows.reduce(
        (best, r) => (r.points > (best?.points ?? -Infinity) ? r : best),
        null
      );
      weakest = rows.reduce(
        (worst, r) => (r.points < (worst?.points ??  Infinity) ? r : worst),
        null
      );
    }

    if (strongest && weakest) {
      coreTileBackEl.textContent =
        `${strongest.label} is this team's strongest Core Trait, while ` +
        `${weakest.label} is the weakest.`;
    } else {
      coreTileBackEl.textContent =
        `Core Traits summarize eight field-normalized strengths that form the Core score.`;
    }
  }

  if (breadthTileBackEl) {
    const hits = team.breadthHits != null ? team.breadthHits : 0;
    if (breadthScore > 0) {
      breadthTileBackEl.textContent =
        `Breadth Bonus: ${hits} Above-Average strengths → +${fmt(breadthScore, 3)}.`;
    } else {
      breadthTileBackEl.textContent =
        `No Breadth Bonus: strengths are more concentrated in fewer areas.`;
    }
  }

  // ----- Résumé Mini Tile Back -----
  const resumeTileBackEl = document.getElementById(isA ? 'backResumeTileA' : 'backResumeTileB');
  if (resumeTileBackEl) {
    resumeTileBackEl.textContent = resumeEl?.textContent || '';
  }

  // ----- Profile Marks Mini Tile Back -----
  const marksTileBackEl = document.getElementById(isA ? 'backMarksTileA' : 'backMarksTileB');
  if (marksTileBackEl) {
    marksTileBackEl.textContent = marksEl?.textContent || '';
  }
}

function renderTeamCards(result) {
  renderTeamSide('A', result);
  renderTeamSide('B', result);
}

// Dynamically filter which rounds are available based on selected teams' seeds
function updateRoundOptionsForCurrentSeeds() {
  const roundBtn = document.getElementById("roundSelectBtn");
  const roundDropdown = document.getElementById("roundDropdown");
  if (!roundBtn || !roundDropdown) return;

  const selectA =
    document.getElementById('teamA') ||
    document.getElementById('teamASelect') ||
    document.getElementById('cindTeamSelect');

  const selectB =
    document.getElementById('teamB') ||
    document.getElementById('teamBSelect') ||
    document.getElementById('favTeamSelect');

  const teamAName = selectA?.value || '';
  const teamBName = selectB?.value || '';

  const showAllRounds = () => {
    roundDropdown.querySelectorAll(".round-option").forEach(opt => {
      opt.style.display = "";
    });
    CURRENT_ROUND = null;
    roundBtn.textContent = "Select Round";
  };

  // Sandbox = no restrictions
  if (SANDBOX_MODE) {
    showAllRounds();
    return;
  }

  if (!teamAName || !teamBName) {
    showAllRounds();
    return;
  }

  const teamA = getTeamByName(teamAName);
  const teamB = getTeamByName(teamBName);

  if (!teamA || !teamB || teamA.seed == null || teamB.seed == null) {
    showAllRounds();
    return;
  }

  const allowedRounds = new Set(getPossibleRoundsForSeeds(teamA.seed, teamB.seed));

  roundDropdown.querySelectorAll(".round-option").forEach(opt => {
    const code = opt.getAttribute("data-round");
    opt.style.display = allowedRounds.has(code) ? "" : "none";
  });

  // Force user to pick a compatible round
  CURRENT_ROUND = null;
  roundBtn.textContent = "Select Round";
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
          RAW_ROWS = rows;
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
    console.log('[MI] Compare button clicked');

    if (!RAW_ROWS || RAW_ROWS.length === 0) {
      alert('Please upload the tournament CSV first.');
      return;
    }

    const selectA = document.getElementById('teamA');
    const selectB = document.getElementById('teamB');

    if (!selectA || !selectB || !selectA.value || !selectB.value) {
      alert('Please select both teams before comparing.');
      return;
    }

    const teamA = getTeamByName(selectA.value);
    const teamB = getTeamByName(selectB.value);

    if (!teamA || !teamB) {
      alert('Selected teams are not recognized. Try reloading the data.');
      return;
    }

    if (!CURRENT_ROUND) {
      alert('Please select a round before comparing.');
      return;
    }

    // 🔥 ONLY enforce legal rounds when Sandbox mode is OFF
    if (!SANDBOX_MODE) {
      const allowedRounds = getPossibleRoundsForSeeds(teamA.seed, teamB.seed);
      if (!allowedRounds.includes(CURRENT_ROUND)) {
        alert(
          `As seeds ${teamA.seed} and ${teamB.seed}, these teams can only meet in: ` +
          allowedRounds.map(getRoundLabelFromCode).join(', ') +
          `. Please choose one of those rounds.`
        );
        return;
      }
    }

      console.log('[MI] Running compareTeams...');
      compareTeams(selectA.value, selectB.value);
    });
  }

  const editMatchupBtn = document.getElementById('editMatchupBtn');
   if (editMatchupBtn) {
     editMatchupBtn.addEventListener('click', (e) => {
      e.preventDefault();
      hideMatchupBar();
      window.scrollTo({ top: 0, behavior: 'smooth' });
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

// ===== ROUND SELECTOR =====
const roundBtn = document.getElementById("roundSelectBtn");
const roundDropdown = document.getElementById("roundDropdown");

if (roundBtn && roundDropdown) {
  // Initialize button label from CURRENT_ROUND
  roundBtn.textContent = getRoundLabelFromCode(CURRENT_ROUND);

  // Open/close dropdown
  roundBtn.addEventListener("click", () => {
    roundDropdown.classList.toggle("hidden");
  });

  // Handle selecting a round
  roundDropdown.querySelectorAll(".round-option").forEach(opt => {
    opt.addEventListener("click", () => {
      const value = opt.getAttribute("data-round");

      CURRENT_ROUND = value;  // 🔥 Global is updated here

      // Update button label
      roundBtn.textContent = opt.textContent;

      // Hide dropdown
      roundDropdown.classList.add("hidden");

      console.log("[MI] Round selected:", CURRENT_ROUND);
    });
  });

  // Close dropdown if clicking outside
   document.addEventListener("click", (e) => {
    if (!roundDropdown.contains(e.target) && e.target !== roundBtn) {
      roundDropdown.classList.add("hidden");
    }
  });

  // ---- Click-to-flip for team cards ----
  const teamCards = document.querySelectorAll('.team-card');

  teamCards.forEach(card => {
    card.addEventListener('click', (e) => {
      // Ignore clicks on buttons / links so Explain etc. still work normally
      if (
        e.target.closest('button') ||
        e.target.closest('a') ||
        e.target.closest('.link-btn')
      ) {
        return;
      }
      card.classList.toggle('flipped');
    });
  });

  // ---- Click-to-flip for individual tiles (Core, Résumé, Marks) ----
  const flipTiles = document.querySelectorAll('.flip-tile');

  flipTiles.forEach(tile => {
    tile.addEventListener('click', (e) => {
      // Don’t trigger on buttons/links and don’t bubble up to flip whole card
      if (
        e.target.closest('button') ||
        e.target.closest('a') ||
        e.target.closest('.link-btn')
      ) {
        return;
      }
      e.stopPropagation();
      tile.classList.toggle('flipped');
    });
  });
 }

  // ---- Sandbox Mode toggle ----
  const sandboxToggle = document.getElementById('sandboxModeToggle');
if (sandboxToggle) {
  SANDBOX_MODE = sandboxToggle.checked;

  sandboxToggle.addEventListener('change', () => {
    SANDBOX_MODE = sandboxToggle.checked;
    console.log('[MI] Sandbox mode:', SANDBOX_MODE ? 'ON' : 'OFF');

    // here we should re-evaluate round options:
    updateRoundOptionsForCurrentSeeds();
  });
}
}

// ---- ONE dom-ready block (outside the function) ----
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupEventListeners);
} else {
  setupEventListeners();
}