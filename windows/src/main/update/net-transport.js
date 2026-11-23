/**
 * ZXDesk工作台 Windows 客户端
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
      // Electron 的 response.headers 是 `{ 名: [值] }`，值可能是数组。
      // 下载模块按 `headers['content-length']` 这样的字符串用，这里统一扁平成小写字符串 ——
      // 别指望 `Number(['150'])` 这种隐式转换，换个 Electron 版本就可能变。
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
