// Use Chromium's existing system proxy configuration for configured services.
// Keep this injectable so protocol tests and non-Electron consumers use their own fetch.
export function createDesktopFetch(fetcher) {
  return (input, options = {}) => {
    const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!['http:', 'https:'].includes(new URL(address).protocol)) throw new Error('服务连接只支持 HTTP(S) 地址');
    return fetcher(input instanceof URL ? input.href : input, { ...options, credentials: 'omit', cache: 'no-store' });
  };
}
