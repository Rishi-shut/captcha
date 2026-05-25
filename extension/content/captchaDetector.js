/**
 * captchaDetector.js — CAPTCHA Element Locator
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * Finds the CAPTCHA image, input field, and submit button on the SRM portal.
 *
 * WHY NOT JUST USE ONE SELECTOR?
 *   Websites change their HTML over time. If the SRM portal updates their page
 *   and renames an element (e.g. #captchaImg → #captcha-image), a hardcoded
 *   single selector would silently break the extension.
 *
 *   Instead, we use a PRIORITY LIST of selectors. The detector tries them
 *   in order and returns the first match. If the portal changes one selector,
 *   another in the list likely still works — keeping the extension resilient.
 *
 * HOW TO UPDATE SELECTORS:
 *   1. Right-click the CAPTCHA image on the portal → "Inspect"
 *   2. Note the element's id, class, name attributes
 *   3. Add the new selector at the TOP of the appropriate list below
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SELECTOR STRATEGY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Priority tiers (tried in order):
 *   Tier 1: Exact ID selectors     — Most reliable, break only on full rename
 *   Tier 2: Attribute selectors    — More flexible, survive class renames
 *   Tier 3: Generic heuristics     — Last resort, analyse all elements on page
 */

'use strict';

// ─── Selector Configuration ───────────────────────────────────────────────────
// Update these lists if the SRM portal HTML changes.
// Add new selectors at the TOP of each list (highest priority).

/** CSS selectors for the CAPTCHA <img> element — tried in order */
const CAPTCHA_IMG_SELECTORS = [
  // Tier 1: Exact ID (most reliable)
  '#captchaImg',
  '#captcha_img',
  '#captchaImage',
  '#captcha-img',
  '#captcha-image',

  // Tier 2: Attribute-based (flexible)
  'img[id*="captcha" i]',           // Any img whose id contains "captcha" (case-insensitive)
  'img[src*="captcha" i]',          // Any img whose src URL contains "captcha"
  'img[alt*="captcha" i]',          // Any img whose alt text mentions captcha
  'img[name*="captcha" i]',         // Any img with name attribute containing captcha

  // Tier 3: Form-structure heuristic
  // CAPTCHA images are typically small (< 300px wide) and inside a form
  // This is the most fragile selector — only used as a last resort
];

/** CSS selectors for the CAPTCHA text <input> field */
const CAPTCHA_INPUT_SELECTORS = [
  // Tier 1: Exact ID
  '#captchaTextBox',
  '#captcha_text',
  '#captchaInput',
  '#captcha-input',
  '#captchatext',
  '#txtCaptcha',

  // Tier 2: Attribute-based
  'input[id*="captcha" i]',
  'input[name*="captcha" i]',
  'input[placeholder*="captcha" i]',
  'input[autocomplete="off"][type="text"]',  // CAPTCHAs often disable autocomplete
];

/** CSS selectors for the login submit button */
const LOGIN_BTN_SELECTORS = [
  // Tier 1: Exact ID
  '#btnSubmit',
  '#loginBtn',
  '#login-btn',
  '#submitBtn',
  '#btnLogin',

  // Tier 2: Attribute / type based
  'button[type="submit"]',
  'input[type="submit"]',
  'button[id*="login" i]',
  'button[id*="submit" i]',
  'a[id*="login" i]',
];

/** CSS selectors for the "Refresh CAPTCHA" button/link */
const CAPTCHA_REFRESH_SELECTORS = [
  // Tier 1: Exact ID
  '#refreshCaptcha',
  '#captchaRefresh',
  '#refreshCapImg',
  '#btnRefreshCaptcha',

  // Tier 2: Attribute-based
  'a[id*="refresh" i][id*="captcha" i]',
  'img[id*="refresh" i]',
  'a[title*="refresh" i]',
  'a[onclick*="captcha" i]',     // Often CAPTCHAs are refreshed via onclick
  '[onclick*="refreshCaptcha"]',
  '[onclick*="refresh_captcha"]',
];

// ─── Detector Module ──────────────────────────────────────────────────────────

const SRMCaptchaDetector = {

  /**
   * Find all CAPTCHA-related elements on the current page.
   *
   * @returns {{ captchaImg, captchaInput, loginBtn, refreshBtn } | null}
   *   Returns null if the CAPTCHA image cannot be found (not on login page).
   *   captchaImg and captchaInput are required.
   *   loginBtn and refreshBtn may be null (non-fatal).
   */
  findElements() {
    SRMLogger.debug('Detector', 'Scanning page for CAPTCHA elements...');

    // ── Find CAPTCHA image (REQUIRED) ─────────────────────────────────────────
    const captchaImg = this._findElement(CAPTCHA_IMG_SELECTORS, 'CAPTCHA image');

    if (!captchaImg) {
      // Not on login page, or CAPTCHA not loaded yet
      SRMLogger.debug('Detector', 'CAPTCHA image not found — not on login page or CAPTCHA pending');
      return null;
    }

    // Verify the image is actually loaded and visible (has real dimensions)
    if (!this._isImageReady(captchaImg)) {
      SRMLogger.debug('Detector', 'CAPTCHA image found but not yet loaded — will retry');
      return null;
    }

    // ── Find CAPTCHA input field (REQUIRED) ───────────────────────────────────
    const captchaInput = this._findElement(CAPTCHA_INPUT_SELECTORS, 'CAPTCHA input');

    if (!captchaInput) {
      SRMLogger.warn(
        'Detector',
        'CAPTCHA image found but input field not found. Check CAPTCHA_INPUT_SELECTORS in captchaDetector.js'
      );
      return null;
    }

    // ── Find login button (OPTIONAL) ──────────────────────────────────────────
    const loginBtn = this._findElement(LOGIN_BTN_SELECTORS, 'Login button');
    if (!loginBtn) {
      SRMLogger.warn('Detector', 'Login button not found — auto-submit will be unavailable');
    }

    // ── Find refresh button (OPTIONAL) ────────────────────────────────────────
    const refreshBtn = this._findElement(CAPTCHA_REFRESH_SELECTORS, 'Refresh button');
    if (!refreshBtn) {
      SRMLogger.debug('Detector', 'Refresh button not found — will use src reload method for retry');
    }

    SRMLogger.info('Detector', `Found: img=${captchaImg.id || captchaImg.src?.slice(-20)}, input=${captchaInput.id}, btn=${loginBtn?.id || 'n/a'}, refresh=${refreshBtn?.id || 'n/a'}`);

    return { captchaImg, captchaInput, loginBtn, refreshBtn };
  },

  /**
   * Check if a CAPTCHA image has changed (used by MutationObserver callback).
   * Compares the image src before and after a mutation.
   *
   * @param {MutationRecord[]} mutations - Array of mutations from MutationObserver
   * @param {HTMLImageElement} watchedImg - The CAPTCHA img element being watched
   * @returns {boolean} True if the CAPTCHA image src changed
   */
  isCaptchaRefreshed(mutations, watchedImg) {
    for (const mutation of mutations) {
      if (
        mutation.type === 'attributes' &&
        mutation.attributeName === 'src' &&
        mutation.target === watchedImg
      ) {
        SRMLogger.info('Detector', 'CAPTCHA src changed — new CAPTCHA detected');
        return true;
      }

      // Also check if the CAPTCHA image was replaced with a new element
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.tagName === 'IMG' && this._isCaptchaLike(node)) {
            SRMLogger.info('Detector', 'New CAPTCHA img element added to DOM');
            return true;
          }
        }
      }
    }
    return false;
  },

  /**
   * Create a MutationObserver that watches for CAPTCHA changes.
   * This handles:
   *   - Manual "Refresh CAPTCHA" button clicks (src attribute change)
   *   - Portal dynamically replacing the CAPTCHA element (childList change)
   *
   * @param {HTMLElement}   target    - Element to observe (usually document.body)
   * @param {HTMLImageElement} captchaImg - The specific CAPTCHA img to watch
   * @param {function}      callback  - Called when a CAPTCHA change is detected
   * @returns {MutationObserver} - The observer (call .disconnect() to stop)
   */
  watchForCaptchaChanges(target, captchaImg, callback) {
    const observer = new MutationObserver((mutations) => {
      if (this.isCaptchaRefreshed(mutations, captchaImg)) {
        // Wait a brief moment for the new CAPTCHA image to finish loading
        setTimeout(() => {
          SRMLogger.debug('Detector', 'Triggering callback after CAPTCHA change');
          callback();
        }, 300);
      }
    });

    observer.observe(target, {
      attributes:    true,           // Watch for src attribute changes
      attributeFilter: ['src'],      // Only care about src changes
      childList:     true,           // Watch for new/removed elements
      subtree:       true,           // Watch the entire subtree (not just direct children)
    });

    SRMLogger.debug('Detector', 'MutationObserver started — watching for CAPTCHA changes');
    return observer;
  },

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Try each selector in the list and return the first matching element.
   *
   * @param {string[]} selectors   - CSS selectors to try in order
   * @param {string}   elementName - Human-readable name for logging
   * @returns {Element|null}
   * @private
   */
  _findElement(selectors, elementName) {
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          SRMLogger.debug('Detector', `${elementName}: found with selector "${selector}"`);
          return el;
        }
      } catch (e) {
        // Invalid CSS selector — skip it and try the next one
        SRMLogger.warn('Detector', `Invalid selector "${selector}": ${e.message}`);
      }
    }

    // None of the selectors matched — log all selectors tried for debugging
    SRMLogger.debug('Detector', `${elementName}: not found with any selector`, selectors.join(', '));
    return null;
  },

  /**
   * Check if an image element is fully loaded and has valid dimensions.
   * An image might be in the DOM but still downloading.
   *
   * @param {HTMLImageElement} img
   * @returns {boolean}
   * @private
   */
  _isImageReady(img) {
    return (
      img.complete &&
      img.naturalWidth  > 0 &&
      img.naturalHeight > 0
    );
  },

  /**
   * Heuristic check: does an image element look like a CAPTCHA?
   * Used when scanning all images on the page as a last resort.
   *
   * Characteristics of CAPTCHA images:
   *   - Small width (50–300px typically)
   *   - Small height (30–100px typically)
   *   - src URL often contains "captcha", "verify", "seccode" etc.
   *
   * @param {HTMLImageElement} img
   * @returns {boolean}
   * @private
   */
  _isCaptchaLike(img) {
    if (!img || img.tagName !== 'IMG') return false;

    const src = (img.src || '').toLowerCase();
    const id  = (img.id  || '').toLowerCase();
    const alt = (img.alt || '').toLowerCase();

    const captchaKeywords = ['captcha', 'verify', 'seccode', 'vcode', 'checkcode'];
    const hasCaptchaKeyword = captchaKeywords.some(kw =>
      src.includes(kw) || id.includes(kw) || alt.includes(kw)
    );

    // Small image (typical CAPTCHA size range)
    const isSmall = img.naturalWidth > 0 &&
                    img.naturalWidth  < 400 &&
                    img.naturalHeight < 150;

    return hasCaptchaKeyword || isSmall;
  },
};

window.SRMCaptchaDetector = SRMCaptchaDetector;
