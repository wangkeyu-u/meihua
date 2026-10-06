export function replaceOnce(content, oldText, newText) {
  if (!oldText) throw new Error('旧内容不能为空');
  const first = content.indexOf(oldText);
  if (first < 0) throw new Error('找不到要替换的原文');
  if (content.indexOf(oldText, first + 1) >= 0) throw new Error('原文出现多次，请提供更长的唯一片段');
  return content.slice(0, first) + newText + content.slice(first + oldText.length);
}
