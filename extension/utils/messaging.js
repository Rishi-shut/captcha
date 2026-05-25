/**
 * messaging.js — Extension Message Passing Helpers
 *
 * WHY: Chrome extensions have three separate JavaScript contexts:
 *   1. Content Script  (runs in the page)
 *   2. Service Worker  (background.js)
 *   3. Popup           (popup.js)
 *
 * These contexts CANNOT share variables or call each other's functions
 * directly. They must communicate via chrome.runtime.sendMessage() and
 * chrome.runtime.onMessage.
 *
 * This module standardises the message format and provides clean helpers
 * so the rest of the code never has to deal with raw messaging APIs.
 *
 * MESSAGE FORMAT:
 *   {
 *     type:    string  — e.g. 'CAPTCHA_SOLVED', 'GET_STATUS'
 *     payload: any     — data specific to the message type
 *   }
 *
 * MESSAGE TYPES:
 *   CAPTCHA_DETECTED       content → background  — CAPTCHA found on page
 *   CAPTCHA_SOLVED         content → background  — OCR completed
 *   CAPTCHA_FAILED         content → background  — OCR failed / low confidence
 *   GET_STATUS             popup   → background  — Request current state
 *   STATUS_UPDATE          background → popup    — Push state to popup
 *   TOGGLE_EXTENSION       popup   → background  — Enable/disable
 *   TOGGLE_AUTO_SUBMIT     popup   → background  — Enable/disable auto-submit
 *   SET_CONFIDENCE_THRESHOLD popup → background  — Update threshold
 *   MANUAL_CORRECTION      popup   → content     — User corrected the CAPTCHA
 *   RETRY_CAPTCHA          popup   → content     — Retry OCR
 *   CLEAR_LOGS             popup   → background  — Clear log buffer
 */

'use strict';

const SRMMessaging = {

  /**
   * Send a message to the background service worker.
   * Safe to call from content scripts or popup.
   *
   * @param {string} type    - Message type constant
   * @param {*}      payload - Data to send with the message
   * @returns {Promise<*>}   - Response from the receiver (if any)
   */
  async send(type, payload = null) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
          if (chrome.runtime.lastError) {
            // Extension context may be invalidated on page reload — not fatal
            SRMLogger.warn('Messaging', `Send failed for "${type}": ${chrome.runtime.lastError.message}`);
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch (err) {
        SRMLogger.warn('Messaging', `sendMessage threw: ${err.message}`);
        resolve(null);
      }
    });
  },

  /**
   * Send a message to the active tab's content script.
   * Only callable from the popup or background script.
   *
   * @param {number} tabId   - Target tab ID
   * @param {string} type
   * @param {*}      payload
   * @returns {Promise<*>}
   */
  async sendToTab(tabId, type, payload = null) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          SRMLogger.warn('Messaging', `Tab send failed: ${chrome.runtime.lastError.message}`);
          resolve(null);
        } else {
          resolve(response);
        }
      });
    });
  },

  /**
   * Register a message listener.
   * The handler receives (type, payload) and can return a value
   * which becomes the response.
   *
   * @param {function} handler - (type: string, payload: any, sender: object) => any
   */
  onMessage(handler) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const { type, payload } = message || {};
      try {
        const result = handler(type, payload, sender);
        if (result instanceof Promise) {
          result.then(sendResponse).catch((err) => {
            SRMLogger.error('Messaging', `Handler error for "${type}": ${err.message}`);
            sendResponse(null);
          });
          return true; // Keep channel open for async response
        } else {
          sendResponse(result);
        }
      } catch (err) {
        SRMLogger.error('Messaging', `Sync handler error for "${type}": ${err.message}`);
        sendResponse(null);
      }
    });
  },

  // ─── Message Type Constants ────────────────────────────────────────────────
  TYPES: {
    CAPTCHA_DETECTED:          'CAPTCHA_DETECTED',
    CAPTCHA_SOLVED:            'CAPTCHA_SOLVED',
    CAPTCHA_FAILED:            'CAPTCHA_FAILED',
    GET_STATUS:                'GET_STATUS',
    STATUS_UPDATE:             'STATUS_UPDATE',
    TOGGLE_EXTENSION:          'TOGGLE_EXTENSION',
    TOGGLE_AUTO_SUBMIT:        'TOGGLE_AUTO_SUBMIT',
    SET_CONFIDENCE_THRESHOLD:  'SET_CONFIDENCE_THRESHOLD',
    MANUAL_CORRECTION:         'MANUAL_CORRECTION',
    RETRY_CAPTCHA:             'RETRY_CAPTCHA',
    CLEAR_LOGS:                'CLEAR_LOGS',
  },
};

window.SRMMessaging = SRMMessaging;
