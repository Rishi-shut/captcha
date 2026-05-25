/**
 * background.js — Service Worker (Extension Hub)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * The background service worker is the central nervous system of the extension.
 * It acts as a message router and state manager between the two other contexts:
 *
 *   Content Script  ←──── Messages ────►  Background  ←──── Messages ────►  Popup
 *
 * WHY DO WE NEED A BACKGROUND SCRIPT AT ALL?
 *   Content scripts and popup scripts run in isolated JS environments.
 *   They CANNOT directly call each other's functions or share variables.
 *   The background script is the only persistent context that:
 *     - Can communicate with both content scripts AND the popup simultaneously
 *     - Can use ALL Chrome APIs (unlike content scripts which have restrictions)
 *     - Persists across page navigations (the content script dies on navigation)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MANIFEST V3 SERVICE WORKER CAVEAT
 * ─────────────────────────────────────────────────────────────────────────────
 * In Manifest V3, the background "page" was replaced with a Service Worker.
 *
 * KEY DIFFERENCE: Service Workers CAN go to sleep when idle.
 * This means: ANY state stored in global JS variables is lost when the
 * worker sleeps. You must use chrome.storage for anything that must persist.
 *
 * We follow this rule strictly:
 *   ✅ Persistent state → chrome.storage.local
 *   ✅ Session state    → chrome.storage.session (cleared on browser restart)
 *   ❌ Global variables → NOT used for persistent state
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RESPONSIBILITIES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  1. INSTALLATION / STARTUP
 *     - Set up default settings on first install
 *     - Log extension startup
 *
 *  2. MESSAGE ROUTING
 *     Content → Background:
 *       CAPTCHA_DETECTED  → forward to popup (update live status)
 *       CAPTCHA_SOLVED    → forward to popup + update stats in storage
 *       CAPTCHA_FAILED    → forward to popup + update stats in storage
 *
 *     Popup → Background:
 *       GET_STATUS            → query active tab, forward to content script
 *       TOGGLE_EXTENSION      → save to storage, forward to content script
 *       TOGGLE_AUTO_SUBMIT    → save to storage
 *       SET_CONFIDENCE_THRESHOLD → save to storage, forward to content script
 *       RETRY_CAPTCHA         → forward to content script
 *       MANUAL_CORRECTION     → forward to content script
 *       CLEAR_LOGS            → clear session log storage
 *
 *  3. ICON BADGE
 *     - Show a coloured badge on the extension icon to indicate current state:
 *         Green  "✓"  → CAPTCHA solved
 *         Yellow "…"  → Working (detecting / solving)
 *         Red    "✗"  → Failed / manual correction needed
 *         Grey   ""   → Idle / disabled
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// INSTALLATION & STARTUP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fired once when the extension is first installed, or when it's updated.
 * This is the right place to set default settings.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[SRM][INFO][Background] Extension ${details.reason} — version ${chrome.runtime.getManifest().version}`);

  if (details.reason === 'install') {
    // First-time install: write default settings to storage
    await chrome.storage.local.set({
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
    });

    console.log('[SRM][INFO][Background] Default settings written to storage ✓');
  }

  if (details.reason === 'update') {
    console.log(`[SRM][INFO][Background] Updated from ${details.previousVersion} → ${chrome.runtime.getManifest().version}`);
    // Future: handle migrations if schema changes between versions
  }

  // Set the initial idle badge state
  setBadge('idle');
});

/**
 * Fired every time the Service Worker starts up (on browser start, tab navigation, etc.)
 * Note: this runs each time the worker wakes from sleep.
 */
chrome.runtime.onStartup.addListener(() => {
  console.log('[SRM][INFO][Background] Service worker started');
  setBadge('idle');
});

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE ROUTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Central message handler — ALL messages from content scripts AND popup
 * arrive here. We inspect the message type and route accordingly.
 *
 * Return value from the handler becomes the response sent back to the caller.
 * Return a Promise to respond asynchronously.
 * Return true (synchronously) to keep the response channel open.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message || {};

  if (!type) {
    console.warn('[SRM][WARN][Background] Received message with no type:', message);
    sendResponse(null);
    return;
  }

  console.log(`[SRM][DEBUG][Background] Message: ${type}`, payload || '');

  // Route to the appropriate handler (all async)
  handleMessage(type, payload, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error(`[SRM][ERROR][Background] Handler error for "${type}": ${err.message}`);
      sendResponse({ ok: false, error: err.message });
    });

  return true; // Keep message channel open for async response
});

/**
 * Route a message to its specific handler.
 *
 * @param {string} type    - Message type constant
 * @param {*}      payload - Message data
 * @param {object} sender  - Chrome sender info (tab, frameId, etc.)
 * @returns {Promise<*>}   - Response to send back
 */
async function handleMessage(type, payload, sender) {
  switch (type) {

    // ── FROM CONTENT SCRIPT: CAPTCHA was detected on the page ─────────────────
    case 'CAPTCHA_DETECTED':
      setBadge('working');
      await forwardToPopup(type, {
        ...payload,
        tabId: sender.tab?.id,
      });
      return { ok: true };

    // ── FROM CONTENT SCRIPT: CAPTCHA was solved successfully ──────────────────
    case 'CAPTCHA_SOLVED':
      setBadge('success');
      // Stats are updated by content script via SRMStorage.recordAttempt()
      // Just forward the result to the popup for live display
      await forwardToPopup(type, {
        ...payload,
        tabId: sender.tab?.id,
      });
      return { ok: true };

    // ── FROM CONTENT SCRIPT: All retries failed ───────────────────────────────
    case 'CAPTCHA_FAILED':
      setBadge('failed');
      await forwardToPopup(type, {
        ...payload,
        tabId: sender.tab?.id,
      });
      return { ok: true };

    // ── FROM POPUP: Get current status of the active tab ──────────────────────
    case 'GET_STATUS': {
      const tab = await getActiveTab();
      if (!tab) return { ok: false, error: 'No active tab found' };

      // Forward to content script in that tab
      const contentResponse = await sendToTab(tab.id, type, payload);
      // Also return storage settings for the popup to display
      const storage = await chrome.storage.local.get(null);
      return {
        ok:             true,
        contentStatus:  contentResponse,
        settings:       storage,
        tabId:          tab.id,
        tabUrl:         tab.url,
        isOnSRMPortal:  tab.url?.includes('sp.srmist.edu.in'),
      };
    }

    // ── FROM POPUP: Toggle extension on/off ───────────────────────────────────
    case 'TOGGLE_EXTENSION': {
      const { enabled } = payload;
      await chrome.storage.local.set({ enabled });
      console.log(`[SRM][INFO][Background] Extension ${enabled ? 'enabled' : 'disabled'}`);

      setBadge(enabled ? 'idle' : 'disabled');

      // Forward to content script so it activates/deactivates immediately
      const tab = await getActiveTab();
      if (tab) await sendToTab(tab.id, type, payload);

      return { ok: true };
    }

    // ── FROM POPUP: Toggle auto-submit ────────────────────────────────────────
    case 'TOGGLE_AUTO_SUBMIT': {
      const { autoSubmit } = payload;
      await chrome.storage.local.set({ autoSubmit });
      console.log(`[SRM][INFO][Background] Auto-submit: ${autoSubmit}`);
      return { ok: true };
    }

    // ── FROM POPUP: Change confidence threshold ───────────────────────────────
    case 'SET_CONFIDENCE_THRESHOLD': {
      const { threshold } = payload;
      if (typeof threshold !== 'number' || threshold < 0 || threshold > 100) {
        return { ok: false, error: 'Threshold must be a number between 0 and 100' };
      }
      await chrome.storage.local.set({ confidenceThreshold: threshold });
      console.log(`[SRM][INFO][Background] Confidence threshold set to ${threshold}%`);

      // Also update the content script's in-memory setting
      const tab = await getActiveTab();
      if (tab) await sendToTab(tab.id, type, payload);

      return { ok: true };
    }

    // ── FROM POPUP: Toggle debug mode ─────────────────────────────────────────
    case 'TOGGLE_DEBUG_MODE': {
      const { debugMode } = payload;
      await chrome.storage.local.set({ debugMode });
      console.log(`[SRM][INFO][Background] Debug mode: ${debugMode}`);
      return { ok: true };
    }

    // ── FROM POPUP: Retry CAPTCHA solve ───────────────────────────────────────
    case 'RETRY_CAPTCHA': {
      const tab = await getActiveTab();
      if (!tab) return { ok: false, error: 'No active SRM tab found' };
      const response = await sendToTab(tab.id, type, payload);
      return response || { ok: true };
    }

    // ── FROM POPUP: Apply manual correction ───────────────────────────────────
    case 'MANUAL_CORRECTION': {
      const tab = await getActiveTab();
      if (!tab) return { ok: false, error: 'No active SRM tab found' };
      const response = await sendToTab(tab.id, type, payload);
      return response || { ok: true };
    }

    // ── FROM POPUP: Clear log buffer ──────────────────────────────────────────
    case 'CLEAR_LOGS': {
      await chrome.storage.session.set({ srmLogs: [] }).catch(() => {});
      console.log('[SRM][INFO][Background] Logs cleared');
      return { ok: true };
    }

    // ── Unknown message type ──────────────────────────────────────────────────
    default:
      console.warn(`[SRM][WARN][Background] Unknown message type: "${type}"`);
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POPUP FORWARDING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forward a message to the popup (if it's currently open).
 *
 * WHY "if it's open"?
 *   The popup only exists while the user has it open. If it's closed,
 *   chrome.runtime.sendMessage will throw "Could not establish connection".
 *   We silently ignore this error — it's not a problem if the popup isn't open.
 *
 * @param {string} type
 * @param {*}      payload
 */
async function forwardToPopup(type, payload) {
  try {
    await chrome.runtime.sendMessage({ type, payload });
  } catch {
    // Popup is not open — silently ignore
    // This is expected and harmless
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB COMMUNICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a message to the content script in a specific tab.
 *
 * @param {number} tabId   - Chrome tab ID
 * @param {string} type    - Message type
 * @param {*}      payload
 * @returns {Promise<*>}   - Response from content script, or null on error
 */
async function sendToTab(tabId, type, payload = null) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type, payload });
    return response;
  } catch (err) {
    // Content script not loaded in this tab (not on SRM portal, or still loading)
    console.log(`[SRM][DEBUG][Background] Tab ${tabId} not responding to "${type}": ${err.message}`);
    return null;
  }
}

/**
 * Get the currently active tab in the focused Chrome window.
 * Returns null if no tab is found or if the active tab isn't the SRM portal.
 *
 * WHY filter by SRM URL?
 *   We only want to send messages to tabs that have our content script running.
 *   Sending to a non-SRM tab would fail silently or worse.
 *
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({
      active:        true,
      currentWindow: true,
    });

    const tab = tabs[0];

    if (!tab) {
      console.log('[SRM][DEBUG][Background] No active tab found');
      return null;
    }

    // Check the tab is on the SRM portal
    if (!tab.url?.includes('sp.srmist.edu.in')) {
      // Try to find an SRM tab in any window
      const srmTabs = await chrome.tabs.query({
        url: 'https://sp.srmist.edu.in/*',
      });

      if (srmTabs.length > 0) {
        console.log(`[SRM][DEBUG][Background] Active tab not SRM — found SRM tab: ${srmTabs[0].id}`);
        return srmTabs[0];
      }

      console.log('[SRM][DEBUG][Background] No SRM portal tab found');
      return null;
    }

    return tab;
  } catch (err) {
    console.error(`[SRM][ERROR][Background] getActiveTab error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ICON BADGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update the extension icon badge to reflect current state.
 *
 * Chrome allows a small text badge (up to 4 chars) and a background colour
 * on the extension action icon. We use this to give instant visual feedback:
 *
 *   State        Badge  Colour
 *   ─────────────────────────────
 *   idle         ""     transparent
 *   disabled     "OFF"  grey (#6b7280)
 *   working      "..."  blue (#3b82f6)
 *   success      "OK"   green (#22c55e)
 *   failed       "ERR"  red (#ef4444)
 *
 * @param {'idle'|'disabled'|'working'|'success'|'failed'} state
 */
function setBadge(state) {
  const BADGE_CONFIG = {
    idle:     { text: '',    color: '#00000000' },  // Transparent (no badge)
    disabled: { text: 'OFF', color: '#6b7280'   },  // Grey
    working:  { text: '...',  color: '#3b82f6'  },  // Blue
    success:  { text: 'OK',  color: '#22c55e'   },  // Green
    failed:   { text: 'ERR', color: '#ef4444'   },  // Red
  };

  const config = BADGE_CONFIG[state] || BADGE_CONFIG.idle;

  // setBadgeText and setBadgeBackgroundColor are async in MV3 but
  // we don't need to await them — fire and forget is fine for UI updates
  chrome.action.setBadgeText({ text: config.text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: config.color }).catch(() => {});
  chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => {});

  console.log(`[SRM][DEBUG][Background] Badge: "${config.text}" (${state})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE CHANGE LISTENER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Listen for storage changes and react to them.
 * This allows the background to stay in sync when the popup or content script
 * writes to storage.
 *
 * Currently used to:
 *   - Update the badge when the extension is enabled/disabled
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.enabled) {
    const enabled = changes.enabled.newValue;
    console.log(`[SRM][INFO][Background] Storage: enabled changed to ${enabled}`);
    setBadge(enabled ? 'idle' : 'disabled');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TAB LISTENER: Detect navigation to SRM portal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When a tab navigates to the SRM portal login page, reset the badge to idle.
 * This ensures a clean visual state for each new login attempt.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === 'complete' &&
    tab.url?.includes('sp.srmist.edu.in')
  ) {
    console.log(`[SRM][INFO][Background] SRM portal loaded in tab ${tabId}`);
    // Reset badge to idle — content script will update it as work progresses
    setBadge('idle');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE WORKER KEEPALIVE (Optional)
// ─────────────────────────────────────────────────────────────────────────────
// MV3 service workers sleep after ~30 seconds of inactivity.
// For this extension, sleeping is fine — the content script runs independently.
// We don't need a keepalive mechanism.
//
// If you ever need the background to stay awake (e.g. for a timer),
// use chrome.alarms.create() which can wake the service worker on a schedule.

console.log('[SRM][INFO][Background] Service worker script loaded ✓');
