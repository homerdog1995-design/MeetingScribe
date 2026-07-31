'use strict';

/**
 * Detects which local AI engines are actually usable on this machine, so
 * Settings → AI Engines can show accurate status without the user having to
 * hand-configure paths from scratch. Every probe here is local-only:
 * filesystem checks, spawning a `--help`/`--version` command, or an HTTP
 * request to 127.0.0.1. Nothing ever leaves the machine.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

const EXEC_TIMEOUT_MS = 4000;
const HTTP_TIMEOUT_MS = 1500;

function execFileAsync(binary, args) {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, error: error ? error.message : null, stdout, stderr });
    });
  });
}

async function commandExists(binary) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = await execFileAsync(probe, [binary]);
  return result.ok;
}

async function httpProbe(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { ok: false };
    const body = await response.json().catch(() => null);
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function commonWhisperCppPaths() {
  const bin = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const home = os.homedir();
  return [
    path.join(home, 'whisper.cpp', 'build', 'bin', bin),
    path.join(home, 'whisper.cpp', bin),
    process.platform === 'darwin' ? '/opt/homebrew/bin/whisper-cli' : null,
    process.platform === 'linux' ? '/usr/local/bin/whisper-cli' : null,
  ].filter(Boolean);
}

async function detectWhisperCpp(configuredPath) {
  const candidates = [configuredPath, ...commonWhisperCppPaths()].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const result = await execFileAsync(candidate, ['--help']);
      if (result.ok || /usage/i.test(result.stdout || result.stderr || '')) {
        return { available: true, path: candidate };
      }
    }
  }
  const onPath = await commandExists('whisper-cli');
  if (onPath) return { available: true, path: 'whisper-cli' };
  return { available: false, path: null };
}

async function detectFasterWhisper(pythonPath) {
  const python = pythonPath || 'python3';
  const exists = await commandExists(python);
  if (!exists) return { available: false, reason: 'python-not-found' };

  const result = await execFileAsync(python, ['-c', 'import faster_whisper; print(faster_whisper.__file__)']);
  if (result.ok) return { available: true, pythonPath: python, modulePath: result.stdout.trim() };
  return { available: false, reason: 'module-not-installed' };
}

async function detectWhisperWasm(assetsDir) {
  const required = ['whisper.wasm', 'whisper.js'];
  const hasCore = required.every((f) => fs.existsSync(path.join(assetsDir, f)));
  if (!hasCore) return { available: false };

  const modelFiles = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
    : [];
  return { available: modelFiles.length > 0, models: modelFiles };
}

async function detectOllama(port) {
  const result = await httpProbe(`http://127.0.0.1:${port}/api/tags`);
  if (!result.ok) return { available: false };
  const models = (result.body?.models || []).map((m) => m.name || m.model);
  return { available: true, models };
}

async function detectLlamaCpp(port) {
  const health = await httpProbe(`http://127.0.0.1:${port}/health`);
  if (health.ok) return { available: true };
  // Some llama.cpp server builds do not expose /health; fall back to /v1/models.
  const models = await httpProbe(`http://127.0.0.1:${port}/v1/models`);
  return { available: models.ok };
}

async function detectAll(settings, whisperWasmAssetsDir) {
  const [whisperCpp, fasterWhisper, whisperWasm, ollama, llamaCpp] = await Promise.all([
    detectWhisperCpp(settings.engines.whisperCpp.binaryPath),
    detectFasterWhisper(settings.engines.fasterWhisper.pythonPath),
    detectWhisperWasm(whisperWasmAssetsDir),
    detectOllama(settings.engines.ollama.port),
    detectLlamaCpp(settings.engines.llamaCpp.port),
  ]);

  const results = {
    whisperCpp,
    fasterWhisper,
    whisperWasm,
    webSpeech: { available: true, requiresDisclosure: true, enabled: settings.engines.webSpeech.enabled },
    ollama,
    llamaCpp,
    detectedAt: Date.now(),
  };

  logger.info('modelDetection', 'Engine detection complete', {
    whisperCpp: whisperCpp.available,
    fasterWhisper: fasterWhisper.available,
    whisperWasm: whisperWasm.available,
    ollama: ollama.available,
    llamaCpp: llamaCpp.available,
  });

  return results;
}

module.exports = { detectAll, detectWhisperCpp, detectFasterWhisper, detectWhisperWasm, detectOllama, detectLlamaCpp };
