// 账户体检：真实余额（费用中心）+ 模型开通状态与免费额度（方舟管控面）。
// 两条链路都只认 Access Key（AK/SK），方舟的 API Key 查不了这些。
// 文档：
//   余额   https://api.volcengine.com/api-docs/view?action=QueryBalanceAcct&serviceCode=billing
//   开通   https://ark.volcengine.com/docs/list-model-activations-api
import { MODELS } from './models.js';
import { callApi } from './sign.js';
import { CONFIG_FILE, readConfig } from './config.js';

export const BALANCE_THRESHOLD = 200;
export const BILLING_HOST = 'billing.volcengineapi.com';
export const ARK_CTL_HOST = 'ark.cn-beijing.volcengineapi.com';

/** AK/SK 优先级：环境变量 > ~/.ark/config.json。 */
export function resolveAccessKey() {
  const envAk = process.env.VOLC_ACCESS_KEY || process.env.VOLCENGINE_ACCESS_KEY_ID;
  const envSk = process.env.VOLC_SECRET_KEY || process.env.VOLCENGINE_SECRET_ACCESS_KEY;
  if (envAk && envSk) return { ak: envAk.trim(), sk: envSk.trim(), source: 'env VOLC_ACCESS_KEY' };

  const cfg = readConfig();
  if (cfg.accessKey && cfg.secretKey) {
    return { ak: String(cfg.accessKey).trim(), sk: String(cfg.secretKey).trim(), source: CONFIG_FILE };
  }

  const err = new Error(
    '查余额/开通状态需要 Access Key（不是方舟 API Key）。二选一：\n' +
      '  1) ark config set access-key <AK>  然后  ark config set secret-key <SK>\n' +
      '  2) 设置环境变量 VOLC_ACCESS_KEY / VOLC_SECRET_KEY\n' +
      '获取地址：https://console.volcengine.com/iam/keymanage',
  );
  err.exitCode = 2;
  throw err;
}

/** 账户余额。返回 { available, cash, freeze, arrears, credit, currency, accountId } */
export async function queryBalance({ ak, sk }) {
  const res = await callApi({
    method: 'GET',
    host: BILLING_HOST,
    service: 'billing',
    query: { Action: 'QueryBalanceAcct', Version: '2022-01-01' },
    ak,
    sk,
  });
  const r = res.Result || res.result || {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    available: num(r.AvailableBalance),
    cash: num(r.CashBalance),
    freeze: num(r.FreezeAmount),
    arrears: num(r.ArrearsBalance),
    credit: num(r.CreditLimit),
    currency: r.Currency || 'CNY',
    accountId: r.AccountID ?? null,
    raw: r,
  };
}

/** 模型开通列表（自动翻页）。返回 Items 数组。 */
export async function listActivations({ ak, sk, pageSize = 100, maxPages = 10 } = {}) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await callApi({
      method: 'POST',
      host: ARK_CTL_HOST,
      service: 'ark',
      query: { Action: 'ListModelActivations', Version: '2024-01-01' },
      body: { PageNumber: page, PageSize: pageSize, WithFreeUsage: true, WithPrice: false },
      ak,
      sk,
    });
    const r = res.Result || res.result || {};
    const batch = r.Items || [];
    items.push(...batch);
    const total = Number(r.TotalCount ?? batch.length);
    if (!batch.length || items.length >= total) break;
  }
  return items;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 官方 FoundationModelName 常去掉日期后缀（doubao-seedance-2-5-260628 → doubao-seedance-2-5），用前缀匹配。 */
export function nameMatches(found, known) {
  const a = norm(found);
  const b = norm(known);
  if (!a || !b) return false;
  return a === b || b.startsWith(a) || a.startsWith(b);
}

export function isVideoModel(item) {
  const s = `${item.FoundationModelName || ''} ${item.DisplayName || ''}`;
  return /seedance/i.test(s);
}

/** 纯函数：把余额 + 开通列表算出结论，便于离线自检。 */
export function assess({ balance, activations = [], catalog = MODELS }) {
  const entries = Object.entries(catalog).map(([key, m]) => {
    const hit = activations.find((a) => nameMatches(a.FoundationModelName, m.id) || nameMatches(a.DisplayName, m.label));
    const free = hit?.InitialInferenceFreeUsage || null;
    return {
      key,
      label: m.label,
      id: m.id,
      state: hit ? hit.State : 'Unknown',
      freeTotal: free ? Number(free.Total) || 0 : null,
      freeConsumed: free ? Number(free.Consumed) || 0 : null,
      found: Boolean(hit),
      rawName: hit?.FoundationModelName || null,
    };
  });

  const available = balance ? balance.available : null;
  const met = available === null ? null : available >= BALANCE_THRESHOLD;
  const videoActivated = entries.filter((e) => e.state === 'Available');
  const videoUnavailable = entries.filter((e) => e.state !== 'Available');
  const anyActive = activations.some((a) => a.State === 'Available');
  const locked = anyActive && available !== null ? Math.min(BALANCE_THRESHOLD, available) : 0;

  const others = activations
    .filter((a) => !isVideoModel(a))
    .filter((a) => a.State === 'Available')
    .map((a) => {
      const f = a.InitialInferenceFreeUsage || null;
      return {
        label: a.DisplayName || a.FoundationModelName,
        name: a.FoundationModelName,
        state: a.State,
        freeTotal: f ? Number(f.Total) || 0 : 0,
        freeConsumed: f ? Number(f.Consumed) || 0 : 0,
        overdue: Boolean(a.IsOverdue),
      };
    });

  const warnings = [];
  const overdue = activations.find((a) => a.IsOverdue);
  if (overdue) warnings.push(`账号存在欠费（${overdue.DisplayName || overdue.FoundationModelName}），已开通模型也可能调用失败`);
  if (met === false) warnings.push(`可用余额 ¥${available?.toFixed(2)} 低于 ${BALANCE_THRESHOLD} 元，现在无法开通 Seedance 视频模型`);
  if (met && videoUnavailable.length === entries.length) warnings.push('余额已达标，但还没有开通任何 Seedance 模型：去「开通管理 → 视觉模型」逐个点开通');
  if (met && videoUnavailable.length && videoActivated.length) {
    warnings.push(`还有 ${videoUnavailable.length} 个视频模型未开通：${videoUnavailable.map((e) => e.label.replace('Doubao-', '')).join('、')}`);
  }
  const othersWithQuota = others.filter((o) => o.freeTotal > 0 && o.freeConsumed >= o.freeTotal);
  if (othersWithQuota.length) {
    warnings.push(`${othersWithQuota.length} 个已开通模型的免费额度已用完，继续调用会直接扣余额：${othersWithQuota.slice(0, 3).map((o) => o.label).join('、')}`);
  }

  return { entries, others, available, met, locked, warnings, videoActivated, videoUnavailable };
}

/** 真实请求：余额 + 开通状态，任一失败都保留另一部分结果。 */
export async function buildAccountReport({ ak, sk, withOthers = true } = {}) {
  const errors = [];
  const [balance, activations] = await Promise.all([
    queryBalance({ ak, sk }).catch((e) => {
      errors.push(`余额查询失败：${e.message}`);
      return null;
    }),
    listActivations({ ak, sk }).catch((e) => {
      errors.push(`开通状态查询失败：${e.message}`);
      return null;
    }),
  ]);
  if (errors.length === 2) {
    const err = new Error(errors.join('\n'));
    err.exitCode = 1;
    throw err;
  }
  const report = assess({ balance, activations: activations || [] });
  if (!withOthers) report.others = [];
  return { balance, activationCount: (activations || []).length, errors, ...report };
}
