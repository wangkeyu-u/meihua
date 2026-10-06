export function uiError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (let i = 0; i < 4; i++) {
    const clean = message.replace(/^Error:\s*/, '').replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/, '');
    if (clean === message) break;
    message = clean;
  }
  return message.trim() || '暂时未能完成，请重试。';
}
