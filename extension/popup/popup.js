/**
 * popup.js — Popup UI Controller
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * Controls all interactions in the popup window:
 *   - Loads current state from chrome.storage on open
 *   - Listens for live updates from the background service worker
 *   - Handles all user interactions (toggles, sliders, buttons, correction input)
 *   - Sends commands to background → content script
 *   - Renders the CAPTCHA preview images, confidence bar, stats, and logs
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POPUP LIFECYCLE
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. popup.html loads → popup.js runs
 *   2. init() reads storage → renders current state
 *   3. Sets up message listener for live updates from background
 *   4. Sets up event listeners for all UI controls
 *   5. (Popup is open) — user interacts → commands sent to background
 *   6. (Content script solves CAPTCHA) → background forwards → popup updates
 *   7. User closes popup → popup context is destroyed
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTE ON CHROME.RUNTIME.SENDMESSAGE IN POPUP
 * ─────────────────────────────────────────────────────────────────────────────
 * Messages from popup go to background.js first.
 * Background.js then forwards to the content script via chrome.tabs.sendMessage.
 * Popup CANNOT directly message content scripts.
 */

'use strict';

// ─── DOM References ───────────────────────────────────────────────────────────
// Cached at startup — avoids repeated querySelector calls

const DOM = {
  // Header
  enableToggle:       document.getElementById('enableToggle'),
  toggleLabel:        document.getElementById('toggleLabel'),

  // Status
  statusDot:          document.getElementById('statusDot'),
  statusText:         document.getElementById('statusText'),
  statusBadge:        document.getElementById('statusBadge'),

  // CAPTCHA previews
  imgOriginal:        document.getElementById('imgOriginal'),
  imgProcessed:       document.getElementById('imgProcessed'),
  placeholderOrig:    document.getElementById('placeholderOriginal'),
  placeholderProc:    document.getElementById('placeholderProcessed'),

  // OCR result
  ocrText:            document.getElementById('ocrText'),
  confidenceValue:    document.getElementById('confidenceValue'),
  confidenceBar:      document.getElementById('confidenceBar'),
  confidencePct:      document.getElementById('confidencePct'),

  // Action buttons
  btnRetry:           document.getElementById('btnRetry'),
  btnCorrect:         document.getElementById('btnCorrect'),

  // Manual correction
  correctionPanel:    document.getElementById('correctionPanel'),
  correctionInput:    document.getElementById('correctionInput'),
  btnApplyCorrection: document.getElementById('btnApplyCorrection'),

  // Stats
  statAttempts:       document.getElementById('statAttempts'),
  statSuccesses:      document.getElementById('statSuccesses'),
  statRate:           document.getElementById('statRate'),
  statAvgConf:        document.getElementById('statAvgConf'),

  // Settings
  settingsToggle:     document.getElementById('settingsToggle'),
  settingsBody:       document.getElementById('settingsBody'),
  thresholdSlider:    document.getElementById('thresholdSlider'),
  thresholdValue:     document.getElementById('thresholdValue'),
  autoSubmitToggle:   document.getElementById('autoSubmitToggle'),
  debugModeToggle:    document.getElementById('debugModeToggle'),

  // Logs
  logsToggle:         document.getElementById('logsToggle'),
  logsBody:           document.getElementById('logsBody'),
  logList:            document.getElementById('logList'),
  btnClearLogs:       document.getElementById('btnClearLogs'),

  // Footer
  btnResetStats:      document.getElementById('btnResetStats'),
};

// ─── State ────────────────────────────────────────────────────────────────────

/** Current settings (synced from chrome.storage) */
let state = {
  enabled:             true,
  autoSubmit:          false,
  debugMode:           false,
  confidenceThreshold: 70,
  stats: {
    attempts:        0,
    successes:       0,
    failures:        0,
    totalConfidence: 0,
  },
  lastCaptchaImage:    null,
  lastProcessedImage:  null,
};

/** Current solve result (from the most recent CAPTCHA_SOLVED message) */
let lastResult = null;

// ─── Initialisation ───────────────────────────────────────────────────────────

/**
 * Entry point — runs when popup.html finishes loading.
 */
async function init() {
  try {
    // Load current state from storage
    const stored = await chromeGet(null); // null = get everything
    if (stored) {
      Object.assign(state, stored);
    }

    // Render everything from stored state
    renderAll();

    // Set up event listeners
    setupEventListeners();

    // Set up message listener for live updates
    setupMessageListener();

    // Request a status check from the content script
    // (so we see current state immediately, not just what's in storage)
    await sendToBackground('GET_STATUS', {});

  } catch (err) {
    console.error('[Popup] Init error:', err);
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render the entire UI from current `state`.
 * Called once on startup, then individual sections are updated reactively.
 */
function renderAll() {
  renderHeader();
  renderStatus('idle', 'Waiting for CAPTCHA…');
  renderImages(state.lastCaptchaImage, state.lastProcessedImage);
  renderStats(state.stats);
  renderSettings();
}

/**
 * Update the header toggle to reflect enabled/disabled state.
 */
function renderHeader() {
  DOM.enableToggle.checked = state.enabled;
  DOM.toggleLabel.textContent = state.enabled ? 'ON' : 'OFF';
  document.body.classList.toggle('disabled', !state.enabled);
}

/**
 * Update the status bar with a new state and message.
 *
 * @param {'idle'|'working'|'success'|'failed'|'disabled'} dotState
 * @param {string} message
 * @param {string} [badge] - Optional badge text ('SOLVED', 'FAILED', etc.)
 * @param {string} [badgeType] - 'success' | 'failed' | 'working'
 */
function renderStatus(dotState, message, badge, badgeType) {
  // Update dot
  DOM.statusDot.className = `status-dot ${dotState}`;
  DOM.statusDot.classList.toggle('pulse', dotState === 'working');

  // Update text
  DOM.statusText.textContent = message;

  // Update badge
  if (badge) {
    DOM.statusBadge.textContent = badge;
    DOM.statusBadge.className   = `status-badge show ${badgeType || ''}`;
  } else {
    DOM.statusBadge.className   = 'status-badge';
    DOM.statusBadge.textContent = '';
  }
}

/**
 * Show the CAPTCHA preview images.
 * Hides the placeholder when an image is available.
 *
 * @param {string|null} originalBase64
 * @param {string|null} processedBase64
 */
function renderImages(originalBase64, processedBase64) {
  // Original image
  if (originalBase64) {
    DOM.imgOriginal.src = originalBase64;
    DOM.imgOriginal.classList.remove('hidden');
    DOM.placeholderOrig.style.display = 'none';
  } else {
    DOM.imgOriginal.classList.add('hidden');
    DOM.placeholderOrig.style.display = '';
  }

  // Processed image
  if (processedBase64) {
    DOM.imgProcessed.src = processedBase64;
    DOM.imgProcessed.classList.remove('hidden');
    DOM.placeholderProc.style.display = 'none';
  } else {
    DOM.imgProcessed.classList.add('hidden');
    DOM.placeholderProc.style.display = '';
  }
}

/**
 * Update the OCR result display and confidence meter.
 *
 * @param {string} text       - The OCR result text
 * @param {number} confidence - 0–100
 */
function renderOCRResult(text, confidence) {
  // OCR text
  DOM.ocrText.textContent = text || '—';
  DOM.ocrText.classList.toggle('has-value', !!text);

  // Confidence value with colour coding
  if (confidence > 0) {
    DOM.confidenceValue.textContent = `${confidence}%`;
    DOM.confidencePct.textContent   = `${confidence}%`;

    // Colour code: green ≥ 80, yellow 50–79, red < 50
    DOM.confidenceValue.className = 'confidence-value ' + (
      confidence >= 80 ? 'high' :
      confidence >= 50 ? 'medium' : 'low'
    );
  } else {
    DOM.confidenceValue.textContent = '—';
    DOM.confidenceValue.className   = 'confidence-value';
    DOM.confidencePct.textContent   = '0%';
  }

  // Animate the confidence bar
  DOM.confidenceBar.style.width = `${Math.min(confidence, 100)}%`;
}

/**
 * Update the statistics panel.
 *
 * @param {object} stats
 */
function renderStats(stats) {
  if (!stats) return;

  const { attempts, successes, totalConfidence } = stats;

  DOM.statAttempts.textContent  = attempts || 0;
  DOM.statSuccesses.textContent = successes || 0;

  // Success rate
  const rate = attempts > 0
    ? Math.round((successes / attempts) * 100)
    : null;
  DOM.statRate.textContent = rate !== null ? `${rate}%` : '—';

  // Average confidence
  const avgConf = attempts > 0
    ? Math.round(totalConfidence / attempts)
    : null;
  DOM.statAvgConf.textContent = avgConf !== null ? `${avgConf}%` : '—';
}

/**
 * Render the settings panel with current values.
 */
function renderSettings() {
  DOM.thresholdSlider.value   = state.confidenceThreshold;
  DOM.thresholdValue.textContent = `${state.confidenceThreshold}%`;
  DOM.autoSubmitToggle.checked = state.autoSubmit;
  DOM.debugModeToggle.checked  = state.debugMode;
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

/**
 * Render log entries in the log panel.
 * Called when the logs accordion is opened or new logs arrive.
 */
async function renderLogs() {
  let logs = [];

  try {
    const stored = await chromeGet('srmLogs', false); // local storage
    logs = stored?.srmLogs || [];
  } catch {
    // local storage may not be available
  }

  if (!logs || logs.length === 0) {
    DOM.logList.innerHTML = `<div class="log-empty">No logs yet — open the SRM portal to start</div>`;
    return;
  }

  // Show most recent logs first (reverse order)
  const fragment = document.createDocumentFragment();

  [...logs].reverse().forEach(entry => {
    const row = document.createElement('div');
    row.className = 'log-entry';

    // Format timestamp → just time (HH:MM:SS)
    const time = entry.timestamp
      ? new Date(entry.timestamp).toLocaleTimeString('en-IN', { hour12: false })
      : '';

    row.innerHTML = `
      <span class="log-time">${escHtml(time)}</span>
      <span class="log-level ${escHtml(entry.level || 'INFO')}">${escHtml(entry.level || 'INFO')}</span>
      <span class="log-module">[${escHtml(entry.module || '?')}]</span>
      <span class="log-msg">${escHtml(entry.message || '')}</span>
    `;
    fragment.appendChild(row);
  });

  DOM.logList.innerHTML = '';
  DOM.logList.appendChild(fragment);
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

function setupEventListeners() {
  // ── Enable/Disable Toggle ──────────────────────────────────────────────────
  DOM.enableToggle.addEventListener('change', async () => {
    const enabled = DOM.enableToggle.checked;
    state.enabled = enabled;

    DOM.toggleLabel.textContent = enabled ? 'ON' : 'OFF';
    document.body.classList.toggle('disabled', !enabled);

    if (enabled) {
      renderStatus('idle', 'Extension enabled — waiting for CAPTCHA…');
    } else {
      renderStatus('disabled', 'Extension disabled');
    }

    await sendToBackground('TOGGLE_EXTENSION', { enabled });
  });

  // ── Retry Button ──────────────────────────────────────────────────────────
  DOM.btnRetry.addEventListener('click', async () => {
    renderStatus('working', 'Retrying OCR…', '…', 'working');
    DOM.btnRetry.disabled = true;

    await sendToBackground('RETRY_CAPTCHA', {});

    // Re-enable after a delay
    setTimeout(() => { DOM.btnRetry.disabled = false; }, 2000);
  });

  // ── Manual Correction Button ───────────────────────────────────────────────
  DOM.btnCorrect.addEventListener('click', () => {
    const isVisible = DOM.correctionPanel.classList.contains('visible');
    DOM.correctionPanel.classList.toggle('visible', !isVisible);
    if (!isVisible) {
      DOM.correctionInput.focus();
    }
  });

  // ── Apply Correction ───────────────────────────────────────────────────────
  DOM.btnApplyCorrection.addEventListener('click', applyCorrection);
  DOM.correctionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyCorrection();
    if (e.key === 'Escape') DOM.correctionPanel.classList.remove('visible');
  });

  // ── Confidence Threshold Slider ────────────────────────────────────────────
  DOM.thresholdSlider.addEventListener('input', () => {
    const val = parseInt(DOM.thresholdSlider.value);
    DOM.thresholdValue.textContent = `${val}%`;
  });

  DOM.thresholdSlider.addEventListener('change', async () => {
    const threshold = parseInt(DOM.thresholdSlider.value);
    state.confidenceThreshold = threshold;
    await sendToBackground('SET_CONFIDENCE_THRESHOLD', { threshold });
  });

  // ── Auto Submit Toggle ─────────────────────────────────────────────────────
  DOM.autoSubmitToggle.addEventListener('change', async () => {
    const autoSubmit = DOM.autoSubmitToggle.checked;
    state.autoSubmit = autoSubmit;
    await sendToBackground('TOGGLE_AUTO_SUBMIT', { autoSubmit });
  });

  // ── Debug Mode Toggle ──────────────────────────────────────────────────────
  DOM.debugModeToggle.addEventListener('change', async () => {
    const debugMode = DOM.debugModeToggle.checked;
    state.debugMode = debugMode;
    await sendToBackground('TOGGLE_DEBUG_MODE', { debugMode });
  });

  // ── Settings Accordion ─────────────────────────────────────────────────────
  DOM.settingsToggle.addEventListener('click', () => {
    toggleAccordion(DOM.settingsToggle, DOM.settingsBody);
  });

  // ── Logs Accordion ─────────────────────────────────────────────────────────
  DOM.logsToggle.addEventListener('click', (e) => {
    // Prevent the clear button from toggling the accordion
    if (e.target.closest('#btnClearLogs')) return;
    const willOpen = !DOM.logsBody.classList.contains('open');
    toggleAccordion(DOM.logsToggle, DOM.logsBody);
    if (willOpen) renderLogs(); // Load logs when opened
  });

  // ── Clear Logs ─────────────────────────────────────────────────────────────
  DOM.btnClearLogs.addEventListener('click', async (e) => {
    e.stopPropagation(); // Don't toggle accordion
    await sendToBackground('CLEAR_LOGS', {});
    DOM.logList.innerHTML = `<div class="log-empty">Logs cleared ✓</div>`;
  });

  // ── Reset Stats ────────────────────────────────────────────────────────────
  DOM.btnResetStats.addEventListener('click', async () => {
    const confirmed = confirm('Reset all statistics? This cannot be undone.');
    if (!confirmed) return;

    const emptyStats = { attempts: 0, successes: 0, failures: 0, totalConfidence: 0 };
    await chrome.storage.local.set({ stats: emptyStats });
    state.stats = emptyStats;
    renderStats(emptyStats);
  });
}

// ─── Manual Correction ────────────────────────────────────────────────────────

async function applyCorrection() {
  const text = DOM.correctionInput.value.trim();
  if (!text) return;

  await sendToBackground('MANUAL_CORRECTION', { text });

  // Visual feedback
  DOM.correctionInput.value = '';
  DOM.correctionPanel.classList.remove('visible');
  renderStatus('success', `Manual correction applied: "${text}"`, 'APPLIED', 'success');
}

// ─── Accordion Helper ─────────────────────────────────────────────────────────

function toggleAccordion(header, body) {
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  header.setAttribute('aria-expanded', String(!isOpen));
}

// ─── Message Listener (from background) ───────────────────────────────────────

/**
 * Listen for live messages from the background service worker.
 * The background forwards CAPTCHA_DETECTED, CAPTCHA_SOLVED, CAPTCHA_FAILED
 * from the content script to the popup.
 */
function setupMessageListener() {
  chrome.runtime.onMessage.addListener((message) => {
    const { type, payload } = message || {};

    switch (type) {

      case 'CAPTCHA_DETECTED':
        renderStatus(
          'working',
          `Solving CAPTCHA… (attempt ${payload?.attempt || 1}/${payload?.maxRetries || 3})`,
          '…',
          'working'
        );
        break;

      case 'CAPTCHA_SOLVED': {
        const { text, confidence } = payload || {};
        lastResult = payload;

        renderStatus(
          'success',
          `Solved: "${text}" — ${confidence}% confidence`,
          'SOLVED',
          'success'
        );
        renderOCRResult(text, confidence);

        // Refresh images from storage (content script updates them)
        loadAndRenderImages();

        // Refresh stats from storage
        loadAndRenderStats();

        // Flash the result section
        flashElement(document.querySelector('.result-section'));
        break;
      }

      case 'CAPTCHA_FAILED': {
        const { lastText, lastConfidence } = payload || {};
        renderStatus(
          'failed',
          `Low confidence (${lastConfidence}%) — please correct manually`,
          'FAILED',
          'failed'
        );
        renderOCRResult(lastText || '?', lastConfidence || 0);
        loadAndRenderImages();
        loadAndRenderStats();

        // Auto-open correction panel on failure
        DOM.correctionPanel.classList.add('visible');
        DOM.correctionInput.focus();
        break;
      }

      case 'STATUS_UPDATE':
        // Full status refresh from background
        if (payload?.settings) {
          Object.assign(state, payload.settings);
          renderSettings();
          renderStats(state.stats);
        }
        break;
    }
  });
}

// ─── Storage Helpers ──────────────────────────────────────────────────────────

/**
 * Load images from storage and display them in the preview.
 * Called after a solve completes (storage is updated by content script).
 */
async function loadAndRenderImages() {
  try {
    const { lastCaptchaImage, lastProcessedImage } = await chromeGet([
      'lastCaptchaImage',
      'lastProcessedImage',
    ]);
    renderImages(lastCaptchaImage, lastProcessedImage);
  } catch {
    // Storage read failed silently
  }
}

/**
 * Load stats from storage and update the stats panel.
 */
async function loadAndRenderStats() {
  try {
    const { stats } = await chromeGet('stats');
    if (stats) {
      state.stats = stats;
      renderStats(stats);
    }
  } catch {
    // Silently ignore
  }
}

// ─── Chrome API Wrappers ──────────────────────────────────────────────────────

/**
 * Promise wrapper for chrome.storage.local.get (or session).
 *
 * @param {string|string[]|null} keys - Key(s) to retrieve, or null for all
 * @param {boolean} useSession        - Use session storage instead of local
 * @returns {Promise<object>}
 */
function chromeGet(keys, useSession = false) {
  return new Promise((resolve, reject) => {
    const storage = useSession ? chrome.storage.session : chrome.storage.local;
    if (!storage) { resolve({}); return; }
    storage.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Send a message to the background service worker.
 *
 * @param {string} type
 * @param {*}      payload
 * @returns {Promise<*>}
 */
function sendToBackground(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[Popup] sendMessage error:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      console.warn('[Popup] sendMessage threw:', err.message);
      resolve(null);
    }
  });
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Escape HTML special characters for safe innerHTML insertion.
 * Always sanitize user-provided or external data before inserting into DOM.
 *
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

/**
 * Briefly flash a DOM element to draw attention to it.
 * Uses the .flash CSS animation class.
 *
 * @param {Element} element
 */
function flashElement(element) {
  if (!element) return;
  element.classList.remove('flash');
  void element.offsetWidth; // Force reflow to restart animation
  element.classList.add('flash');
  element.addEventListener('animationend', () => element.classList.remove('flash'), { once: true });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
