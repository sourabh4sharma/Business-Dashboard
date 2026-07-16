// ============================================================
// Collections Dashboard
// Private, paytm.com-restricted Google Sheet → Apps Script (JSONP).
// Two views: Overview (Summary tab, many tables) and POD Details
// (one POD sheet at a time, chosen from a dropdown). Auto-refreshes
// in place every REFRESH_INTERVAL_MS, only touching the DOM when the
// underlying data actually changed.
// ============================================================
const APPS_SCRIPT_URL =
  "https://script.google.com/a/macros/paytm.com/s/AKfycbypuj2sqF3__N_3gBQ6zJHQdR-RnmrPP-mNmezkRAp1EpPunw4Ct2qiDfehaz_NkY-i/exec";
const APPS_SCRIPT_KEY = "eFZYQGevyYbeiRxswugbkF7YI4BLAcN3";
const REFRESH_INTERVAL_MS = 7000; // Overview auto-refresh cadence
const POD_REFRESH_MS = 30000; // POD auto-refresh cadence (data is large)
const PAGE_SIZE = 1000; // rows fetched per JSONP chunk

// Gemini AI (Overview "Ask about this data"). Paste the API key here once
// you have it. NOTE: this file is public, so the key will be visible in
// source — restrict it in Google AI Studio to the github.io referrer.
const GEMINI_API_KEY = "";
const GEMINI_MODEL = "gemini-2.0-flash";

const SUMMARY_SHEET = "Summary";
const PODS = [
  { label: "D2C & Auto", sheetName: "D2C & Auto POD" },
  { label: "Govt + Telco", sheetName: "Govt + Telco" },
  { label: "CDIT + BFSI", sheetName: "CDIT+BFSI POD" },
  { label: "FMCG North", sheetName: "FMCG North POD" },
  { label: "FMCG South", sheetName: "FMCG - South POD" },
  { label: "FMCG West", sheetName: "FMCG West POD" },
  { label: "Gaming", sheetName: "Gaming POD" },
];

// ---- State ---------------------------------------------------------------
let currentView = "overview"; // "overview" | "pod"
let currentPodIndex = 0;
let podRows = [];
let podColumns = [];
let sortCol = null;
let sortDir = 1;
let lastSnapshotByKey = {};
let lastPodRenderKey = null;
let summaryRowsCache = null; // last Summary rows, for the AI panel
let loadSeq = 0; // guards against overlapping/stale loads
let inFlight = false; // a fetch is currently running
let lastBgAt = 0; // timestamp of the last completed load
const rendered = { overview: false, pod: false };

// ---- Number helpers ------------------------------------------------------
function parseNumber(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (s === "" || s === "#N/A" || s === "N/A" || s === "#DIV/0!") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Amount in ₹ Lakhs → readable string.
function fmtLakh(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const a = Math.abs(n);
  const digits = a >= 1000 ? 0 : a >= 10 ? 1 : 2;
  return n.toLocaleString("en-IN", { maximumFractionDigits: digits });
}

// Amount in ₹ Lakhs → ₹ Crore figure string (value only).
function fmtCrore(lakhs) {
  if (lakhs === null || isNaN(lakhs)) return "—";
  return (lakhs / 100).toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

function fmtPercent(fraction) {
  if (fraction === null || isNaN(fraction)) return "—";
  return (fraction * 100).toFixed(1) + "%";
}

// Raw rupees → auto-scaled ₹ figure (Cr / L / plain).
function fmtRupees(r) {
  if (r === null || isNaN(r)) return "—";
  const a = Math.abs(r);
  if (a >= 1e7) return "₹" + (r / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 1 }) + " Cr";
  if (a >= 1e5) return "₹" + (r / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 1 }) + " L";
  return "₹" + Math.round(r).toLocaleString("en-IN");
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function nowTime() {
  return new Date().toLocaleTimeString();
}

function slug(s) {
  return "sec-" + String(s || "details").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function setBusy(on) {
  const b = document.getElementById("busy");
  if (b) b.hidden = !on;
}

function setProgress(frac) {
  const bar = document.getElementById("loadBar");
  if (!bar) return;
  if (frac === null || frac === undefined) {
    bar.hidden = true;
    bar.style.width = "0%";
    return;
  }
  bar.hidden = false;
  bar.style.width = Math.round(frac * 100) + "%";
}

function findColumnIndex(headerRow, keyword) {
  const kw = keyword.toLowerCase();
  return headerRow.findIndex((h) => (h || "").toLowerCase().includes(kw));
}

// ---- Data fetch (JSONP) --------------------------------------------------
function jsonpFetch(url, params) {
  return new Promise((resolve, reject) => {
    const cbName = "jsonp_cb_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");
    let done = false;
    const cleanup = () => {
      delete window[cbName];
      script.remove();
    };
    window[cbName] = (data) => {
      done = true;
      resolve(data);
      cleanup();
    };
    script.onerror = () => {
      if (!done) {
        reject(new Error("Couldn't reach the data source (JSONP load failed)."));
        cleanup();
      }
    };
    const qs = new URLSearchParams({ ...params, callback: cbName }).toString();
    script.src = url + (url.includes("?") ? "&" : "?") + qs;
    document.body.appendChild(script);
    setTimeout(() => {
      if (!done) {
        reject(new Error("Timed out. Make sure you're signed into your paytm.com Google account."));
        cleanup();
      }
    }, 15000);
  });
}

// Fetch a whole tab in PAGE_SIZE chunks so large POD sheets don't time out
// and we can report real progress. Backward-compatible with an Apps Script
// that ignores start/limit (it returns everything in the first chunk).
async function fetchTabRows(sheetName, onProgress) {
  let start = 1;
  let total = null;
  let all = [];
  // Safety cap: 200 chunks (200k rows) prevents any infinite loop.
  for (let guard = 0; guard < 200; guard++) {
    const data = await jsonpFetch(APPS_SCRIPT_URL, {
      key: APPS_SCRIPT_KEY,
      tab: sheetName,
      start: String(start),
      limit: String(PAGE_SIZE),
    });
    if (data && data.error) throw new Error(data.error);
    const vals = (data && data.values) || [];
    total = data && data.total != null ? Number(data.total) : all.length + vals.length;
    all = all.concat(vals);
    if (onProgress && total > 0) onProgress(Math.min(1, all.length / total));
    start += vals.length;
    if (vals.length === 0 || all.length >= total || vals.length < PAGE_SIZE) break;
  }
  if (onProgress) onProgress(1);
  return all;
}

// ============================================================
// SUMMARY PARSING
// The Summary sheet stacks several tables. Split it into sections:
// a section starts at a single-cell title row, may carry a subtitle
// ("Outstanding amount…"), one header row (detected by keyword), and
// the data rows that follow.
// ============================================================
const HEADER_KEYWORDS = ["3m+ overdue", "target collections", "balance-month start"];

function nonEmptyCount(r) {
  return r.filter((c) => String(c ?? "").trim() !== "").length;
}
function firstText(r) {
  return String(r[0] ?? "").trim();
}
function joinedLower(r) {
  return r.map((c) => String(c ?? "").toLowerCase()).join(" | ");
}

function parseSummarySections(rows) {
  const sections = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.header || cur.rows.length)) sections.push(cur);
    cur = null;
  };

  for (const r of rows) {
    const jl = joinedLower(r);
    const isSubtitle = jl.includes("outstanding amount");
    const isTitle =
      nonEmptyCount(r) === 1 && firstText(r) !== "" && parseNumber(firstText(r)) === null && !isSubtitle;
    const isHeader = nonEmptyCount(r) >= 3 && HEADER_KEYWORDS.some((k) => jl.includes(k));
    const isBlank = nonEmptyCount(r) === 0;

    if (isSubtitle) {
      if (!cur) cur = { title: "", subtitle: "", header: null, rows: [] };
      cur.subtitle = "₹ Lakhs";
      continue;
    }
    if (isTitle) {
      flush();
      cur = { title: firstText(r), subtitle: "", header: null, rows: [] };
      continue;
    }
    if (!cur) cur = { title: "", subtitle: "", header: null, rows: [] };
    if (isHeader) {
      cur.header = r;
      continue;
    }
    if (isBlank) continue;
    cur.rows.push(r);
  }
  flush();

  // Disambiguate repeated titles (two "Summary - All Debtors" tables).
  const seen = {};
  sections.forEach((s) => {
    if (!s.title) return;
    if (seen[s.title]) s.title = s.title + " (grouped)";
    else seen[s.title] = true;
  });
  return sections;
}

function findSection(sections, keyword) {
  const kw = keyword.toLowerCase();
  return sections.find((s) => s.title.toLowerCase().includes(kw));
}

// ============================================================
// OVERVIEW RENDER
// ============================================================
function renderOverview(rows) {
  document.getElementById("podView").hidden = true;
  document.getElementById("overviewView").hidden = false;
  summaryRowsCache = rows;

  const sections = parseSummarySections(rows);

  renderKpis(sections);
  renderCategoryChart(sections);
  renderPodChart(sections);
  renderTargetMeters(sections);
  renderSummaryTables(sections);
}

function renderKpis(sections) {
  const el = document.getElementById("kpiRow");
  const s = findSection(sections, "summary - all debtors");
  if (!s || !s.header) {
    el.innerHTML = "";
    return;
  }
  const h = s.header;
  const totalRow = s.rows.find((r) => /^total/i.test(firstText(r)));
  if (!totalRow) {
    el.innerHTML = "";
    return;
  }

  const iMonthStart = findColumnIndex(h, "total os");
  const iCollected = findColumnIndex(h, "collected this month");
  const iCurrent = findColumnIndex(h, "current balance");

  const monthStart = parseNumber(totalRow[iMonthStart]);
  const collected = parseNumber(totalRow[iCollected]);
  const current = parseNumber(totalRow[iCurrent]);
  const overdue3m = parseNumber(totalRow[iCurrent + 1]);
  const underCredit = parseNumber(totalRow[iCurrent + 3]);

  const tiles = [];

  // Total outstanding, delta vs month start (a drop is good).
  let foot = "";
  if (monthStart) {
    const pct = ((current - monthStart) / monthStart) * 100;
    const down = pct <= 0;
    foot = `<span class="delta ${down ? "up-good" : "down-bad"}">${down ? "▼" : "▲"} ${Math.abs(pct).toFixed(1)}%</span> vs month start`;
  }
  tiles.push(kpiTile("Total outstanding", fmtCrore(current), "Cr", "", foot));

  tiles.push(kpiTile("Collected this month", fmtCrore(collected), "Cr", "accent-good", "month to date"));

  const share = current ? Math.round((overdue3m / current) * 100) : null;
  tiles.push(
    kpiTile("3M+ overdue", fmtCrore(overdue3m), "Cr", "accent-crit", share != null ? `${share}% of the book` : "")
  );

  tiles.push(kpiTile("Under credit", fmtCrore(underCredit), "Cr", "accent-warn", "not yet due"));

  el.innerHTML = tiles.join("");
}

function kpiTile(label, value, unit, accentClass, footHtml) {
  return `<div class="kpi ${accentClass}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">₹${value}<span class="unit">${unit}</span></div>
    <div class="kpi-foot">${footHtml || ""}</div>
  </div>`;
}

// Extract {labels, values} of the "Current Balance" column for the
// non-total, non-auxiliary data rows of a section.
function balanceSeries(section) {
  if (!section || !section.header) return { labels: [], values: [] };
  const iCurrent = findColumnIndex(section.header, "current balance");
  const col = iCurrent === -1 ? section.header.length - 4 : iCurrent;
  const labels = [];
  const values = [];
  section.rows.forEach((r) => {
    const label = firstText(r);
    if (!label) return;
    if (/^total/i.test(label)) return;
    if (/salience|cohort|% collection/i.test(label)) return;
    const v = parseNumber(r[col]);
    if (v === null) return;
    labels.push(label);
    values.push(v);
  });
  return { labels, values };
}

function upsertChart(refKey, canvasId, config) {
  if (window[refKey]) {
    window[refKey].data = config.data;
    window[refKey].options = config.options;
    window[refKey].update();
  } else {
    window[refKey] = new Chart(document.getElementById(canvasId), config);
  }
}

function baseBarOptions({ horizontal }) {
  const muted = cssVar("--muted");
  const grid = cssVar("--grid");
  const line = cssVar("--line");
  const valueAxis = {
    grid: { color: grid, drawTicks: false },
    border: { display: false },
    ticks: { color: muted, callback: (v) => fmtLakh(v) },
  };
  const catAxis = {
    grid: { display: false },
    border: { color: line },
    ticks: { color: muted, autoSkip: false },
  };
  return {
    indexAxis: horizontal ? "y" : "x",
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (c) => " ₹" + fmtLakh(horizontal ? c.parsed.x : c.parsed.y) + " L",
        },
      },
    },
    scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
  };
}

function renderCategoryChart(sections) {
  const s = findSection(sections, "category wise");
  const { labels, values } = balanceSeries(s);
  const colors = [cssVar("--s1"), cssVar("--s2"), cssVar("--s3"), cssVar("--s4"), cssVar("--s5")];
  upsertChart("_categoryChart", "categoryChart", {
    type: "bar",
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: labels.map((_, i) => colors[i % colors.length]), borderRadius: 4, maxBarThickness: 40 }],
    },
    options: baseBarOptions({ horizontal: false }),
  });
}

function renderPodChart(sections) {
  const s = findSection(sections, "direct advertiser");
  const { labels, values } = balanceSeries(s);
  upsertChart("_podChart", "podChart", {
    type: "bar",
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: cssVar("--s1"), borderRadius: 4, maxBarThickness: 22 }],
    },
    options: baseBarOptions({ horizontal: true }),
  });
}

function renderTargetMeters(sections) {
  const panel = document.getElementById("targetPanel");
  const el = document.getElementById("targetMeters");
  const s = findSection(sections, "collection target");
  if (!s || !s.header) {
    panel.hidden = true;
    return;
  }
  const iAch = findColumnIndex(s.header, "% ach");
  if (iAch === -1) {
    panel.hidden = true;
    return;
  }
  const meters = [];
  s.rows.forEach((r) => {
    const label = firstText(r);
    if (!label || /^total/i.test(label)) return;
    const frac = parseNumber(r[iAch]);
    if (frac === null) return;
    const pct = Math.max(0, Math.min(1, frac)) * 100;
    const cls = frac >= 0.75 ? "good" : frac >= 0.4 ? "" : frac >= 0.2 ? "warn" : "low";
    meters.push(`<div class="meter">
      <span class="meter-label">${label}</span>
      <span class="meter-track"><span class="meter-fill ${cls}" style="width:${pct.toFixed(1)}%"></span></span>
      <span class="meter-val">${(frac * 100).toFixed(0)}%</span>
    </div>`);
  });
  if (!meters.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  el.innerHTML = meters.join("");
}

function renderSummaryTables(sections) {
  const container = document.getElementById("summaryTables");
  const nav = document.getElementById("tableNav");
  container.innerHTML = "";
  nav.innerHTML = "";

  const label = document.createElement("span");
  label.className = "table-nav-label";
  label.textContent = "Jump to:";
  nav.appendChild(label);

  sections.forEach((s) => {
    if (!s.header && s.rows.length === 0) return;
    const id = slug(s.title);
    const card = buildSummaryCard(s);
    card.id = id;
    container.appendChild(card);

    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = s.title || "Details";
    chip.addEventListener("click", () => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    nav.appendChild(chip);
  });
}

function buildSummaryCard(section) {
  const card = document.createElement("div");
  card.className = "panel summary-card";

  const head = document.createElement("div");
  head.className = "panel-head";
  head.innerHTML =
    `<h3 class="panel-title">${section.title || "Details"}</h3>` +
    (section.subtitle ? `<span class="panel-sub">${section.subtitle}</span>` : "");
  card.appendChild(head);

  const scroll = document.createElement("div");
  scroll.className = "summary-scroll";
  const table = document.createElement("table");
  table.className = "summary-table";

  const header = section.header || [];
  // Drop the duplicated label column (e.g. "Status","Status").
  const dropDupCol =
    header.length > 1 && String(header[0] ?? "").trim() === String(header[1] ?? "").trim() && header[0];
  const keep = header.map((_, i) => i).filter((i) => !(dropDupCol && i === 1));

  // Per-column percent flag (columns whose header contains "%").
  const pctCol = keep.map((i) => /%/.test(String(header[i] ?? "")));

  if (header.length) {
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    keep.forEach((i) => {
      const th = document.createElement("th");
      th.textContent = String(header[i] ?? "").replace(/\n/g, " ").trim();
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    table.appendChild(thead);
  }

  const tbody = document.createElement("tbody");
  section.rows.forEach((r) => {
    const label = firstText(r);
    const isTotal = /^total/i.test(label) || label === "";
    const isAux = /salience|cohort|% collection/i.test(label);
    const tr = document.createElement("tr");
    if (isTotal) tr.className = "is-total";
    else if (isAux) tr.className = "is-aux";

    keep.forEach((colIdx, k) => {
      const td = document.createElement("td");
      const raw = r[colIdx];
      if (k === 0) {
        td.textContent = raw === undefined || raw === "" ? (isTotal ? "Total" : "") : String(raw);
      } else {
        const n = parseNumber(raw);
        if (n === null) {
          td.textContent = raw === undefined ? "" : String(raw).trim() === "#DIV/0!" ? "—" : String(raw);
        } else if (pctCol[k] || isAux) {
          td.textContent = fmtPercent(n);
        } else {
          td.textContent = fmtLakh(n);
          if (n < 0) td.className = "num-neg";
        }
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  scroll.appendChild(table);
  card.appendChild(scroll);
  return card;
}

// ============================================================
// POD DETAIL RENDER
// ============================================================
function renderPodCards(rows, columns) {
  const findCol = (kw) => columns.find((c) => c.toLowerCase().includes(kw.toLowerCase()));
  const amountCol = findCol("amount");
  const collectedCol = columns.find((c) => c.toLowerCase() === "collected");
  const balanceCol = findCol("balance");
  const statusCol = findCol("collected/not collected") || findCol("collected/ not collected");
  const sum = (col) => rows.reduce((acc, r) => acc + (parseNumber(r[col]) ?? 0), 0);

  const cards = [{ label: "Invoices", value: rows.length.toLocaleString("en-IN"), accent: "" }];
  if (amountCol) cards.push({ label: "Total amount", value: fmtRupees(sum(amountCol)), accent: "" });
  if (balanceCol) cards.push({ label: "Balance outstanding", value: fmtRupees(sum(balanceCol)), accent: "accent-crit" });
  if (collectedCol) cards.push({ label: "Collected", value: fmtRupees(sum(collectedCol)), accent: "accent-good" });
  if (statusCol) {
    const pending = rows.filter((r) => (r[statusCol] || "").trim() && !/^collected$/i.test((r[statusCol] || "").trim())).length;
    cards.push({ label: "Pending items", value: pending.toLocaleString("en-IN"), accent: "accent-warn" });
  }

  document.getElementById("podCards").innerHTML = cards
    .map((c) => `<div class="kpi ${c.accent}"><div class="kpi-label">${c.label}</div><div class="kpi-value" style="font-size:22px">${c.value}</div></div>`)
    .join("");
  return statusCol;
}

function podFindCol(columns, ...keywords) {
  for (const kw of keywords) {
    const c = columns.find((col) => col.toLowerCase().includes(kw.toLowerCase()));
    if (c) return c;
  }
  return null;
}

const AGING_BUCKETS = [
  { key: "Under credit", re: /under\s*credit/i, color: "--s1" },
  { key: "1–30 days", re: /1\s*-\s*30/, color: "--good" },
  { key: "31–60 days", re: /31\s*-\s*60/, color: "--s4" },
  { key: "61–90 days", re: /61\s*-\s*90/, color: "--warning" },
  { key: "91–180 days", re: /91\s*-\s*180/, color: "--serious" },
  { key: "181–365 days", re: /181\s*-\s*365/, color: "--critical" },
  { key: "365+ days", re: /more than 365|365\s*\+|>\s*365/i, color: "--critical" },
];

function miniPanel(title, bodyHtml) {
  return `<div class="panel"><div class="panel-head"><h3 class="panel-title">${title}</h3></div>${bodyHtml}</div>`;
}

function renderPodSummary(rows, columns) {
  const host = document.getElementById("podSummary");
  const panels = [];
  const sum = (col) => rows.reduce((a, r) => a + (parseNumber(r[col]) ?? 0), 0);

  const balanceCol = podFindCol(columns, "balance");
  const statusCol = podFindCol(columns, "collected/not collected", "collected/ not collected");
  const customerCol = podFindCol(columns, "customer name");
  const etaMonthCol = columns.find((c) => /eta.*month/i.test(c));
  const valueCol = columns.find((c) => /^value$/i.test(c.trim())) || null;

  // Aging profile (bar per bucket)
  const buckets = [];
  AGING_BUCKETS.forEach((b) => {
    const col = columns.find((c) => b.re.test(c));
    if (col) buckets.push({ label: b.key, color: b.color, amount: sum(col) });
  });
  if (buckets.length >= 2) {
    const max = Math.max(1, ...buckets.map((b) => Math.abs(b.amount)));
    const body = buckets
      .map((b) => {
        const w = Math.max(0, (Math.abs(b.amount) / max) * 100);
        return `<div class="aging-row">
          <span class="aging-label">${b.label}</span>
          <span class="aging-track"><span class="aging-fill" style="width:${w.toFixed(1)}%;background:var(${b.color})"></span></span>
          <span class="aging-val">${fmtRupees(b.amount)}</span>
        </div>`;
      })
      .join("");
    panels.push(miniPanel("Aging profile", body));
  }

  // Status breakdown
  if (statusCol) {
    const groups = {};
    rows.forEach((r) => {
      const k = (r[statusCol] || "").trim() || "—";
      if (!groups[k]) groups[k] = { count: 0, bal: 0 };
      groups[k].count++;
      if (balanceCol) groups[k].bal += parseNumber(r[balanceCol]) ?? 0;
    });
    const entries = Object.entries(groups).sort((a, b) => b[1].bal - a[1].bal);
    const body = entries
      .map(([k, v]) => `<tr><td>${k}</td><td>${v.count}</td><td>${balanceCol ? fmtRupees(v.bal) : "—"}</td></tr>`)
      .join("");
    panels.push(
      miniPanel(
        "Status breakdown",
        `<table class="mini-table"><thead><tr><th>Status</th><th>Invoices</th><th>Balance</th></tr></thead><tbody>${body}</tbody></table>`
      )
    );
  }

  // Expected collections by ETA month
  if (etaMonthCol) {
    const groups = {};
    rows.forEach((r) => {
      const k = (r[etaMonthCol] || "").trim();
      if (!k) return;
      if (!groups[k]) groups[k] = { count: 0, val: 0 };
      let add = parseNumber(r[valueCol]);
      if (add === null) add = balanceCol ? parseNumber(r[balanceCol]) ?? 0 : 0;
      groups[k].count++;
      groups[k].val += add;
    });
    const entries = Object.entries(groups).sort((a, b) => b[1].val - a[1].val).slice(0, 10);
    if (entries.length) {
      const body = entries
        .map(([k, v]) => `<tr><td>${k}</td><td>${v.count}</td><td>${fmtRupees(v.val)}</td></tr>`)
        .join("");
      panels.push(
        miniPanel(
          "Expected collections by ETA",
          `<table class="mini-table"><thead><tr><th>ETA month</th><th>Invoices</th><th>Expected</th></tr></thead><tbody>${body}</tbody></table>`
        )
      );
    }
  }

  // Top debtors by balance
  if (customerCol && balanceCol) {
    const byCust = {};
    rows.forEach((r) => {
      const k = (r[customerCol] || "").trim();
      if (!k) return;
      byCust[k] = (byCust[k] || 0) + (parseNumber(r[balanceCol]) ?? 0);
    });
    const top = Object.entries(byCust).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) {
      const body = top.map(([k, v]) => `<tr><td title="${k}">${k}</td><td>${fmtRupees(v)}</td></tr>`).join("");
      panels.push(
        miniPanel(
          "Top debtors by balance",
          `<table class="mini-table"><thead><tr><th>Customer</th><th>Balance</th></tr></thead><tbody>${body}</tbody></table>`
        )
      );
    }
  }

  host.innerHTML = panels.join("");
}

function cellContent(r, c, statusColName) {
  const val = r[c] ?? "";
  if (c === statusColName && val) {
    const isCollected = /^collected$/i.test(String(val).trim());
    return { html: `<span class="status-pill ${isCollected ? "status-collected" : "status-pending"}">${val}</span>`, isHtml: true };
  }
  return { html: String(val), isHtml: false };
}

function buildRow(r, columns, statusColName) {
  const tr = document.createElement("tr");
  columns.forEach((c) => {
    const td = document.createElement("td");
    const { html, isHtml } = cellContent(r, c, statusColName);
    if (isHtml) td.innerHTML = html;
    else td.textContent = html;
    tr.appendChild(td);
  });
  return tr;
}

function flashCell(td) {
  td.classList.remove("cell-flash");
  void td.offsetWidth;
  td.classList.add("cell-flash");
}

function updateRowInPlace(tr, r, columns, statusColName) {
  const cells = tr.children;
  columns.forEach((c, i) => {
    const td = cells[i];
    if (!td) return;
    const { html, isHtml } = cellContent(r, c, statusColName);
    if (isHtml) {
      if (td.innerHTML !== html) {
        td.innerHTML = html;
        flashCell(td);
      }
    } else if (td.textContent !== html) {
      td.textContent = html;
      flashCell(td);
    }
  });
}

function renderPodTable() {
  const tableWrap = document.querySelector(".table-wrap");
  const prevScrollTop = tableWrap.scrollTop;
  const searchTerm = document.getElementById("searchBox").value.trim().toLowerCase();
  const statusVal = document.getElementById("statusFilter").value;
  const statusCol = document.getElementById("statusFilter").dataset.col;

  let filtered = podRows.filter((r) => {
    if (statusVal && statusCol && (r[statusCol] || "").trim() !== statusVal) return false;
    if (!searchTerm) return true;
    return podColumns.some((c) => (r[c] || "").toLowerCase().includes(searchTerm));
  });

  if (sortCol) {
    filtered = [...filtered].sort((a, b) => {
      const av = parseNumber(a[sortCol]);
      const bv = parseNumber(b[sortCol]);
      let cmp;
      if (av !== null && bv !== null) cmp = av - bv;
      else cmp = String(a[sortCol] || "").localeCompare(String(b[sortCol] || ""));
      return cmp * sortDir;
    });
  }

  document.getElementById("rowCount").textContent = `${filtered.length} of ${podRows.length} rows`;

  // Rebuild the whole table when the POD, columns, or sort change; otherwise
  // diff cells in place so the periodic refresh doesn't flicker.
  const renderKey = currentPodIndex + "" + podColumns.join("") + sortCol + sortDir + statusVal + searchTerm;
  const structuralChange = lastPodRenderKey !== renderKey;
  lastPodRenderKey = renderKey;

  const statusColName = statusCol;
  const visibleRows = filtered.slice(0, 2000);
  const tbody = document.querySelector("#podTable tbody");
  const existingTrs = tbody.querySelectorAll("tr");

  if (structuralChange || existingTrs.length !== visibleRows.length) {
    const thead = document.querySelector("#podTable thead");
    thead.innerHTML = "";
    const headRow = document.createElement("tr");
    podColumns.forEach((c) => {
      const th = document.createElement("th");
      th.textContent = c + (sortCol === c ? (sortDir === 1 ? " ▲" : " ▼") : "");
      th.addEventListener("click", () => {
        sortDir = sortCol === c ? -sortDir : 1;
        sortCol = c;
        renderPodTable();
      });
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);

    tbody.innerHTML = "";
    visibleRows.forEach((r) => tbody.appendChild(buildRow(r, podColumns, statusColName)));
  } else {
    visibleRows.forEach((r, i) => updateRowInPlace(existingTrs[i], r, podColumns, statusColName));
  }

  tableWrap.scrollTop = prevScrollTop;
}

function renderPod(rows) {
  document.getElementById("overviewView").hidden = true;
  document.getElementById("podView").hidden = false;

  if (!rows.length) throw new Error("This POD returned no data.");
  podColumns = rows[0].map((c) => (c || "").trim()).filter((c) => c !== "");
  const numCols = rows[0].length;
  podRows = rows
    .slice(1)
    .filter((r) => r.some((cell) => (cell || "").trim() !== ""))
    .map((r) => {
      const obj = {};
      for (let i = 0; i < numCols; i++) {
        const key = (rows[0][i] || "").trim();
        if (key) obj[key] = r[i];
      }
      return obj;
    });

  const statusCol = renderPodCards(podRows, podColumns);
  renderPodSummary(podRows, podColumns);

  const statusFilter = document.getElementById("statusFilter");
  const previousSelection = statusFilter.value;
  statusFilter.innerHTML = '<option value="">All statuses</option>';
  statusFilter.dataset.col = statusCol || "";
  if (statusCol) {
    const uniqueVals = [...new Set(podRows.map((r) => (r[statusCol] || "").trim()).filter(Boolean))].sort();
    uniqueVals.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      statusFilter.appendChild(opt);
    });
    if (uniqueVals.includes(previousSelection)) statusFilter.value = previousSelection;
  }

  renderPodTable();
}

// ============================================================
// LOAD / REFRESH
// ============================================================
function currentKey() {
  return currentView === "overview" ? SUMMARY_SHEET : PODS[currentPodIndex].sheetName;
}

async function loadCurrent(opts = {}) {
  const background = !!opts.background;
  const key = currentKey();
  const seq = ++loadSeq;
  inFlight = true;
  const loadingEl = document.getElementById("loadingMsg");
  const errorEl = document.getElementById("errorMsg");
  const lastUpdatedEl = document.getElementById("lastUpdated");

  // First paint of a view shows the big centered spinner; after that we keep
  // the current content on screen and only show a small "busy" spinner, so a
  // refresh or a view/POD switch never blanks the dashboard.
  const firstPaint = !rendered[currentView];
  if (!background) {
    errorEl.hidden = true;
    if (firstPaint) {
      document.getElementById("overviewView").hidden = true;
      document.getElementById("podView").hidden = true;
      loadingEl.hidden = false;
    } else {
      setBusy(true);
    }
  }

  // Progress UI only for foreground loads (never flash it on background ticks).
  const onProgress = background
    ? null
    : (frac) => {
        if (seq !== loadSeq) return;
        setProgress(frac);
        const pct = Math.round(frac * 100);
        if (firstPaint) {
          const t = loadingEl.querySelector("span:last-child");
          if (t) t.textContent = `Loading data… ${pct}%`;
        } else {
          lastUpdatedEl.textContent = `Loading… ${pct}%`;
        }
      };

  try {
    const rows = await fetchTabRows(key, onProgress);
    if (seq !== loadSeq) return; // a newer load superseded this one

    const snapshot = JSON.stringify(rows);
    if (background && lastSnapshotByKey[key] === snapshot) {
      lastUpdatedEl.textContent = "Live · checked " + nowTime();
      return;
    }
    lastSnapshotByKey[key] = snapshot;

    if (currentView === "overview") renderOverview(rows);
    else renderPod(rows);
    rendered[currentView] = true;

    errorEl.hidden = true;
    lastUpdatedEl.textContent = "Live · updated " + nowTime();
  } catch (err) {
    if (seq !== loadSeq) return;
    console.error(err);
    if (!background) {
      errorEl.hidden = false;
      errorEl.textContent = "Couldn't load data.\n\n" + (err && err.message ? err.message : err);
    }
  } finally {
    if (seq === loadSeq) {
      inFlight = false;
      lastBgAt = Date.now();
      if (!background) {
        loadingEl.hidden = true;
        setBusy(false);
        setProgress(null);
        const t = loadingEl.querySelector("span:last-child");
        if (t) t.textContent = "Loading data…";
      }
    }
  }
}

// ---- View switching ------------------------------------------------------
function showView(view) {
  currentView = view;
  document.querySelectorAll(".viewnav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.getElementById("podPicker").hidden = view !== "pod";
  loadCurrent({ background: false });
}

// ---- Auto refresh --------------------------------------------------------
let refreshTimer = null;
let autoRefreshPaused = false;

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  // Tick often, but only actually refresh once the view's cadence has elapsed
  // (Overview is light and refreshes at 7s; POD data is heavy — every 30s).
  refreshTimer = setInterval(() => {
    if (autoRefreshPaused || inFlight || document.visibilityState !== "visible") return;
    const gap = currentView === "overview" ? REFRESH_INTERVAL_MS : POD_REFRESH_MS;
    if (Date.now() - lastBgAt < gap) return;
    loadCurrent({ background: true });
  }, 2000);
}

function setPaused(paused) {
  autoRefreshPaused = paused;
  document.getElementById("pauseBtn").textContent = paused ? "Resume" : "Pause";
  document.getElementById("liveDot").classList.toggle("paused", paused);
}

// ---- Gemini AI (answers only from the Summary tab) -----------------------
async function askGemini(question) {
  const answerEl = document.getElementById("aiAnswer");
  answerEl.hidden = false;
  answerEl.textContent = "Thinking…";

  if (!GEMINI_API_KEY) {
    answerEl.textContent =
      "AI isn't enabled yet — add your Gemini API key to GEMINI_API_KEY in app.js to turn this on.";
    return;
  }
  if (!summaryRowsCache) {
    answerEl.textContent = "Summary data hasn't loaded yet — open the Overview first.";
    return;
  }

  try {
    const body = {
      system_instruction: {
        parts: [
          {
            text:
              "You are a collections analyst assistant for a debtors dashboard. Answer ONLY using the " +
              "Summary data provided below. Amounts are in INR Lakhs unless stated otherwise. If the answer " +
              "is not derivable from the data, say so plainly. Be concise; use short bullets for lists.",
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: `Summary data (rows as JSON):\n${JSON.stringify(summaryRowsCache)}\n\nQuestion: ${question}` }],
        },
      ],
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    const json = await res.json();
    if (!res.ok) throw new Error((json.error && json.error.message) || "HTTP " + res.status);
    const parts = json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
    answerEl.textContent = (parts ? parts.map((p) => p.text).join("") : "").trim() || "No answer returned.";
  } catch (err) {
    answerEl.textContent = "AI error: " + (err && err.message ? err.message : err);
  }
}

function initAi() {
  const note = document.getElementById("aiNote");
  if (!GEMINI_API_KEY) note.textContent = "Enable by adding an API key in app.js";
  document.getElementById("aiForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = document.getElementById("aiInput").value.trim();
    if (q) askGemini(q);
  });
}

// ---- Init ----------------------------------------------------------------
function init() {
  const podSelect = document.getElementById("podSelect");
  PODS.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = p.label;
    podSelect.appendChild(opt);
  });
  podSelect.addEventListener("change", () => {
    currentPodIndex = Number(podSelect.value);
    sortCol = null;
    sortDir = 1;
    loadCurrent({ background: false });
  });

  document.querySelectorAll(".viewnav-btn").forEach((b) => {
    b.addEventListener("click", () => showView(b.dataset.view));
  });

  document.getElementById("refreshBtn").addEventListener("click", () => loadCurrent({ background: false }));
  document.getElementById("pauseBtn").addEventListener("click", () => setPaused(!autoRefreshPaused));
  document.getElementById("searchBox").addEventListener("input", renderPodTable);
  document.getElementById("statusFilter").addEventListener("change", renderPodTable);

  initAi();
  showView("overview");
  startAutoRefresh();
}

init();
