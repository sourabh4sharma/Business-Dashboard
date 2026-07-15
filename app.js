// ---- Configuration -----------------------------------------------------
// The sheet is private and domain-restricted to paytm.com. Data is fetched
// live, on a short interval, straight from an Apps Script web app deployed
// inside that sheet (Execute as: Me) — via JSONP, since a plain fetch()
// would hit the paytm.com Google sign-in wall instead of returning JSON.
// Only works for viewers signed into a paytm.com Google account in-browser.
const APPS_SCRIPT_URL =
  "https://script.google.com/a/macros/paytm.com/s/AKfycbx9lMG4oCmvDNVCUeDY8JdALLsMK5e4iV5Wcv4GqwebvJXfpRsojJeHvcBX_p3qmUpO/exec";
const APPS_SCRIPT_KEY = "eFZYQGevyYbeiRxswugbkF7YI4BLAcN3";
const REFRESH_INTERVAL_MS = 7000;

const TABS = [
  { label: "Summary", sheetName: "Summary", type: "summary" },
  { label: "D2C & Auto POD", sheetName: "D2C & Auto POD", type: "pod" },
  { label: "Govt + Telco", sheetName: "Govt + Telco", type: "pod" },
  { label: "CDIT+BFSI POD", sheetName: "CDIT+BFSI POD", type: "pod" },
  { label: "FMCG North POD", sheetName: "FMCG North POD", type: "pod" },
  { label: "FMCG - South POD", sheetName: "FMCG - South POD", type: "pod" },
  { label: "FMCG West POD", sheetName: "FMCG West POD", type: "pod" },
  { label: "Gaming POD", sheetName: "Gaming POD", type: "pod" },
];

// ---- State ---------------------------------------------------------------
let currentTabIndex = 0;
let podRows = [];
let podColumns = [];
let sortCol = null;
let sortDir = 1;
let lastRawByTab = {}; // sheetName -> JSON snapshot, to skip no-op refreshes

// ---- Helpers ---------------------------------------------------------------
function parseNumber(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (s === "" || s === "#N/A" || s === "N/A") return null;
  const cleaned = s.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(n) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function findColumnIndex(headerRow, keyword) {
  const kw = keyword.toLowerCase();
  return headerRow.findIndex((h) => (h || "").toLowerCase().includes(kw));
}

function findColumnName(columns, keyword) {
  const kw = keyword.toLowerCase();
  return columns.find((c) => c.toLowerCase().includes(kw));
}

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
        reject(new Error("Timed out waiting for data. Make sure you're signed into your paytm.com Google account."));
        cleanup();
      }
    }, 15000);
  });
}

async function fetchTabRows(sheetName) {
  const data = await jsonpFetch(APPS_SCRIPT_URL, { key: APPS_SCRIPT_KEY, tab: sheetName });
  if (data && data.error) throw new Error(data.error);
  return (data && data.values) || [];
}

// ---- Rendering: tabs -----------------------------------------------------
function renderTabNav() {
  const nav = document.getElementById("tabNav");
  nav.innerHTML = "";
  TABS.forEach((tab, i) => {
    const btn = document.createElement("button");
    btn.className = "tab-btn" + (i === currentTabIndex ? " active" : "");
    btn.textContent = tab.label;
    btn.addEventListener("click", () => selectTab(i));
    nav.appendChild(btn);
  });
}

async function selectTab(i) {
  currentTabIndex = i;
  sortCol = null;
  sortDir = 1;
  renderTabNav();
  await loadCurrentTab({ background: false });
}

// ---- Summary tab -----------------------------------------------------------
function renderSummary(rows) {
  document.getElementById("podView").style.display = "none";
  const view = document.getElementById("summaryView");
  view.style.display = "block";

  const headerRowIdx = rows.findIndex((r) =>
    r.some((c) => (c || "").toLowerCase().includes("total os"))
  );
  if (headerRowIdx === -1 || !rows[headerRowIdx + 1]) {
    throw new Error("Could not find the summary table inside the 'Summary' tab.");
  }
  const header = rows[headerRowIdx];
  const data = rows[headerRowIdx + 1];

  const monthStartIdx = findColumnIndex(header, "total os");
  const collectedIdx = findColumnIndex(header, "collected this month");
  const currentIdx = findColumnIndex(header, "current balance");

  const sections = [
    { key: "Total O/S – Month Start", start: monthStartIdx },
    { key: "Collected this Month", start: collectedIdx },
    { key: "Current Balance", start: currentIdx },
  ].filter((s) => s.start !== -1);

  const cardsEl = document.getElementById("summaryCards");
  let cardEls = cardsEl.querySelectorAll(".card");
  if (cardEls.length !== sections.length) {
    cardsEl.innerHTML = "";
    sections.forEach(() => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = '<div class="label"></div><div class="value"></div>';
      cardsEl.appendChild(card);
    });
    cardEls = cardsEl.querySelectorAll(".card");
  }
  sections.forEach((s, i) => {
    const total = parseNumber(data[s.start]);
    const labelEl = cardEls[i].querySelector(".label");
    const valueEl = cardEls[i].querySelector(".value");
    const labelText = `${s.key} (₹ Lakhs)`;
    if (labelEl.textContent !== labelText) labelEl.textContent = labelText;
    valueEl.textContent = formatNumber(total);
    valueEl.className = "value" + (total < 0 ? " neg" : "");
  });

  const labels = ["3M+ Overdue", "0-3M Overdue", "Under Credit"];
  const datasets = sections.map((s, i) => ({
    label: s.key,
    data: [1, 2, 3].map((offset) => parseNumber(data[s.start + offset]) ?? 0),
    backgroundColor: ["#2563eb", "#16a34a", "#f59e0b"][i % 3],
  }));

  const ctx = document.getElementById("agingChart").getContext("2d");
  if (window._agingChart) {
    window._agingChart.data.labels = labels;
    window._agingChart.data.datasets = datasets;
    window._agingChart.update();
  } else {
    window._agingChart = new Chart(ctx, {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        plugins: { title: { display: true, text: "Aging buckets by section (₹ Lakhs)" } },
        scales: { y: { beginAtZero: true } },
      },
    });
  }
}

// ---- POD tab -----------------------------------------------------------
function renderPodCards(rows, columns) {
  const amountCol = findColumnName(columns, "amount");
  const collectedCol = findColumnName(columns, "collected") && columns.find(c => c.toLowerCase() === "collected");
  const balanceCol = findColumnName(columns, "balance");
  const statusCol = findColumnName(columns, "collected/not collected") || findColumnName(columns, "collected/ not collected");

  const sum = (col) => rows.reduce((acc, r) => acc + (parseNumber(r[col]) ?? 0), 0);

  const cards = [
    { label: "Invoices", value: formatNumber(rows.length) },
  ];
  if (amountCol) cards.push({ label: "Total Amount", value: formatNumber(sum(amountCol)) });
  if (collectedCol) cards.push({ label: "Total Collected", value: formatNumber(sum(collectedCol)) });
  if (balanceCol) cards.push({ label: "Total Balance", value: formatNumber(sum(balanceCol)) });
  if (statusCol) {
    const pending = rows.filter((r) => (r[statusCol] || "").trim() && !/^collected$/i.test((r[statusCol] || "").trim())).length;
    cards.push({ label: "Pending Items", value: formatNumber(pending) });
  }

  const cardsEl = document.getElementById("podCards");
  let cardEls = cardsEl.querySelectorAll(".card");
  if (cardEls.length !== cards.length) {
    cardsEl.innerHTML = "";
    cards.forEach(() => {
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = '<div class="label"></div><div class="value"></div>';
      cardsEl.appendChild(el);
    });
    cardEls = cardsEl.querySelectorAll(".card");
  }
  cards.forEach((c, i) => {
    const labelEl = cardEls[i].querySelector(".label");
    const valueEl = cardEls[i].querySelector(".value");
    if (labelEl.textContent !== c.label) labelEl.textContent = c.label;
    valueEl.textContent = c.value;
  });

  return statusCol;
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

  const tbody = document.querySelector("#podTable tbody");
  tbody.innerHTML = "";
  const statusColName = document.getElementById("statusFilter").dataset.col;
  filtered.slice(0, 2000).forEach((r) => {
    const tr = document.createElement("tr");
    podColumns.forEach((c) => {
      const td = document.createElement("td");
      if (c === statusColName && r[c]) {
        const isCollected = /^collected$/i.test(r[c].trim());
        td.innerHTML = `<span class="status-pill ${isCollected ? "status-collected" : "status-pending"}">${r[c]}</span>`;
      } else {
        td.textContent = r[c] ?? "";
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  tableWrap.scrollTop = prevScrollTop;
}

function renderPod(rows) {
  document.getElementById("summaryView").style.display = "none";
  const view = document.getElementById("podView");
  view.style.display = "block";

  if (!rows.length) throw new Error("This tab returned no data.");
  podColumns = rows[0].map((c) => (c || "").trim()).filter((c) => c !== "");
  const numCols = rows[0].length;
  podRows = rows.slice(1)
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

// ---- Load / refresh -----------------------------------------------------
// `background: true` = a periodic auto-refresh of the tab already on screen.
// These must never flash a loading state or tear down the view — only
// touch the DOM if the underlying data actually changed.
async function loadCurrentTab(opts = {}) {
  const background = !!opts.background;
  const tab = TABS[currentTabIndex];
  const loadingEl = document.getElementById("loadingMsg");
  const errorEl = document.getElementById("errorMsg");
  const lastUpdatedEl = document.getElementById("lastUpdated");

  if (!background) {
    document.getElementById("summaryView").style.display = "none";
    document.getElementById("podView").style.display = "none";
    errorEl.style.display = "none";
    loadingEl.style.display = "block";
    loadingEl.textContent = `Loading “${tab.label}”…`;
  }

  try {
    const rows = await fetchTabRows(tab.sheetName);
    const snapshot = JSON.stringify(rows);

    if (background && lastRawByTab[tab.sheetName] === snapshot) {
      lastUpdatedEl.textContent = "Live — checked " + new Date().toLocaleTimeString() + ", no changes";
      return;
    }
    lastRawByTab[tab.sheetName] = snapshot;

    if (tab.type === "summary") renderSummary(rows);
    else renderPod(rows);
    errorEl.style.display = "none";
    lastUpdatedEl.textContent = "Live — updated " + new Date().toLocaleTimeString();
  } catch (err) {
    console.error(err);
    errorEl.style.display = "block";
    errorEl.textContent = "Couldn't load this tab.\n\n" + (err && err.message ? err.message : err);
  } finally {
    if (!background) loadingEl.style.display = "none";
  }
}

let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.visibilityState === "visible") loadCurrentTab({ background: true });
  }, REFRESH_INTERVAL_MS);
}

document.getElementById("refreshBtn").addEventListener("click", () => loadCurrentTab({ background: false }));
document.getElementById("searchBox").addEventListener("input", renderPodTable);
document.getElementById("statusFilter").addEventListener("change", renderPodTable);

renderTabNav();
loadCurrentTab({ background: false });
startAutoRefresh();
