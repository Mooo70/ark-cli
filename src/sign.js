// 火山引擎签名 v4（HMAC-SHA256），零依赖实现。
// 官方文档：https://www.volcengine.com/docs/6369/67269
// 方舟管控面：Service=ark，Region=cn-beijing，Host=ark.cn-beijing.volcengineapi.com
// 费用中心：  Service=billing，Region=cn-beijing，Host=billing.volcengineapi.com

import crypto from 'node:crypto';

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC3986 编码，比 encodeURIComponent 多转义 !'()* 这几个字符（火山签名要求）。 */
export function encodeRFC3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** 2026-11-05T04:40:00.000Z → 20261105T044000Z */
export function toXDate(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** 按 key 字典序拼规范化查询串，同 key 多值也要排序。 */
export function canonicalQuery(query = {}) {
  const pairs = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    const values = Array.isArray(v) ? v : [v];
    for (const item of values) pairs.push([encodeRFC3986(k), encodeRFC3986(String(item))]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * 生成一次签名请求所需的全部信息。返回 { url, headers } 可直接喂给 fetch。
 * @param {object} o
 * @param {'GET'|'POST'} o.method
 * @param {string} o.host       如 ark.cn-beijing.volcengineapi.com
 * @param {string} o.service    如 ark / billing
 * @param {string} [o.region]   默认 cn-beijing
 * @param {string} [o.path]     默认 /
 * @param {object} [o.query]    会全部放进 URL 与签名
 * @param {object} [o.body]     POST 时序列化为 JSON
 * @param {string} o.ak
 * @param {string} o.sk
 * @param {Date}   [o.now]      便于离线自检时固定时间
 */
export function signedRequest({ method = 'GET', host, service, region = 'cn-beijing', path = '/', query = {}, body, ak, sk, now = new Date() }) {
  if (!ak || !sk) throw new Error('签名需要 Access Key 与 Secret Key');
  const verb = method.toUpperCase();
  const xDate = toXDate(now);
  const dateStamp = xDate.slice(0, 8);
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const payloadHash = sha256Hex(payload);

  const headers = { host, 'x-date': xDate };
  if (verb === 'POST') {
    headers['content-type'] = 'application/json';
    headers['x-content-sha256'] = payloadHash;
  }

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k].trim()}\n`)
    .join('');
  const qs = canonicalQuery(query);

  const canonicalRequest = [verb, path, qs, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(sk, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const authorization = `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `https://${host}${path}${qs ? '?' + qs : ''}`,
    method: verb,
    headers: { ...headers, authorization },
    body: verb === 'POST' ? payload : undefined,
    debug: { canonicalRequest, stringToSign, credentialScope, signature },
  };
}

/** 调一次并解析 JSON；HTTP 非 2xx 或 ResponseMetadata.Error 抛错。 */
export async function callApi(opts, { timeoutMs = 20000 } = {}) {
  const req = signedRequest(opts);
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`返回不是 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }
  const apiErr = json?.ResponseMetadata?.Error;
  if (!res.ok || apiErr) {
    const code = apiErr?.Code || `HTTP ${res.status}`;
    const msg = apiErr?.Message || text.slice(0, 300);
    const err = new Error(`${code}：${msg}`);
    err.code = code;
    err.status = res.status;
    err.requestId = json?.ResponseMetadata?.RequestId;
    throw err;
  }
  return json;
}
