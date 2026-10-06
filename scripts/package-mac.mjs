import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputs = await packager({
  dir: root,
  name: '梅花',
  platform: 'darwin',
  arch: 'arm64',
  out: path.join(root, 'release'),
  overwrite: true,
  icon: path.join(root, 'assets', 'Meihua.icns'),
  appBundleId: 'local.zhuge.agent',
  extendInfo: {
    NSAppleEventsUsageDescription: '梅花在你要求使用本机应用、联系人或 Apple Mail 时，通过 macOS 自动化完成操作。',
    NSContactsUsageDescription: '梅花在你要求按姓名查找收件人时读取联系人邮箱。',
  },
  asar: false,
  // Packager matches paths relative to the project root. Only ship runtime files.
  ignore: [/^\/(?!(?:electron|dist|node_modules)(?:\/|$)|(?:package\.json|THIRD_PARTY_NOTICES\.md)$).+/],
});
console.log(outputs.join('\n'));
