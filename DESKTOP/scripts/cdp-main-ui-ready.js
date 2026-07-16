'use strict';

const PROMOTED_MAIN_UI_EXPRESSION = `(() => {
  const prompt = document.querySelector('#prompt');
  return document.visibilityState === 'visible'
    && document.readyState === 'complete'
    && !!window.api
    && !!prompt
    && !prompt.disabled
    && !prompt.readOnly
    && !document.documentElement.classList.contains('startup-prewarm')
    && !document.querySelector('#startup-cover');
})()`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPromotedMainUi(cdp, options = {}) {
  if (!cdp || typeof cdp.call !== 'function') {
    throw new TypeError('waitForPromotedMainUi requires a connected CDP client');
  }
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 45_000);
  const pollMs = Math.max(10, Number(options.pollMs) || 100);
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await cdp.call('Runtime.evaluate', {
        expression: PROMOTED_MAIN_UI_EXPRESSION,
        awaitPromise: true,
        returnByValue: true,
      }, Math.min(5_000, remaining));
      lastValue = result?.result?.value;
      if (lastValue === true) return true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }
  const detail = lastError || `last value=${JSON.stringify(lastValue)}`;
  throw new Error(`Timed out waiting for promoted visible main UI (${detail})`);
}

module.exports = {
  PROMOTED_MAIN_UI_EXPRESSION,
  waitForPromotedMainUi,
};
