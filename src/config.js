import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = process.env.ARK_CONFIG_DIR || path.join(os.homedir(), '.ark');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(next) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // Windows 上 chmod 基本无效，忽略
  }
  return CONFIG_FILE;
}

/** Key 优先级：环境变量 ARK_API_KEY > ~/.ark/config.json。都没有就报错并给出修复命令。 */
export function resolveApiKey() {
  const fromEnv = process.env.ARK_API_KEY && process.env.ARK_API_KEY.trim();
  if (fromEnv) return { key: fromEnv, source: 'env ARK_API_KEY' };
  const cfg = readConfig();
  if (cfg.apiKey && String(cfg.apiKey).trim()) {
    return { key: String(cfg.apiKey).trim(), source: CONFIG_FILE };
  }
  const err = new Error(
    '没有找到 API Key。二选一：\n' +
      '  1) ark config set api-key <你的方舟APIKey>\n' +
      '  2) 设置环境变量 ARK_API_KEY\n' +
      '获取地址：https://console.volcengine.com/ark/region:ark+cn-beijing/apikey',
  );
  err.exitCode = 2;
  throw err;
}
