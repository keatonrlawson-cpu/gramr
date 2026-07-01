// Gramr popup script

const RULES_META = [
  { id: "misspelling",       label: "Misspellings",              severity: "error" },
  { id: "its-its",           label: "its vs it's",               severity: "error" },
  { id: "there-their-theyre",label: "their / there / they're",   severity: "error" },
  { id: "your-youre",        label: "your vs you're",            severity: "error" },
  { id: "comma-splice",      label: "Comma splices",             severity: "warning" },
  { id: "intro-clause-comma",label: "Missing commas (intro)",    severity: "warning" },
  { id: "affect-effect",     label: "affect vs effect",          severity: "warning" },
  { id: "who-whom",          label: "who vs whom",               severity: "warning" },
  { id: "fewer-less",        label: "fewer vs less",             severity: "warning" },
  { id: "double-negative",   label: "Double negatives",          severity: "warning" },
  { id: "oxford-comma",      label: "Oxford comma",              severity: "info" },
  { id: "wordy",             label: "Wordy phrases",             severity: "info" },
];

const toggle = document.getElementById("enableToggle");
const app = document.querySelector(".app");
const errCount = document.getElementById("errCount");
const warnCount = document.getElementById("warnCount");
const infoCount = document.getElementById("infoCount");
const statusText = document.getElementById("statusText");
const ruleList = document.getElementById("ruleList");

// Render rule list
for (const rule of RULES_META) {
  const li = document.createElement("li");
  li.className = "rule-item";
  li.innerHTML = `<span class="rule-dot rule-dot--${rule.severity}"></span>${escHtml(rule.label)}`;
  ruleList.appendChild(li);
}

// Load saved state
chrome.storage.sync.get({ enabled: true }, ({ enabled }) => {
  toggle.checked = enabled;
  applyEnabledState(enabled);
});

// Load latest stats (stored by background.js)
const statsStorage = chrome.storage.session ?? chrome.storage.local;
statsStorage.get("latestStats", ({ latestStats }) => {
  if (latestStats) updateStats(latestStats);
});

toggle.addEventListener("change", () => {
  const enabled = toggle.checked;
  chrome.storage.sync.set({ enabled });
  applyEnabledState(enabled);
});

// Listen for live stats from the active tab
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "stats") updateStats(msg.stats);
});

function applyEnabledState(enabled) {
  if (enabled) {
    app.classList.remove("disabled");
  } else {
    app.classList.add("disabled");
    statusText.textContent = "Gramr is paused. Toggle the switch to resume.";
  }
}

function updateStats(stats) {
  errCount.textContent = stats.errors ?? 0;
  warnCount.textContent = stats.warnings ?? 0;
  infoCount.textContent = stats.info ?? 0;

  document.getElementById("statErrors").classList.toggle("has-items", (stats.errors ?? 0) > 0);
  document.getElementById("statWarnings").classList.toggle("has-items", (stats.warnings ?? 0) > 0);
  document.getElementById("statInfo").classList.toggle("has-items", (stats.info ?? 0) > 0);

  const total = stats.total ?? 0;
  if (total === 0) {
    statusText.textContent = "No issues found — great writing!";
  } else {
    statusText.textContent = `${total} suggestion${total !== 1 ? "s" : ""} found. Click the underlines to learn more.`;
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
