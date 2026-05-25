/**
 * ocrEngine.js — Tesseract.js OCR Wrapper
 *
 * WHY: Tesseract.js is a WebAssembly port of the Tesseract OCR engine.
 * It can read text from images entirely in the browser — no server needed.
 *
 * HOW IT WORKS:
 *   1. A Tesseract "worker" is a Web Worker that runs the OCR engine.
 *   2. We load the English language data file (eng.traineddata).
 *   3. We pass a preprocessed canvas/image to the worker.
 *   4. Tesseract analyses pixel patterns and returns text + confidence.
 *
 * CONFIGURATION:
 *   - PSM 8: Treat the image as a single word (best for simple CAPTCHAs)
 *   - Character whitelist: Only A-Z, a-z, 0-9 (reduces wrong characters)
 *
 * IMPORTANT: The worker is expensive to create. We create it once and
 * reuse it across multiple CAPTCHA solves (lazy initialisation).
 */

'use strict';

// ─── OCR Engine State ─────────────────────────────────────────────────────────

/** Cached Tesseract worker instance (created once, reused). */
let worker = null;

/** Whether the worker is currently being initialised (prevents double-init). */
let isInitialising = false;

/** Promise that resolves when the worker is ready. */
let workerReadyPromise = null;

/**
 * OCR character whitelist — restrict Tesseract to these characters only.
 * CAPTCHA characters are typically alphanumeric, so we exclude punctuation
 * and other symbols that would cause recognition errors.
 */
const CHAR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// ─── Public API ───────────────────────────────────────────────────────────────

const SRMOCREngine = {

  /**
   * Initialise the Tesseract worker (lazy — called automatically on first use).
   * Safe to call multiple times — only creates one worker.
   *
   * @returns {Promise<void>}
   */
  async init() {
    if (worker) return; // Already initialised
    if (workerReadyPromise) return workerReadyPromise; // Already initialising

    SRMLogger.info('OCR', 'Initialising Tesseract.js worker...');

    workerReadyPromise = (async () => {
      try {
        isInitialising = true;

        // Tesseract.js v4/v5 API
        // The worker loads from our local libs/ directory
        worker = await Tesseract.createWorker('eng', 1, {
          // Point to our locally bundled lang data
          langPath: chrome.runtime.getURL('libs/tessdata/'),
          workerPath: chrome.runtime.getURL('libs/tesseract.worker.min.js'),
          corePath: chrome.runtime.getURL('libs/tesseract-core.wasm.js'),
          logger: (m) => {
            if (m.status === 'recognizing text') {
              SRMLogger.debug('OCR', `Progress: ${Math.floor(m.progress * 100)}%`);
            }
          },
        });

        // Configure Tesseract parameters for CAPTCHA recognition
        await worker.setParameters({
          // PSM 7 = Single text line (best for line CAPTCHAs)
          tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
          // Restrict to alphanumeric characters only
          tessedit_char_whitelist: CHAR_WHITELIST,
          // Disable dictionary — CAPTCHA is not a real word
          load_system_dawg: '0',
          load_freq_dawg:   '0',
        });

        isInitialising = false;
        SRMLogger.info('OCR', 'Tesseract.js worker ready ✓');
      } catch (err) {
        isInitialising = false;
        worker = null;
        workerReadyPromise = null;
        throw new Error(`OCR init failed: ${err.message}`);
      }
    })();

    return workerReadyPromise;
  },

  /**
   * Solve a CAPTCHA image using OCR.
   *
   * @param {HTMLCanvasElement|HTMLImageElement|string} imageSource
   *   Can be a canvas element, img element, or base64 data URL.
   *
   * @returns {Promise<{text: string, confidence: number, words: Array}>}
   *   text:       Cleaned OCR result string
   *   confidence: Overall confidence score (0–100)
   *   words:      Array of word-level results (each with its own confidence)
   *
   * @throws {Error} If OCR fails or worker is unavailable
   */
  async solve(imageSource) {
    // Ensure worker is ready
    await this.init();

    if (!worker) {
      throw new Error('OCR worker not available');
    }

    SRMLogger.info('OCR', 'Running recognition...');
    const startTime = performance.now();

    const { data } = await worker.recognize(imageSource);

    const elapsed = Math.round(performance.now() - startTime);
    SRMLogger.debug('OCR', `Recognition completed in ${elapsed}ms`);

    // Clean the raw OCR text:
    const rawText = data.text || '';
    
    let cleanText = rawText
      .replace(/[^A-Za-z0-9]/g, '')
      .trim();

    // Remove spaces/newlines
    cleanText = cleanText.replace(/\s+/g, '');

    // Optional length trimming
    if (cleanText.length > 6) {
      cleanText = cleanText.slice(0, 6);
    }

    const confidence = Math.round(data.confidence) || 0;

    SRMLogger.info('OCR', `Result: "${cleanText}" (confidence: ${confidence}%)`);

    if (cleanText.length === 0) {
      SRMLogger.warn('OCR', 'OCR returned empty text — may need better preprocessing');
    }

    return {
      text:       cleanText,
      confidence: confidence,
      words:      data.words || [],
      rawText:    rawText,
      elapsed:    elapsed,
    };
  },

  /**
   * Terminate the Tesseract worker and free resources.
   * Call this when the extension is disabled to avoid memory leaks.
   * @returns {Promise<void>}
   */
  async terminate() {
    if (worker) {
      SRMLogger.info('OCR', 'Terminating Tesseract worker...');
      await worker.terminate();
      worker           = null;
      workerReadyPromise = null;
      SRMLogger.info('OCR', 'Worker terminated ✓');
    }
  },

  /**
   * Check if the worker has been initialised.
   * @returns {boolean}
   */
  isReady() {
    return worker !== null;
  },
};

window.SRMOCREngine = SRMOCREngine;
