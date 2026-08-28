// Curated views set transparent combinations of filters; every checkbox remains editable.
const PRESETS = {
  ev_vanguard:       { filters: { home_charging_tier: ['Strong'], trajectory_tier: ['Rapid'] } },
  ev_desert:         { filters: { charging_tier: ['Desert'] } },
  rural_aging_fleet: { filters: { geo_tier: ['Rural'], age_tier: ['Aging-skew'] } },
  affluent_adopter:  { filters: { income_tier: ['Higher'], ev_tier: ['Heavy'], trajectory_tier: ['Rapid'] } },
};

let activeFilters = {
  geo_tier: new Set(),
  income_tier: new Set(),
  dwelling_tier: new Set(),
  home_charging_tier: new Set(),
  charging_tier: new Set(),
  ev_tier: new Set(),
  age_tier: new Set(),
  trajectory_tier: new Set(),
  county: new Set(),
};
let selectedLayer = null;
const TOTAL_POP = GEO.features.reduce((s, f) => s + (Number(f.properties.population) || 0), 0);
const TOTAL_VEH = GEO.features.reduce((s, f) => s + (Number(f.properties.total_vehicles_dmv) || 0), 0);

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
const numOr = (v, d = null) => {
  if (v === '' || v === null || v === undefined) return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const fmtInt = v => (v === null || v === undefined || isNaN(v)) ? '-' : Math.round(v).toLocaleString();
const fmtPct = (v, digits = 1) => (v === null || v === undefined || isNaN(v)) ? '-' : v.toFixed(digits) + '%';
const fmtPctRound = v => (v === null || v === undefined || isNaN(v)) ? '-' : Math.round(v) + '%';
const fmtMoney = v => (v === null || v === undefined || isNaN(v)) ? '-' : '$' + Math.round(v).toLocaleString();
// Round-to-nearest-$1K KPI format: $109,767 -> $110K, $187,432 -> $187K
const fmtMoneyK = v => {
  if (v === null || v === undefined || isNaN(v)) return '-';
  if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  return '$' + Math.round(v / 1000) + 'K';
};
const fmtMillions = v => (v === null || v === undefined || isNaN(v)) ? '-' : (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : (v / 1e3).toFixed(0) + 'K');
// Source distances are stored in km; the US exec audience reads miles.
const KM_TO_MI = 0.621371;
const fmtMi = v => (v === null || v === undefined || isNaN(v)) ? '-' : (v * KM_TO_MI).toFixed(1);

let currentView = 'zip';  // 'zip' or 'county'
const matchingCountyFips = new Set();

function matchesFilters(p) {
  for (const key of ['geo_tier','income_tier','dwelling_tier','home_charging_tier','charging_tier','ev_tier','age_tier','trajectory_tier']) {
    const set = activeFilters[key];
    if (set.size > 0 && !set.has(p[key])) return false;
  }
  const cs = activeFilters.county;
  if (cs.size > 0 && !cs.has(p.county)) return false;
  return true;
}

function computeMetrics(feats) {
  function popWeighted(field) {
    let num = 0, den = 0;
    for (const f of feats) {
      const v = numOr(f.properties[field]);
      const w = numOr(f.properties.population, 0);
      if (v !== null && w > 0) { num += v * w; den += w; }
    }
    return den > 0 ? num / den : null;
  }
  function vehWeighted(field) {
    let num = 0, den = 0;
    for (const f of feats) {
      const v = numOr(f.properties[field]);
      const w = numOr(f.properties.total_vehicles_dmv, 0);
      if (v !== null && w > 0) { num += v * w; den += w; }
    }
    return den > 0 ? num / den : null;
  }
  function hhWeighted(field) {
    let num = 0, den = 0;
    for (const f of feats) {
      const v = numOr(f.properties[field]);
      const w = numOr(f.properties.households, 0);
      if (v !== null && w > 0) { num += v * w; den += w; }
    }
    return den > 0 ? num / den : null;
  }
  function vehWeightedPrior(field) {
    // Prior-year shares weighted by the prior-year fleet size, so the YoY anchor aggregates
    // exactly like the current shares (vehWeighted) over the same selected ZIPs.
    let num = 0, den = 0;
    for (const f of feats) {
      const v = numOr(f.properties[field]);
      const w = numOr(f.properties.total_vehicles_dmv_prior, 0);
      if (v !== null && w > 0) { num += v * w; den += w; }
    }
    return den > 0 ? num / den : null;
  }
  const pop = feats.reduce((s, f) => s + (numOr(f.properties.population) || 0), 0);
  const veh = feats.reduce((s, f) => s + (numOr(f.properties.total_vehicles_dmv) || 0), 0);
  const counties = new Set(feats.map(f => f.properties.county_fips).filter(Boolean)).size;
  return {
    zips: feats.length,
    pop,
    pop_share: TOTAL_POP > 0 ? (pop / TOTAL_POP * 100) : 0,
    veh,
    veh_share: TOTAL_VEH > 0 ? (veh / TOTAL_VEH * 100) : 0,
    counties,
    income: hhWeighted('median_hh_income'),
    hcp: hhWeighted('home_charging_proxy'),
    bev: vehWeighted('bev_pct'),
    chargers: popWeighted('stations_per_1k_pop'),
    fuel: {
      ICE: vehWeighted('ice_pct'),
      HEV: vehWeighted('hev_pct'),
      PHEV: vehWeighted('phev_pct'),
      BEV: vehWeighted('bev_pct'),
      Diesel: vehWeighted('diesel_pct'),
      FlexFuel: vehWeighted('flexfuel_pct'),
    },
    fuel_prior: {
      ICE: vehWeightedPrior('ice_pct_prior'),
      HEV: vehWeightedPrior('hev_pct_prior'),
      PHEV: vehWeightedPrior('phev_pct_prior'),
      BEV: vehWeightedPrior('bev_pct_prior'),
    },
    age: {
      new: vehWeighted('pct_new_0_3yr'),
      mid: vehWeighted('pct_mid_4_9yr'),
      old: vehWeighted('pct_old_10plus_yr'),
    },
    age_avg: vehWeighted('avg_vehicle_age'),
    dwelling: {
      sfh: hhWeighted('sfh_pct'),
      mobile: hhWeighted('mobile_home_pct'),
      mud: hhWeighted('mud_pct'),
    },
    nearest_l2: popWeighted('nearest_l2_km'),
    nearest_dcf: popWeighted('nearest_dcfast_km'),
    geo: (() => {
      const c = {Urban: 0, Suburban: 0, Rural: 0};
      for (const f of feats) {
        const t = f.properties.geo_tier;
        if (t in c) c[t] += (numOr(f.properties.population) || 0);
      }
      const tot = c.Urban + c.Suburban + c.Rural;
      return tot > 0 ? {
        urban: c.Urban / tot * 100,
        suburban: c.Suburban / tot * 100,
        rural: c.Rural / tot * 100,
      } : { urban: null, suburban: null, rural: null };
    })(),
  };
}

// Baseline metrics (full footprint, for compare-vs-baseline)
const BASELINE = computeMetrics(GEO.features);

// ------------------------------------------------------------
// County aggregates — group ZIPs by county_fips, compute weighted aggregates
// using the same logic as ZIP-level: household-weighted for income, vehicle-weighted
// for fuel mix, household-weighted for housing/home-charging. True ratios
// (density, chargers/1K) computed as sum/sum, not averaged.
// ------------------------------------------------------------
function aggregateCounty(zipFeats) {
  let pop = 0, hh = 0, vehicles = 0, area = 0, stations = 0, l2 = 0, dcf = 0;
  let nL2num = 0, nL2den = 0, nDCFnum = 0, nDCFden = 0;
  let wBev = 0, wIce = 0, wHev = 0, wPhev = 0, wDiesel = 0, wFlex = 0;
  let wAge = 0, ageDen = 0;
  let wHcp = 0, hcpDen = 0;
  let wInc = 0, incDen = 0;
  let wSfh = 0, sfhDen = 0;
  let wMud = 0, mudDen = 0;
  const geoMix = {Urban: 0, Suburban: 0, Rural: 0};
  for (const f of zipFeats) {
    const p = f.properties;
    const popN = numOr(p.population, 0);
    const hhN = numOr(p.households, 0);
    const vehN = numOr(p.total_vehicles_dmv, 0);
    pop += popN; hh += hhN; vehicles += vehN;
    area += numOr(p.land_area_sqkm, 0);
    stations += numOr(p.ev_stations, 0);
    l2 += numOr(p.ev_level2_ports, 0);
    dcf += numOr(p.ev_dc_fast_ports, 0);
    if (vehN > 0) {
      if (numOr(p.bev_pct) !== null)      wBev += p.bev_pct * vehN;
      if (numOr(p.ice_pct) !== null)      wIce += p.ice_pct * vehN;
      if (numOr(p.hev_pct) !== null)      wHev += p.hev_pct * vehN;
      if (numOr(p.phev_pct) !== null)     wPhev += p.phev_pct * vehN;
      if (numOr(p.diesel_pct) !== null)   wDiesel += p.diesel_pct * vehN;
      if (numOr(p.flexfuel_pct) !== null) wFlex += p.flexfuel_pct * vehN;
      if (numOr(p.avg_vehicle_age) !== null) { wAge += p.avg_vehicle_age * vehN; ageDen += vehN; }
    }
    if (hhN > 0) {
      if (numOr(p.home_charging_proxy) !== null) { wHcp += p.home_charging_proxy * hhN; hcpDen += hhN; }
      if (numOr(p.median_hh_income) !== null) { wInc += p.median_hh_income * hhN; incDen += hhN; }
      if (numOr(p.sfh_pct) !== null) { wSfh += p.sfh_pct * hhN; sfhDen += hhN; }
      if (numOr(p.mud_pct) !== null) { wMud += p.mud_pct * hhN; mudDen += hhN; }
    }
    if (popN > 0) {
      const t = p.geo_tier;
      if (t in geoMix) geoMix[t] += popN;
      if (numOr(p.nearest_l2_km) !== null) { nL2num += p.nearest_l2_km * popN; nL2den += popN; }
      if (numOr(p.nearest_dcfast_km) !== null) { nDCFnum += p.nearest_dcfast_km * popN; nDCFden += popN; }
    }
  }
  const totGeo = geoMix.Urban + geoMix.Suburban + geoMix.Rural;
  let geoDom = null;
  if (totGeo > 0) {
    const ranked = Object.entries(geoMix).sort((a, b) => b[1] - a[1]);
    geoDom = ranked[0][0];
  }
  return {
    zip_count: zipFeats.length,
    population: pop,
    households: hh,
    vehicles,
    land_area_sqkm: area,
    ev_stations: stations,
    ev_level2_ports: l2,
    ev_dc_fast_ports: dcf,
    pop_density_per_sqkm: area > 0 ? pop / area : null,
    stations_per_1k_pop: pop > 0 ? (stations / pop) * 1000 : null,
    bev_pct:    vehicles > 0 ? wBev / vehicles : null,
    ice_pct:    vehicles > 0 ? wIce / vehicles : null,
    hev_pct:    vehicles > 0 ? wHev / vehicles : null,
    phev_pct:   vehicles > 0 ? wPhev / vehicles : null,
    diesel_pct: vehicles > 0 ? wDiesel / vehicles : null,
    flexfuel_pct: vehicles > 0 ? wFlex / vehicles : null,
    avg_vehicle_age: ageDen > 0 ? wAge / ageDen : null,
    home_charging_proxy: hcpDen > 0 ? wHcp / hcpDen : null,
    median_hh_income: incDen > 0 ? wInc / incDen : null,
    sfh_pct: sfhDen > 0 ? wSfh / sfhDen : null,
    mud_pct: mudDen > 0 ? wMud / mudDen : null,
    nearest_l2_km: nL2den > 0 ? nL2num / nL2den : null,
    nearest_dcfast_km: nDCFden > 0 ? nDCFnum / nDCFden : null,
    geo_urban_share: totGeo > 0 ? geoMix.Urban / totGeo * 100 : null,
    geo_dominant: geoDom,
  };
}

// Group ZIPs by county_fips, then bake aggregates into county feature properties
const ZIPS_BY_COUNTY_FIPS = {};
for (const f of GEO.features) {
  const fips = f.properties.county_fips;
  if (!fips) continue;
  if (!ZIPS_BY_COUNTY_FIPS[fips]) ZIPS_BY_COUNTY_FIPS[fips] = [];
  ZIPS_BY_COUNTY_FIPS[fips].push(f);
}
for (const cf of COUNTY_GEO.features) {
  const fips = cf.properties.county_fips;
  const zips = ZIPS_BY_COUNTY_FIPS[fips] || [];
  Object.assign(cf.properties, aggregateCounty(zips));
}

// ------------------------------------------------------------
// Map
// ------------------------------------------------------------
const map = L.map('map', { preferCanvas: true });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19
}).addTo(map);

// ------------------------------------------------------------
// Cluster / color lens — the map fill mode.
//   'segment'  → All clusters: each matching ZIP colored by its family hue (5 families).
//   'cluster'  → one family isolated (selectedCluster): only its ZIPs color, the rest grey.
//   ev/income/age → metric ramp: matching ZIPs shaded on a single-hue gradient.
// Non-matching ZIPs (left-rail filters) always dim to grey so the filter affordance survives.
// Public build: public demographics and vehicle data only.
// ------------------------------------------------------------
let colorMode = 'segment';      // 'segment' (all) · 'cluster' (one) · 'ev'/'income'/'age'
let selectedCluster = null;     // family name when colorMode === 'cluster'

// 5 parent families → one hue each (reuses each family's base-segment color).
const FAMILY_COLORS = {
  'High-income technology suburbs':          '#1B2A4A',  // navy
  'Middle-income suburbs':        '#5b8db8',  // slate-blue
  'Dense renter cities':     '#1f6f5a',  // teal
  'Rural and small-town owners':      '#c08b2a',  // gold
  'Younger Valley families': '#B22222',  // red
};
const FAMILY_LEGEND = [
  ['High-income technology suburbs',          '#1B2A4A'],
  ['Middle-income suburbs',        '#5b8db8'],
  ['Dense renter cities',     '#1f6f5a'],
  ['Rural and small-town owners',      '#c08b2a'],
  ['Younger Valley families', '#B22222'],
];
const METRIC_MODES = {
  ev:     { field: 'bev_pct',          label: 'BEV %',         hue: '#1f6f5a', fmt: v => v.toFixed(1) + '%' },
  income: { field: 'median_hh_income', label: 'Median income', hue: '#41699f', fmt: v => '$' + Math.round(v / 1000) + 'K' },
  age:    { field: 'avg_vehicle_age',  label: 'Fleet age',     hue: '#c08b2a', fmt: v => v.toFixed(1) + ' yr' },
};
function colorVal(p, mode) {
  const f = METRIC_MODES[mode]; return f ? numOr(p[f.field]) : null;
}
// Robust ramp domains: 5th–95th percentile over all ZIPs, so per-ZIP outliers don't flatten
// the gradient. Fixed (not per-selection) so colors stay absolute.
function _pctile(arr, q) {
  const s = arr.slice().sort((a, b) => a - b);
  const i = Math.max(0, Math.min(s.length - 1, Math.round(q * (s.length - 1))));
  return s[i];
}
const COLOR_DOMAINS = {};
for (const _m of Object.keys(METRIC_MODES)) {
  const vals = GEO.features.map(f => colorVal(f.properties, _m)).filter(v => v !== null && !isNaN(v));
  COLOR_DOMAINS[_m] = vals.length ? [_pctile(vals, 0.05), _pctile(vals, 0.95)] : [0, 1];
}

const _GREY = { color: '#b9bec5', weight: 0.18, fillColor: '#f5f3ee', fillOpacity: 0.18 };
function styleFor(feat) {
  const p = feat.properties;
  // Non-matching ZIPs always dim to grey (the filter affordance, preserved in every mode).
  if (!matchesFilters(p)) return _GREY;
  // Isolate one cluster: only the picked family colors; every other matching ZIP greys too.
  if (colorMode === 'cluster') {
    if (p.sc_parent !== selectedCluster) return _GREY;
    return { color: '#0f1117', weight: 0.5, fillColor: FAMILY_COLORS[p.sc_parent] || '#41699f', fillOpacity: 0.82 };
  }
  // All clusters: color each matching ZIP by its family hue (5 families).
  if (colorMode === 'segment') {
    const c = FAMILY_COLORS[p.sc_parent];
    // Unsegmented ZIPs (outside the 748-ZIP base) read as neutral, not a fake cluster.
    if (!c) return { color: '#9aa0a8', weight: 0.3, fillColor: '#d8dce1', fillOpacity: 0.5 };
    return { color: '#0f1117', weight: 0.45, fillColor: c, fillOpacity: 0.78 };
  }
  // Metric ramp.
  const mode = METRIC_MODES[colorMode];
  const v = colorVal(p, colorMode);
  if (v === null) return { color: '#9aa0a8', weight: 0.3, fillColor: '#e9ebee', fillOpacity: 0.4 };
  const d = COLOR_DOMAINS[colorMode];
  const t = d[1] > d[0] ? Math.max(0, Math.min(1, (v - d[0]) / (d[1] - d[0]))) : 0.5;
  return { color: '#0f1117', weight: 0.4, fillColor: mode.hue, fillOpacity: 0.14 + 0.78 * t };
}

// Map legend reflects the active mode: one cluster, the 5-family key, or a min→max ramp.
// It also reports the population of what's currently colored (respects filters + isolation).
function renderLegend() {
  const bar = document.getElementById('map-legend-bar');
  if (!bar) return;
  let _pop = 0;
  for (const f of GEO.features) {
    const p = f.properties;
    if (!matchesFilters(p)) continue;
    if (colorMode === 'cluster' && selectedCluster && p.sc_parent !== selectedCluster) continue;
    _pop += Number(p.population) || 0;
  }
  const popCap = `<span class="legend-pop">${fmtMillions(_pop)} people</span>`;
  const filteredOut = '<span class="legend-item" style="opacity:.65;margin-left:10px"><span class="legend-swatch" style="background:#f5f3ee;box-shadow:inset 0 0 0 1px #c8ccd2"></span>Filtered out</span>';
  if (currentView === 'county') {
    bar.innerHTML = '<span class="legend-key">Counties</span>'
      + '<span class="legend-item"><span class="legend-swatch" style="background:#41699f"></span>Contains a matching ZIP</span>'
      + popCap + filteredOut;
    return;
  }
  if (colorMode === 'cluster') {
    const c = FAMILY_COLORS[selectedCluster] || '#41699f';
    bar.innerHTML = '<span class="legend-key">Cluster</span>'
      + `<span class="legend-item"><span class="legend-swatch" style="background:${c}"></span>${selectedCluster}</span>`
      + popCap + filteredOut;
  } else if (colorMode === 'segment') {
    bar.innerHTML = '<span class="legend-key">Clusters</span>'
      + FAMILY_LEGEND.map(([name, c]) => `<span class="legend-item"><span class="legend-swatch" style="background:${c}"></span>${name}</span>`).join('')
      + popCap + filteredOut;
  } else {
    const mode = METRIC_MODES[colorMode];
    const d = COLOR_DOMAINS[colorMode];
    bar.innerHTML = `<span class="legend-key">${mode.label}</span>`
      + `<span class="legend-cap">${mode.fmt(d[0])}</span>`
      + `<span class="legend-ramp" style="background:linear-gradient(90deg, ${mode.hue}22, ${mode.hue})"></span>`
      + `<span class="legend-cap">${mode.fmt(d[1])}</span>`
      + popCap + filteredOut;
  }
}

function onEach(feat, layer) {
  layer.on({
    mouseover: e => {
      const p = feat.properties;
      e.target.setStyle({ weight: 1.7, color: '#0f1117' });
      // Hover = the "what kind of place is this, should I click?" layer.
      // The full 4-dimension breakdown lives in the click-detail card, not here.
      const bev = numOr(p.bev_pct);
      const age = numOr(p.avg_vehicle_age);
      const cmp = (cur, base) => {
        if (cur === null || base === null) return '';
        const d = cur - base;
        const arrow = Math.abs(d) < 0.5 ? '' : (d > 0 ? ' ▲' : ' ▼');
        return ` <span style="opacity:0.65">(vs ${fmtPctRound(base)}${arrow})</span>`;
      };
      e.target.bindTooltip(
        `<div><strong style="font-size:12px">${p.zcta}</strong> · ${p.county || ''}<br>
        <span style="opacity:0.75">${fmtMillions(numOr(p.population))} people</span><br>
        Fleet age ${age !== null ? age.toFixed(1) + ' yr' : '-'} · <strong>BEV ${fmtPctRound(bev)}</strong>${cmp(bev, BASELINE.bev)}<br>
        <span style="opacity:0.6;font-size:10px">Click for the full profile →</span></div>`,
        { sticky: true }
      ).openTooltip();
    },
    mouseout: e => {
      if (e.target !== selectedLayer) e.target.setStyle(styleFor(feat));
    },
    click: e => {
      if (selectedLayer) selectedLayer.setStyle(styleFor(selectedLayer.feature));
      selectedLayer = e.target;
      e.target.setStyle({ weight: 2.2, color: '#B22222' });
      e.target.bringToFront();
      renderZipDetail(feat.properties);
    }
  });
}

const geoLayer = L.geoJSON(GEO, { style: styleFor, onEachFeature: onEach }).addTo(map);
map.fitBounds(geoLayer.getBounds(), { padding: [18, 18] });

// Keyboard-accessible alternative to clicking a Canvas polygon.
const zipLookup = document.getElementById('zip-lookup');
const zipOptions = document.getElementById('zip-options');
zipOptions.innerHTML = GEO.features
  .map(f => `<option value="${f.properties.zcta} — ${f.properties.county}"></option>`)
  .join('');
zipLookup.addEventListener('change', () => {
  const zcta = zipLookup.value.trim().slice(0, 5);
  let matchedLayer = null;
  geoLayer.eachLayer(layer => {
    if (layer.feature.properties.zcta === zcta) matchedLayer = layer;
  });
  if (!matchedLayer) return;
  setView('zip');
  if (selectedLayer) selectedLayer.setStyle(styleFor(selectedLayer.feature));
  selectedLayer = matchedLayer;
  matchedLayer.setStyle({ weight: 2.2, color: '#B22222' });
  map.fitBounds(matchedLayer.getBounds(), { maxZoom: 11, padding: [24, 24] });
  renderZipDetail(matchedLayer.feature.properties);
});

// Charger point-dots are created only when requested, avoiding 9,244 markers at startup.
const chargerRenderer = L.canvas({ padding: 0.5 });
let chargerLayer = null;
function getChargerLayer() {
  if (chargerLayer) return chargerLayer;
  chargerLayer = L.layerGroup();
  for (const c of CHARGERS) {
    const dcf = c[2];
    L.circleMarker([c[0], c[1]], {
      renderer: chargerRenderer,
      radius: dcf ? 3.2 : 1.5,
      fillColor: dcf ? '#B22222' : '#5b8db8',
      color: dcf ? '#7d1414' : '#5b8db8',
      weight: dcf ? 0.5 : 0,
      fillOpacity: dcf ? 0.92 : 0.45,
    }).addTo(chargerLayer);
  }
  return chargerLayer;
}
let chargersOn = false;
const chargerBtn = document.getElementById('charger-toggle');
chargerBtn.addEventListener('click', () => {
  chargersOn = !chargersOn;
  if (chargersOn) { getChargerLayer().addTo(map); } else if (chargerLayer) { map.removeLayer(chargerLayer); }
  chargerBtn.classList.toggle('active', chargersOn);
  chargerBtn.textContent = chargersOn ? '● Charger locations' : '○ Charger locations';
});

// ------------------------------------------------------------
// County layer (Path B — separate boundary layer with own tooltip)
// ------------------------------------------------------------
function styleForCounty(feat) {
  const matches = matchingCountyFips.has(feat.properties.county_fips);
  return {
    color: matches ? '#0f1117' : '#b9bec5',
    weight: matches ? 1.0 : 0.4,
    fillColor: matches ? '#41699f' : '#f5f3ee',
    fillOpacity: matches ? 0.68 : 0.22,
  };
}

function onEachCounty(feat, layer) {
  layer.on({
    mouseover: e => {
      const p = feat.properties;
      e.target.setStyle({ weight: 2.5, color: '#0f1117' });
      const cmp = (cur, base) => {
        if (cur === null || base === null) return '';
        const d = cur - base;
        const arrow = Math.abs(d) < 0.5 ? '' : (d > 0 ? ' ▲' : ' ▼');
        return ` <span style="opacity:0.65">(vs ${fmtPctRound(base)}${arrow})</span>`;
      };
      const cAge = numOr(p.avg_vehicle_age);
      const countyName = p.county.endsWith(' County') ? p.county : `${p.county} County`;
      e.target.bindTooltip(
        `<div><strong style="font-size:12px">${countyName}</strong><br>
        <span style="opacity:0.75">${p.zip_count} ZIPs · ${fmtMillions(p.population)} people</span><br>
        Fleet age ${cAge !== null ? cAge.toFixed(1) + ' yr' : '-'} · <strong>BEV ${fmtPctRound(p.bev_pct)}</strong>${cmp(p.bev_pct, BASELINE.bev)}<br>
        <span style="opacity:0.6;font-size:10px">Click to drill into ZIPs →</span></div>`,
        { sticky: true }
      ).openTooltip();
    },
    mouseout: e => {
      e.target.setStyle(styleForCounty(feat));
    },
    click: e => {
      // Drill in — filter to this county and switch to ZIP view
      activeFilters.county = new Set([feat.properties.county]);
      syncCheckboxes();
      setView('zip');
    }
  });
}

const countyLayer = L.geoJSON(COUNTY_GEO, {
  style: styleForCounty,
  onEachFeature: onEachCounty,
});

function setView(key) {
  if (key !== 'zip' && key !== 'county') return;
  currentView = key;
  const vsel = document.getElementById('view-select');
  if (vsel && vsel.value !== key) vsel.value = key;  // keep dropdown synced (e.g. county drill-in)
  if (key === 'county') {
    if (map.hasLayer(geoLayer)) map.removeLayer(geoLayer);
    if (!map.hasLayer(countyLayer)) countyLayer.addTo(map);
  } else {
    if (map.hasLayer(countyLayer)) map.removeLayer(countyLayer);
    if (!map.hasLayer(geoLayer)) geoLayer.addTo(map);
  }
  updateAll();
}

document.getElementById('view-select').addEventListener('change', e => setView(e.target.value));

// Color-by lens — recolor the ZIP layer + refresh the legend (county view stays binary).
document.getElementById('color-select').addEventListener('change', e => {
  const v = e.target.value;
  if (v === 'all') { colorMode = 'segment'; selectedCluster = null; }
  else if (METRIC_MODES[v]) { colorMode = v; selectedCluster = null; }
  else { colorMode = 'cluster'; selectedCluster = v; }  // a family name
  updateAll();      // restyles the map AND re-renders the scorecard (isolates to the cluster)
  renderLegend();
});

// ------------------------------------------------------------
// Selection aggregate — weighted demographics + powertrain over the filtered ZIPs (public data).
// Uses population-weighted means and count ratios for the cluster scorecard rows.
// ------------------------------------------------------------

function _scWm(rows, valKey, wtKey) {
  let num = 0, den = 0;
  for (const p of rows) {
    const v = numOr(p[valKey]); const w = numOr(p[wtKey], 0);
    if (v !== null && w > 0) { num += v * w; den += w; }
  }
  return den > 0 ? num / den : null;
}
function _scSum(rows, key) { let s = 0; for (const p of rows) s += numOr(p[key], 0); return s; }

function segAgg(rows) {
  // Aggregate public place descriptors and vehicle outcomes for the live scorecard.
  const raceTot = _scSum(rows, 'sc_race_total') || 1;
  const hhTot   = _scSum(rows, 'sc_hh_total')   || 1;
  const eduPop  = _scSum(rows, 'sc_edu_pop25')  || 1;
  return {
    nzip:    rows.length,
    pop:     _scSum(rows, 'population'),
    income:  _scWm(rows, 'median_hh_income', 'households'),
    age:     _scWm(rows, 'median_age', 'population'),
    density: _scWm(rows, 'pop_density_per_sqkm', 'population'),
    owner:   _scWm(rows, 'owner_occupied_pct', 'households'),
    veh:     _scWm(rows, 'avg_vehicles_per_hh', 'households'),
    bev:     _scWm(rows, 'bev_pct', 'total_vehicles_dmv'),
    hev:     _scWm(rows, 'hev_pct', 'total_vehicles_dmv'),
    phev:    _scWm(rows, 'phev_pct', 'total_vehicles_dmv'),
    asian:   _scSum(rows, 'sc_race_asian_nh') / raceTot * 100,
    hisp:    _scSum(rows, 'sc_race_hispanic') / raceTot * 100,
    kids:    _scSum(rows, 'sc_hh_with_kids') / hhTot * 100,
    ba: (_scSum(rows,'sc_edu_ba')+_scSum(rows,'sc_edu_ma')+_scSum(rows,'sc_edu_prof')+_scSum(rows,'sc_edu_phd')) / eduPop * 100,
  };
}

// ------------------------------------------------------------
// Scorecard of the selection — the five-family table, recomputed over the filtered
// ZIPs (one row per family; pick a cluster above to show just its line). PUBLIC build:
// Public build: demographics and powertrain columns only.
// ------------------------------------------------------------
const SC_COLS = [
  { k:'nzip',    label:'ZIPs',          grp:'size', fmt:'int'    },
  { k:'pop',     label:'People',        grp:'size', fmt:'pop'    },
  { k:'income',  label:'Income',        grp:'who',  fmt:'money'  },
  { k:'age',     label:'Age',           grp:'who',  fmt:'dec1'   },
  { k:'asian',   label:'Asian %',       grp:'who',  fmt:'pct0'   },
  { k:'hisp',    label:'Hisp %',        grp:'who',  fmt:'pct0'   },
  { k:'ba',      label:'College %',     grp:'who',  fmt:'pct0'   },
  { k:'owner',   label:'Owner %',       grp:'who',  fmt:'pct0'   },
  { k:'kids',    label:'Kids %',        grp:'who',  fmt:'pct0'   },
  { k:'density', label:'Density',       grp:'who',  fmt:'int'    },
  { k:'veh',     label:'Veh/HH',        grp:'who',  fmt:'dec1'   },
  { k:'bev',     label:'BEV %',         grp:'beh',  fmt:'dec1'   },
  { k:'hev',     label:'Hybrid %',      grp:'beh',  fmt:'dec1'   },
  { k:'phev',    label:'Plug-in %',     grp:'beh',  fmt:'dec1'   },
];

// Fixed reference stats for cell shading — computed once over ALL segmented ZIPs, so the
// coloring is absolute (stable across filtering AND when a single cluster is isolated; the
// old per-visible-row min/max went blank with one row). base[k] = the full-footprint weighted
// average (the norm we diverge from); spread[k] = the largest family deviation from base
// (sets full saturation); max[k] = the largest family value (magnitude bar for SIZE columns).
const SC_STATS = (() => {
  const famRows = {};
  for (const f of GEO.features) {
    const p = f.properties; if (!p.sc_parent) continue;
    (famRows[p.sc_parent] = famRows[p.sc_parent] || []).push(p);
  }
  const allRows = []; for (const k in famRows) allRows.push(...famRows[k]);
  const base = segAgg(allRows);
  const aggs = Object.keys(famRows).map(k => segAgg(famRows[k]));
  const spread = {}, max = {};
  for (const col of SC_COLS) {
    let mx = 0, sp = 0;
    for (const a of aggs) {
      const v = a[col.k];
      if (v === null || v === undefined || isNaN(v)) continue;
      mx = Math.max(mx, v); sp = Math.max(sp, Math.abs(v - base[col.k]));
    }
    max[col.k] = mx || 1; spread[col.k] = sp || 1;
  }
  return { base, spread, max };
})();

function recomputeScorecard(feats) {
  const fam = {};
  for (const f of feats) {
    const p = f.properties; const par = p.sc_parent;
    if (!par) continue;  // unsegmented ZIPs excluded (748-ZIP scorecard base)
    (fam[par] = fam[par] || []).push(p);
  }
  const out = Object.keys(fam).map(par => ({ family: par, agg: segAgg(fam[par]) }));
  out.sort((a, b) => (b.agg.bev || 0) - (a.agg.bev || 0));  // rank high-EV → low-EV
  return out;
}

function renderScorecard(feats) {
  const host = document.getElementById('seg-scorecard');
  if (!host) return;
  let data = recomputeScorecard(feats);
  // Isolate: when a single cluster is picked, show only its line.
  if (colorMode === 'cluster' && selectedCluster) data = data.filter(d => d.family === selectedCluster);
  if (!data.length) {
    host.innerHTML = '<div class="sc-empty">No segmented ZIPs in this selection. (The scorecard covers the 748-ZIP segmentation base.)</div>';
    return;
  }
  const fmt = (v, f) => {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (f === 'int')    return Math.round(v).toLocaleString();
    if (f === 'pop')    return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.round(v / 1e3) + 'K';
    if (f === 'money')  return '$' + Math.round(v / 1000) + 'k';
    if (f === 'dec1')   return (Math.round(v * 10) / 10).toFixed(1);
    if (f === 'pct0')   return Math.round(v) + '%';
    return v;
  };
  // Cell shading — ONE simple idea: each metric cell is colored by how that cluster compares
  // to the full-footprint average. Blue = above the average, amber = below; the stronger the color,
  // the bigger the gap. Anchored to fixed SC_STATS so it holds even with one cluster isolated.
  // SIZE columns (ZIPs / People) are plain counts — not "vs average" — so they're left unshaded.
  const cellStyle = (v, col) => {
    if (v === null || v === undefined || isNaN(v) || col.grp === 'size') return '';
    const dev = (v - SC_STATS.base[col.k]) / SC_STATS.spread[col.k];
    const t = Math.max(0, Math.min(1, Math.abs(dev)));
    const above = dev >= 0;
    const hue = above ? '65,105,159' : '193,124,42';  // blue = above average · amber = below
    const a = (0.08 + 0.28 * t).toFixed(2);
    return `background: rgba(${hue},${a}); color: inherit`;
  };
  let h = '<table class="sc-table"><thead>';
  h += '<tr class="sc-colrow"><th class="sc-rowhead">Cluster</th>'
     + SC_COLS.map(c => `<th>${c.label}</th>`).join('') + '</tr></thead><tbody>';
  for (const d of data) {
    h += '<tr class="sc-fam"><td class="sc-rowhead">' + d.family + '</td>'
       + SC_COLS.map(c => `<td style="${cellStyle(d.agg[c.k], c)}">${fmt(d.agg[c.k], c.fmt)}</td>`).join('') + '</tr>';
  }
  h += '</tbody></table>';
  host.innerHTML = h;
}

// ------------------------------------------------------------
// Update all
// ------------------------------------------------------------
function updateAll() {
  const matching = GEO.features.filter(f => matchesFilters(f.properties));
  const m = computeMetrics(matching);

  // Build the set of counties with at least one matching ZIP (drives the
  // grey-out behavior on the county layer).
  matchingCountyFips.clear();
  for (const f of matching) matchingCountyFips.add(f.properties.county_fips);

  // Preset active states depend only on activeFilters; refresh first thing.
  if (typeof updatePresetActiveStates === 'function') updatePresetActiveStates();

  // Scorecard-of-selection headline — a live, population-led readout. When one cluster is
  // isolated it scopes to that cluster (and names it); otherwise it sums the whole selection.
  const _sel = document.getElementById('sel-summary');
  const _hf = (colorMode === 'cluster' && selectedCluster)
    ? matching.filter(f => f.properties.sc_parent === selectedCluster)
    : matching;
  const hm = computeMetrics(_hf);
  if (_sel) {
    if (hm.zips === 0) {
      _sel.innerHTML = '<span class="kpi">No ZIPs selected</span>';
    } else {
      const _k = [];
      if (colorMode === 'cluster' && selectedCluster) _k.push(`<span class="kpi"><strong>${selectedCluster}</strong></span>`);
      _k.push(`<span class="kpi">${fmtMillions(hm.pop)} <strong>people</strong></span>`);
      _k.push(`<span class="kpi">${fmtInt(hm.zips)} <strong>ZIPs</strong></span>`);
      _k.push(`<span class="kpi">${fmtPct(hm.bev)} <strong>BEV</strong></span>`);
      _k.push(`<span class="kpi">${hm.age_avg == null ? '-' : hm.age_avg.toFixed(1)} yr <strong>fleet age</strong></span>`);
      _k.push(`<span class="kpi">${fmtMoneyK(hm.income)} <strong>income</strong></span>`);
      _sel.innerHTML = _k.join('');
    }
  }

  // Map title + foot are static now (highlight map, no shading lens). The "what's
  // selected" count lives in the scope bar above the map.

  if (m.zips === 0) {
    document.getElementById('map-empty').hidden = false;  // notify: this combination is empty
    renderScorecard([]);
    geoLayer.setStyle(styleFor);
    if (typeof countyLayer !== 'undefined') countyLayer.setStyle(styleForCounty);
    renderActiveSummary();
    renderLegend();
    return;
  }
  document.getElementById('map-empty').hidden = true;  // results exist — hide the empty-state overlay

  // Recompute the five-family scorecard over the same matching ZIPs shown on the map.
  renderScorecard(matching);

  renderActiveSummary();
  geoLayer.setStyle(styleFor);
  if (typeof countyLayer !== 'undefined') countyLayer.setStyle(styleForCounty);
  renderLegend();
}

// ------------------------------------------------------------
// Active filter summary + count
// ------------------------------------------------------------
// Updates the sidebar active-filter count badge. (The standalone active-filter
// pill bar was removed — the count badge + scope line cover "what's active".)
function renderActiveSummary() {
  let totalActive = 0;
  for (const key of Object.keys(activeFilters)) {
    totalActive += activeFilters[key].size;
  }
  const cnt = document.getElementById('active-count');
  cnt.textContent = totalActive;
  cnt.classList.toggle('none', totalActive === 0);
}

function syncCheckboxes() {
  document.querySelectorAll('input[type="checkbox"][data-filter]').forEach(cb => {
    const key = cb.dataset.filter;
    const val = cb.dataset.value;
    cb.checked = activeFilters[key].has(val);
    cb.closest('.check-row').classList.toggle('active', cb.checked);
  });
  renderCountyPills();
  renderCountyList();
}

// ------------------------------------------------------------
// ZIP detail
// ------------------------------------------------------------
function renderZipDetail(p) {
  const el = document.getElementById('zip-detail');
  const avgAgeValue = numOr(p.avg_vehicle_age);
  const l2Distance = numOr(p.nearest_l2_km);
  const dcFastDistance = numOr(p.nearest_dcfast_km);
  const avgAge = avgAgeValue === null ? '-' : avgAgeValue.toFixed(1) + ' yr';
  const nL2 = l2Distance === null ? '-' : fmtMi(l2Distance) + ' mi';
  const nDCF = dcFastDistance === null ? '-' : fmtMi(dcFastDistance) + ' mi';
  el.innerHTML = `
    <h3>${p.zcta} — ${p.county}</h3>
    <table class="zip-table">
      <tr>
        <th>Snapshot</th>
        <td>Pop ${fmtInt(numOr(p.population))} · ${fmtMoney(numOr(p.median_hh_income))} median income · median age ${p.median_age || '-'}</td>
      </tr>
      <tr>
        <th>Vehicle profile</th>
        <td>ICE ${fmtPct(numOr(p.ice_pct))} · HEV ${fmtPct(numOr(p.hev_pct))} · PHEV ${fmtPct(numOr(p.phev_pct))} · <span class="bev-strong">BEV ${fmtPct(numOr(p.bev_pct))}</span> · Diesel ${fmtPct(numOr(p.diesel_pct))}<br>
        Avg age ${avgAge} · newer-fleet BEV tier ${p.trajectory_tier || '-'} (${fmtPct(numOr(p.pct_new_BEV))} of 0–3-year vehicles are BEVs)</td>
      </tr>
      <tr>
        <th>Housing and geography</th>
        <td>${p.geo_tier || '-'} · Single-family ${fmtPct(numOr(p.sfh_pct))} · Multi-unit ${fmtPct(numOr(p.mud_pct))} · Income tier: ${p.income_tier || '-'}</td>
      </tr>
      <tr>
        <th>Home-charging proxy</th>
        <td><strong>${fmtPct(numOr(p.home_charging_proxy))}</strong> owner-occupied single-family homes — tier: ${p.home_charging_tier || '-'}; not observed charger access</td>
      </tr>
      <tr>
        <th>Public charging</th>
        <td>${p.ev_stations || 0} stations (${p.ev_level2_ports || 0} L2 ports, ${p.ev_dc_fast_ports || 0} DC-fast) · nearest L2 ${nL2} · nearest DC-fast ${nDCF} — tier: ${p.charging_tier || '-'}</td>
      </tr>
      <tr>
        <th>Top makes</th>
        <td>${p.top_makes || '-'}</td>
      </tr>
    </table>
    <button class="filter-action" data-filter-county="${p.county}">Filter to ${p.county}</button>
  `;
  // Let a ZIP detail become an explicit county filter without resetting the other choices.
  el.querySelector('.filter-action').addEventListener('click', () => {
    activeFilters.county.add(p.county);
    syncCheckboxes();
    updateAll();
  });
}

// ------------------------------------------------------------
// Filter UI handlers
// ------------------------------------------------------------
function attachCheckboxHandlers() {
  document.querySelectorAll('input[type="checkbox"][data-filter]').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.filter;
      const val = cb.dataset.value;
      if (cb.checked) activeFilters[key].add(val);
      else activeFilters[key].delete(val);
      cb.closest('.check-row').classList.toggle('active', cb.checked);
      updateAll();
    });
  });
}

// ------------------------------------------------------------
// County search/dropdown
// ------------------------------------------------------------
function renderCountyList() {
  const q = (document.getElementById('county-search').value || '').toLowerCase().trim();
  const list = document.getElementById('county-list');
  const matches = COUNTIES.filter(c => c.toLowerCase().includes(q));
  list.innerHTML = matches.map(c => `
    <label class="county-option">
      <input type="checkbox" data-county="${c}" ${activeFilters.county.has(c) ? 'checked' : ''}>
      <span>${c}</span>
    </label>
  `).join('') || '<div class="county-option" style="color:var(--muted)">No matches</div>';
  list.querySelectorAll('input[data-county]').forEach(cb => {
    cb.addEventListener('change', () => {
      const c = cb.dataset.county;
      if (cb.checked) activeFilters.county.add(c);
      else activeFilters.county.delete(c);
      renderCountyPills();
      updateAll();
    });
  });
}
function renderCountyPills() {
  const wrap = document.getElementById('county-selected');
  wrap.innerHTML = [...activeFilters.county].map(c => `
    <span class="county-pill">${c}<button type="button" class="x" data-county="${c}" aria-label="Remove ${c}">×</button></span>
  `).join('');
  wrap.querySelectorAll('.x').forEach(x => {
    x.addEventListener('click', () => {
      activeFilters.county.delete(x.dataset.county);
      renderCountyPills();
      renderCountyList();
      updateAll();
    });
  });
}
function setupCounty() {
  const search = document.getElementById('county-search');
  const list = document.getElementById('county-list');
  renderCountyList();
  renderCountyPills();
  search.addEventListener('focus', () => list.classList.add('open'));
  search.addEventListener('input', renderCountyList);
  document.addEventListener('click', e => {
    if (!e.target.closest('.county-wrap')) list.classList.remove('open');
  });
}

// ------------------------------------------------------------
// Reset
// ------------------------------------------------------------
document.getElementById('reset-btn').addEventListener('click', () => {
  Object.keys(activeFilters).forEach(k => activeFilters[k] = new Set());
  syncCheckboxes();
  if (selectedLayer) {
    selectedLayer.setStyle(styleFor(selectedLayer.feature));
    selectedLayer = null;
  }
  document.getElementById('zip-detail').innerHTML = `
    <h3>Click a ZIP on the map for full detail</h3>
    <p style="margin: 4px 0 0">Vehicle mix, housing, public charging, and place-level demographics.</p>
  `;
  document.getElementById('county-search').value = '';
  document.getElementById('zip-lookup').value = '';
  updateAll();
});

// Empty-state overlay's "Clear all filters" button reuses the same reset path.
document.getElementById('map-empty-clear').addEventListener('click', () => {
  document.getElementById('reset-btn').click();
});

// ------------------------------------------------------------
// Presets
// ------------------------------------------------------------
function applyPreset(key) {
  // Clear all filters first, then apply the preset's filter set
  Object.keys(activeFilters).forEach(k => activeFilters[k] = new Set());
  const preset = PRESETS[key];
  for (const [filterKey, values] of Object.entries(preset.filters)) {
    for (const v of values) activeFilters[filterKey].add(v);
  }
  syncCheckboxes();
  updateAll();
}

function updatePresetActiveStates() {
  // Reflect the live filter state in the curated-view dropdown: snap to a preset when the
  // filters exactly match its combo, else "Custom" if anything is active, else the full footprint.
  const sel = document.getElementById('curated-view');
  if (!sel) return;
  let matched = '';
  for (const [key, preset] of Object.entries(PRESETS)) {
    const presetKeys = new Set(Object.keys(preset.filters));
    const exactMatch = Object.entries(preset.filters).every(([fk, vs]) =>
      activeFilters[fk].size === vs.length && vs.every(v => activeFilters[fk].has(v))
    );
    const otherActive = Object.entries(activeFilters).some(([fk, set]) =>
      !presetKeys.has(fk) && set.size > 0
    );
    if (exactMatch && !otherActive) { matched = key; break; }
  }
  const anyActive = Object.values(activeFilters).some(s => s.size > 0);
  sel.value = matched || (anyActive ? '__custom__' : '');
}

document.getElementById('curated-view').addEventListener('change', e => {
  const v = e.target.value;
  if (v === '__custom__') return;   // display-only; not a user action
  if (v === '') {                  // Full footprint — clear every filter
    Object.keys(activeFilters).forEach(k => activeFilters[k] = new Set());
    document.getElementById('county-search').value = '';
    syncCheckboxes();
    updateAll();
  } else {
    applyPreset(v);
  }
});

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------
attachCheckboxHandlers();
setupCounty();
renderLegend();  // paint the segment key (default color mode) before first interaction
updateAll();  // styles the layers (styleFor / styleForCounty) + fills scope/rail
