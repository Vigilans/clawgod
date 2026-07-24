#!/usr/bin/env bun
const { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync, readdirSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');
const { spawnSync } = require('child_process');

const clawgodDir = __dirname;
const patchesFile = join(clawgodDir, 'patches.json');
const enabledCapabilities = existsSync(patchesFile)
  ? new Set(JSON.parse(readFileSync(patchesFile, 'utf8')).enabled)
  : null;
const capabilityEnabled = (id) => enabledCapabilities === null || enabledCapabilities.has(id);
let artifactDir = clawgodDir;

function readSourceVersion(dir) {
  try { return readFileSync(join(dir, '.source-version'), 'utf8').trim(); }
  catch { return ''; }
}

function wrappedClaudeExecutable() {
  if (process.env.CLAUDE_CODE_ENTRYPOINT !== 'claude-vscode' || process.argv.length < 3) return null;
  const candidate = process.argv[2];
  if (!existsSync(candidate)) return null;
  const normalized = candidate.replace(/\\/g, '/');
  if (!/\/anthropic\.claude-code-[^/]+\/resources\/native-(?:binary|binaries\/[^/]+)\/claude(?:\.exe)?$/.test(normalized)) return null;
  process.argv.splice(2, 1);
  return candidate;
}

function queryClaudeVersion(executable) {
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') return null;
  return result.stdout.trim().match(/^([0-9]+(?:\.[0-9]+){2}(?:-[0-9A-Za-z.-]+)?) \(Claude Code\)$/)?.[1] || null;
}

function validArtifact(dir, version) {
  const entry = join(dir, 'cli.original.cjs');
  if (!existsSync(entry) || readSourceVersion(dir) !== version) return false;
  return !existsSync(join(dir, 'pathmap.json')) || existsSync(join(dir, 'bunfs'));
}

function selectWrappedArtifact() {
  const executable = wrappedClaudeExecutable();
  if (!executable) return;

  process.env.CLAUDE_CODE_EXECPATH = executable;
  const version = queryClaudeVersion(executable);
  if (!version) {
    process.stderr.write('[clawgod] Could not identify wrapped Claude; using the installed patched version.\n');
    return;
  }
  if (validArtifact(clawgodDir, version)) return;

  const versionsDir = join(clawgodDir, 'versions');
  const target = join(versionsDir, version);
  if (validArtifact(target, version)) {
    artifactDir = target;
    return;
  }

  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  try {
    for (const entry of readdirSync(versionsDir)) {
      if (entry.startsWith(`.${version}.tmp-`)) {
        rmSync(join(versionsDir, entry), { recursive: true, force: true });
      }
    }
  } catch {}

  mkdirSync(versionsDir, { recursive: true });
  const stage = join(versionsDir, `.${version}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`);
  try {
    const result = spawnSync(process.execPath, [join(clawgodDir, 'repatch.mjs'), executable, stage, version], {
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0 || !validArtifact(stage, version)) throw new Error('build failed');
    try {
      renameSync(stage, target);
    } catch {
      if (!validArtifact(target, version)) throw new Error('publish failed');
      rmSync(stage, { recursive: true, force: true });
    }
    artifactDir = target;
  } catch {
    rmSync(stage, { recursive: true, force: true });
    if (validArtifact(target, version)) artifactDir = target;
    else process.stderr.write(`[clawgod] Could not patch wrapped Claude ${version}; using the installed patched version.\n`);
  }
}

selectWrappedArtifact();

// One-time migration: earlier wrapper versions set CLAUDE_CONFIG_DIR=~/.clawgod,
// which made Claude Code read/write ~/.clawgod/.claude.json instead of the
// native ~/.claude.json (the file holding MCP config, project history, session
// index). Move it back transparently on first run after upgrade.
const nativeClaudeJson = join(homedir(), '.claude.json');
const strayClaudeJson = join(clawgodDir, '.claude.json');
if (existsSync(strayClaudeJson) && !existsSync(nativeClaudeJson)) {
  try { renameSync(strayClaudeJson, nativeClaudeJson); } catch {}
}

const providerDir = clawgodDir;
const configFile = join(providerDir, 'provider.json');

const defaultConfig = {
  apiKey: '',
  baseURL: 'https://api.anthropic.com',
  model: '',
  smallModel: '',
  timeoutMs: 3000000,
};

let config = { ...defaultConfig };
if (capabilityEnabled('clawgod.provider-config')) {
  if (existsSync(configFile)) {
    try {
      const raw = JSON.parse(readFileSync(configFile, 'utf8'));
      config = { ...defaultConfig, ...raw };
    } catch {}
  } else {
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2) + '\n');
  }

  // OpenAI-compatible provider proxy (grok, openai-compat, etc.)
  const _proxyTypes = { grok: 1, 'openai-compat': 1 };
  if (_proxyTypes[config.type]) {
    let _proxyKey = config.apiKey || '';
    if (!_proxyKey && config.type === 'grok') {
      try {
        const _gs = JSON.parse(readFileSync(join(homedir(), '.grok', 'user-settings.json'), 'utf8'));
        _proxyKey = _gs.apiKey || '';
      } catch {}
      if (!_proxyKey) _proxyKey = process.env.GROK_API_KEY || '';
    }
    if (_proxyKey) {
      const { startProxy } = require('./openai-proxy.cjs');
      const _proxy = startProxy({
        apiKey: _proxyKey,
        baseURL: config.baseURL || (config.type === 'grok' ? 'https://api.x.ai/v1' : ''),
        model: config.model || '',
      });
      process.env.ANTHROPIC_API_KEY = 'proxy-passthrough';
      process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + _proxy.port;
      process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-passthrough';
      if (config.model) process.env.ANTHROPIC_MODEL = config.model;
      if (config.smallModel) process.env.ANTHROPIC_SMALL_FAST_MODEL = config.smallModel;
      process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
      process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS ??= '1';
      process.on('exit', function () { try { _proxy.stop(); } catch {} });
      process.stderr.write('[clawgod] OpenAI-compat proxy on port ' + _proxy.port + ' (type: ' + config.type + ')\n');
      config = { ...defaultConfig };  // prevent fallthrough to apiKey/baseURL injection below
    } else {
      process.stderr.write('[clawgod] Warning: type=' + config.type + ' but no API key found\n');
    }
  }

  const hasProviderApiKey = !!config.apiKey;

  if (hasProviderApiKey) {
    process.env.ANTHROPIC_API_KEY = config.apiKey;
    if (config.baseURL) process.env.ANTHROPIC_BASE_URL = config.baseURL;
    if (config.model) process.env.ANTHROPIC_MODEL = config.model;
    if (config.smallModel) process.env.ANTHROPIC_SMALL_FAST_MODEL = config.smallModel;
    if (config.baseURL && !/anthropic\.com/i.test(config.baseURL)) {
      process.env.ANTHROPIC_AUTH_TOKEN ??= config.apiKey;
    }
  } else if (config.baseURL && config.baseURL !== defaultConfig.baseURL) {
    process.env.ANTHROPIC_BASE_URL ??= config.baseURL;
  }

  if (config.timeoutMs) {
    process.env.API_TIMEOUT_MS ??= String(config.timeoutMs);
  }
}

// Third-party Anthropic-compatible proxies (DeepSeek / OneAPI / Bedrock /
// vLLM / etc.) don't share Anthropic's server-side handling of
// x-anthropic-billing-header. That header carries a per-request `cch` field
// which Anthropic's own server excludes from prompt-cache key calculation
// (via cacheScope:null), but third-party proxies fold into the prefix hash —
// so the cached prefix changes every request and cache hit rate drops to
// zero. Auto-disable the header whenever baseURL points away from Anthropic.
// Users can force re-enable with CLAUDE_CODE_ATTRIBUTION_HEADER=1 if needed.
const configuredBaseURL = process.env.ANTHROPIC_BASE_URL ?? config.baseURL;
if (capabilityEnabled('system-prompt.remove-attribution-header') && configuredBaseURL && !/anthropic\.com/i.test(configuredBaseURL)) {
  process.env.CLAUDE_CODE_ATTRIBUTION_HEADER ??= '0';
  // Third-party proxies (headroom, etc.) often require remote control.
  // Lean mode sets disableRemoteControl:true in settings.json — undo it
  // when the user is routing through a non-Anthropic endpoint.
  try {
    const _rcSettings = join(homedir(), '.claude', 'settings.json');
    if (existsSync(_rcSettings)) {
      const _rcS = JSON.parse(readFileSync(_rcSettings, 'utf8'));
      if (_rcS.disableRemoteControl) {
        delete _rcS.disableRemoteControl;
        writeFileSync(_rcSettings, JSON.stringify(_rcS, null, 2) + '\n');
      }
    }
  } catch {}
}

process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1';
process.env.DISABLE_INSTALLATION_CHECKS ??= '1';
// Use system ripgrep (extracted vendor rg path was build-time-baked; system
// rg is the most reliable fallback under Bun runtime).
process.env.USE_BUILTIN_RIPGREP ??= '1';

const featuresFile = join(providerDir, 'features.json');
if (capabilityEnabled('clawgod.features-config') && !process.env.CLAUDE_INTERNAL_FC_OVERRIDES && existsSync(featuresFile)) {
  try {
    const raw = readFileSync(featuresFile, 'utf8');
    JSON.parse(raw);
    process.env.CLAUDE_INTERNAL_FC_OVERRIDES = raw;
  } catch {}
}

// Monkey-patch process.execPath: Anthropic's CLI uses process.execPath to
// locate the native binary for shell wrappers (find→bfs, grep→ugrep, rg) and
// subprocess spawning. Under Bun, process.execPath returns the Bun runtime
// path, not the Claude native binary. The launcher script sets
// CLAUDE_CODE_EXECPATH to claude.orig (the real ELF binary) before exec'ing
// Bun, so we use that as the source of truth.  See issue #100.
const _realExecPath = process.env.CLAUDE_CODE_EXECPATH || process.execPath;
if (_realExecPath !== process.execPath) {
  Object.defineProperty(process, 'execPath', {
    value: _realExecPath,
    configurable: true,
  });
}

// Lean mode toggle — --lean-off / --lean-on / --lean-max
if (capabilityEnabled('clawgod.lean-settings') && (process.argv.includes('--lean-off') || process.argv.includes('--lean-on') || process.argv.includes('--lean-max'))) {
  const _leanOff = join(clawgodDir, '.lean-disabled');
  const _leanMax = join(clawgodDir, '.lean-max');
  const _leanSettings = join(homedir(), '.claude', 'settings.json');
  const _baseDeny = ['DesignSync','NotebookEdit','PushNotification','RemoteTrigger','CronCreate','CronDelete','CronList'];
  const _maxDeny = ['EnterPlanMode','ExitPlanMode','SendMessage','ScheduleWakeup','AskUserQuestion','ReportFindings'];
  const _baseFlags = ['disableWorkflows','disableRemoteControl','disableClaudeAiConnectors','disableArtifact'];
  const _maxFlags = ['disableBundledSkills'];
  const _allDeny = new Set([..._baseDeny, ..._maxDeny]);
  const _allFlags = [..._baseFlags, ..._maxFlags];
  const _unlink = function(p) { try { require('fs').unlinkSync(p); } catch {} };
  if (process.argv.includes('--lean-off')) {
    writeFileSync(_leanOff, '');
    _unlink(_leanMax);
    try {
      const _s = JSON.parse(readFileSync(_leanSettings, 'utf8'));
      for (const _k of _allFlags) delete _s[_k];
      if (Array.isArray(_s.permissions?.deny)) _s.permissions.deny = _s.permissions.deny.filter(function(t) { return !_allDeny.has(t); });
      writeFileSync(_leanSettings, JSON.stringify(_s, null, 2) + '\n');
    } catch {}
    process.stderr.write('[clawgod] Lean mode disabled. All tools restored.\n');
  } else {
    const _isMax = process.argv.includes('--lean-max');
    _unlink(_leanOff);
    if (_isMax) writeFileSync(_leanMax, ''); else _unlink(_leanMax);
    const _deny = _isMax ? [..._baseDeny, ..._maxDeny] : _baseDeny;
    const _flags = _isMax ? _allFlags : _baseFlags;
    try {
      let _s = {};
      try { _s = JSON.parse(readFileSync(_leanSettings, 'utf8')); } catch {}
      let _ch = false;
      for (const _k of _flags) { if (!(_k in _s)) { _s[_k] = true; _ch = true; } }
      // If downgrading from max to on, remove max-only keys
      if (!_isMax) { for (const _k of _maxFlags) { if (_k in _s) { delete _s[_k]; _ch = true; } } }
      if (!_s.permissions) _s.permissions = {};
      if (!Array.isArray(_s.permissions.deny)) _s.permissions.deny = [];
      const _ex = new Set(_s.permissions.deny);
      for (const _t of _deny) { if (!_ex.has(_t)) { _s.permissions.deny.push(_t); _ch = true; } }
      // If downgrading from max to on, remove max-only deny entries
      if (!_isMax) {
        const _maxSet = new Set(_maxDeny);
        const _before = _s.permissions.deny.length;
        _s.permissions.deny = _s.permissions.deny.filter(function(t) { return !_maxSet.has(t); });
        if (_s.permissions.deny.length !== _before) _ch = true;
      }
      if (_ch) writeFileSync(_leanSettings, JSON.stringify(_s, null, 2) + '\n');
    } catch {}
    process.stderr.write('[clawgod] Lean mode: ' + (_isMax ? 'max' : 'on') + '. Settings updated.\n');
  }
  process.exit(0);
}

// Update check — cached, non-blocking, 24h interval
if (capabilityEnabled('clawgod.update-notification')) try {
  const _ucFile = join(clawgodDir, '.update-check');
  const _verFile = join(clawgodDir, '.clawgod-version');
  if (existsSync(_verFile)) {
    const _localVer = readFileSync(_verFile, 'utf8').trim();
    let _uc = null;
    try { if (existsSync(_ucFile)) _uc = JSON.parse(readFileSync(_ucFile, 'utf8')); } catch {}
    var _semGt = function(a, b) { var x = a.split('.'), y = b.split('.'); for (var i = 0; i < 3; i++) { var d = (parseInt(x[i]||0)) - (parseInt(y[i]||0)); if (d) return d > 0; } return false; };
    if (_uc && _uc.v && _semGt(_uc.v, _localVer)) {
      process.stderr.write('[clawgod] v' + _uc.v + ' available (installed: v' + _localVer + ") — run 'claude update' to upgrade\n");
    }
    if (!_uc || Date.now() - (_uc.t || 0) > 86400000) {
      fetch('https://api.github.com/repos/0Chencc/clawgod/releases/latest', {
        headers: { 'User-Agent': 'clawgod' },
        signal: AbortSignal.timeout(5000),
      }).then(function(r) { return r.json(); }).then(function(d) {
        var v = (d.tag_name || '').replace(/^v/, '');
        if (v) writeFileSync(_ucFile, JSON.stringify({ t: Date.now(), v: v }));
      }).catch(function() {});
    }
  }
} catch {}

require(join(artifactDir, 'cli.original.cjs'));
