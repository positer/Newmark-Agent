const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const port = Number(process.argv[2] || 9482);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function targets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

(async () => {
  let pages = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      pages = await targets();
      if (pages.some(target => target.type === 'page')) break;
    } catch (_) {}
    await delay(250);
  }
  const page = pages.find(target => target.type === 'page' && String(target.url || '').startsWith('file:'));
  if (!page) throw new Error('Electron renderer page unavailable');

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const callId = ++id;
      const listener = event => {
        const message = JSON.parse(event.data);
        if (message.id !== callId) return;
        socket.removeEventListener('message', listener);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      };
      socket.addEventListener('message', listener);
      socket.send(JSON.stringify({ id: callId, method, params }));
    });
  }

  const targetResult = await call('Runtime.evaluate', {
    expression: `(() => {
      const source = document.querySelector('#left-ws-add');
      if (!source) return null;
      const rect = source.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
    })()`,
    returnByValue: true,
  });
  const target = targetResult.result.value;
  if (!target || target.width <= 0 || target.height <= 0) throw new Error('#left-ws-add is not visible');

  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: target.x, y: target.y,
    button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse',
  });
  await delay(170);

  const heldResult = await call('Runtime.evaluate', {
    expression: `(() => {
      const source = document.querySelector('#left-ws-add');
      const style = getComputedStyle(source);
      const child = source.firstElementChild ? getComputedStyle(source.firstElementChild) : null;
      const before = getComputedStyle(source, '::before');
      const after = getComputedStyle(source, '::after');
      const float = document.querySelector('.liquid-fixed-control-float:popover-open');
      return {
        url: location.href,
        className: source.className,
        active: source.dataset.fixedLiquidActive || '',
        color: style.color,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        childVisibility: child && child.visibility,
        beforeContent: before.content,
        afterContent: after.content,
        floatVisible: !!float,
        floatOpacity: float ? getComputedStyle(float).opacity : '',
        floatText: float ? float.textContent.trim() : '',
      };
    })()`,
    returnByValue: true,
  });
  const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const screenshotPath = path.resolve(__dirname, '..', '..', 'archive', '20260828-fixed-liquid-source-held.png');
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: target.x, y: target.y,
    button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse',
  });
  await delay(300);
  const releasedResult = await call('Runtime.evaluate', {
    expression: `(() => {
      const source = document.querySelector('#left-ws-add');
      return source ? {
        covered: source.classList.contains('liquid-fixed-source-covered'),
        active: source.dataset.fixedLiquidActive || '',
        connected: source.isConnected,
      } : { covered: false, active: '', connected: false };
    })()`,
    returnByValue: true,
  });

  const held = heldResult.result.value;
  const released = releasedResult.result.value;
  const pass = held.className.includes('liquid-fixed-source-covered') &&
    held.active === 'true' && held.color === 'rgba(0, 0, 0, 0)' &&
    held.backgroundColor === 'rgba(0, 0, 0, 0)' && held.backgroundImage === 'none' &&
    held.boxShadow === 'none' && held.childVisibility === 'hidden' &&
    held.floatVisible && Number(held.floatOpacity) > 0.99 &&
    !released.covered && released.active === '';
  console.log(JSON.stringify({ pass, held, released, screenshot: screenshotPath }, null, 2));
  socket.close();
  if (!pass) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
