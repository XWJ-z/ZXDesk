/**
 * 下载模块的 Electron 传输层：把 `net.request` 包成
 * `transport(url, { headers, onResponse, onError }) => { abort }`。
 *
 * 为什么用 `net.request` 而不是 `net.fetch`：下载要进度与断点续传，
 * `net.fetch` 只给 ReadableStream，拿不到「已收到多少字节」的中间态。
 *
 * ⚠️ `redirect: 'manual'`：跳转由下载模块自己跟随 —— 它要逐跳校验 https，
 * 交给 Chromium 自动跟会绕过这条检查。
 */

export function createNetTransport(net) {
  return function netTransport(url, handlers = {}) {
    const { headers = {}, onResponse, onError } = handlers;
    const request = net.request({
      url,
      method: 'GET',
      redirect: 'manual',
      headers: { ...headers },
    });

    request.on('response', (response) => {
      // ⚠️ Electron 的 response.headers 是 `{ 名: [值] }`，值可能是数组。
      //    下载模块按 `headers['content-length']` 这样的字符串用，这里统一扁平成小写字符串 ——
      //    别指望 `Number(['150'])` 这种隐式转换，换个 Electron 版本就可能变。
      const flat = {};
      for (const [key, value] of Object.entries(response.headers || {})) {
        flat[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      }
      onResponse?.({
        statusCode: response.statusCode,
        headers: flat,
        stream: response,
      });
    });
    request.on('error', (error) => onError?.(error));
    request.end();

    return {
      abort: () => {
        try {
          request.abort();
        } catch {
          /* 已经结束 */
        }
      },
    };
  };
}
