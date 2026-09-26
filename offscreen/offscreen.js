/**
 * 在隐藏 iframe 中承接托管登录页，并校验窗口、来源、请求号和响应时间。
 */
import { config, extensionId } from '../config/firebase-config.js';

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    message?.target !== 'auth-offscreen'
    || sender.id !== chrome.runtime.id
    || typeof message.requestId !== 'string'
    || !message.requestId
  ) return false;

  const authOrigin = new URL(config.authPageUrl).origin;
  const iframe = document.createElement('iframe');
  iframe.src = config.authPageUrl;
  iframe.hidden = true;
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  let finished = false;

  /** 只结束一次并移除所有临时资源。 */
  const finish = result => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    window.removeEventListener('message', receive);
    iframe.remove();
    respond(result);
  };

  const receive = event => {
    const issuedAt = event.data?.issuedAt;
    const age = Date.now() - issuedAt;
    if (
      event.source !== iframe.contentWindow
      || event.origin !== authOrigin
      || event.data?.requestId !== message.requestId
      || typeof event.data?.idToken !== 'string'
      || !Number.isFinite(issuedAt)
      || age < 0
      || age > 120_000
    ) return;
    finish({
      idToken: event.data.idToken,
      requestId: event.data.requestId,
      issuedAt,
      origin: `chrome-extension://${extensionId}`
    });
  };

  const timer = setTimeout(() => finish({
    idToken: '',
    requestId: message.requestId,
    issuedAt: Date.now(),
    origin: `chrome-extension://${extensionId}`
  }), 120_000);
  window.addEventListener('message', receive);
  iframe.addEventListener('load', () => {
    iframe.contentWindow.postMessage({ type: 'xhs-comment-auth-start', requestId: message.requestId }, authOrigin);
  }, { once: true });
  iframe.addEventListener('error', () => finish({
    idToken: '',
    requestId: message.requestId,
    issuedAt: Date.now(),
    origin: `chrome-extension://${extensionId}`
  }), { once: true });
  document.body.append(iframe);
  return true;
});
