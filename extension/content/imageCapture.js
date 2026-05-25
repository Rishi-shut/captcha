/**
 * imageCapture.js — CAPTCHA Image Pixel Capture
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracts the raw pixel data from the CAPTCHA <img> element so it can
 * be passed to the preprocessing pipeline.
 *
 * WHY USE CANVAS?
 *   We cannot directly read the bytes of an image file that the browser
 *   has loaded. The browser's security model restricts direct file access.
 *
 *   However, we CAN draw the image onto a <canvas> element and then read
 *   the canvas pixel data. This works because:
 *   1. The image was loaded by the page itself (same origin — no CORS issue)
 *   2. The canvas API lets us read pixel data from same-origin content
 *   3. canvas.toDataURL() converts the pixels to a base64 PNG string
 *
 * WHY BASE64 OUTPUT?
 *   Both OpenCV.js (preprocessor) and Tesseract.js (OCR) accept base64
 *   data URLs as input. It's also easy to display in the popup as a preview.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POTENTIAL ISSUES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * "Tainted canvas" error:
 *   If the CAPTCHA image is served from a DIFFERENT domain than the page
 *   (cross-origin), drawing it to canvas marks the canvas as "tainted"
 *   and canvas.toDataURL() throws a SecurityError.
 *
 *   For the SRM portal, the CAPTCHA is served from the same server, so
 *   this is not an issue. But if it ever becomes cross-origin, the fix is:
 *     img.crossOrigin = 'anonymous'; // Set BEFORE img.src
 *   (Only works if the server sends CORS headers, which most don't for CAPTCHAs)
 *
 * Image not loaded yet:
 *   The CAPTCHA <img> might be in the DOM but still downloading.
 *   We check img.complete and img.naturalWidth before drawing.
 *   If not ready, we wait for the 'load' event.
 */

'use strict';

const SRMImageCapture = {

  /**
   * Capture the CAPTCHA image as a base64 PNG data URL.
   *
   * This is the main method. It handles both the case where the image
   * is already loaded and the case where it's still loading.
   *
   * @param {HTMLImageElement} captchaImg - The CAPTCHA <img> element
   * @returns {Promise<CaptureResult>}
   *   {
   *     base64PNG:   string,  — "data:image/png;base64,..." full data URL
   *     width:       number,  — Captured image width (natural/actual pixels)
   *     height:      number,  — Captured image height
   *     capturedAt:  Date,    — Timestamp of capture
   *   }
   * @throws {Error} If image cannot be captured
   */
  async capture(captchaImg) {
    SRMLogger.info('Capture', 'Starting CAPTCHA image capture...');

    // ── Wait for image to be fully loaded ─────────────────────────────────────
    await this._waitForImageLoad(captchaImg);

    // ── Validate image dimensions ─────────────────────────────────────────────
    const width  = captchaImg.naturalWidth;
    const height = captchaImg.naturalHeight;

    if (width === 0 || height === 0) {
      throw new Error(
        `CAPTCHA image has invalid dimensions: ${width}×${height}. ` +
        'The image may have failed to load or the src is invalid.'
      );
    }

    SRMLogger.debug('Capture', `Image dimensions: ${width}×${height}px`);

    // ── Draw onto canvas and export ───────────────────────────────────────────
    const base64PNG = this._drawToCanvas(captchaImg, width, height);

    // Sanity check — a valid PNG data URL should be reasonably long
    if (base64PNG.length < 100) {
      throw new Error('Captured image is suspiciously small — canvas may be blank');
    }

    SRMLogger.info('Capture', `CAPTCHA captured: ${width}×${height}px (${base64PNG.length} bytes encoded)`);

    return {
      base64PNG,
      width,
      height,
      capturedAt: new Date(),
    };
  },

  /**
   * Capture the image and return a canvas element directly.
   * Used internally when you need to pass a canvas to OpenCV.js.
   *
   * @param {HTMLImageElement} captchaImg
   * @returns {Promise<HTMLCanvasElement>}
   */
  async captureToCanvas(captchaImg) {
    await this._waitForImageLoad(captchaImg);

    const width  = captchaImg.naturalWidth;
    const height = captchaImg.naturalHeight;

    const canvas    = document.createElement('canvas');
    canvas.width    = width;
    canvas.height   = height;

    const ctx = canvas.getContext('2d', {
      // Hint to browser: we will be reading pixels back from this canvas
      // This can improve performance in some browsers
      willReadFrequently: true,
    });

    ctx.drawImage(captchaImg, 0, 0, width, height);
    return canvas;
  },

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Draw an image element onto a new canvas and export as base64 PNG.
   *
   * HOW CANVAS CAPTURE WORKS:
   *   1. Create a hidden <canvas> element (never added to the DOM)
   *   2. Set canvas size to the image's natural (actual pixel) dimensions
   *   3. Use ctx.drawImage() to paint the image onto the canvas
   *   4. ctx.drawImage() copies the decoded image pixels into canvas memory
   *   5. canvas.toDataURL('image/png') reads those pixels and encodes to PNG
   *   6. Result is a base64 string representing the full image
   *
   * WHY naturalWidth instead of clientWidth?
   *   clientWidth = display size (CSS-scaled, e.g., 100px displayed in a 200px box)
   *   naturalWidth = actual image pixel size (always the true resolution)
   *   We want the full resolution for best OCR accuracy.
   *
   * @param {HTMLImageElement} img
   * @param {number}           width
   * @param {number}           height
   * @returns {string} base64 PNG data URL
   * @private
   */
  _drawToCanvas(img, width, height) {
    // Create off-screen canvas (not attached to DOM, invisible to user)
    const canvas    = document.createElement('canvas');
    canvas.width    = width;
    canvas.height   = height;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Draw the image at its natural (full) resolution
    // Parameters: image, dx, dy, dWidth, dHeight
    //   dx, dy = top-left corner of destination in canvas
    //   dWidth, dHeight = how large to draw (same as natural size)
    ctx.drawImage(img, 0, 0, width, height);

    // Export as PNG for maximum quality (PNG is lossless — no JPEG artifacts)
    const base64PNG = canvas.toDataURL('image/png');

    SRMLogger.debug('Capture', `Canvas export: ${base64PNG.length} chars base64`);
    return base64PNG;
  },

  /**
   * Wait for an HTMLImageElement to finish loading.
   *
   * Three scenarios:
   *   A) Image already fully loaded → resolve immediately
   *   B) Image still loading → wait for 'load' event
   *   C) Image failed to load → reject with error
   *
   * WHY img.complete?
   *   img.complete is true when:
   *   - The image has no src
   *   - The image has finished loading successfully
   *   - The image has failed to load
   *   We also check naturalWidth > 0 to distinguish success from failure.
   *
   * @param {HTMLImageElement} img
   * @param {number} timeoutMs - Maximum wait time (default: 5 seconds)
   * @returns {Promise<void>}
   * @private
   */
  _waitForImageLoad(img, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      // Case A: Already loaded with valid dimensions
      if (img.complete && img.naturalWidth > 0) {
        SRMLogger.debug('Capture', 'Image already loaded ✓');
        resolve();
        return;
      }

      // Case A variant: complete but naturalWidth is 0 (broken image)
      if (img.complete && img.naturalWidth === 0) {
        reject(new Error('CAPTCHA image is broken or failed to load (naturalWidth=0)'));
        return;
      }

      // Case B: Still loading — set up a timeout-protected event listener
      SRMLogger.debug('Capture', 'Waiting for CAPTCHA image to load...');

      const timeout = setTimeout(() => {
        img.removeEventListener('load',  onLoad);
        img.removeEventListener('error', onError);
        reject(new Error(`CAPTCHA image load timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onLoad = () => {
        clearTimeout(timeout);
        img.removeEventListener('load',  onLoad);
        img.removeEventListener('error', onError);
        SRMLogger.debug('Capture', 'Image load event fired ✓');

        if (img.naturalWidth > 0) {
          resolve();
        } else {
          reject(new Error('Image load fired but naturalWidth is still 0'));
        }
      };

      // Case C: Image failed to load
      const onError = () => {
        clearTimeout(timeout);
        img.removeEventListener('load',  onLoad);
        img.removeEventListener('error', onError);
        reject(new Error('CAPTCHA image load error event fired'));
      };

      img.addEventListener('load',  onLoad);
      img.addEventListener('error', onError);
    });
  },
};

window.SRMImageCapture = SRMImageCapture;
