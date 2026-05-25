/**
 * autofill.js — CAPTCHA Field Auto-Filler
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * Types the solved CAPTCHA text into the input field and optionally
 * submits the login form.
 *
 * WHY NOT JUST SET `inputElement.value = text`?
 * ─────────────────────────────────────────────────────────────────────────────
 * Simply setting .value works for plain HTML forms, but the SRM portal likely
 * uses JavaScript to validate form fields. Modern web forms listen for browser
 * events like 'input' and 'change' to:
 *   - Enable/disable the submit button (button is disabled until all fields filled)
 *   - Run real-time validation (e.g. "CAPTCHA must be 6 characters")
 *   - Update an internal state object (React, Vue, jQuery form plugins)
 *
 * If we just set .value without firing these events, the form's JavaScript
 * still thinks the field is empty. The submit button might stay disabled,
 * or the form might submit an empty CAPTCHA value.
 *
 * OUR SOLUTION: Simulate real user typing by:
 *   1. Focusing the input (mimics clicking on it)
 *   2. Setting .value
 *   3. Dispatching 'input' event (fires when user types a character)
 *   4. Dispatching 'change' event (fires when field loses focus after change)
 *   5. Dispatching 'blur'  event (fires when field loses focus)
 *
 * This sequence exactly mimics what happens when a real user types the CAPTCHA.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTO-SUBMIT
 * ─────────────────────────────────────────────────────────────────────────────
 * Default: OFF — the user clicks "Login" manually.
 * This is the safest default. Auto-submit can be enabled from the popup toggle.
 *
 * When auto-submit IS enabled, we try:
 *   1. Click the submit button (preferred — triggers all button click handlers)
 *   2. form.submit() (fallback — bypasses button click handlers but submits form)
 */

'use strict';

const SRMAutofill = {

  /**
   * Fill the CAPTCHA input field with the solved text.
   *
   * @param {HTMLInputElement} inputElement - The CAPTCHA text input field
   * @param {string}           text         - The solved CAPTCHA text
   * @returns {boolean} True if fill was successful
   */
  fill(inputElement, text) {
    if (!inputElement) {
      SRMLogger.error('Autofill', 'Cannot fill — input element is null');
      return false;
    }

    if (!text || text.trim().length === 0) {
      SRMLogger.warn('Autofill', 'Cannot fill — text is empty or blank');
      return false;
    }

    const cleanText = text.trim();
    SRMLogger.info('Autofill', `Filling CAPTCHA field with: "${cleanText}"`);

    try {
      // ── Step 1: Focus the input ──────────────────────────────────────────────
      // Simulates the user clicking on the input field.
      // Some frameworks ignore input events unless the element is focused first.
      inputElement.focus();

      // ── Step 2: Clear any existing value ────────────────────────────────────
      // In case a previous attempt left text in the field.
      inputElement.value = '';

      // ── Step 3: Set the new value ────────────────────────────────────────────
      // The actual text fill. We use the native value setter to be as
      // compatible as possible with React and other frameworks.
      //
      // React uses synthetic events and tracks value via a special descriptor.
      // To properly update React's internal state:
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;

      if (nativeInputValueSetter) {
        // Use the native setter — this bypasses React's override and lets
        // React properly detect the change when we dispatch the 'input' event
        nativeInputValueSetter.call(inputElement, cleanText);
      } else {
        // Fallback: direct assignment (works for plain HTML forms)
        inputElement.value = cleanText;
      }

      // ── Step 4: Dispatch browser events ─────────────────────────────────────
      // These events tell the page's JavaScript that the field value changed.
      //
      // 'input' event  → fires on every keystroke. Most form validators listen here.
      // 'change' event → fires when the field loses focus after a change.
      // 'blur'  event  → fires when the field loses focus. Some validators use this.
      //
      // { bubbles: true } is important — without it, event listeners on parent
      // elements (e.g., the form itself) won't receive the event.

      this._dispatchEvent(inputElement, 'input');
      this._dispatchEvent(inputElement, 'change');
      this._dispatchEvent(inputElement, 'blur');

      // ── Step 5: Visual highlight to confirm fill ─────────────────────────────
      // Briefly highlight the filled field with a green outline so the user
      // can see that auto-fill happened. Fades after 2 seconds.
      this._highlightField(inputElement, 'success');

      SRMLogger.info('Autofill', `Field filled successfully with "${cleanText}" ✓`);
      return true;

    } catch (err) {
      SRMLogger.error('Autofill', `Failed to fill input: ${err.message}`);
      this._highlightField(inputElement, 'error');
      return false;
    }
  },

  /**
   * Click the login submit button (auto-submit).
   *
   * Called only when the auto-submit setting is enabled.
   * Tries to click the actual button first, falls back to form.submit().
   *
   * @param {HTMLElement|null} loginBtn  - The login button element
   * @param {HTMLInputElement} inputElement - The CAPTCHA input (used to find form)
   * @param {number} delayMs - Delay before submitting (default: 800ms)
   * @returns {Promise<boolean>} True if submit was triggered
   */
  async submit(loginBtn, inputElement, delayMs = 800) {
    // Wait before submitting — gives the user a moment to see what was filled
    // and gives the form's validation time to process the input events we fired
    if (delayMs > 0) {
      SRMLogger.debug('Autofill', `Waiting ${delayMs}ms before auto-submit...`);
      await this._sleep(delayMs);
    }

    SRMLogger.info('Autofill', 'Attempting auto-submit...');

    // ── Method 1: Click the login button ──────────────────────────────────────
    // Preferred method. Clicking the button triggers:
    //   - The button's own click event handlers
    //   - The form's submit event
    //   - All validation that's tied to the submit button
    if (loginBtn) {
      try {
        loginBtn.click();
        SRMLogger.info('Autofill', 'Login button clicked ✓');
        return true;
      } catch (err) {
        SRMLogger.warn('Autofill', `Button click failed: ${err.message} — trying form.submit()`);
      }
    }

    // ── Method 2: form.submit() ────────────────────────────────────────────────
    // Fallback if the button wasn't found or clicking failed.
    // Note: form.submit() bypasses the form's 'submit' event handlers.
    // This means some validation might be skipped. Use as last resort.
    const form = inputElement?.closest('form');
    if (form) {
      try {
        form.submit();
        SRMLogger.info('Autofill', 'Form submitted via form.submit() ✓');
        return true;
      } catch (err) {
        SRMLogger.error('Autofill', `form.submit() also failed: ${err.message}`);
      }
    }

    SRMLogger.error('Autofill', 'Auto-submit failed — no button found and no form found');
    return false;
  },

  /**
   * Clear the CAPTCHA input field.
   * Used before a retry to reset the field state.
   *
   * @param {HTMLInputElement} inputElement
   */
  clear(inputElement) {
    if (!inputElement) return;

    inputElement.value = '';
    this._dispatchEvent(inputElement, 'input');
    this._dispatchEvent(inputElement, 'change');
    SRMLogger.debug('Autofill', 'Input field cleared');
  },

  /**
   * Refresh the CAPTCHA by clicking the refresh button,
   * or by modifying the image src to force a reload.
   *
   * @param {HTMLElement|null}  refreshBtn  - The "Refresh CAPTCHA" button/link
   * @param {HTMLImageElement}  captchaImg  - The CAPTCHA image element
   * @returns {Promise<void>}
   */
  async refreshCaptcha(refreshBtn, captchaImg) {
    SRMLogger.info('Autofill', 'Refreshing CAPTCHA...');

    // ── Method 1: Click the refresh button ────────────────────────────────────
    if (refreshBtn) {
      try {
        refreshBtn.click();
        SRMLogger.info('Autofill', 'Refresh button clicked ✓');
        // Wait for the new CAPTCHA to start loading
        await this._sleep(500);
        return;
      } catch (err) {
        SRMLogger.warn('Autofill', `Refresh button click failed: ${err.message}`);
      }
    }

    // ── Method 2: Reload image src with cache-buster ───────────────────────────
    // Adds a timestamp to the CAPTCHA src URL, forcing the browser to
    // request a fresh image from the server instead of using the cached one.
    //
    // Example:
    //   Before: /captcha.jpg?session=abc
    //   After:  /captcha.jpg?session=abc&_t=1716598825000
    if (captchaImg && captchaImg.src) {
      try {
        const originalSrc = captchaImg.src;
        const separator   = originalSrc.includes('?') ? '&' : '?';
        captchaImg.src    = `${originalSrc}${separator}_t=${Date.now()}`;
        SRMLogger.info('Autofill', 'CAPTCHA src reloaded with cache-buster ✓');
        await this._sleep(500);
        return;
      } catch (err) {
        SRMLogger.warn('Autofill', `Src reload failed: ${err.message}`);
      }
    }

    SRMLogger.warn('Autofill', 'Could not refresh CAPTCHA — no refresh button and no src to modify');
  },

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Dispatch a native browser Event on an element.
   *
   * We use the actual Event/InputEvent constructors to create events that
   * are indistinguishable from real user events. Some form frameworks check
   * event.isTrusted — however, programmatically-created events always have
   * isTrusted=false (this is a browser security feature that cannot be faked).
   * The SRM portal's form likely doesn't check isTrusted, so this is fine.
   *
   * @param {HTMLElement} element
   * @param {string}      eventType - 'input', 'change', 'blur', 'focus', etc.
   * @private
   */
  _dispatchEvent(element, eventType) {
    let event;

    if (eventType === 'input') {
      // InputEvent is the proper type for 'input' events
      event = new InputEvent('input', {
        bubbles:    true,   // Let parent elements hear the event
        cancelable: true,
        data:       element.value,
      });
    } else {
      // Generic Event for 'change', 'blur', 'focus' etc.
      event = new Event(eventType, {
        bubbles:    true,
        cancelable: true,
      });
    }

    element.dispatchEvent(event);
    SRMLogger.debug('Autofill', `Dispatched '${eventType}' event on input`);
  },

  /**
   * Briefly highlight the CAPTCHA input field to visually confirm fill.
   *
   * @param {HTMLElement} element
   * @param {'success'|'error'} type
   * @private
   */
  _highlightField(element, type) {
    const originalOutline     = element.style.outline;
    const originalTransition  = element.style.transition;

    const colour = type === 'success' ? '#22c55e' : '#ef4444'; // green : red

    element.style.transition = 'outline 0.15s ease';
    element.style.outline    = `2px solid ${colour}`;

    // Remove the highlight after 2 seconds
    setTimeout(() => {
      element.style.outline    = originalOutline;
      element.style.transition = originalTransition;
    }, 2000);
  },

  /**
   * Promise-based sleep utility.
   * @param {number} ms - Milliseconds to wait
   * @returns {Promise<void>}
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },
};

window.SRMAutofill = SRMAutofill;
