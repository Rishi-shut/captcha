/**
 * content.js — Main Content Script Orchestrator
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the ENTRY POINT of the content script layer.
 * It coordinates all other content modules in the correct sequence:
 *
 *   captchaDetector → imageCapture → preprocessor → ocrEngine → autofill
 *
 * It also handles:
 *   - Extension enable/disable checks (read from chrome.storage)
 *   - MutationObserver to detect CAPTCHA refresh
 *   - Retry logic (up to MAX_RETRIES attempts on low confidence)
 *   - Reporting results to the background service worker
 *   - Receiving manual correction commands from the popup
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXECUTION FLOW
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Chrome injects content.js into the SRM portal tab
 *        ↓
 *  init() → read settings from storage
 *        ↓
 *  [If disabled] → exit silently
 *        ↓
 *  [If enabled] → waitForCaptcha() → poll/observe until CAPTCHA img loads
 *        ↓
 *  runPipeline() → full OCR pipeline
 *        ↓
 *  [If confidence ≥ threshold] → fill field → report success
 *  [If confidence < threshold] → retry (refresh CAPTCHA + re-run pipeline)
 *        ↓
 *  [If all retries fail] → report failure → user can correct manually
 *        ↓
 *  watchForRefresh() → keep MutationObserver running so we re-solve
 *                      any future CAPTCHA refreshes automatically
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RETRY LOGIC
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Why retry?
 *   OCR accuracy on any single CAPTCHA might be low due to:
 *   - Particularly noisy CAPTCHA rendering that day
 *   - Difficult characters (1/l/I, 0/O, B/8)
 *   - Suboptimal preprocessing for that specific image
 *
 * On each retry, we REQUEST a NEW CAPTCHA from the server (by clicking
 * the refresh button). A fresh CAPTCHA might be cleaner and easier to read.
 *
 * After MAX_RETRIES, we give up and show "manual correction" in the popup.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum OCR retry attempts before giving up and asking user to correct manually */
const MAX_RETRIES = 3;

/** Delay between retry attempts (ms). Gives new CAPTCHA time to load. */
const RETRY_DELAY_MS = 800;

/** Initial delay after page load before starting detection (ms).
 *  Allows dynamic content to settle after page load.
 */
const INITIAL_DELAY_MS = 500;

/** How often to poll for the CAPTCHA element if not yet found (ms) */
const POLL_INTERVAL_MS = 400;

/** Maximum time to wait for CAPTCHA to appear (ms) */
const CAPTCHA_WAIT_TIMEOUT_MS = 15000;

// ─── Module State ─────────────────────────────────────────────────────────────

/** Current extension settings (loaded from storage on init) */
let settings = {
  enabled:             true,
  autoSubmit:          false,
  debugMode:           false,
  confidenceThreshold: 70,
};

/** Currently found CAPTCHA elements */
let elements = {
  captchaImg:   null,
  captchaInput: null,
  loginBtn:     null,
  refreshBtn:   null,
};

/** MutationObserver watching for CAPTCHA refresh */
let captchaObserver = null;

/** Whether a pipeline run is currently in progress (prevents parallel runs) */
let isPipelineRunning = false;

/** Current attempt number (1 to MAX_RETRIES) */
let currentAttempt = 0;

// ─── Initialisation ───────────────────────────────────────────────────────────

/**
 * Main entry point — called automatically when the content script loads.
 * Reads settings, configures utilities, then starts CAPTCHA detection.
 */
async function init() {
  // Small initial delay — let the page's own JavaScript settle first
  await sleep(INITIAL_DELAY_MS);

  SRMLogger.info('Content', '─── SRM CAPTCHA Solver initialising ───');

  try {
    // ── Load settings from chrome.storage ─────────────────────────────────────
    settings = await SRMStorage.getAll();

    // ── Configure utilities based on settings ─────────────────────────────────
    SRMLogger.configure({
      debugMode: settings.debugMode,
      persist:   true,  // Save logs to storage so popup can read them
    });

    SRMLogger.info('Content', `Settings loaded: enabled=${settings.enabled}, threshold=${settings.confidenceThreshold}%, autoSubmit=${settings.autoSubmit}`);

    // ── Check if extension is enabled ─────────────────────────────────────────
    if (!settings.enabled) {
      SRMLogger.info('Content', 'Extension is disabled — standing by');
      // Still listen for "enable" messages from popup
      setupMessageListener();
      return;
    }

    // ── Verify we're on the correct page ──────────────────────────────────────
    if (!isOnLoginPage()) {
      SRMLogger.info('Content', `Not on login page (${window.location.pathname}) — standing by`);
      return;
    }

    SRMLogger.info('Content', 'On login page — starting CAPTCHA detection');

    // ── Set up message listener (for popup commands) ───────────────────────────
    setupMessageListener();

    // ── Start watching for the CAPTCHA to appear ───────────────────────────────
    await waitForCaptchaAndRun();

  } catch (err) {
    SRMLogger.error('Content', `Initialisation failed: ${err.message}`);
  }
}

// ─── Page Detection ───────────────────────────────────────────────────────────

/**
 * Check if we're on the SRM login page.
 * The extension only runs on the specific login URL, not all SRM pages.
 *
 * @returns {boolean}
 */
function isOnLoginPage() {
  const path = window.location.pathname.toLowerCase();
  const loginPaths = [
    '/srmiststudentportal/students/loginmanager/youlogin.jsp',
    '/srmiststudentportal/students/loginmanager/',
    '/youlogin.jsp',
  ];
  return loginPaths.some(p => path.includes(p.toLowerCase()));
}

// ─── CAPTCHA Detection & Waiting ─────────────────────────────────────────────

/**
 * Poll the DOM until the CAPTCHA image appears, then run the pipeline.
 * Uses a combination of polling (every POLL_INTERVAL_MS) and a timeout.
 *
 * WHY POLL instead of just MutationObserver?
 *   When content.js first loads, the CAPTCHA image may already be in the DOM
 *   but still loading. MutationObserver on DOM insertions would miss this case.
 *   Polling is simple and reliable for the initial detection.
 *
 *   After the first solve, we switch to MutationObserver for ongoing refresh detection.
 *
 * @returns {Promise<void>}
 */
async function waitForCaptchaAndRun() {
  SRMLogger.info('Content', 'Waiting for CAPTCHA to appear...');

  const startTime = Date.now();

  return new Promise((resolve) => {
    const poll = async () => {
      // Timeout check
      if (Date.now() - startTime > CAPTCHA_WAIT_TIMEOUT_MS) {
        SRMLogger.warn('Content', `CAPTCHA not found after ${CAPTCHA_WAIT_TIMEOUT_MS}ms — giving up`);
        resolve();
        return;
      }

      // Try to find CAPTCHA elements
      const found = SRMCaptchaDetector.findElements();

      if (found) {
        elements = found;
        SRMLogger.info('Content', 'CAPTCHA detected — starting pipeline');
        resolve();

        // Run the pipeline (don't await here — let resolve complete first)
        runPipeline();
      } else {
        // Not found yet — try again after interval
        setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    poll();
  });
}

// ─── Main Pipeline ────────────────────────────────────────────────────────────

/**
 * Run the full CAPTCHA solving pipeline.
 *
 * This is the core function. It runs:
 *   1. Capture CAPTCHA image
 *   2. Preprocess image (OpenCV.js)
 *   3. Run OCR (Tesseract.js)
 *   4. Check confidence
 *   5. Fill the field (or retry if confidence too low)
 *
 * Safe to call multiple times — guards against parallel runs with isPipelineRunning.
 *
 * @param {number} [attempt=1] - Current attempt number (1 = first try)
 */
async function runPipeline(attempt = 1) {
  // Guard: Don't run if another pipeline is already in progress
  if (isPipelineRunning && attempt === 1) {
    SRMLogger.warn('Content', 'Pipeline already running — ignoring duplicate trigger');
    return;
  }

  isPipelineRunning  = true;
  currentAttempt     = attempt;

  SRMLogger.info('Content', `─── Pipeline attempt ${attempt}/${MAX_RETRIES} ───`);

  // Notify popup that we're working
  await SRMMessaging.send(SRMMessaging.TYPES.CAPTCHA_DETECTED, {
    attempt,
    maxRetries: MAX_RETRIES,
  });

  try {
    // ── Re-check elements (they may have changed after a refresh) ──────────────
    const freshElements = SRMCaptchaDetector.findElements();
    if (!freshElements) {
      throw new Error('CAPTCHA elements not found on attempt ' + attempt);
    }
    elements = freshElements;

    // ── Step 1: Capture CAPTCHA image ─────────────────────────────────────────
    SRMLogger.info('Content', 'Step 1: Capturing CAPTCHA image...');
    const captureResult = await SRMImageCapture.capture(elements.captchaImg);

    // ── Step 2: Preprocess image ──────────────────────────────────────────────
    SRMLogger.info('Content', 'Step 2: Preprocessing image (OpenCV.js)...');
    const preprocessResult = await SRMPreprocessor.process(captureResult.base64PNG);

    // Save images to storage so popup can preview them
    await SRMStorage.saveCaptchaImages(
      captureResult.base64PNG,
      preprocessResult.processedBase64
    );

    // ── Step 3: OCR ───────────────────────────────────────────────────────────
    SRMLogger.info('Content', 'Step 3: Running OCR (Tesseract.js)...');
    const ocrResult = await SRMOCREngine.solve(preprocessResult.processedBase64);

    const { text, confidence } = ocrResult;

    SRMLogger.info('Content', `OCR result: "${text}" (confidence: ${confidence}%)`);

    // ── Step 4: Confidence check ──────────────────────────────────────────────
    if (confidence < settings.confidenceThreshold) {

      SRMLogger.warn(
        'Content',
        `Confidence ${confidence}% is below threshold ${settings.confidenceThreshold}% — ${attempt < MAX_RETRIES ? 'retrying' : 'giving up'}`
      );

      if (attempt < MAX_RETRIES) {
        // ── Retry: refresh CAPTCHA and try again ────────────────────────────
        SRMLogger.info('Content', `Refreshing CAPTCHA and retrying (attempt ${attempt + 1}/${MAX_RETRIES})...`);

        // Clear the input field first
        SRMAutofill.clear(elements.captchaInput);

        // Refresh CAPTCHA
        await SRMAutofill.refreshCaptcha(elements.refreshBtn, elements.captchaImg);

        // Wait for new CAPTCHA to load
        await sleep(RETRY_DELAY_MS);

        isPipelineRunning = false;  // Allow the next call
        await runPipeline(attempt + 1);
        return;

      } else {
        // ── All retries exhausted ──────────────────────────────────────────
        await handleFailure(text, confidence);
        return;
      }
    }

    // ── Step 5: Autofill ──────────────────────────────────────────────────────
    SRMLogger.info('Content', `Step 5: Filling CAPTCHA field with "${text}"...`);
    const filled = SRMAutofill.fill(elements.captchaInput, text);

    if (!filled) {
      throw new Error('Autofill returned false — field may not have been filled');
    }

    // ── Step 6: Record success ────────────────────────────────────────────────
    await SRMStorage.recordAttempt(true, confidence);

    // Notify popup of success
    await SRMMessaging.send(SRMMessaging.TYPES.CAPTCHA_SOLVED, {
      text,
      confidence,
      attempt,
      preprocessTimingMs: preprocessResult.timingMs,
      ocrElapsedMs:       ocrResult.elapsed,
    });

    SRMLogger.info('Content', `✓ CAPTCHA solved: "${text}" (${confidence}% confidence)`);

    // ── Step 7: Optional auto-submit ──────────────────────────────────────────
    if (settings.autoSubmit) {
      SRMLogger.info('Content', 'Auto-submit enabled — submitting form...');
      await SRMAutofill.submit(elements.loginBtn, elements.captchaInput);
    }

    // ── Step 8: Start watching for CAPTCHA refresh ────────────────────────────
    // After a successful solve, keep watching in case user refreshes the CAPTCHA
    // or login fails and a new CAPTCHA appears.
    watchForRefresh();

  } catch (err) {
    SRMLogger.error('Content', `Pipeline error on attempt ${attempt}: ${err.message}`);

    if (attempt < MAX_RETRIES) {
      SRMLogger.info('Content', `Retrying after error (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await sleep(RETRY_DELAY_MS);
      isPipelineRunning = false;
      await runPipeline(attempt + 1);
    } else {
      await handleFailure('', 0);
    }
  } finally {
    isPipelineRunning = false;
  }
}

// ─── Failure Handler ──────────────────────────────────────────────────────────

/**
 * Handle the case where all retries are exhausted.
 * Records the failure, notifies the popup, and lets the user correct manually.
 *
 * @param {string} lastText       - The best OCR text we got (may be wrong)
 * @param {number} lastConfidence - The confidence score of the best attempt
 */
async function handleFailure(lastText, lastConfidence) {
  SRMLogger.warn(
    'Content',
    `All ${MAX_RETRIES} attempts exhausted. Best result: "${lastText}" (${lastConfidence}%). Manual correction needed.`
  );

  await SRMStorage.recordAttempt(false, lastConfidence);

  // Fill whatever we have (the user can correct it from the popup)
  if (lastText && elements.captchaInput) {
    SRMAutofill.fill(elements.captchaInput, lastText);
  }

  await SRMMessaging.send(SRMMessaging.TYPES.CAPTCHA_FAILED, {
    lastText,
    lastConfidence,
    attempts: MAX_RETRIES,
    message:  'OCR confidence too low after all retries. Please correct manually.',
  });
}

// ─── CAPTCHA Refresh Watcher ──────────────────────────────────────────────────

/**
 * Set up a MutationObserver to detect CAPTCHA refresh.
 *
 * After the initial solve, we keep watching the CAPTCHA image.
 * If it changes (user clicked "Refresh", or a new CAPTCHA appears after a
 * failed login), we automatically re-run the full pipeline.
 *
 * WHY: Without this, if the user refreshes the CAPTCHA or the login fails
 *      (showing a new CAPTCHA), they'd have to manually click the extension.
 */
function watchForRefresh() {
  // Disconnect any existing observer first
  if (captchaObserver) {
    captchaObserver.disconnect();
    SRMLogger.debug('Content', 'Previous MutationObserver disconnected');
  }

  if (!elements.captchaImg) {
    SRMLogger.warn('Content', 'Cannot set up refresh watcher — no CAPTCHA image element');
    return;
  }

  captchaObserver = SRMCaptchaDetector.watchForCaptchaChanges(
    document.body,        // Observe the whole body for new elements
    elements.captchaImg,  // Specifically watch this image's src
    async () => {
      SRMLogger.info('Content', 'CAPTCHA changed — re-running pipeline');
      // Reset attempt counter for the new CAPTCHA
      currentAttempt = 0;
      isPipelineRunning = false;
      await runPipeline(1);
    }
  );

  SRMLogger.info('Content', 'MutationObserver active — watching for CAPTCHA changes');
}

// ─── Message Listener (from Popup & Background) ───────────────────────────────

/**
 * Set up the message listener for commands from the popup.
 *
 * Commands we handle:
 *   TOGGLE_EXTENSION     → enable/disable the extension
 *   RETRY_CAPTCHA        → re-run the pipeline on demand
 *   MANUAL_CORRECTION    → fill a specific text (user typed it in popup)
 *   GET_STATUS           → respond with current state
 */
function setupMessageListener() {
  SRMMessaging.onMessage(async (type, payload) => {
    SRMLogger.debug('Content', `Message received: ${type}`, payload);

    switch (type) {

      // ── User toggled the extension from popup ──────────────────────────────
      case SRMMessaging.TYPES.TOGGLE_EXTENSION: {
        settings.enabled = payload.enabled;
        SRMLogger.info('Content', `Extension ${settings.enabled ? 'enabled' : 'disabled'} via popup`);

        if (settings.enabled && isOnLoginPage()) {
          // Re-run detection if extension was just enabled
          await waitForCaptchaAndRun();
        } else if (!settings.enabled && captchaObserver) {
          // Stop watching if disabled
          captchaObserver.disconnect();
          captchaObserver = null;
        }
        return { ok: true };
      }

      // ── User clicked "Retry" in popup ─────────────────────────────────────
      case SRMMessaging.TYPES.RETRY_CAPTCHA: {
        SRMLogger.info('Content', 'Manual retry requested from popup');
        isPipelineRunning = false;
        await SRMAutofill.refreshCaptcha(elements.refreshBtn, elements.captchaImg);
        await sleep(RETRY_DELAY_MS);
        await runPipeline(1);
        return { ok: true };
      }

      // ── User typed a correction in popup ──────────────────────────────────
      case SRMMessaging.TYPES.MANUAL_CORRECTION: {
        const correctedText = payload?.text?.trim();
        if (!correctedText) {
          SRMLogger.warn('Content', 'Manual correction received empty text — ignoring');
          return { ok: false, error: 'Empty text' };
        }

        SRMLogger.info('Content', `Manual correction: "${correctedText}"`);

        if (elements.captchaInput) {
          const success = SRMAutofill.fill(elements.captchaInput, correctedText);
          return { ok: success };
        } else {
          // Input not found — re-scan elements and try again
          const found = SRMCaptchaDetector.findElements();
          if (found?.captchaInput) {
            elements = found;
            const success = SRMAutofill.fill(elements.captchaInput, correctedText);
            return { ok: success };
          }
          return { ok: false, error: 'CAPTCHA input field not found' };
        }
      }

      // ── Popup is requesting current status ────────────────────────────────
      case SRMMessaging.TYPES.GET_STATUS: {
        return {
          ok:               true,
          isOnLoginPage:    isOnLoginPage(),
          enabled:          settings.enabled,
          isPipelineRunning,
          currentAttempt,
          hasElements: {
            captchaImg:   !!elements.captchaImg,
            captchaInput: !!elements.captchaInput,
            loginBtn:     !!elements.loginBtn,
            refreshBtn:   !!elements.refreshBtn,
          },
        };
      }

      // ── Settings updated from popup ────────────────────────────────────────
      case SRMMessaging.TYPES.SET_CONFIDENCE_THRESHOLD: {
        settings.confidenceThreshold = payload.threshold;
        SRMLogger.info('Content', `Confidence threshold updated to ${payload.threshold}%`);
        return { ok: true };
      }

      default:
        SRMLogger.debug('Content', `Unhandled message type: ${type}`);
        return null;
    }
  });

  SRMLogger.debug('Content', 'Message listener set up ✓');
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Simple promise-based sleep.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Start the extension immediately when the content script loads.
// The script runs at document_idle (declared in manifest.json), so the
// page's DOM is fully built by this point.
init().catch(err => {
  console.error('[SRM][ERROR][Content] Fatal init error:', err);
});
