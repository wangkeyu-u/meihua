import { access, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../process.js';

import { wrapCommandWithSandboxMacOS } from '../vendor/sandbox-runtime/sandbox/macos-sandbox-utils.js';
const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";

export async function sandboxAvailability() {
  if (process.platform !== 'darwin') return { available: false, backend: null, reason: '当前只支持 macOS 系统进程沙箱；此平台会拒绝隔离命令' };
  try {
    await access('/usr/bin/sandbox-exec');
    const result = await runProcess('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', '/bin/echo', 'meihua-sandbox-probe'], { timeoutMs: 5000 });
    return { available: result.code === 0 && result.stdout.trim() === 'meihua-sandbox-probe', backend: 'macOS Seatbelt', reason: result.code === 0 ? '' : '系统拒绝启动进程沙箱' };
  } catch { return { available: false, backend: 'macOS Seatbelt', reason: '系统进程沙箱不可用，不会自动降级' }; }
}
export async function sandboxLaunch(command, args = [], options = {}) {
  if (process.platform !== 'darwin') throw new Error('此平台没有可用的执行沙箱，未启动命令');
  await access('/usr/bin/sandbox-exec');
  const workspace = await realpath(options.workspace || options.cwd), cwd = await realpath(options.cwd || workspace);
  // SRT config paths treat these characters as glob syntax. Refuse ambiguous roots rather than widening access.
  if (/[\[\]*?]/.test(workspace)) throw new Error('沙箱工作目录不能含 [ ] * ?，请选择不含这些字符的文件夹');
  if (cwd !== workspace && !cwd.startsWith(workspace + path.sep)) throw new Error('命令目录超出沙箱工作目录');
  const temporary = path.join(workspace, '.meihua', 'tmp'); await mkdir(temporary, { recursive: true });
  if ((await realpath(temporary)) !== temporary) throw new Error('沙箱临时目录不能是符号链接');
  if (Object.keys(options.env || {}).some((key) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))) throw new Error('MCP 环境变量名称无效');
  const environment = { ...options.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: temporary, TMPDIR: temporary, LANG: process.env.LANG || 'en_US.UTF-8', LC_ALL: process.env.LC_ALL || 'en_US.UTF-8', ELECTRON_RUN_AS_NODE: '1' };
  const executable = options.shell ? command : [command, ...args].map(quote).join(' ');
  const wrapped = wrapCommandWithSandboxMacOS({ command: executable, needsNetworkRestriction: !options.network,
    readConfig: { denyOnly: ['/'], allowWithinDeny: [workspace, temporary, '/System', '/usr', '/bin', '/sbin', '/opt/homebrew', '/Library/Apple', '/dev/null', '/dev/random', '/dev/urandom', '/private/var/db/dyld', '/private/var/select/sh', '/private/etc/ssl', '/private/etc/resolv.conf', '/private/etc/hosts'] },
    writeConfig: { allowOnly: options.readOnly ? [temporary] : [workspace, temporary], denyWithinAllow: ['.git', '.zhuge', '.agents', '.env', 'AGENTS.md', 'SKILL.md'].flatMap((name) => [path.join(workspace, name), path.join(workspace, '**', name), path.join(workspace, '**', name, '**')]) },
    allowAppleEvents: false, allowLocalBinding: false, allowAllUnixSockets: false, binShell: '/bin/sh', setEnvVars: environment });
  return { command: '/bin/sh', args: ['-c', wrapped], cwd, env: environment };
}
export async function runSandboxed(command, args = [], options = {}) {
  const launch = await sandboxLaunch(command, args, options);
  return runProcess(launch.command, launch.args, { cwd: launch.cwd, signal: options.signal, timeoutMs: options.timeoutMs, maxOutput: options.maxOutput, env: launch.env });
}
