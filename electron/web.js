export async function fetchWebpage(address, signal, fetcher = fetch) {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(15000)].filter(Boolean));
  let url = new URL(address);
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (url.protocol !== 'https:') throw new Error('只支持 HTTPS 网页');
    const response = await fetcher(url, { signal: combined, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('网页跳转缺少目标地址');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`网页请求失败：${response.status}`); }
    const maxBytes = 2 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new Error('网页超过 2 MB，请选择较小的页面');
    }
    const chunks = []; let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new Error('网页超过 2 MB，请选择较小的页面');
        chunks.push(chunk);
      }
    }
    return Buffer.concat(chunks).toString('utf8').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 30000);
  }
  throw new Error('网页跳转次数过多');
}
