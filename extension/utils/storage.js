/**
 * storage.js — Chrome Storage Abstraction Layer
 *
 * WHY: chrome.storage.local is asynchronous and callback-based.
 * This module wraps it in Promises with typed defaults so the rest
 * of the extension never has to deal with raw storage boilerplate.
 *
 * SCHEMA:
 *   enabled            boolean  — Is the extension active?
 *   autoSubmit         boolean  — Auto-click login after filling CAPTCHA?
 *   debugMode          boolean  — Show verbose logs?
 *   confidenceThreshold number  — Minimum OCR confidence (0–100) to accept result
 *   stats              object   — Lifetime usage statistics
 *   lastCaptchaImage   string   — Base64 of the original CAPTCHA (for popup preview)
 *   lastProcessedImage string   — Base64 of the preprocessed image (for popup preview)
 */

'use strict';

// ─── Default Settings ─────────────────────────────────────────────────────────

const STORAGE_DEFAULTS = {
  enabled:             true,
  autoSubmit:          false,
  debugMode:           false,
  confidenceThreshold: 70,
  stats: {
    attempts:       0,
    successes:      0,
    totalConfidence: 0,  // Used to compute average confidence
    failures:       0,
  },
  lastCaptchaImage:    null,
  lastProcessedImage:  null,
};

// ─── Storage API ──────────────────────────────────────────────────────────────

const SRMStorage = {

  /**
   * Get one or more settings by key.
   * @param {string|string[]} keys - A single key or array of keys.
   * @returns {Promise<object>} - Object with the requested key-value pairs.
   *
   * Example:
   *   const { enabled, debugMode } = await SRMStorage.get(['enabled', 'debugMode']);
   */
  async get(keys) {
    return new Promise((resolve, reject) => {
      // Build defaults for only the requested keys
      const defaults = {};
      const keyList = Array.isArray(keys) ? keys : [keys];
      keyList.forEach(k => {
        if (STORAGE_DEFAULTS.hasOwnProperty(k)) {
          defaults[k] = STORAGE_DEFAULTS[k];
        }
      });

      chrome.storage.local.get(defaults, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result);
        }
      });
    });
  },

  /**
   * Get ALL settings (with defaults applied for missing keys).
   * @returns {Promise<object>}
   */
  async getAll() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(STORAGE_DEFAULTS, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result);
        }
      });
    });
  },

  /**
   * Set one or more settings.
   * @param {object} data - Key-value pairs to store.
   * @returns {Promise<void>}
   *
   * Example:
   *   await SRMStorage.set({ enabled: false, debugMode: true });
   */
  async set(data) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(data, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  },

  /**
   * Reset all settings to defaults.
   * @returns {Promise<void>}
   */
  async resetAll() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(STORAGE_DEFAULTS, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  },

  /**
   * Record a CAPTCHA solving attempt in the stats.
   * @param {boolean} success       - Was the CAPTCHA solved correctly?
   * @param {number}  confidence    - OCR confidence score (0–100)
   * @returns {Promise<void>}
   */
  async recordAttempt(success, confidence) {
    const { stats } = await this.get('stats');
    const updated = {
      ...stats,
      attempts:        stats.attempts + 1,
      successes:       stats.successes + (success ? 1 : 0),
      failures:        stats.failures  + (success ? 0 : 1),
      totalConfidence: stats.totalConfidence + confidence,
    };
    await this.set({ stats: updated });
  },

  /**
   * Save the latest CAPTCHA images for popup preview.
   * @param {string} originalBase64   - Original CAPTCHA as base64 data URL
   * @param {string} processedBase64  - Preprocessed CAPTCHA as base64 data URL
   * @returns {Promise<void>}
   */
  async saveCaptchaImages(originalBase64, processedBase64) {
    await this.set({
      lastCaptchaImage:   originalBase64,
      lastProcessedImage: processedBase64,
    });
  },
};

window.SRMStorage = SRMStorage;
