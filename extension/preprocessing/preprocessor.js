/**
 * preprocessor.js — OpenCV.js Image Preprocessing Pipeline
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * Raw CAPTCHA images are deliberately noisy and hard for computers to read.
 * This module cleans them up so Tesseract.js can recognise the text accurately.
 *
 * PIPELINE ORDER (matters — each step builds on the previous):
 *   1. Load image into OpenCV Mat
 *   2. Convert RGBA → Grayscale
 *   3. Gaussian Blur (remove random pixel noise)
 *   4. Otsu's Threshold (convert to pure black & white)
 *   5. Morphological Closing (fill gaps cut by noise lines)
 *   6. Upscale 3× (Tesseract works better on larger images)
 *   7. Export processed image as base64 PNG
 *
 * MEMORY MANAGEMENT (CRITICAL):
 *   OpenCV.js uses WebAssembly memory that JavaScript's garbage collector
 *   does NOT manage. Every cv.Mat you create MUST be manually deleted with
 *   mat.delete() when done, otherwise you get memory leaks that crash the tab.
 *   We use a try/finally pattern to guarantee cleanup even if an error occurs.
 *
 * WHY EACH STEP:
 *   See docs/preprocessing.md for a detailed explanation of every step.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO DEBUG
 * ─────────────────────────────────────────────────────────────────────────────
 * Enable debug mode in the popup to see:
 *   - Processing time for each stage
 *   - Otsu's auto-detected threshold value
 *   - Image dimensions at each stage
 *   - Base64 length (proxy for image content richness)
 *
 * Use test-captchas/test-runner.html to see EVERY intermediate image visually.
 */

'use strict';

// ─── Configuration ────────────────────────────────────────────────────────────
// These values are tuned for SRM's CAPTCHA style.
// If accuracy drops after a portal update, these are the first things to adjust.

const PREPROCESSING_CONFIG = {
  /**
   * GAUSSIAN BLUR KERNEL SIZE
   * Must be an odd positive integer (1, 3, 5, 7, ...)
   *
   * Controls how aggressively we smooth the image before thresholding.
   *   Too small (1): No blurring — noise reaches thresholding step
   *   Too large (9+): Characters start to blur into each other
   *   Sweet spot (3): Removes fine noise without destroying character edges
   */
  blurKernelSize: 3,

  /**
   * MORPHOLOGY KERNEL SIZE
   * Controls the size of the structuring element for MORPH_CLOSE.
   *
   * MORPH_CLOSE = dilation followed by erosion.
   * It fills small gaps/holes inside character strokes (caused by noise lines).
   *
   *   Too small (1×1): No effect
   *   Too large (4×4+): Characters lose detail, thin strokes disappear
   *   Sweet spot (2×2): Fills hairline gaps without altering character shape
   */
  morphKernelSize: 2,

  /**
   * UPSCALE FACTOR
   * How many times larger to make the image before passing to Tesseract.
   *
   * Tesseract was designed for text images where characters are 20–40px tall.
   * CAPTCHA characters are often only 10–20px tall — upscaling compensates.
   *
   *   1: No upscaling (bad accuracy on small CAPTCHAs)
   *   2: Moderate improvement
   *   3: Best balance of accuracy and processing speed ← DEFAULT
   *   4+: Diminishing returns, slower processing
   */
  upscaleFactor: 3,

  /**
   * INTERPOLATION METHOD FOR UPSCALING
   * cv.INTER_CUBIC uses a 4×4 pixel neighbourhood for the smoothest result.
   * cv.INTER_LINEAR is faster but slightly lower quality.
   * cv.INTER_NEAREST is fastest but creates pixelated "staircase" edges.
   */
  interpolation: null, // Set to cv.INTER_CUBIC in init() once cv is ready

  /**
   * Whether to attempt horizontal line removal before thresholding.
   * Lines that are wider than minLineWidth pixels will be detected and erased.
   * Disabled by default — enable if SRM's CAPTCHA has many horizontal noise lines.
   */
  removeHorizontalLines: false,
  minLineWidth: 20, // Minimum horizontal span (pixels) to be classified as a "line"

  /**
   * Whether to attempt vertical line removal before thresholding.
   * Same as above but for vertical lines.
   */
  removeVerticalLines: false,
  minLineHeight: 15,
};

// ─── Preprocessor Module ──────────────────────────────────────────────────────

const SRMPreprocessor = {

  /**
   * Whether OpenCV.js has finished loading.
   * The cv object is available globally but may not be ready immediately.
   */
  _opencvReady: false,

  /**
   * Wait for OpenCV.js to be ready.
   * OpenCV.js loads asynchronously (it's a WASM module).
   * This method polls until it's available, up to a timeout.
   *
   * @param {number} timeoutMs - Maximum time to wait (default: 10 seconds)
   * @returns {Promise<void>}
   * @throws {Error} If OpenCV doesn't load within the timeout
   */
  async waitForOpenCV(timeoutMs = 10000) {
    if (this._opencvReady) return;

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const check = () => {
        // cv is the global OpenCV object injected by opencv.js
        if (typeof cv !== 'undefined' && cv.Mat) {
          // OpenCV is ready — set the interpolation mode now
          PREPROCESSING_CONFIG.interpolation = cv.INTER_CUBIC;
          this._opencvReady = true;
          SRMLogger.info('Preprocessor', 'OpenCV.js ready ✓');
          resolve();
        } else if (Date.now() - startTime > timeoutMs) {
          reject(new Error('OpenCV.js failed to load within timeout'));
        } else {
          // Not ready yet — check again in 100ms
          setTimeout(check, 100);
        }
      };

      check();
    });
  },

  /**
   * Run the full preprocessing pipeline on a CAPTCHA image.
   *
   * @param {string} base64PNG
   *   The CAPTCHA image as a base64 data URL (from imageCapture.js).
   *   Format: "data:image/png;base64,iVBORw0KGgo..."
   *
   * @returns {Promise<PreprocessingResult>}
   *   {
   *     processedBase64: string,  — Cleaned image as base64 PNG
   *     originalBase64:  string,  — Original image (passed through unchanged)
   *     dimensions:      { width, height },  — Final image size
   *     otsuThreshold:   number,  — Auto-detected threshold value (0–255)
   *     stages:          object,  — Debug: base64 of each intermediate stage
   *     timingMs:        object,  — Debug: time spent in each stage
   *   }
   *
   * @throws {Error} If OpenCV is not loaded or preprocessing fails
   */
  async process(base64PNG) {
    SRMLogger.info('Preprocessor', 'Starting preprocessing pipeline...');
    const pipelineStart = performance.now();

    // Ensure OpenCV is loaded before we use it
    await this.waitForOpenCV();

    // Timing tracker for each stage (for debug output)
    const timingMs = {};

    // Stage images for debug visualisation (only populated in debug mode)
    const stages = {};

    // All OpenCV Mats we create — tracked here for guaranteed cleanup
    const matsToDelete = [];

    try {
      // ── STAGE 1: Load Image ─────────────────────────────────────────────────

      let t = performance.now();
      const { canvas, img } = await this._base64ToCanvas(base64PNG);
      const srcMat = cv.imread(canvas); // RGBA Mat from canvas
      matsToDelete.push(srcMat);
      timingMs.load = Math.round(performance.now() - t);

      SRMLogger.debug('Preprocessor', `Loaded image: ${srcMat.cols}×${srcMat.rows}px`, timingMs);
      this._saveStage(stages, 'original', canvas);

      // ── STAGE 2: Grayscale Conversion ───────────────────────────────────────
      //
      // WHY: Tesseract and our thresholding work on single-channel images.
      //      Colour information is noise for CAPTCHA reading.
      //
      // Before: Each pixel = (R, G, B, A) — 4 channels
      // After:  Each pixel = brightness (0=black, 255=white) — 1 channel

      t = performance.now();
      const grayMat = new cv.Mat();
      matsToDelete.push(grayMat);
      cv.cvtColor(srcMat, grayMat, cv.COLOR_RGBA2GRAY);
      timingMs.grayscale = Math.round(performance.now() - t);

      SRMLogger.debug('Preprocessor', `Grayscale done (${timingMs.grayscale}ms)`);
      this._saveStage(stages, 'grayscale', this._matToCanvas(grayMat));

      // ── STAGE 3: Gaussian Blur (Denoising) ──────────────────────────────────
      //
      // WHY: CAPTCHAs have random "salt and pepper" noise — individual pixels
      //      that are slightly lighter or darker than their surroundings.
      //      These confuse thresholding (a dark noise pixel near a light area
      //      gets classified as text when it isn't).
      //
      //      Gaussian blur replaces each pixel with a weighted average of its
      //      neighbours. The weights follow a bell curve (more weight to nearby
      //      pixels). This smooths out the noise without destroying the larger,
      //      meaningful character shapes.
      //
      // kernel = 3×3 = each pixel is averaged with its 8 immediate neighbours.
      // sigma  = 0   = let OpenCV auto-calculate from kernel size.

      t = performance.now();
      const blurredMat = new cv.Mat();
      matsToDelete.push(blurredMat);
      const blurKernel = new cv.Size(
        PREPROCESSING_CONFIG.blurKernelSize,
        PREPROCESSING_CONFIG.blurKernelSize
      );
      cv.GaussianBlur(grayMat, blurredMat, blurKernel, 0);
      timingMs.blur = Math.round(performance.now() - t);

      SRMLogger.debug('Preprocessor', `Gaussian blur done (${timingMs.blur}ms, kernel=${PREPROCESSING_CONFIG.blurKernelSize}×${PREPROCESSING_CONFIG.blurKernelSize})`);
      this._saveStage(stages, 'blurred', this._matToCanvas(blurredMat));

      // ── STAGE 4: Otsu's Thresholding (Binarization) ─────────────────────────
      //
      // WHY: Tesseract achieves best accuracy on pure black-and-white images
      //      where text = black (0) and background = white (255).
      //      Grey values confuse the character recognition algorithm.
      //
      // OTSU'S METHOD: Instead of picking a fixed threshold (e.g., "everything
      //      below 128 is black"), Otsu's automatically finds the optimal
      //      threshold by analysing the image's pixel brightness histogram.
      //      It finds the threshold that maximises the separation between
      //      dark pixels (text) and light pixels (background).
      //
      //      This is crucial because CAPTCHA brightness varies — a darker
      //      CAPTCHA needs a different threshold than a lighter one.
      //
      // The return value of cv.threshold() is the Otsu threshold value (0–255).
      // We save this for debugging — it tells you how the image was classified.

      t = performance.now();
      const binaryMat = new cv.Mat();
      matsToDelete.push(binaryMat);

      const otsuThreshold = cv.threshold(
        blurredMat,
        binaryMat,
        0,           // Threshold value (ignored when THRESH_OTSU is used)
        255,         // Max value assigned to pixels above threshold
        cv.THRESH_BINARY | cv.THRESH_OTSU  // Use Otsu's method
      );
      timingMs.threshold = Math.round(performance.now() - t);

      SRMLogger.debug(
        'Preprocessor',
        `Otsu threshold: ${Math.round(otsuThreshold)} (${timingMs.threshold}ms)`
      );
      this._saveStage(stages, 'binary', this._matToCanvas(binaryMat));

      // ── OPTIONAL: Line Removal ───────────────────────────────────────────────
      // Removes horizontal/vertical noise lines drawn across the CAPTCHA.
      // Disabled by default — enable in PREPROCESSING_CONFIG if needed.

      let lineRemovedMat = binaryMat;
      if (PREPROCESSING_CONFIG.removeHorizontalLines ||
          PREPROCESSING_CONFIG.removeVerticalLines) {
        lineRemovedMat = this._removeLines(binaryMat, matsToDelete);
        this._saveStage(stages, 'lineRemoved', this._matToCanvas(lineRemovedMat));
        SRMLogger.debug('Preprocessor', 'Line removal applied');
      }

      // ── STAGE 5: Morphological Closing ──────────────────────────────────────
      //
      // WHY: Noise lines drawn across the CAPTCHA can cut through character
      //      strokes, leaving thin gaps. After thresholding, these gaps appear
      //      as white (background) pixels breaking up black (text) characters.
      //      Tesseract then sees broken characters and misreads them.
      //
      // MORPH_CLOSE = Dilation followed immediately by Erosion.
      //
      //   DILATION: Makes dark regions expand. Each pixel becomes dark if ANY
      //             of its kernel-sized neighbours is dark. This fills gaps.
      //
      //   EROSION:  Shrinks dark regions. Each pixel stays dark only if ALL
      //             of its kernel-sized neighbours are dark. This removes the
      //             expansion that dilation added to character edges.
      //
      //   NET EFFECT: Small gaps INSIDE characters are filled.
      //               Character edges return to approximately original size.
      //               Thin noise dots that are smaller than the kernel disappear.
      //
      // kernel = 2×2 = operates on a 2-pixel neighbourhood.
      // Too large: Characters merge into each other or thin strokes disappear.

      t = performance.now();
      const closedMat = new cv.Mat();
      matsToDelete.push(closedMat);

      const morphKernel = cv.Mat.ones(
        PREPROCESSING_CONFIG.morphKernelSize,
        PREPROCESSING_CONFIG.morphKernelSize,
        cv.CV_8U
      );
      matsToDelete.push(morphKernel);

      cv.morphologyEx(lineRemovedMat, closedMat, cv.MORPH_CLOSE, morphKernel);
      timingMs.morphology = Math.round(performance.now() - t);

      SRMLogger.debug('Preprocessor', `Morphology done (${timingMs.morphology}ms, kernel=${PREPROCESSING_CONFIG.morphKernelSize}×${PREPROCESSING_CONFIG.morphKernelSize})`);
      this._saveStage(stages, 'morphology', this._matToCanvas(closedMat));

      // ── STAGE 6: Upscale 3× ─────────────────────────────────────────────────
      //
      // WHY: Tesseract was trained on images where characters are at least
      //      20–30 pixels tall. CAPTCHA characters are often only 10–20px tall.
      //      When characters are too small:
      //        - Fine details that distinguish characters are lost
      //        - '0' vs 'O', '1' vs 'l' etc. become indistinguishable
      //        - Tesseract's pattern matching becomes unreliable
      //
      //      Upscaling to 3× makes characters ~45px tall — well within
      //      Tesseract's optimum range.
      //
      // INTER_CUBIC: Uses a 4×4 pixel neighbourhood (bicubic interpolation).
      //   Produces the smoothest upscaled result — sharp edges stay sharp.
      //   Slower than INTER_LINEAR but the quality improvement is worth it
      //   because smoother character edges = better OCR accuracy.

      t = performance.now();
      const upscaledMat = new cv.Mat();
      matsToDelete.push(upscaledMat);

      const newWidth  = closedMat.cols * PREPROCESSING_CONFIG.upscaleFactor;
      const newHeight = closedMat.rows * PREPROCESSING_CONFIG.upscaleFactor;
      const newSize   = new cv.Size(newWidth, newHeight);

      cv.resize(
        closedMat,
        upscaledMat,
        newSize,
        0, 0,
        PREPROCESSING_CONFIG.interpolation
      );
      timingMs.upscale = Math.round(performance.now() - t);

      SRMLogger.debug(
        'Preprocessor',
        `Upscaled: ${closedMat.cols}×${closedMat.rows} → ${newWidth}×${newHeight} (${timingMs.upscale}ms)`
      );

      // ── STAGE 7: Export ──────────────────────────────────────────────────────

      t = performance.now();
      const outputCanvas = this._matToCanvas(upscaledMat);
      const processedBase64 = outputCanvas.toDataURL('image/png');
      timingMs.export = Math.round(performance.now() - t);

      // Save stage AFTER getting base64 (canvas is the same object)
      stages.final = processedBase64;

      const totalTime = Math.round(performance.now() - pipelineStart);
      SRMLogger.info('Preprocessor', `Pipeline complete in ${totalTime}ms`);
      SRMLogger.debug('Preprocessor', 'Stage timings:', timingMs);

      return {
        processedBase64,
        originalBase64:  base64PNG,
        dimensions:      { width: newWidth, height: newHeight },
        otsuThreshold:   Math.round(otsuThreshold),
        stages,
        timingMs,
        totalTimeMs: totalTime,
      };

    } finally {
      // ── GUARANTEED MEMORY CLEANUP ────────────────────────────────────────────
      // This block runs even if an error was thrown above.
      // Every cv.Mat in matsToDelete is freed from WebAssembly memory.
      // If you add a new Mat to the pipeline, add it to matsToDelete too.

      for (const mat of matsToDelete) {
        try {
          if (mat && !mat.isDeleted()) {
            mat.delete();
          }
        } catch (e) {
          // If a mat was already deleted somehow, ignore the error
          SRMLogger.debug('Preprocessor', `Mat cleanup warning: ${e.message}`);
        }
      }
      SRMLogger.debug('Preprocessor', `Cleaned up ${matsToDelete.length} OpenCV Mats`);
    }
  },

  // ─── Private Helper Methods ────────────────────────────────────────────────

  /**
   * Convert a base64 PNG data URL into a canvas element with the image drawn on it.
   * The canvas is needed to use cv.imread() which reads from a canvas.
   *
   * @param {string} base64PNG - "data:image/png;base64,..."
   * @returns {Promise<{ canvas: HTMLCanvasElement, img: HTMLImageElement }>}
   * @private
   */
  _base64ToCanvas(base64PNG) {
    return new Promise((resolve, reject) => {
      const img    = new Image();
      img.onload   = () => {
        if (img.width === 0 || img.height === 0) {
          reject(new Error('Image has zero dimensions — may not have loaded correctly'));
          return;
        }

        const canvas    = document.createElement('canvas');
        canvas.width    = img.width;
        canvas.height   = img.height;
        const ctx       = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve({ canvas, img });
      };
      img.onerror  = () => reject(new Error('Failed to load base64 image'));
      img.src      = base64PNG;
    });
  },

  /**
   * Convert an OpenCV Mat to an HTMLCanvasElement.
   * This is used to both preview intermediate stages and export the final result.
   *
   * @param {cv.Mat} mat - OpenCV Mat (must be single or multi channel)
   * @returns {HTMLCanvasElement}
   * @private
   */
  _matToCanvas(mat) {
    const canvas    = document.createElement('canvas');
    canvas.width    = mat.cols;
    canvas.height   = mat.rows;
    cv.imshow(canvas, mat);
    return canvas;
  },

  /**
   * Save an intermediate preprocessing stage image for debug visualisation.
   * Only saves if we're in debug mode (avoids memory usage in normal operation).
   *
   * @param {object}                  stages     - The stages accumulator object
   * @param {string}                  stageName  - Name of this stage
   * @param {HTMLCanvasElement|string} canvasOrBase64 - The stage image
   * @private
   */
  _saveStage(stages, stageName, canvasOrBase64) {
    // Only save intermediate stages in debug mode to save memory
    // (base64 strings of images can be 20–100KB each)
    if (typeof canvasOrBase64 === 'string') {
      stages[stageName] = canvasOrBase64;
    } else if (canvasOrBase64 && canvasOrBase64.toDataURL) {
      stages[stageName] = canvasOrBase64.toDataURL('image/png');
    }
  },

  /**
   * Remove horizontal and/or vertical noise lines from a binary image.
   *
   * HOW IT WORKS:
   *   1. Use morphological OPEN with a wide (for horizontal) or tall (for vertical)
   *      kernel to detect long straight structures — these are the lines.
   *   2. Subtract the detected lines from the binary image.
   *
   * WHY MORPH_OPEN for detection?
   *   MORPH_OPEN = Erosion then Dilation.
   *   Erosion with a wide kernel eliminates anything SHORTER than the kernel width.
   *   Then dilation restores the remaining (long) lines to their original thickness.
   *   Result: Only the long horizontal structures survive = the noise lines.
   *
   * @param {cv.Mat}    binaryMat      - Binary (black/white) input image
   * @param {cv.Mat[]}  matsToDelete   - Array to register new Mats for cleanup
   * @returns {cv.Mat}  cleanedMat     - Binary image with lines removed
   * @private
   */
  _removeLines(binaryMat, matsToDelete) {
    const resultMat = binaryMat.clone();
    matsToDelete.push(resultMat);

    if (PREPROCESSING_CONFIG.removeHorizontalLines) {
      // Horizontal line detection kernel: 1 row × minLineWidth columns
      const hKernel = cv.Mat.ones(1, PREPROCESSING_CONFIG.minLineWidth, cv.CV_8U);
      matsToDelete.push(hKernel);

      const hLines = new cv.Mat();
      matsToDelete.push(hLines);

      // MORPH_OPEN with horizontal kernel = detects horizontal structures
      cv.morphologyEx(resultMat, hLines, cv.MORPH_OPEN, hKernel);

      // Invert lines (they're black lines we want to make white = background)
      // Then bitwise AND: black lines become white in result
      const hLinesInv = new cv.Mat();
      matsToDelete.push(hLinesInv);
      cv.bitwise_not(hLines, hLinesInv);

      // Remove lines: keep only pixels that are NOT on detected lines
      cv.bitwise_and(resultMat, hLinesInv, resultMat);

      SRMLogger.debug('Preprocessor', `Horizontal line removal applied (min width: ${PREPROCESSING_CONFIG.minLineWidth}px)`);
    }

    if (PREPROCESSING_CONFIG.removeVerticalLines) {
      // Vertical line detection kernel: minLineHeight rows × 1 column
      const vKernel = cv.Mat.ones(PREPROCESSING_CONFIG.minLineHeight, 1, cv.CV_8U);
      matsToDelete.push(vKernel);

      const vLines = new cv.Mat();
      matsToDelete.push(vLines);

      cv.morphologyEx(resultMat, vLines, cv.MORPH_OPEN, vKernel);

      const vLinesInv = new cv.Mat();
      matsToDelete.push(vLinesInv);
      cv.bitwise_not(vLines, vLinesInv);

      cv.bitwise_and(resultMat, vLinesInv, resultMat);

      SRMLogger.debug('Preprocessor', `Vertical line removal applied (min height: ${PREPROCESSING_CONFIG.minLineHeight}px)`);
    }

    return resultMat;
  },

  /**
   * Update preprocessing configuration at runtime.
   * Call this from the popup if you expose tuning controls.
   *
   * @param {Partial<typeof PREPROCESSING_CONFIG>} options
   *
   * Example:
   *   SRMPreprocessor.configure({ blurKernelSize: 5, upscaleFactor: 4 });
   */
  configure(options = {}) {
    // Validate blurKernelSize must be odd
    if (options.blurKernelSize !== undefined) {
      const k = options.blurKernelSize;
      if (k < 1 || k % 2 === 0) {
        SRMLogger.warn('Preprocessor', `blurKernelSize must be an odd positive integer, got ${k} — using 3`);
        options.blurKernelSize = 3;
      }
    }

    Object.assign(PREPROCESSING_CONFIG, options);
    SRMLogger.info('Preprocessor', 'Configuration updated:', PREPROCESSING_CONFIG);
  },

  /**
   * Get the current preprocessing configuration.
   * Useful for the popup settings panel.
   *
   * @returns {object} - Current configuration values
   */
  getConfig() {
    return { ...PREPROCESSING_CONFIG };
  },
};

// Make available globally within the content script context
window.SRMPreprocessor = SRMPreprocessor;
