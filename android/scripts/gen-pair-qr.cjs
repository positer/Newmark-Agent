// 生成本机 Newmark 配对二维码 PNG（供手机「从相册选择图片」扫码绑定）
// 用法：node gen-pair-qr.cjs [host]
//   host 默认取环境变量 NEWMARK_HOST 或 10.0.2.2（Android 模拟器回环）；真机传同内网/tailscale IP
//   root 默认取 NEWMARK_ROOT 或 ~/.Newmark（本机 Newmark 运行时根）
// 依赖：PC 端已 `npm run build`（DESKTOP/dist）且 server 正在监听 47890
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = process.env.NEWMARK_ROOT || path.join(os.homedir(), '.Newmark');
const host = process.argv[2] || process.env.NEWMARK_HOST || '10.0.2.2';
const desktop = process.env.NEWMARK_DESKTOP || path.resolve(__dirname, '..', '..', 'DESKTOP');

const QRCode = require(path.join(desktop, 'node_modules', 'qrcode'));
const { createPairingSession } = require(path.join(desktop, 'dist', 'core', 'mobilePairing.js'));

const session = createPairingSession(root);
// confirmPairing 只校验 pairingId + token + 过期，不校验 host；这里仅替换 URL 的 host 供移动端连接
const url = `newmark-pair://${host}:${session.port}?token=${encodeURIComponent(session.token)}&host=${encodeURIComponent(session.hostname)}&port=${session.port}&pairingId=${session.pairingId}&issuedAt=${session.issuedAt}&expiresAt=${session.expiresAt}`;

QRCode.toDataURL(url, { width: 420, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#101828', light: '#FFFFFF' } })
  .then((dataUrl) => {
    const out = path.resolve(__dirname, '..', '..', `newmark-pair-qr-${host.replace(/[^A-Za-z0-9.-]/g, '_')}.png`);
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('SAVED=' + out);
    console.log('HOST=' + host);
    console.log('PAIRING_ID=' + session.pairingId);
    console.log('URL=' + url);
  });
