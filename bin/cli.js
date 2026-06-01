#!/usr/bin/env node
// codex-proxy CLI — npx codex-anywhere-proxy install
// Node.js compatible (no dependencies). Proxy itself requires Bun.

const { execSync, spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const readline = require("readline");

// ─── Constants ───────────────────────────────────────────────────────
const INSTALL_DIR = path.join(os.homedir(), ".codex-proxy");
const CONFIG_FILE = path.join(INSTALL_DIR, "config.toml");
const CODEX_HOME = path.join(os.homedir(), ".codex");
const CODEX_CONFIG = path.join(CODEX_HOME, "config.toml");
const PID_FILE = path.join(INSTALL_DIR, "proxy.pid");
const LOG_FILE = path.join(INSTALL_DIR, "proxy.log");
const DEFAULT_PORT = 8765;

// Colors
const R = "\x1b[0m";
const RED = "\x1b[0;31m";
const GRN = "\x1b[0;32m";
const YLW = "\x1b[1;33m";
const BLU = "\x1b[0;34m";
const CYN = "\x1b[0;36m";
const BOLD = "\x1b[1m";

// ─── Helpers ─────────────────────────────────────────────────────────
function log(tag, msg) {
  const colors = { ok: GRN, warn: YLW, err: RED, info: BLU };
  const c = colors[tag] || "";
  const prefix = tag === "ok" ? "✓" : tag === "warn" ? "⚠" : tag === "err" ? "✗" : "→";
  console.log(`${c}${prefix}${R} ${msg}`);
}

function ask(question, defaultVal) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const hint = defaultVal ? ` [${defaultVal}]` : "";
    rl.question(`  ${question}${hint}: `, (answer) => {
      rl.close();
      resolve((answer.trim() || defaultVal || "").trim());
    });
  });
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: opts.silent ? "pipe" : "inherit", ...opts });
  } catch (e) {
    if (opts.allowFail) return null;
    throw e;
  }
}

function getBunPath() {
  try { return execSync("which bun", { encoding: "utf-8" }).trim(); }
  catch { return path.join(os.homedir(), ".bun", "bin", "bun"); }
}

/** Reverse lookup: upstream model name → Codex alias (e.g. glm-5.1 → gpt-5.4) */
function aliasForUpstream(upstream, aliases) {
  if (!aliases) return null;
  for (const [alias, target] of Object.entries(aliases)) {
    if (target === upstream) return alias;
  }
  return null;
}

function formatModelDisplay(upstream, aliases) {
  const alias = aliasForUpstream(upstream, aliases);
  return alias ? `${alias} → ${upstream}` : upstream;
}

/**
 * Create ~/.codex-proxy/proxy.log if missing.
 * systemd StandardOutput=append: does NOT create the file on many distros — logs
 * go to journald only until the file exists.
 */
function ensureLogFile() {
  if (!fs.existsSync(INSTALL_DIR)) fs.mkdirSync(INSTALL_DIR, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, "");
  }
}

function isSystemdProxyActive() {
  if (getPlatform() !== "linux") return false;
  try {
    return run("systemctl --user is-active codex-proxy", { silent: true }).trim() === "active";
  } catch {
    return false;
  }
}

// ─── config.toml read/write ──────────────────────────────────────────
function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  const text = fs.readFileSync(CONFIG_FILE, "utf-8");
  const result = {};
  let current = result;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      result[name] = result[name] || {};
      current = result[name];
      continue;
    }
    const kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      let val = kvMatch[2].trim();
      const ci = val.indexOf(" #");
      if (ci > 0) val = val.slice(0, ci).trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      else if (/^\d+$/.test(val)) val = parseInt(val, 10);
      else if (val === "true") val = true;
      else if (val === "false") val = false;
      else if (val.startsWith("[") && val.endsWith("]")) {
        val = val.slice(1, -1).split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
      }
      current[key] = val;
    }
  }
  return result;
}


/**
 * Maps upstream model names to Codex CLI-compatible aliases.
 * Codex CLI only allows spawn_agent for models it knows (gpt-*, o3, o4).
 * Auto-detects best match based on the upstream model name.
 */
const CODEX_MODEL_MAP = [
  { pattern: /^glm-5\.1$/i,        codex: "gpt-5.4",       vision: "gpt-5.4" },
  { pattern: /^glm-5$/i,            codex: "gpt-5.4",       vision: "gpt-5.4" },
  { pattern: /^glm-5-turbo$/i,      codex: "gpt-5.4-mini",  vision: "gpt-5.4-mini" },
  { pattern: /^glm-5v-turbo$/i,     codex: "gpt-5.4-mini",  vision: "gpt-5.4-mini" },
  { pattern: /^glm-4\.7$/i,        codex: "gpt-5.2",       vision: "gpt-5.2" },
  { pattern: /^glm-4$/i,            codex: "gpt-5.2",       vision: "gpt-5.2" },
  { pattern: /^deepseek-chat$/i,    codex: "gpt-5.4-mini",  vision: "gpt-5.4-mini" },
  { pattern: /^deepseek-reasoner/i, codex: "o4-mini",       vision: "o4-mini" },
  { pattern: /^deepseek/i,          codex: "gpt-5.4-mini",  vision: "gpt-5.4-mini" },
  { pattern: /^qwen/i,              codex: "gpt-5.4-mini",  vision: "gpt-5.4-mini" },
  { pattern: /^llama/i,             codex: "gpt-5.4-mini",  vision: "gpt-5.4-mini" },
  { pattern: /^mistral/i,           codex: "gpt-5.4-mini",  vision: "gpt-5.4-mini" },
  { pattern: /^claude/i,            codex: "gpt-5.4",       vision: "gpt-5.4" },
  { pattern: /^gemini/i,            codex: "gpt-5.4",       vision: "gpt-5.4" },
  { pattern: /^minimax/i,           codex: "gpt-5.4-mini",  vision: "gpt-5.4-mini" },
  { pattern: /^gpt-/i,             codex: null,             vision: null },
  { pattern: /^o[34]/i,            codex: null,             vision: null },
];

function getCodexAlias(modelName, forVision = false) {
  if (!modelName) return null;
  if (/^(gpt-|o[34]|codex)/i.test(modelName)) return null;
  for (const entry of CODEX_MODEL_MAP) {
    if (entry.pattern.test(modelName)) {
      return forVision ? (entry.vision || entry.codex) : entry.codex;
    }
  }
  return "gpt-5.4-mini";
}

function writeConfig(config) {
  const lines = [
    "# codex-proxy configuration",
    "# Reconfigure anytime: codex-proxy config",
    "",
    "[proxy]",
    `upstream = "${config.proxy?.upstream || ""}"`,
    `api_key = "${config.proxy?.api_key || ""}"`,
    `port = ${config.proxy?.port || DEFAULT_PORT}`,
    `filter_non_function_tools = ${config.proxy?.filter_non_function_tools !== false}`,
    `debug = ${config.proxy?.debug === true}`,
    "",
    "[models]",
  ];

  const available = config.models?.available || [];
  if (available.length > 0) {
    lines.push(`available = [${available.map(m => `"${m}"`).join(", ")}]`);
  } else {
    lines.push("available = []");
  }

  lines.push(`active = "${config.models?.active || ""}"`);
  lines.push(`context_window = ${config.models?.context_window || 200000}`);

  // Write [aliases] section for Codex CLI compatibility
  const aliases = config.aliases || {};
  const aliasEntries = Object.entries(aliases).filter(([k, v]) => k && v);
  if (aliasEntries.length > 0) {
    lines.push("");
    lines.push("[aliases]");
    for (const [alias, target] of aliasEntries) {
      lines.push(`${alias} = "${target}"`);
    }
  }

  lines.push("");

  fs.writeFileSync(CONFIG_FILE, lines.join("\n"));
}

function getPort() {
  const config = readConfig();
  return config.proxy?.port || DEFAULT_PORT;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function isProxyRunning() {
  const port = getPort();
  try {
    const { status } = await httpGet(`http://localhost:${port}/health`);
    return status === 200;
  } catch {
    return false;
  }
}

function banner() {
  console.log("");
  console.log(`${BLU}╔══════════════════════════════════════════════════╗`);
  console.log(`║          codex-proxy — CLI                       ║`);
  console.log(`║  Use Codex CLI with any OpenAI-compatible API    ║`);
  console.log(`╚════════════════════════════════════════════════════╝${R}`);
  console.log("");
}

function getPackageDir() {
  return path.resolve(__dirname, "..");
}

function getProxyTs() {
  const installed = path.join(INSTALL_DIR, "proxy.ts");
  if (fs.existsSync(installed)) return installed;
  const local = path.join(getPackageDir(), "proxy.ts");
  if (fs.existsSync(local)) return local;
  return null;
}

// ─── Platform detection ──────────────────────────────────────────────
function getPlatform() {
  const p = os.platform();
  if (p === "linux") return "linux";
  if (p === "darwin") return "macos";
  if (p.startsWith("win")) return "windows";
  return "unknown";
}

// ─── Checkbox model selector ─────────────────────────────────────────
async function selectModels(models, preselected) {
  // models: [{id, context_window, ...}]
  // preselected: ["glm-5.1", "glm-5-turbo"]
  // Returns: ["glm-5.1", "glm-4.7", ...]

  const selected = new Set(preselected || []);
  let cursor = 0;

  // Default: if nothing preselected, select first model
  if (selected.size === 0 && models.length > 0) {
    selected.add(models[0].id);
  }

  function render() {
    // Clear and redraw: move up, clear to end, redraw all lines
    const lines = models.length + 3;
    process.stdout.write(`\x1b[${lines}A`);
    process.stdout.write("\x1b[J");

    process.stdout.write(`  ${BOLD}Select models (↑/↓ move, Space toggle, Enter confirm):${R}\r\n`);
    process.stdout.write("\r\n");
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      const isChecked = selected.has(m.id);
      const isCursor = i === cursor;
      const checkbox = isChecked ? `${GRN}◆${R}` : `${YLW}◇${R}`;
      const ctx = `ctx:${(m.context_window / 1000).toFixed(0)}k`;
      const marker = isCursor ? `${BLU}❯${R} ` : "  ";
      process.stdout.write(`  ${marker}${checkbox} ${isCursor ? BOLD : ""}${m.id}${R}  ${YLW}${ctx}${R}\r\n`);
    }
  }

  // Initial render
  process.stdout.write("\r\n");
  process.stdout.write(`  ${BOLD}Select models (↑/↓ move, Space toggle, Enter confirm):${R}\r\n`);
  process.stdout.write("\r\n");
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const isChecked = selected.has(m.id);
    const checkbox = isChecked ? `${GRN}◆${R}` : `${YLW}◇${R}`;
    const ctx = `ctx:${(m.context_window / 1000).toFixed(0)}k`;
    const marker = i === cursor ? `${BLU}❯${R} ` : "  ";
    process.stdout.write(`  ${marker}${checkbox} ${i === cursor ? BOLD : ""}${m.id}${R}  ${YLW}${ctx}${R}\r\n`);
  }

  return new Promise((resolve) => {
    // Check if stdin is a TTY (interactive terminal)
    if (!process.stdin.isTTY) {
      // Non-interactive: return preselected or all
      const result = selected.size > 0 ? [...selected] : models.map(m => m.id);
      resolve(result);
      return;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdin.setRawMode(true);
    process.stdin.resume();

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      rl.close();
    }

    process.stdin.on("data", (key) => {
      const seq = key.toString();

      if (seq === "\u001b[A" || seq === "k") {
        // Up
        cursor = (cursor - 1 + models.length) % models.length;
        render();
      } else if (seq === "\u001b[B" || seq === "j") {
        // Down
        cursor = (cursor + 1) % models.length;
        render();
      } else if (seq === " ") {
        // Toggle
        const id = models[cursor].id;
        if (selected.has(id)) {
          // Don't allow deselecting if it's the last one
          if (selected.size > 1) selected.delete(id);
        } else {
          selected.add(id);
        }
        render();
      } else if (seq === "\r" || seq === "\n") {
        // Enter — confirm
        cleanup();
        const result = [...selected];
        console.log("");
        console.log(`  ${GRN}Selected:${R} ${result.join(", ")}`);
        console.log("");
        resolve(result);
      } else if (seq === "\u0003") {
        // Ctrl+C
        cleanup();
        process.exit(0);
      }
    });
  });
}

/** Copy proxy runtime files from npm package → ~/.codex-proxy (config.toml untouched). */
function syncProxyFiles() {
  const srcDir = getPackageDir();
  if (!fs.existsSync(INSTALL_DIR)) fs.mkdirSync(INSTALL_DIR, { recursive: true });
  ensureLogFile();

  for (const [src, dest] of [["proxy.ts", "proxy.ts"], ["package.json", "package.json"]]) {
    const srcPath = path.join(srcDir, src);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(INSTALL_DIR, dest));
    }
  }

  const srcModuleDir = path.join(srcDir, "src");
  if (fs.existsSync(srcModuleDir)) {
    const destSrc = path.join(INSTALL_DIR, "src");
    if (!fs.existsSync(destSrc)) fs.mkdirSync(destSrc, { recursive: true });
    for (const f of fs.readdirSync(srcModuleDir)) {
      if (f.endsWith(".ts")) {
        fs.copyFileSync(path.join(srcModuleDir, f), path.join(destSrc, f));
      }
    }
  }
}

function readInstalledVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return null;
  }
}

// ─── Commands ────────────────────────────────────────────────────────

async function cmdInstall() {
  banner();
  const platform = getPlatform();
  log("info", `Platform: ${platform}`);

  // ── Check Bun
  let bunPath = getBunPath();
  if (!fs.existsSync(bunPath)) {
    log("warn", "Bun not found. Installing...");
    run("curl -fsSL https://bun.sh/install | bash", { silent: true });
    bunPath = getBunPath();
    if (!fs.existsSync(bunPath)) {
      log("err", "Bun installation failed. Install manually: https://bun.sh");
      process.exit(1);
    }
  }
  log("ok", `Bun: ${bunPath}`);

  // ── Check Codex CLI
  try {
    const codexPath = run("which codex", { silent: true }).trim();
    log("ok", `Codex: ${codexPath}`);
  } catch {
    log("warn", "Codex CLI not found. Install: https://github.com/openai/codex");
  }

  syncProxyFiles();
  log("ok", `Proxy installed to ${INSTALL_DIR}`);

  // ── Interactive Configuration
  const config = await configureProvider();

  // ── Configure Codex
  configureCodex(config);

  // ── Setup service
  await setupService(bunPath, platform);

  // ── Done
  console.log("");
  console.log(`${GRN}╔══════════════════════════════════════════════════╗`);
  console.log(`║  ✓  Installation complete!                       ║`);
  console.log(`╚══════════════════════════════════════════════════╝${R}`);
  console.log("");
  const displayModel = formatModelDisplay(config.models.active, config.aliases);
  console.log(`  Provider: ${config.proxy.upstream}`);
  console.log(`  Model:    ${displayModel}`);
  console.log("");
  console.log("  Start coding:");
  console.log(`    ${BLU}codex${R}`);
  console.log("");
  console.log("  Reconfigure anytime:");
  console.log(`    ${BLU}codex-proxy config${R}`);
  console.log("");
}

async function cmdConfig() {
  banner();
  console.log(`${CYN}═══ Reconfigure codex-proxy ═══${R}`);
  console.log("");

  if (!fs.existsSync(INSTALL_DIR)) {
    log("err", "codex-proxy is not installed. Run: npx codex-anywhere-proxy install");
    process.exit(1);
  }

  const config = await configureProvider();
  configureCodex(config);

  console.log("");
  log("ok", "Configuration updated!");

  // Restart if running
  if (await isProxyRunning()) {
    console.log("");
    log("info", "Restarting proxy...");
    await restartService();
  } else {
    console.log("");
    console.log("  Restart the proxy:");
    console.log(`    ${BLU}codex-proxy start${R}`);
  }
  console.log("");
}

async function cmdStart() {
  const proxyTs = getProxyTs();
  if (!proxyTs) {
    log("err", "Proxy not installed. Run: npx codex-anywhere-proxy install");
    process.exit(1);
  }

  if (await isProxyRunning()) {
    log("info", "Proxy is already running.");
    return;
  }

  const bunPath = getBunPath();
  const port = getPort();
  ensureLogFile();

  // Try systemctl first
  if (getPlatform() === "linux") {
    try {
      // Clear any failed state from previous crash loop before starting
      run("systemctl --user reset-failed codex-proxy.service", { silent: true, allowFail: true });
      run("systemctl --user start codex-proxy", { silent: true });
      await new Promise((r) => setTimeout(r, 1500));
      if (await isProxyRunning()) {
        log("ok", `Proxy started (systemd, port ${port})`);
        log("info", `Logs: ${LOG_FILE}`);
        return;
      }
    } catch {}
  }

  if (getPlatform() === "macos") {
    try {
      run("launchctl load ~/Library/LaunchAgents/com.codex-proxy.plist 2>/dev/null", { silent: true, allowFail: true });
      await new Promise((r) => setTimeout(r, 1500));
      if (await isProxyRunning()) {
        log("ok", `Proxy started (launchd, port ${port})`);
        return;
      }
    } catch {}
  }

  // Fallback: start directly
  log("info", "Starting proxy directly...");
  const child = spawn(bunPath, ["run", proxyTs], {
    cwd: INSTALL_DIR,
    detached: true,
    stdio: ["ignore", fs.openSync(LOG_FILE, "a"), fs.openSync(LOG_FILE, "a")],
  });
  child.unref();

  // Write PID
  fs.writeFileSync(PID_FILE, String(child.pid));

  // Wait for health
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isProxyRunning()) {
      log("ok", `Proxy started on port ${port} (PID ${child.pid})`);
      log("info", `Logs: ${LOG_FILE}`);
      return;
    }
  }

  log("err", "Proxy failed to start. Check logs: " + LOG_FILE);
  process.exit(1);
}

async function cmdStop() {
  // Try systemctl first
  if (getPlatform() === "linux") {
    try {
      run("systemctl --user stop codex-proxy", { silent: true });
      await new Promise((r) => setTimeout(r, 500));
      if (!(await isProxyRunning())) {
        log("ok", "Proxy stopped (systemd)");
        return;
      }
    } catch {}
  }

  if (getPlatform() === "macos") {
    try {
      run("launchctl unload ~/Library/LaunchAgents/com.codex-proxy.plist 2>/dev/null", { silent: true, allowFail: true });
      await new Promise((r) => setTimeout(r, 500));
      if (!(await isProxyRunning())) {
        log("ok", "Proxy stopped (launchd)");
        return;
      }
    } catch {}
  }

  // Kill by PID file
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    try {
      process.kill(pid, "SIGTERM");
      fs.unlinkSync(PID_FILE);
      log("ok", `Proxy stopped (PID ${pid})`);
      return;
    } catch {}
  }

  // Last resort: kill by port
  const port = getPort();
  try {
    if (getPlatform() === "windows") {
      run(`netstat -ano | findstr :${port} | findstr LISTENING`);
    } else {
      const pids = run(`lsof -ti:${port}`, { silent: true }).trim().split("\n").filter(Boolean);
      for (const pid of pids) {
        try { process.kill(parseInt(pid), "SIGTERM"); } catch {}
      }
      if (pids.length > 0) {
        log("ok", `Proxy stopped (killed ${pids.length} process(es) on port ${port})`);
        return;
      }
    }
  } catch {}

  log("warn", "Proxy is not running.");
}

async function cmdUpgrade() {
  if (!fs.existsSync(INSTALL_DIR)) {
    log("err", "codex-proxy is not installed. Run: codex-proxy install");
    process.exit(1);
  }

  let cliVersion = "unknown";
  try {
    cliVersion = JSON.parse(fs.readFileSync(path.join(getPackageDir(), "package.json"), "utf-8")).version;
  } catch {}

  const prev = readInstalledVersion();
  syncProxyFiles();
  const next = readInstalledVersion();

  log("ok", `CLI package v${cliVersion} → synced to ${INSTALL_DIR}`);
  if (prev && next && prev !== next) {
    log("ok", `Runtime updated: v${prev} → v${next}`);
  } else if (prev === next) {
    log("info", `Runtime already at v${next ?? cliVersion}`);
  }

  if (await isProxyRunning()) {
    log("info", "Restarting proxy...");
    await restartService();
  }

  console.log("");
  console.log(`  ${BLU}codex-proxy status${R}  — verify version`);
  console.log("");
}

async function cmdRestart() {
  await restartService();
}

async function restartService() {
  await cmdStop();
  await new Promise((r) => setTimeout(r, 500));
  await cmdStart();
}

async function cmdStatus() {
  const port = getPort();
  const running = await isProxyRunning();

  if (!running) {
    console.log("");
    log("warn", "Proxy is not running.");
    console.log(`  Start: ${BLU}codex-proxy start${R}`);
    console.log("");
    return;
  }

  try {
    const { body } = await httpGet(`http://localhost:${port}/health`);
    const health = JSON.parse(body);
    console.log("");
    console.log(`${GRN}●${R} Proxy running on port ${port}`);
    console.log(`  Version:  ${health.version}`);
    console.log(`  Upstream: ${health.upstream}`);
    console.log(`  API Key:  ${health.hasApiKey ? GRN + "configured" + R : RED + "missing" + R}`);

    // Show config
    const config = readConfig();
    const aliases = config.aliases || {};
    if (config.models?.active) {
      console.log(`  Model:    ${formatModelDisplay(config.models.active, aliases)}`);
    }
    if (config.models?.available?.length > 0) {
      const availDisplay = config.models.available.map(m => formatModelDisplay(m, aliases));
      console.log(`  Available: ${availDisplay.join(", ")}`);
    }

    // Also get stats
    try {
      const { body: statsBody } = await httpGet(`http://localhost:${port}/stats`);
      const stats = JSON.parse(statsBody);
      if (stats.cumulative) {
        console.log(`  Requests: ${stats.cumulative.request_count || 0}`);
        console.log(`  Tokens:   ${((stats.cumulative.input_tokens || 0) + (stats.cumulative.output_tokens || 0)).toLocaleString()}`);
      }
    } catch {}

    console.log("");
  } catch (e) {
    console.log("");
    log("warn", `Proxy running but health check failed: ${e.message}`);
    console.log("");
  }
}

async function cmdModels() {
  const port = getPort();

  if (!(await isProxyRunning())) {
    log("err", "Proxy is not running. Start it first: codex-proxy start");
    process.exit(1);
  }

  try {
    const { body } = await httpGet(`http://localhost:${port}/models/filtered`);
    const data = JSON.parse(body);
    const models = data.models || [];
    const config = readConfig();

    console.log("");
    console.log(`${BOLD}Available Models${R} (${models.length} filtered)`);
    console.log(`${"─".repeat(60)}`);

    for (const m of models) {
      const ctx = m.context_window ? `ctx:${(m.context_window / 1000).toFixed(0)}k` : "";
      const isActive = m.id === config.models?.active;
      const isSelected = (config.models?.available || []).includes(m.id);
      const marker = isActive ? `${GRN}●${R} ` : isSelected ? `${GRN}◆${R} ` : "  ";
      console.log(`  ${marker}${BLU}${m.id}${R}${ctx ? "  " + YLW + ctx + R : ""}${isActive ? " (active)" : ""}`);
    }

    console.log(`${"─".repeat(60)}`);
    console.log(`  Reconfigure: ${BLU}codex-proxy config${R}`);
    console.log("");
  } catch (e) {
    log("err", `Failed to fetch models: ${e.message}`);
  }
}

async function cmdLogs() {
  const hasLogFile = fs.existsSync(LOG_FILE);
  const logSize = hasLogFile ? fs.statSync(LOG_FILE).size : 0;

  if (hasLogFile && logSize > 0) {
    try {
      if (getPlatform() === "windows") {
        run(`type ${LOG_FILE}`);
      } else {
        execFileSync("tail", ["-n", "50", "-f", LOG_FILE], { stdio: "inherit" });
      }
    } catch {
      // tail interrupted (Ctrl+C)
    }
    return;
  }

  // Proxy running via systemd but append: never created the file — logs are in journald
  if (isSystemdProxyActive()) {
    log("warn", `Log file empty or missing: ${LOG_FILE}`);
    log("info", "Proxy is running (systemd). Showing journalctl instead.");
    log("info", "Fix permanently: codex-proxy restart (creates proxy.log on start)");
    try {
      execFileSync(
        "journalctl",
        ["--user", "-u", "codex-proxy", "-n", "80", "-f", "--no-pager"],
        { stdio: "inherit" },
      );
    } catch {
      // journalctl interrupted
    }
    return;
  }

  if (hasLogFile && logSize === 0) {
    log("warn", `Log file exists but is empty: ${LOG_FILE}`);
    log("info", "Restart proxy after enabling debug in config.toml: codex-proxy restart");
    return;
  }

  log("warn", "No log file found. Proxy may not have been started yet.");
  log("info", `Expected: ${LOG_FILE}`);
  log("info", "Start: codex-proxy start");
}

function cmdVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(getPackageDir(), "package.json"), "utf-8"));
    const installed = readInstalledVersion();
    console.log(`codex-proxy CLI v${pkg.version}`);
    if (installed) {
      console.log(`codex-proxy runtime (~/.codex-proxy) v${installed}`);
      if (installed !== pkg.version) {
        log("warn", "CLI and runtime versions differ — run: codex-proxy upgrade");
      }
    }
  } catch {
    console.log("codex-proxy (version unknown)");
  }
}

// ─── Internal: Interactive Configuration ─────────────────────────────

async function configureProvider() {
  console.log("");
  console.log(`${CYN}═══ Provider Configuration ═══${R}`);
  console.log("");

  const currentConfig = readConfig();

  const providers = [
    { name: "Z.AI / GLM", url: "https://api.z.ai/api/coding/paas/v4", model: "glm-5.1", ctx: "200000" },
    { name: "Zhipu AI / BigModel", url: "https://open.bigmodel.cn/api/coding/paas/v4", model: "glm-5.1", ctx: "200000" },
    { name: "DeepSeek", url: "https://api.deepseek.com/v1", model: "deepseek-chat", ctx: "64000" },
    { name: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-4.1", ctx: "1047576" },
    { name: "OpenRouter (aggregator)", url: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat-v3-0324", ctx: "64000" },
    { name: "Ollama (local)", url: "http://localhost:11434/v1", model: "qwen3:8b", ctx: "32768" },
    { name: "Custom URL", url: "", model: "default", ctx: "128000" },
  ];

  const currentUrl = currentConfig.proxy?.upstream;
  for (let i = 0; i < providers.length; i++) {
    const marker = currentUrl === providers[i].url ? ` ${GRN}(current)${R}` : "";
    console.log(`  ${i + 1}) ${providers[i].name}${marker}`);
  }
  console.log("");

  const choice = await ask("Select provider [1-7]", "1");
  const idx = Math.max(0, Math.min(providers.length - 1, parseInt(choice, 10) - 1));
  const provider = providers[idx];

  let upstreamUrl = provider.url;
  if (!upstreamUrl) {
    upstreamUrl = await ask("Enter API base URL");
    if (!upstreamUrl) {
      log("err", "URL is required.");
      process.exit(1);
    }
  }

  log("ok", `Provider: ${provider.name} (${upstreamUrl})`);

  // API Key
  console.log("");
  let apiKey = "";
  if (provider.name.includes("Ollama")) {
    apiKey = "ollama";
  } else {
    const currentKey = currentConfig.proxy?.api_key;
    const keyHint = currentKey ? `current: ${currentKey.slice(0, 8)}...` : "";
    apiKey = await ask(`API Key ${keyHint}`);
    if (!apiKey && currentKey) {
      apiKey = currentKey;
    }
    if (!apiKey) {
      log("warn", "No API key entered. Add it later to " + CONFIG_FILE);
    }
  }

  // ── Write temporary config so proxy can start for model discovery
  const tempConfig = {
    proxy: {
      upstream: upstreamUrl,
      api_key: apiKey,
      port: currentConfig.proxy?.port || DEFAULT_PORT,
    },
    models: {
      available: [],
      active: "",
      context_window: 200000,
    },
  };
  writeConfig(tempConfig);

  // ── Start proxy temporarily to fetch filtered models
  console.log("");
  console.log(`${CYN}═══ Model Selection ═══${R}`);
  console.log("");

  const port = tempConfig.proxy.port;
  let filteredModels = [];

  // Check if proxy is already running (from previous install)
  let wasAlreadyRunning = false;
  try {
    const { status } = await httpGet(`http://localhost:${port}/health`);
    wasAlreadyRunning = status === 200;
  } catch {}

  if (wasAlreadyRunning) {
    // Proxy running — restart it to pick up new provider config
    try { run("systemctl --user restart codex-proxy", { silent: true }); } catch {}
  } else {
    // Start proxy in background temporarily
    const bunPath = getBunPath();
    const proxyTs = getProxyTs();
    if (proxyTs) {
      const child = spawn(bunPath, ["run", proxyTs], {
        cwd: INSTALL_DIR,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.unref();
    }
  }

  // Poll proxy until models are loaded (max 15 seconds)
  log("info", "Waiting for proxy to load models...");
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const { status, body } = await httpGet(`http://localhost:${port}/models/filtered`);
      if (status === 200) {
        const data = JSON.parse(body);
        // BUILTIN_MODELS has 8 models — wait until models.dev fetch completes
        // (filtered count should be different from builtin-only count)
        if (status === 200 && data.catalog_ready && data.total > 0) {
          filteredModels = data.models || [];
          break;
        }
      }
    } catch {}
  }

  // Stop temporarily started proxy (don't stop if it was already running)
  if (!wasAlreadyRunning) {
    try { run(`fuser -k ${port}/tcp 2>/dev/null`, { silent: true, allowFail: true }); } catch {}
  }

  let selectedModels = [];
  let activeModel = "";
  let contextWindow = 200000;

  if (filteredModels.length > 0) {
    log("info", `Found ${filteredModels.length} models for this provider.`);

    // Multi-select checkbox
    const preselected = currentConfig.models?.available || [];
    selectedModels = await selectModels(filteredModels, preselected);

    // Ask which model should be active (default)
    console.log(`${BOLD}  Active model (used by Codex):${R}`);
    console.log("");
    for (let i = 0; i < selectedModels.length; i++) {
      const m = filteredModels.find(fm => fm.id === selectedModels[i]);
      const ctx = m ? ` (${(m.context_window / 1000).toFixed(0)}k context)` : "";
      console.log(`    ${i + 1}) ${selectedModels[i]}${ctx}`);
    }
    console.log("");

    const activeChoice = await ask("Select active model", "1");
    const activeIdx = Math.max(0, Math.min(selectedModels.length - 1, parseInt(activeChoice, 10) - 1));
    activeModel = selectedModels[activeIdx];

    // Get context window from model data
    const activeModelData = filteredModels.find(m => m.id === activeModel);
    contextWindow = activeModelData?.context_window || 200000;

    log("ok", `Active model: ${activeModel} (${(contextWindow / 1000).toFixed(0)}k context)`);
  } else {
    // Fallback: manual entry
    const defaultModel = currentConfig.models?.active || provider.model;
    const defaultCtx = currentConfig.models?.context_window || provider.ctx;

    activeModel = await ask("Model name", defaultModel);
    contextWindow = parseInt(await ask("Context window (tokens)", String(defaultCtx)), 10) || 200000;
    selectedModels = [activeModel];

    log("ok", `Model: ${activeModel} (${contextWindow} context)`);
  }

  // ── Vision model selection ──
  let visionModel = "";
  if (filteredModels.length > 1) {
    console.log("");
    console.log(`${BOLD}  Vision model (for image analysis):${R}`);
    console.log("    0) None");
    for (let i = 0; i < selectedModels.length; i++) {
      const m = filteredModels.find(fm => fm.id === selectedModels[i]);
      const ctx = m ? ` (${(m.context_window / 1000).toFixed(0)}k)` : "";
      const marker = selectedModels[i] === activeModel ? ` ${GRN}(active)${R}` : "";
      console.log(`    ${i + 1}) ${selectedModels[i]}${ctx}${marker}`);
    }
    console.log("");
    const visionChoice = await ask("Select vision model [0 = none]", "0");
    const visionIdx = parseInt(visionChoice, 10) - 1;
    if (visionIdx >= 0 && visionIdx < selectedModels.length) {
      visionModel = selectedModels[visionIdx];
      log("ok", `Vision model: ${visionModel}`);
    }
  }

  // ── Build aliases for Codex CLI compatibility ──
  const aliases = {};
  const activeAlias = getCodexAlias(activeModel);
  if (activeAlias) {
    aliases[activeAlias] = activeModel;
    log("info", `Codex alias: ${activeAlias} → ${activeModel}`);
  }
  if (visionModel && visionModel !== activeModel) {
    const visionAlias = getCodexAlias(visionModel, true);
    if (visionAlias && visionAlias !== activeAlias) {
      aliases[visionAlias] = visionModel;
      log("info", `Vision alias: ${visionAlias} → ${visionModel}`);
    }
  }

  // ── Write final config.toml ──
  const finalConfig = {
    proxy: {
      upstream: upstreamUrl,
      api_key: apiKey,
      port: tempConfig.proxy.port,
    },
    models: {
      available: selectedModels,
      active: activeModel,
      context_window: contextWindow,
    },
    aliases,
  };
  writeConfig(finalConfig);

  return finalConfig;
}

function configureCodex(config) {
  const model = config.models.active;
  const ctx = config.models.context_window;
  const port = getPort();

  if (!fs.existsSync(CODEX_HOME)) fs.mkdirSync(CODEX_HOME, { recursive: true });

  if (!fs.existsSync(CODEX_CONFIG)) {
    const toml = [
      `model_provider = "codex-proxy"`,
      `model = "${model}"`,
      `model_context_window = ${ctx}`,
      "",
      `[model_providers.codex-proxy]`,
      `name = "Codex Proxy"`,
      `base_url = "http://localhost:${port}/v1"`,
      `wire_api = "responses"`,
      "",
    ].join("\n");
    fs.writeFileSync(CODEX_CONFIG, toml);
    log("ok", `Created ${CODEX_CONFIG}`);
    return;
  }

  // Parse existing TOML into sections
  const content = fs.readFileSync(CODEX_CONFIG, "utf-8");
  const lines = content.split("\n");
  const sections = {}; // sectionName -> [{line, idx}]
  let currentSection = ""; // "" = top-level
  let sectionLineStart = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!sections[currentSection]) sections[currentSection] = [];
      continue;
    }
    if (!sections[currentSection]) sections[currentSection] = [];
    sections[currentSection].push({ line: lines[i], idx: i });
  }

  // Helper: set a key in a section (or top-level if section="")
  function setKey(section, key, value) {
    if (!sections[section]) sections[section] = [];
    const entries = sections[section];
    for (const entry of entries) {
      const trimmed = entry.line.trim();
      if (trimmed.startsWith(`${key}=`) || trimmed.startsWith(`${key} =`)) {
        entry.line = `${key} = ${value}`;
        return;
      }
    }
    // Key not found — append to section
    entries.push({ line: `${key} = ${value}`, idx: -1 });
  }

  // Set top-level keys
  setKey("", "model_provider", '"codex-proxy"');
  setKey("", "model", `"${model}"`);
  setKey("", "model_context_window", String(ctx));

  // Ensure [model_providers.codex-proxy] section exists
  if (!sections["model_providers.codex-proxy"]) {
    sections["model_providers.codex-proxy"] = [];
  }
  setKey("model_providers.codex-proxy", "name", '"Codex Proxy"');
  setKey("model_providers.codex-proxy", "base_url", `"http://localhost:${port}/v1"`);
  setKey("model_providers.codex-proxy", "wire_api", '"responses"');

  // Reconstruct file: iterate original lines, replace values from sections
  // Strategy: walk through original lines, replace matched keys, then append new keys
  const usedKeys = new Set(); // track which keys we've written
  const newLines = [];
  let curSection = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    
    if (sectionMatch) {
      // Before switching section, append any new keys for previous section
      const prevEntries = sections[curSection] || [];
      for (const entry of prevEntries) {
        if (entry.idx === -1) newLines.push(entry.line);
      }
      // Mark all keys in previous section as handled
      for (const entry of prevEntries) {
        if (entry.idx !== -1) usedKeys.add(`${curSection}::${entry.line.trim().split("=")[0].trim()}`);
      }

      curSection = sectionMatch[1].trim();
      newLines.push(line);
      continue;
    }

    if (trimmed.startsWith("#") || trimmed === "") {
      newLines.push(line);
      continue;
    }

    // Key-value line
    const kvMatch = trimmed.match(/^(\w+)\s*=/);
    if (kvMatch) {
      const key = kvMatch[1];
      const lookupKey = `${curSection}::${key}`;
      const entries = sections[curSection] || [];
      const found = entries.find(e => {
        const ek = e.line.trim().match(/^(\w+)\s*=/);
        return ek && ek[1] === key;
      });
      if (found && found.line !== line) {
        newLines.push(found.line);
        usedKeys.add(lookupKey);
      } else {
        newLines.push(line);
        usedKeys.add(lookupKey);
      }
    } else {
      newLines.push(line);
    }
  }

  // Append remaining new keys for last section
  const lastEntries = sections[curSection] || [];
  for (const entry of lastEntries) {
    if (entry.idx === -1) newLines.push(entry.line);
  }

  // Append [model_providers.codex-proxy] if it wasn't in original file
  if (!content.includes("[model_providers.codex-proxy]")) {
    newLines.push("");
    newLines.push("[model_providers.codex-proxy]");
    const providerEntries = sections["model_providers.codex-proxy"] || [];
    for (const entry of providerEntries) {
      newLines.push(entry.line);
    }
  } else {
    // Append any new provider keys that weren't written
    const providerEntries = sections["model_providers.codex-proxy"] || [];
    for (const entry of providerEntries) {
      if (entry.idx === -1) {
        // Find where [model_providers.codex-proxy] section ends and insert before next section
        const sectionIdx = newLines.findIndex(l => l.trim() === "[model_providers.codex-proxy]");
        if (sectionIdx !== -1) {
          // Find end of this section
          let insertAt = sectionIdx + 1;
          while (insertAt < newLines.length && !newLines[insertAt].trim().startsWith("[")) {
            insertAt++;
          }
          newLines.splice(insertAt, 0, entry.line);
        }
      }
    }
  }

  const newContent = newLines.join("\n");
  if (newContent !== content) {
    fs.writeFileSync(CODEX_CONFIG, newContent);
  }
  log("ok", `Updated model → ${model} in ${CODEX_CONFIG}`);
}

async function setupService(bunPath, platform) {
  ensureLogFile();
  if (platform === "linux") {
    const serviceDir = path.join(os.homedir(), ".config", "systemd", "user");
    if (!fs.existsSync(serviceDir)) fs.mkdirSync(serviceDir, { recursive: true });

    const service = [
      `[Unit]`,
      `Description=codex-proxy`,
      `After=network.target`,
      `StartLimitIntervalSec=30`,
      `StartLimitBurst=5`,
      ``,
      `[Service]`,
      `Type=simple`,
      `ExecStart=${bunPath} run ${path.join(INSTALL_DIR, "proxy.ts")}`,
      `Restart=on-failure`,
      `RestartSec=3`,
      `Environment=HOME=${os.homedir()}`,
      `StandardOutput=append:${LOG_FILE}`,
      `StandardError=append:${LOG_FILE}`,
      `WorkingDirectory=${INSTALL_DIR}`,
      ``,
      `[Install]`,
      `WantedBy=default.target`,
      "",
    ].join("\n");

    fs.writeFileSync(path.join(serviceDir, "codex-proxy.service"), service);
    run("systemctl --user daemon-reload", { silent: true });
    run("systemctl --user enable codex-proxy.service", { silent: true });

    // Only (re)start systemd service if proxy is NOT already running.
    // If a manually-started proxy is healthy on the port, systemd will
    // detect it via the pre-flight health check in server.ts and exit(0).
    // But we avoid an unnecessary restart attempt.
    const wasRunning = await isProxyRunning();
    if (!wasRunning) {
      run("systemctl --user reset-failed codex-proxy.service", { silent: true, allowFail: true });
      run("systemctl --user restart codex-proxy.service", { silent: true, allowFail: true });
      log("ok", "systemd service installed and started (auto-starts on boot)");
    } else {
      log("ok", "systemd service installed (proxy already running manually — will auto-start on next boot)");
    }

  } else if (platform === "macos") {
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.codex-proxy.plist");
    const plistDir = path.dirname(plistPath);
    if (!fs.existsSync(plistDir)) fs.mkdirSync(plistDir, { recursive: true });

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codex-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bunPath}</string>
        <string>run</string>
        <string>${path.join(INSTALL_DIR, "proxy.ts")}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>
</dict>
</plist>`;

    fs.writeFileSync(plistPath, plist);
    run(`launchctl load ${plistPath} 2>/dev/null`, { silent: true, allowFail: true });
    log("ok", "launchd service installed (auto-starts on login)");
    log("info", `Logs: ${LOG_FILE}`);

  } else {
    log("warn", `No auto-start for ${platform}. Start manually: codex-proxy start`);
  }
}

// ─── Help ────────────────────────────────────────────────────────────
function showHelp() {
  banner();
  console.log(`${BOLD}Usage:${R}  npx codex-anywhere-proxy <command>`);
  console.log(`       codex-proxy <command>  ${R}(if installed globally)`);
  console.log("");
  console.log(`${BOLD}Commands:${R}`);
  console.log("");
  console.log(`  ${BLU}install${R}    Install and configure (first-time setup)`);
  console.log(`  ${BLU}upgrade${R}    Sync npm package → ~/.codex-proxy and restart`);
  console.log(`  ${BLU}config${R}     Reconfigure provider, API key, model`);
  console.log(`  ${BLU}start${R}      Start the proxy`);
  console.log(`  ${BLU}stop${R}       Stop the proxy`);
  console.log(`  ${BLU}restart${R}    Restart the proxy`);
  console.log(`  ${BLU}status${R}     Show proxy status and configuration`);
  console.log(`  ${BLU}models${R}     List available models`);
  console.log(`  ${BLU}logs${R}       Tail proxy logs (Ctrl+C to exit)`);
  console.log(`  ${BLU}version${R}    Show version`);
  console.log("");
  console.log(`${BOLD}Quick start:${R}`);
  console.log("");
  console.log(`  ${BLU}npx codex-anywhere-proxy install${R}  # First time`);
  console.log(`  ${BLU}codex${R}                                # Start coding!`);
  console.log("");
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const command = process.argv[2] || "";
  const commands = { install: cmdInstall, upgrade: cmdUpgrade, config: cmdConfig, start: cmdStart, stop: cmdStop, restart: cmdRestart, status: cmdStatus, models: cmdModels, logs: cmdLogs, version: cmdVersion };

  // Aliases
  if (command === "configure") return cmdConfig();
  if (command === "--version" || command === "-v") return cmdVersion();
  if (command === "--help" || command === "-h" || command === "help") return showHelp();

  const handler = commands[command];
  if (!handler) return showHelp();

  try {
    await handler();
  } catch (e) {
    console.log("");
    log("err", e.message);
    if (process.env.DEBUG) console.log(e.stack);
    console.log("");
    process.exit(1);
  }
}

main();
