/**
 * 股票智研 - 本地分析服务
 * 数据源：东方财富公开行情/财报/资金流/新闻接口（实时拉取，不缓存历史结果集）
 * 分析引擎：本地多因子规则引擎（趋势/动量/资金/估值/基本面/消息面）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const https = require('https');
const { execFile } = require('child_process');
const { runAiReport } = require('./llm');

const PORT = process.env.PORT || 8630;
const PUBLIC_DIR = path.join(__dirname, 'public');

const EM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://quote.eastmoney.com/',
};
const TX_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
const UT_TOKEN = 'b2884a393a59ad64002292a3e90d46a5';

/* 简单按域名节流，避免触发数据源反爬 */
const hostLastReq = new Map();
async function throttle(url, minGap = 220) {
  let host;
  try { host = new URL(url).host; } catch (_) { return; }
  const last = hostLastReq.get(host) || 0;
  const wait = last + minGap - Date.now();
  if (wait > 0) await sleep(wait);
  hostLastReq.set(host, Date.now());
}

const DISCLAIMER = '免责声明：以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。';

/* ---------------- HTTP helpers ---------------- */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** curl 子进程兜底（第三链路）：注意必须用 execFile 数组传参，spawn shell 会被环境拦。
 *  binary=true 时返回 Buffer（用于 GBK 接口） */
function curlText(url, timeoutMs = 12000, binary = false) {
  return new Promise((resolve, reject) => {
    const referer = url.includes('datacenter') ? 'https://data.eastmoney.com/' : 'https://quote.eastmoney.com/';
    execFile('curl', [
      '-s', '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '-H', `Referer: ${referer}`,
      url,
    ], { maxBuffer: 16 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else if (!stdout || !stdout.length) reject(new Error('curl empty'));
      else resolve(stdout);
    });
  });
}

/** 底层兼容兜底：东财对 Node fetch(undici) 的 TLS 指纹会间歇断连（UND_ERR_SOCKET），
 *  而经典 https 模块走的是另一套 OpenSSL 流程，实测稳定可用 */
function legacyGet(url, timeoutMs = 12000, headers = EM_HEADERS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { headers, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(legacyGet(new URL(res.headers.location, url).href, timeoutMs, headers));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** 带重试的 fetch：数据源会对出口 IP 间歇限流（UND_ERR_SOCKET / socket hang up），
 *  三条链路的 TLS 栈各不相同互为备份：undici fetch → 经典 https → curl 子进程 */
async function fetchText(url, timeoutMs = 12000, headers = EM_HEADERS, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(500 * attempt);
    await throttle(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers, signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  // undici 全失败 → 经典 https → curl（三条链路 TLS 栈不同，对所有数据源兜底）
  try {
    const buf = await legacyGet(url, timeoutMs, headers);
    return buf.toString('utf8');
  } catch (e) { lastErr = e; }
  await sleep(600);
  return curlText(url, timeoutMs);
}

/** 拉二进制并 GBK 解码（腾讯行情接口），失败时走 https/curl 兜底 */
async function fetchGbk(url, timeoutMs = 12000, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(500 * attempt);
    await throttle(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: TX_HEADERS, signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      return new TextDecoder('gbk').decode(buf);
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const buf = await legacyGet(url, timeoutMs, TX_HEADERS);
    return new TextDecoder('gbk').decode(buf);
  } catch (e) { lastErr = e; }
  await sleep(600);
  const buf = await curlText(url, timeoutMs, true);
  return new TextDecoder('gbk').decode(buf);
}

async function fetchJson(url, timeoutMs) {
  const text = await fetchText(url, timeoutMs);
  return JSON.parse(text);
}

async function fetchJsonp(url, timeoutMs) {
  const text = await fetchText(url, timeoutMs);
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end < 0) throw new Error('bad jsonp');
  return JSON.parse(text.slice(start + 1, end));
}

/* ---------------- 名称模糊搜索 ---------------- */

const SEARCH_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8'; // 东财搜索联想公开 token（官网前端同款）
const searchCache = new Map(); // keyword -> {t, results}

/** 东财搜索联想（主源）：输入名称/拼音/代码片段，返回 A股/港股/美股 候选。
 *  QuoteID 直接就是 secid（如 1.600519 / 116.00700 / 105.AAPL），省去二次探测 */
async function searchViaEastmoney(keyword) {
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}` +
    `&type=14&token=${SEARCH_TOKEN}&count=12`;
  const j = await fetchJson(url, 8000, { ...EM_HEADERS, Referer: 'https://www.eastmoney.com/' });
  const list = j && j.QuotationCodeTable && j.QuotationCodeTable.Data;
  if (!Array.isArray(list)) throw new Error('em search empty');
  const out = [];
  for (const r of list) {
    const classify = r.Classify;
    if (classify !== 'AStock' && classify !== 'HK' && classify !== 'UsStock') continue; // 过滤板块/指数/期货/权证
    const code = r.Code, quoteId = r.QuoteID;
    if (!code || !quoteId) continue;
    let market;
    if (classify === 'AStock') {
      const c0 = code[0];
      market = (c0 === '6' || c0 === '9') ? 'A股(沪)' : (c0 === '4' || c0 === '8') ? 'A股(北)' : 'A股(深)';
    } else if (classify === 'HK') {
      if (!/^\d{5}$/.test(code)) continue;
      if (/购|沽|牛|熊/.test(r.Name || '')) continue; // 剔除窝轮/牛熊证，只留港股正股
      market = '港股';
    } else {
      market = '美股';
    }
    out.push({ code, name: r.Name, market, secid: quoteId });
  }
  return out;
}

/** 腾讯 smartbox（备用源）：GBK 编码 + \uXXXX 转义，需双重解码 */
async function searchViaTencent(keyword) {
  const text = await fetchGbk(`https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(keyword)}&t=all`, 8000);
  const m = text.match(/v_hint="([^"]*)"/);
  if (!m || !m[1]) return [];
  const decoded = m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const out = [];
  for (const item of decoded.split('^')) {
    const f = item.split('~');
    if (f.length < 3) continue;
    const mkt = f[0], code = f[1], name = f[2];
    if (mkt === 'sh' || mkt === 'sz' || mkt === 'bj') {
      const c0 = code[0];
      const market = mkt === 'sh' ? 'A股(沪)' : mkt === 'bj' ? 'A股(北)' : 'A股(深)';
      const secid = (c0 === '6' || c0 === '9') ? `1.${code}` : `0.${code}`;
      out.push({ code, name, market, secid });
    } else if (mkt === 'hk' && /^\d{5}$/.test(code) && !/购|沽|牛|熊/.test(name)) {
      out.push({ code, name, market: '港股', secid: `116.${code}` });
    } else if (mkt === 'us') {
      const base = code.replace(/\..*$/, ''); // 腾讯美股代码带交易所后缀（AAPL.OQ），归一化
      out.push({ code: base, name, market: '美股', secid: `105.${base}` });
    }
  }
  return out;
}

/** 名称模糊搜索：双源互备，60s 缓存 */
async function searchStocks(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const hit = searchCache.get(kw);
  if (hit && Date.now() - hit.t < 60e3) return hit.results;
  let results = [];
  try {
    results = await searchViaEastmoney(kw);
  } catch (_) {
    try { results = await searchViaTencent(kw); } catch (_) { results = []; }
  }
  if (!results.length) {
    try { results = await searchViaTencent(kw); } catch (_) { /* 忽略 */ }
  }
  // 按相关性粗排：名称精确匹配 > 名称前缀 > 代码前缀 > 其他
  const score = (r) => {
    if (r.name === kw || r.code === kw.toUpperCase()) return 0;
    if (r.name.startsWith(kw)) return 1;
    if (r.code.toUpperCase().startsWith(kw.toUpperCase())) return 2;
    return 3;
  };
  results.sort((a, b) => score(a) - score(b));
  results = results.slice(0, 8);
  searchCache.set(kw, { t: Date.now(), results });
  return results;
}

/* ---------------- 持仓组合分析 ---------------- */

const PORTFOLIO_FILE = path.join(__dirname, 'portfolio.json');
let portfolioCache = null; // {t, data}

async function getPortfolio() {
  if (portfolioCache && Date.now() - portfolioCache.t < 60e3) return portfolioCache.data;
  const raw = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
  const holdings = [];
  // 串行拉行情（节流保护），某只失败不拖垮整体
  for (const h of raw.holdings) {
    const item = { ...h, livePrice: null, liveChangePct: null, driftPct: null, quoteOk: false };
    try {
      const resolved = await resolveSecid(secidCandidates(h.code));
      if (resolved) {
        const q = await getQuote(resolved);
        if (q && q.price != null) {
          item.livePrice = q.price;
          item.liveChangePct = q.changePct;
          item.driftPct = +(((q.price - h.snapshotPrice) / h.snapshotPrice) * 100).toFixed(2);
          item.quoteOk = true;
          item.quoteSource = q.source;
        }
      }
    } catch (_) { /* 单只行情失败忽略 */ }
    item.weight = +(h.value / raw.stockValue * 100).toFixed(2);
    holdings.push(item);
  }
  // 板块集中度
  const bySector = {};
  for (const h of holdings) {
    if (!bySector[h.sector]) bySector[h.sector] = { sector: h.sector, value: 0, pnl: 0, count: 0 };
    bySector[h.sector].value += h.value;
    bySector[h.sector].pnl += h.pnl;
    bySector[h.sector].count += 1;
  }
  const sectors = Object.values(bySector)
    .map((s) => ({ ...s, weight: +(s.value / raw.stockValue * 100).toFixed(2) }))
    .sort((a, b) => b.value - a.value);
  // 汇总洞察
  const sorted = [...holdings].sort((a, b) => b.pnl - a.pnl);
  const top3Weight = +[...holdings].sort((a, b) => b.value - a.value).slice(0, 3)
    .reduce((s, h) => s + h.weight, 0).toFixed(2);
  const data = {
    ...raw,
    holdings,
    sectors,
    insights: {
      best: sorted[0] || null,
      worst: sorted[sorted.length - 1] || null,
      top3Weight,
      losers: holdings.filter((h) => h.pnl < 0).length,
      winners: holdings.filter((h) => h.pnl > 0).length,
    },
    fetchedAt: new Date().toISOString(),
  };
  portfolioCache = { t: Date.now(), data };
  return data;
}

/* ---------------- 市场识别 ---------------- */

/**
 * 输入代码 -> 东财 secid 候选列表
 * A股: 6/9 开头 -> 1 (沪), 0/2/3 开头 -> 0 (深), 4/8 开头 -> 0/151 (北交所探测)
 * 港股: 5 位数字 -> 116
 * 美股: 字母 -> 105(纳斯达克) / 106(纽交所) / 107(美交所)
 */
function secidCandidates(raw) {
  const code = raw.trim().toUpperCase();
  if (/^\d{6}$/.test(code)) {
    const c = code[0];
    if (c === '6' || c === '9') return { market: 'A股(沪)', list: [`1.${code}`], code };
    if (c === '4' || c === '8') return { market: 'A股(北)', list: [`0.${code}`, `1.${code}`], code };
    return { market: 'A股(深)', list: [`0.${code}`, `1.${code}`], code };
  }
  if (/^\d{5}$/.test(code)) return { market: '港股', list: [`116.${code}`], code };
  if (/^\d{1,4}$/.test(code)) {
    // 1-4 位数字默认按深市/沪市探测
    const padded = code.padStart(6, '0');
    return { market: 'A股', list: [`0.${padded}`, `1.${padded}`], code: padded };
  }
  if (/^[A-Z.]{1,6}$/.test(code)) {
    return { market: '美股', list: [`105.${code}`, `106.${code}`, `107.${code}`], code };
  }
  return null;
}

/** 腾讯行情符号（备用源） */
function txSymbols(raw, market, code) {
  if (market.startsWith('A股')) {
    const c = code[0];
    const prefix = (c === '6' || c === '9') ? 'sh' : (c === '4' || c === '8') ? 'bj' : 'sz';
    return [prefix + code];
  }
  if (market === '港股') return ['hk' + code];
  if (market === '美股') return ['us' + code];
  return [];
}

const secidCache = new Map(); // code -> resolved

async function resolveSecid(cand) {
  const hit = secidCache.get(cand.code);
  if (hit) return hit;
  // 主源：东财
  for (const secid of cand.list) {
    try {
      const j = await fetchJson(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fltt=2&invt=2&fields=f43,f57,f58`,
        8000
      );
      if (j && j.rc === 0 && j.data && j.data.f43 !== '-' && j.data.f43 != null) {
        const resolved = { secid, txSymbol: null, code: j.data.f57, name: j.data.f58, market: cand.market, source: 'eastmoney' };
        secidCache.set(cand.code, resolved);
        return resolved;
      }
    } catch (_) { /* try next */ }
  }
  // 备用源：腾讯（东财被限流时兜底）
  for (const sym of txSymbols(cand.code, cand.market, cand.code)) {
    try {
      const text = await fetchGbk(`https://qt.gtimg.cn/q=${sym}`, 8000);
      const m = text.match(/="([^"]+)"/);
      if (!m || !m[1]) continue;
      const f = m[1].split('~');
      if (!f[1] || !f[3]) continue;
      const resolved = {
        secid: cand.list[0], // 保留东财 secid 供财报/资金流接口尝试
        // 腾讯美股代码带交易所后缀（AAPL.OQ），需归一化为基础代码，否则拼接 K 线符号会变成 usAAPL.OQ.OQ
        txSymbol: sym, code: (f[2] || cand.code).replace(/\..*$/, ''), name: f[1], market: cand.market, source: 'tencent',
      };
      secidCache.set(cand.code, resolved);
      return resolved;
    } catch (_) { /* try next */ }
  }
  return null;
}

/* ---------------- 数据拉取 ---------------- */

async function getQuote(resolved) {
  // 主源：东财
  try {
    const fields = 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f84,f85,f116,f117,f162,f167,f168,f169,f170,f171';
    const j = await fetchJson(
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${resolved.secid}&fltt=2&invt=2&fields=${fields}`
    );
    if (j.data && j.data.f43 !== '-' && j.data.f43 != null) {
      const d = j.data;
      const num = (v) => (v === '-' || v == null ? null : Number(v));
      return {
        price: num(d.f43), high: num(d.f44), low: num(d.f45), open: num(d.f46),
        volume: num(d.f47), amount: num(d.f48), prevClose: num(d.f60),
        totalShares: num(d.f84), floatShares: num(d.f85),
        totalMcap: num(d.f116), floatMcap: num(d.f117),
        peTtm: num(d.f162), pb: num(d.f167), turnoverRate: num(d.f168),
        change: num(d.f169), changePct: num(d.f170), source: 'eastmoney',
      };
    }
    throw new Error('em quote empty');
  } catch (_) {
    // 备用源：腾讯（GBK，A股字段口径完整；港美股取基础字段）
    const sym = resolved.txSymbol || txSymbols(resolved.code, resolved.market, resolved.code)[0];
    if (!sym) throw new Error('quote unavailable');
    const text = await fetchGbk(`https://qt.gtimg.cn/q=${sym}`);
    const m = text.match(/="([^"]+)"/);
    if (!m || !m[1]) throw new Error('tx quote empty');
    const f = m[1].split('~');
    const n = (i) => {
      const v = parseFloat(f[i]);
      return isNaN(v) ? null : v;
    };
    const isA = resolved.market.startsWith('A股');
    return {
      price: n(3), prevClose: n(4), open: n(5),
      volume: n(6), amount: isA && n(37) != null ? n(37) * 1e4 : null,
      high: n(33), low: n(34), change: n(31), changePct: n(32),
      turnoverRate: isA ? n(38) : null,
      peTtm: isA ? n(39) : null, pb: isA ? n(46) : null,
      totalMcap: isA && n(45) != null ? n(45) * 1e8 : null,
      floatMcap: isA && n(44) != null ? n(44) * 1e8 : null,
      totalShares: null, floatShares: null,
      limitUp: isA ? n(47) : null, limitDown: isA ? n(48) : null, // 腾讯字段：涨停/跌停价
      source: 'tencent',
    };
  }
}

async function getKline(resolved, count = 260) {
  // 主源：东财
  try {
    const j = await fetchJson(
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${resolved.secid}&klt=101&fqt=1&lmt=${count}&end=20500101` +
      `&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58`
    );
    if (j.data && j.data.klines && j.data.klines.length) {
      return j.data.klines.map((line) => {
        const p = line.split(',');
        return {
          date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4],
          volume: +p[5], amount: +p[6], amplitude: +p[7],
        };
      });
    }
    throw new Error('em kline empty');
  } catch (e) {
    console.error('[kline-em]', resolved.secid, e.message);
    // 备用源：腾讯（美股K线需带交易所后缀，逐一探测）
    const base = resolved.txSymbol || txSymbols(resolved.code, resolved.market, resolved.code)[0];
    if (!base) return [];
    const klineSyms = resolved.market === '美股'
      ? [`us${resolved.code}.OQ`, `us${resolved.code}.N`, base]
      : [base];
    for (const sym of klineSyms) {
      try {
        const j = await fetchJson(
          `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,${count},qfq`,
          12000, TX_HEADERS
        );
        const d = j.data && j.data[sym];
        const arr = d && (d.qfqday || d.day);
        if (!arr || arr.length < 30) { console.error('[kline-tx]', sym, 'rows=', arr ? arr.length : 'null'); continue; }
        return arr.map((p) => ({
          date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4],
          volume: +p[5], amount: null, amplitude: null,
        }));
      } catch (e2) { console.error('[kline-tx]', sym, e2.message); }
    }
    return [];
  }
}

async function getCapitalFlow(secid) {
  try {
    const j = await fetchJson(
      `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${secid}&lmt=0&klt=101&ut=${UT_TOKEN}` +
      `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56`
    );
    if (!j.data || !j.data.klines) return null;
    const rows = j.data.klines.map((line) => {
      const p = line.split(',');
      return {
        date: p[0], main: +p[1], small: +p[2], mid: +p[3], large: +p[4], superLarge: +p[5],
      };
    });
    const tail = rows.slice(-10);
    const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
    return {
      latest: rows[rows.length - 1] || null,
      sum5: sum(rows.slice(-5), 'main'),
      sum10: sum(rows.slice(-10), 'main'),
      series: tail,
    };
  } catch (_) { return null; }
}

async function getFinancials(code, market) {
  if (!market.startsWith('A股')) return null; // 东财业绩报表仅覆盖A股
  try {
    const cols = 'SECURITY_CODE,SECURITY_NAME_ABBR,REPORTDATE,TOTAL_OPERATE_INCOME,YSTZ,PARENT_NETPROFIT,SJLTZ,XSMLL,WEIGHTAVG_ROE,BASIC_EPS,BOARD_NAME,BOARD_CODE';
    const filter = encodeURIComponent(`(SECURITY_CODE="${code}")`);
    const j = await fetchJson(
      `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=${cols}` +
      `&filter=${filter}&pageSize=6&pageNumber=1&sortColumns=REPORTDATE&sortTypes=-1`,
      12000, { ...EM_HEADERS, Referer: 'https://data.eastmoney.com/' }
    );
    if (!j.success || !j.result || !j.result.data) return null;
    const list = j.result.data.map((r) => ({
      period: (r.REPORTDATE || '').slice(0, 10),
      revenue: r.TOTAL_OPERATE_INCOME, revYoY: r.YSTZ,
      netProfit: r.PARENT_NETPROFIT, npYoY: r.SJLTZ,
      netMargin: (r.TOTAL_OPERATE_INCOME && r.PARENT_NETPROFIT != null)
        ? +(r.PARENT_NETPROFIT / r.TOTAL_OPERATE_INCOME * 100).toFixed(2) : null,
      grossMargin: r.XSMLL, roe: r.WEIGHTAVG_ROE, eps: r.BASIC_EPS,
    }));
    // 报表自带所属行业板块（比 push2 的 f127 稳定，f127 高频访问会被定向限流）
    const first = j.result.data[0] || {};
    return { list, industry: first.BOARD_NAME || null, boardCode: first.BOARD_CODE || null };
  } catch (_) { return null; }
}

async function getNews(code) {
  try {
    const param = {
      uid: '', keyword: code, type: ['cmsArticleWebOld'], client: 'web',
      clientType: 'web', clientVersion: 'curr',
      param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: 8, preTag: '', postTag: '' } },
    };
    const url = 'https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=' + encodeURIComponent(JSON.stringify(param));
    const j = await fetchJsonp(url, 12000);
    const list = (j.result && j.result.cmsArticleWebOld) || [];
    return list.map((a) => ({
      date: a.date, title: a.title, media: a.mediaName, url: a.url,
    }));
  } catch (_) { return []; }
}

async function getAnnouncements(code, market) {
  if (!market.startsWith('A股')) return [];
  try {
    const j = await fetchJson(
      `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=6&page_index=1&ann_type=A&client_source=web&stock_list=${code}`,
      12000, { ...EM_HEADERS, Referer: 'https://data.eastmoney.com/' }
    );
    const list = (j.data && j.data.list) || [];
    return list.map((a) => ({
      date: (a.notice_date || '').slice(0, 10),
      title: a.title,
      url: `https://data.eastmoney.com/notices/detail/${code}/${a.art_code}.html`,
    }));
  } catch (_) { return []; }
}

/* ---------------- A股特色数据（移植自开源 A 股 Agent 体系） ---------------- */

function emDcHeaders() { return { ...EM_HEADERS, Referer: 'https://data.eastmoney.com/' }; }

/** 所属行业（东财口径，如"白酒Ⅱ"；f127 需带 ut token 否则空响应） */
async function getIndustry(resolved) {
  if (!resolved.market.startsWith('A股')) return null;
  try {
    const j = await fetchJson(
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${resolved.secid}&fields=f127&ut=${UT_TOKEN}`,
      8000
    );
    const v = j.data && j.data.f127;
    return v && v !== '-' ? v : null;
  } catch (_) { return null; }
}

/** 行业板块全景：单次拉取全部板块（按涨幅排序），计算所属板块的轮动位置与资金流。
 *  全市场榜单变化慢，内存缓存 10 分钟；并落盘持久化，进程重启后 6 小时内的旧数据仍可兜底 */
let sectorCache = null; // { t, rows }
const SECTOR_CACHE_FILE = path.join(__dirname, '.sector-cache.json');

function loadSectorCache() {
  if (sectorCache) return;
  try {
    const j = JSON.parse(fs.readFileSync(SECTOR_CACHE_FILE, 'utf8'));
    if (j && j.t && Array.isArray(j.rows)) sectorCache = j;
  } catch (_) { /* 无缓存文件 */ }
}

function saveSectorCache() {
  try { fs.writeFileSync(SECTOR_CACHE_FILE, JSON.stringify(sectorCache)); } catch (_) { /* 忽略 */ }
}

function matchSectorRow(rows, industryName) {
  let idx = rows.findIndex((r) => r.f14 === industryName);
  if (idx < 0) {
    const base = industryName.replace(/[ⅠⅡⅢ]+$/, '');
    idx = rows.findIndex((r) => String(r.f14).replace(/[ⅠⅡⅢ]+$/, '') === base);
  }
  return idx;
}

function sectorRowToBoard(rows, idx, stale) {
  const r = rows[idx];
  return {
    name: r.f14, code: r.f12, rank: idx + 1, total: rows.length,
    changePct: r.f3, upCount: r.f104, downCount: r.f105,
    leader: r.f128 || null, leaderCode: r.f140 || null, mainNetInflow: r.f62,
    ...(stale ? { stale: true } : {}),
  };
}

async function getSectorBoard(industryName) {
  if (!industryName) return null;
  loadSectorCache();
  try {
    let rows = null;
    if (sectorCache && Date.now() - sectorCache.t < 10 * 60e3) {
      rows = sectorCache.rows;
    } else {
      const fields = 'f2,f3,f12,f14,f62,f104,f105,f128,f136,f140';
      const j = await fetchJson(
        `https://push2.eastmoney.com/api/qt/clist/get?fs=m:90%2Bt:2&fltt=2&invt=2&fields=${fields}` +
        `&fid=f3&po=1&pz=500&pn=1&ut=${UT_TOKEN}`,
        12000
      );
      const diff = j.data && j.data.diff;
      if (!diff) throw new Error('sector empty');
      rows = Object.values(diff);
      sectorCache = { t: Date.now(), rows };
      saveSectorCache();
    }
    const idx = matchSectorRow(rows, industryName);
    if (idx < 0) return { name: industryName, total: rows.length };
    return sectorRowToBoard(rows, idx, false);
  } catch (_) {
    // 刷新失败：6 小时内的陈旧缓存（含落盘）继续可用
    if (sectorCache && Date.now() - sectorCache.t < 6 * 3600e3) {
      const idx = matchSectorRow(sectorCache.rows, industryName);
      if (idx >= 0) return sectorRowToBoard(sectorCache.rows, idx, true);
    }
    return null;
  }
}

/** 龙虎榜（近120天上榜记录，东财数据中心） */
async function getBillboard(code, market) {
  if (!market.startsWith('A股')) return null;
  try {
    const since = new Date(Date.now() - 120 * 86400e3).toISOString().slice(0, 10);
    const cols = 'TRADE_DATE,EXPLANATION,BILLBOARD_NET_AMT,BILLBOARD_BUY_AMT,BILLBOARD_SELL_AMT,TURNOVERRATE';
    const filter = encodeURIComponent(`(SECURITY_CODE="${code}")(TRADE_DATE>='${since}')`);
    const j = await fetchJson(
      `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=${cols}` +
      `&filter=${filter}&pageSize=10&pageNumber=1&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB`,
      12000, emDcHeaders()
    );
    if (!j.success || !j.result || !j.result.data) return { count: 0, netSum: 0, items: [] };
    const items = j.result.data.map((r) => ({
      date: (r.TRADE_DATE || '').slice(0, 10),
      reason: r.EXPLANATION,
      netAmt: r.BILLBOARD_NET_AMT, buyAmt: r.BILLBOARD_BUY_AMT, sellAmt: r.BILLBOARD_SELL_AMT,
      turnover: r.TURNOVERRATE,
    }));
    return { count: items.length, netSum: items.reduce((s, r) => s + (r.netAmt || 0), 0), items };
  } catch (_) { return null; }
}

/** 未来限售解禁日程（东财数据中心 RPT_LIFT_STAGE） */
async function getUnlocks(code, market) {
  if (!market.startsWith('A股')) return null;
  try {
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const cols = 'FREE_DATE,FREE_SHARES_TYPE,FREE_SHARES,FREE_RATIO,TOTAL_RATIO,LIFT_MARKET_CAP';
    const filter = encodeURIComponent(`(SECURITY_CODE="${code}")(FREE_DATE>='${today}')`);
    const j = await fetchJson(
      `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LIFT_STAGE&columns=${cols}` +
      `&filter=${filter}&pageSize=3&pageNumber=1&sortColumns=FREE_DATE&sortTypes=1&source=WEB&client=WEB`,
      12000, emDcHeaders()
    );
    // 无解禁计划时接口返回 success:false "返回数据为空"，属正常业务结果
    if (!j.success || !j.result || !j.result.data) return [];
    return j.result.data.map((r) => ({
      date: (r.FREE_DATE || '').slice(0, 10),
      type: r.FREE_SHARES_TYPE,
      shares: r.FREE_SHARES != null ? r.FREE_SHARES * 1e4 : null,       // 万股 -> 股
      floatRatio: r.FREE_RATIO != null ? +(r.FREE_RATIO * 100).toFixed(2) : null,
      mcap: r.LIFT_MARKET_CAP != null ? r.LIFT_MARKET_CAP * 1e4 : null,  // 万元 -> 元
    }));
  } catch (_) { return null; }
}

/** 涨跌停价（腾讯行情字段 f[47]/f[48]，已按板块规则计算好，A股专用） */
async function getLimitPrices(resolved) {
  if (!resolved.market.startsWith('A股')) return null;
  try {
    const sym = resolved.txSymbol || txSymbols(resolved.code, resolved.market, resolved.code)[0];
    if (!sym) return null;
    const text = await fetchGbk(`https://qt.gtimg.cn/q=${sym}`, 8000);
    const m = text.match(/="([^"]+)"/);
    if (!m) return null;
    const f = m[1].split('~');
    const up = parseFloat(f[47]), down = parseFloat(f[48]);
    if (isNaN(up) || isNaN(down) || up <= 0 || down <= 0) return null;
    return { limitUp: up, limitDown: down };
  } catch (_) { return null; }
}

/** A股特色数据聚合（行业优先用财报接口的 BOARD_NAME，f127 作备用） */
async function getAshareExtras(resolved, quote, industryHint) {
  if (!resolved.market.startsWith('A股')) return null;
  const industry = industryHint || await getIndustry(resolved);
  const [sector, billboard, unlocks, limits] = await Promise.all([
    getSectorBoard(industry),
    getBillboard(resolved.code, resolved.market),
    getUnlocks(resolved.code, resolved.market),
    quote.limitUp != null
      ? Promise.resolve({ limitUp: quote.limitUp, limitDown: quote.limitDown })
      : getLimitPrices(resolved),
  ]);
  return {
    industry, sector, billboard, unlocks,
    limitUp: limits && limits.limitUp, limitDown: limits && limits.limitDown,
  };
}

/* ---------------- 技术指标 ---------------- */

function sma(arr, n, key = 'close') {
  if (arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i][key];
  return s / n;
}

function emaSeries(values, n) {
  const k = 2 / (n + 1);
  const out = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function macd(closes) {
  if (closes.length < 35) return null;
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const dif = closes.map((_, i) => e12[i] - e26[i]);
  const dea = emaSeries(dif, 9);
  const i = closes.length - 1;
  const hist = 2 * (dif[i] - dea[i]);
  const prevHist = 2 * (dif[i - 1] - dea[i - 1]);
  return {
    dif: dif[i], dea: dea[i], hist, prevHist,
    goldenCross: dif[i - 1] <= dea[i - 1] && dif[i] > dea[i],
    deadCross: dif[i - 1] >= dea[i - 1] && dif[i] < dea[i],
  };
}

function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

function kdj(klines, n = 9) {
  if (klines.length < n) return null;
  let k = 50, d = 50;
  for (let i = klines.length - n; i < klines.length; i++) {
    const win = klines.slice(Math.max(0, i - n + 1), i + 1);
    const hh = Math.max(...win.map((x) => x.high));
    const ll = Math.min(...win.map((x) => x.low));
    const rsv = hh === ll ? 50 : ((klines[i].close - ll) / (hh - ll)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
  }
  return { k, d, j: 3 * k - 2 * d };
}

function boll(closes, n = 20) {
  if (closes.length < n) return null;
  const win = closes.slice(-n);
  const mid = win.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(win.reduce((s, v) => s + (v - mid) ** 2, 0) / n);
  const upper = mid + 2 * sd, lower = mid - 2 * sd;
  const pctB = upper === lower ? 0.5 : (closes[closes.length - 1] - lower) / (upper - lower);
  return { upper, mid, lower, pctB, bandwidth: mid ? (upper - lower) / mid : 0 };
}

function atr(klines, n = 14) {
  if (klines.length < n + 1) return null;
  let s = 0;
  for (let i = klines.length - n; i < klines.length; i++) {
    const c = klines[i], p = klines[i - 1];
    s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return s / n;
}

function computeIndicators(klines) {
  const closes = klines.map((k) => k.close);
  const last = klines[klines.length - 1];
  const win20 = klines.slice(-20), win60 = klines.slice(-60);
  const vol5 = sma(klines, 5, 'volume'), vol20 = sma(klines, 20, 'volume');
  const year = klines.slice(-250);
  return {
    ma: { ma5: sma(klines, 5), ma10: sma(klines, 10), ma20: sma(klines, 20), ma60: sma(klines, 60) },
    macd: macd(closes),
    rsi14: rsi(closes, 14),
    kdj: kdj(klines),
    boll: boll(closes),
    atr14: atr(klines),
    volRatio: vol20 ? last.volume / vol20 : null,
    swing: {
      high20: Math.max(...win20.map((k) => k.high)),
      low20: Math.min(...win20.map((k) => k.low)),
      high60: Math.max(...win60.map((k) => k.high)),
      low60: Math.min(...win60.map((k) => k.low)),
      high52w: Math.max(...year.map((k) => k.high)),
      low52w: Math.min(...year.map((k) => k.low)),
    },
    ret20: klines.length > 20 ? (last.close / klines[klines.length - 21].close - 1) * 100 : null,
    ret60: klines.length > 60 ? (last.close / klines[klines.length - 61].close - 1) * 100 : null,
  };
}

/* ---------------- 消息面情绪 ---------------- */

const POS_WORDS = ['涨停', '预增', '回购', '增持', '中标', '获批', '创新高', '分红', '签约', '大涨', '扩产', '订单', '突破', '上调', '买入评级', '业绩超预期'];
const NEG_WORDS = ['跌停', '预亏', '减持', '处罚', '立案', '诉讼', '退市', '风险警示', '下滑', '大跌', '违约', '问询', '亏损', '下调', '卖出评级', '业绩低于预期'];

function sentimentOf(title) {
  let s = 0;
  for (const w of POS_WORDS) if (title.includes(w)) s += 1;
  for (const w of NEG_WORDS) if (title.includes(w)) s -= 1;
  return s > 0 ? 'positive' : s < 0 ? 'negative' : 'neutral';
}

/* ---------------- 多因子评分引擎 ---------------- */

function analyzeAll({ quote, klines, ind, flows, financials, newsItems, ashare, market }) {
  const dims = [];
  const f2 = (v) => (v == null ? '—' : (+v).toFixed(2));
  const pct = (v) => (v == null ? '—' : `${(+v).toFixed(2)}%`);
  const yi = (v) => (v == null ? '—' : `${(v / 1e8).toFixed(2)}亿`);

  // 1. 趋势 (权重高)
  {
    const sig = [];
    let score = 0;
    const { ma } = ind;
    const c = quote.price;
    if (ma.ma20 != null) {
      if (c > ma.ma20) { score += 0.5; sig.push({ t: `收盘价 ${f2(c)} 站上 MA20 (${f2(ma.ma20)})，短期趋势偏强`, d: 'up' }); }
      else { score -= 0.5; sig.push({ t: `收盘价 ${f2(c)} 跌破 MA20 (${f2(ma.ma20)})，短期趋势偏弱`, d: 'down' }); }
    }
    if (ma.ma60 != null) {
      if (c > ma.ma60) { score += 0.5; sig.push({ t: `位于 MA60 (${f2(ma.ma60)}) 上方，中期趋势完好`, d: 'up' }); }
      else { score -= 0.5; sig.push({ t: `位于 MA60 (${f2(ma.ma60)}) 下方，中期趋势承压`, d: 'down' }); }
    }
    if (ma.ma5 != null && ma.ma10 != null && ma.ma20 != null && ma.ma60 != null) {
      if (ma.ma5 > ma.ma10 && ma.ma10 > ma.ma20 && ma.ma20 > ma.ma60) {
        score += 0.7; sig.push({ t: '均线多头排列（MA5>MA10>MA20>MA60）', d: 'up' });
      } else if (ma.ma5 < ma.ma10 && ma.ma10 < ma.ma20 && ma.ma20 < ma.ma60) {
        score -= 0.7; sig.push({ t: '均线空头排列（MA5<MA10<MA20<MA60）', d: 'down' });
      }
    }
    if (ind.macd) {
      const m = ind.macd;
      if (m.goldenCross) { score += 0.6; sig.push({ t: 'MACD 刚形成金叉（DIF 上穿 DEA）', d: 'up' }); }
      else if (m.deadCross) { score -= 0.6; sig.push({ t: 'MACD 刚形成死叉（DIF 下穿 DEA）', d: 'down' }); }
      else if (m.hist > 0 && m.hist > m.prevHist) { score += 0.3; sig.push({ t: 'MACD 红柱放大，多头动能增强', d: 'up' }); }
      else if (m.hist < 0 && m.hist < m.prevHist) { score -= 0.3; sig.push({ t: 'MACD 绿柱放大，空头动能增强', d: 'down' }); }
    }
    if (ind.swing.high52w && ind.swing.low52w) {
      const pos = (c - ind.swing.low52w) / (ind.swing.high52w - ind.swing.low52w);
      if (pos > 0.85) { sig.push({ t: `股价处于近一年 ${(pos * 100).toFixed(0)}% 分位，接近 52 周高点`, d: 'flat' }); score += 0.2; }
      else if (pos < 0.15) { sig.push({ t: `股价处于近一年 ${(pos * 100).toFixed(0)}% 分位，接近 52 周低点`, d: 'flat' }); score -= 0.2; }
    }
    dims.push({ key: 'trend', label: '趋势', score: Math.max(-2, Math.min(2, score)), max: 2, signals: sig });
  }

  // 2. 动量
  {
    const sig = [];
    let score = 0;
    if (ind.rsi14 != null) {
      const r = ind.rsi14;
      if (r >= 80) { score -= 0.6; sig.push({ t: `RSI14 = ${f2(r)}，严重超买区，短线回调风险大`, d: 'down' }); }
      else if (r >= 70) { score -= 0.3; sig.push({ t: `RSI14 = ${f2(r)}，进入超买区，追高需谨慎`, d: 'flat' }); }
      else if (r >= 50) { score += 0.4; sig.push({ t: `RSI14 = ${f2(r)}，多头占优且未过热`, d: 'up' }); }
      else if (r >= 30) { score -= 0.2; sig.push({ t: `RSI14 = ${f2(r)}，动能偏弱`, d: 'flat' }); }
      else { score += 0.3; sig.push({ t: `RSI14 = ${f2(r)}，进入超卖区，存在技术性反弹条件`, d: 'up' }); }
    }
    if (ind.kdj) {
      const { j } = ind.kdj;
      if (j > 100) { score -= 0.3; sig.push({ t: `KDJ J 值 ${f2(j)} 超过 100，短线过热`, d: 'flat' }); }
      else if (j < 0) { score += 0.3; sig.push({ t: `KDJ J 值 ${f2(j)} 低于 0，短线超卖`, d: 'flat' }); }
    }
    if (ind.boll) {
      const b = ind.boll;
      if (b.pctB > 1) { score -= 0.3; sig.push({ t: `股价突破布林上轨（${f2(b.upper)}），偏离均值过大`, d: 'flat' }); }
      else if (b.pctB < 0) { score += 0.3; sig.push({ t: `股价跌破布林下轨（${f2(b.lower)}），存在均值回归空间`, d: 'flat' }); }
    }
    if (ind.volRatio != null) {
      if (ind.volRatio > 2) sig.push({ t: `量比 ${f2(ind.volRatio)}，今日显著放量，需辨别放量方向`, d: 'flat' });
      else if (ind.volRatio < 0.6) sig.push({ t: `量比 ${f2(ind.volRatio)}，成交明显萎缩，观望情绪浓`, d: 'flat' });
    }
    dims.push({ key: 'momentum', label: '动量', score: Math.max(-2, Math.min(2, score)), max: 2, signals: sig });
  }

  // 3. 资金面
  {
    const sig = [];
    let score = 0;
    if (flows && flows.latest) {
      if (flows.latest.main > 0) { score += 0.4; sig.push({ t: `最新交易日主力资金净流入 ${yi(flows.latest.main)}`, d: 'up' }); }
      else if (flows.latest.main < 0) { score -= 0.4; sig.push({ t: `最新交易日主力资金净流出 ${yi(-flows.latest.main)}`, d: 'down' }); }
      if (flows.sum5 > 0) { score += 0.5; sig.push({ t: `近 5 日主力累计净流入 ${yi(flows.sum5)}`, d: 'up' }); }
      else { score -= 0.5; sig.push({ t: `近 5 日主力累计净流出 ${yi(-flows.sum5)}`, d: 'down' }); }
      if (flows.sum10 > 0) { score += 0.3; sig.push({ t: `近 10 日主力累计净流入 ${yi(flows.sum10)}，中线资金态度积极`, d: 'up' }); }
      else { score -= 0.3; sig.push({ t: `近 10 日主力累计净流出 ${yi(-flows.sum10)}，中线资金持续撤离`, d: 'down' }); }
      // 游资盘口口诀（移植自 aiagents-stock 的 smart_money 规则）：量价配合辨别建仓/派发/洗盘
      const tr = quote.turnoverRate, chg = quote.changePct;
      if (tr != null && chg != null) {
        const m0 = flows.latest.main;
        if (m0 > 0 && tr < 3) {
          score += 0.3; sig.push({ t: `主力净流入 + 低换手（${f2(tr)}%），符合游资口诀中的"悄然建仓"特征`, d: 'up' });
        } else if (m0 < 0 && tr > 8 && Math.abs(chg) < 2) {
          score -= 0.4; sig.push({ t: `主力净流出 + 高换手（${f2(tr)}%）+ 滞涨，符合"热钱派发"特征，警惕接盘`, d: 'down' });
        } else if (m0 < 0 && chg < -3 && ind.volRatio != null && ind.volRatio < 0.8) {
          sig.push({ t: '主力流出但急跌缩量，存在"洗盘假摔"可能，宜观察次日确认而非恐慌卖出', d: 'flat' });
        }
      }
    } else {
      sig.push({ t: '当前数据源未覆盖该股资金流数据', d: 'flat' });
    }
    dims.push({ key: 'capital', label: '资金面', score: Math.max(-2, Math.min(2, score)), max: 2, signals: sig });
  }

  // 4. 估值
  {
    const sig = [];
    let score = 0;
    const peLabel = quote.source === 'tencent' ? 'PE（腾讯口径）' : 'PE(TTM)';
    if (quote.peTtm != null && quote.peTtm > 0) {
      const pe = quote.peTtm;
      if (pe < 15) { score += 0.6; sig.push({ t: `${peLabel} ${f2(pe)}，绝对估值较低`, d: 'up' }); }
      else if (pe < 30) { score += 0.2; sig.push({ t: `${peLabel} ${f2(pe)}，估值处于中性区间`, d: 'flat' }); }
      else if (pe < 60) { score -= 0.3; sig.push({ t: `${peLabel} ${f2(pe)}，估值偏高，依赖增长兑现`, d: 'flat' }); }
      else { score -= 0.6; sig.push({ t: `${peLabel} ${f2(pe)}，估值很高，对业绩波动敏感`, d: 'down' }); }
      // PEG 粗算（有净利增速时）
      const latestFin = financials && financials[0];
      if (latestFin && latestFin.npYoY != null && latestFin.npYoY > 0) {
        const peg = pe / latestFin.npYoY;
        if (peg < 1) { score += 0.4; sig.push({ t: `按最新净利增速 ${pct(latestFin.npYoY)} 粗算 PEG≈${f2(peg)}，估值有支撑`, d: 'up' }); }
        else if (peg > 2) { score -= 0.4; sig.push({ t: `按最新净利增速 ${pct(latestFin.npYoY)} 粗算 PEG≈${f2(peg)}，估值透支增长`, d: 'down' }); }
      }
    } else if (quote.peTtm != null && quote.peTtm <= 0) {
      score -= 0.8;
      sig.push({ t: `${peLabel} 为负，公司处于亏损状态，估值锚缺失`, d: 'down' });
    } else {
      sig.push({ t: '当前数据源未提供该股 PE，估值维度降权处理', d: 'flat' });
    }
    if (quote.pb != null) {
      sig.push({ t: `PB ${f2(quote.pb)}，总市值 ${yi(quote.totalMcap)}`, d: 'flat' });
    }
    dims.push({ key: 'valuation', label: '估值', score: Math.max(-2, Math.min(2, score)), max: 2, signals: sig });
  }

  // 5. 基本面
  {
    const sig = [];
    let score = 0;
    if (financials && financials.length) {
      const f0 = financials[0];
      if (f0.revYoY != null) {
        if (f0.revYoY > 20) { score += 0.5; sig.push({ t: `最新报告期（${f0.period}）营收同比 +${pct(f0.revYoY)}，增长强劲`, d: 'up' }); }
        else if (f0.revYoY > 0) { score += 0.2; sig.push({ t: `最新报告期（${f0.period}）营收同比 +${pct(f0.revYoY)}，保持增长`, d: 'up' }); }
        else { score -= 0.5; sig.push({ t: `最新报告期（${f0.period}）营收同比 ${pct(f0.revYoY)}，收入收缩`, d: 'down' }); }
      }
      if (f0.npYoY != null) {
        if (f0.npYoY > 20) { score += 0.6; sig.push({ t: `归母净利同比 +${pct(f0.npYoY)}，盈利高增`, d: 'up' }); }
        else if (f0.npYoY > 0) { score += 0.2; sig.push({ t: `归母净利同比 +${pct(f0.npYoY)}，盈利正增长`, d: 'up' }); }
        else { score -= 0.6; sig.push({ t: `归母净利同比 ${pct(f0.npYoY)}，盈利下滑`, d: 'down' }); }
      }
      if (f0.roe != null) {
        if (f0.roe > 15) { score += 0.4; sig.push({ t: `ROE(加权) ${pct(f0.roe)}，盈利质量优秀`, d: 'up' }); }
        else if (f0.roe < 5) { score -= 0.3; sig.push({ t: `ROE(加权) ${pct(f0.roe)}，资本回报偏弱`, d: 'down' }); }
      }
      if (financials.length >= 2 && financials[0].grossMargin != null && financials[1].grossMargin != null) {
        const d = financials[0].grossMargin - financials[1].grossMargin;
        if (d > 1) { score += 0.2; sig.push({ t: `毛利率环比改善 ${d.toFixed(1)} 个百分点`, d: 'up' }); }
        else if (d < -1) { score -= 0.2; sig.push({ t: `毛利率环比下滑 ${(-d).toFixed(1)} 个百分点`, d: 'down' }); }
      }
    } else {
      sig.push({ t: '当前数据源未覆盖该股财务报表数据（非A股或接口未返回）', d: 'flat' });
    }
    dims.push({ key: 'fundamental', label: '基本面', score: Math.max(-2, Math.min(2, score)), max: 2, signals: sig });
  }

  // 6. 消息面
  {
    const sig = [];
    let score = 0;
    let pos = 0, neg = 0;
    for (const n of (newsItems || [])) {
      const s = sentimentOf(n.title || '');
      n.sentiment = s;
      if (s === 'positive') pos++;
      if (s === 'negative') neg++;
    }
    if (pos > neg) { score = Math.min(0.6, (pos - neg) * 0.2); sig.push({ t: `近期新闻偏正面（利好 ${pos} 条 / 利空 ${neg} 条）`, d: 'up' }); }
    else if (neg > pos) { score = Math.max(-0.6, -(neg - pos) * 0.2); sig.push({ t: `近期新闻偏负面（利空 ${neg} 条 / 利好 ${pos} 条）`, d: 'down' }); }
    else sig.push({ t: `近期新闻情绪中性（利好 ${pos} 条 / 利空 ${neg} 条）`, d: 'flat' });
    dims.push({ key: 'news', label: '消息面', score, max: 2, signals: sig });
  }

  // 7. A股特色（龙虎榜热钱 / 解禁压力 / 板块轮动 / 涨跌停，移植自 TradingAgents-astock 的专项分析师）
  if (ashare) {
    const sig = [];
    let score = 0;
    // 龙虎榜热钱
    const bb = ashare.billboard;
    if (bb && bb.count > 0) {
      if (bb.netSum > 0) { score += 0.5; sig.push({ t: `近120日 ${bb.count} 次登上龙虎榜，席位合计净买入 ${yi(bb.netSum)}，热钱关注度高`, d: 'up' }); }
      else { score -= 0.5; sig.push({ t: `近120日 ${bb.count} 次登上龙虎榜，席位合计净卖出 ${yi(-bb.netSum)}，热钱以出货为主`, d: 'down' }); }
    } else if (bb) {
      sig.push({ t: '近120日未上龙虎榜，当前非游资热钱主攻方向', d: 'flat' });
    }
    // 限售解禁
    const un = ashare.unlocks;
    if (un && un.length) {
      const next = un[0];
      const todayStr = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
      const days = Math.max(0, Math.ceil((new Date(next.date) - new Date(todayStr)) / 86400e3));
      const mcapTxt = next.mcap != null ? `（约 ${yi(next.mcap)}）` : '';
      const ratioTxt = next.floatRatio != null ? `，占流通股约 ${next.floatRatio}%` : '';
      if (days <= 30) { score -= 0.6; sig.push({ t: `${next.date}（${days} 天后）将有${next.type || '限售股'}解禁${mcapTxt}${ratioTxt}，短期筹码供给压力临近`, d: 'down' }); }
      else if (days <= 90) { score -= 0.3; sig.push({ t: `${next.date}（${days} 天后）有限售解禁${mcapTxt}${ratioTxt}，中期需留意`, d: 'flat' }); }
      else { sig.push({ t: `最近一次解禁在 ${next.date}（${days} 天后），短期无解禁压力`, d: 'flat' }); }
    } else if (un) {
      score += 0.2; sig.push({ t: '无已披露的未来限售解禁计划，筹码供给稳定', d: 'up' });
    }
    // 板块轮动位置
    const sec = ashare.sector;
    if (sec && sec.rank != null) {
      const pctRank = sec.rank / sec.total;
      const flowTxt = sec.mainNetInflow != null ? `，板块主力净流入 ${yi(sec.mainNetInflow)}` : '';
      if (pctRank <= 0.2) { score += 0.5; sig.push({ t: `所属板块「${sec.name}」今日 ${pct(sec.changePct)}，全行业第 ${sec.rank}/${sec.total}，处于强势轮动区${flowTxt}`, d: 'up' }); }
      else if (pctRank >= 0.8) { score -= 0.5; sig.push({ t: `所属板块「${sec.name}」今日 ${pct(sec.changePct)}，全行业第 ${sec.rank}/${sec.total}，处于资金流出区${flowTxt}`, d: 'down' }); }
      else { sig.push({ t: `所属板块「${sec.name}」今日 ${pct(sec.changePct)}，全行业排名 ${sec.rank}/${sec.total}，轮动位置中性${flowTxt}`, d: 'flat' }); }
      if (sec.leader) sig.push({ t: `板块领涨股为 ${sec.leader}；个股今日 ${pct(quote.changePct)} vs 板块 ${pct(sec.changePct)}`, d: 'flat' });
    }
    // 涨跌停距离
    if (ashare.limitUp != null && quote.price != null) {
      const toUp = (ashare.limitUp / quote.price - 1) * 100;
      const toDown = (1 - ashare.limitDown / quote.price) * 100;
      if (toUp <= 3) { score -= 0.2; sig.push({ t: `距涨停价 ${f2(ashare.limitUp)} 仅 ${f2(toUp)}%，追高性价比低且临近涨停可能无法成交`, d: 'flat' }); }
      else if (toDown <= 3) { score -= 0.3; sig.push({ t: `距跌停价 ${f2(ashare.limitDown)} 仅 ${f2(toDown)}%，注意恐慌盘与流动性风险`, d: 'down' }); }
      else sig.push({ t: `今日涨停价 ${f2(ashare.limitUp)} / 跌停价 ${f2(ashare.limitDown)}，当前距涨停 ${f2(toUp)}%`, d: 'flat' });
    }
    dims.push({ key: 'ashare', label: 'A股特色', score: Math.max(-2, Math.min(2, score)), max: 2, signals: sig });
  }

  // 综合
  const weights = { trend: 1.3, momentum: 0.8, capital: 1.0, valuation: 0.9, fundamental: 1.2, news: 0.6, ashare: 0.9 };
  let total = 0, wsum = 0;
  for (const d of dims) {
    const w = weights[d.key] || 1;
    total += (d.score / d.max) * w;
    wsum += w;
  }
  const composite = (total / wsum) * 100; // -100 ~ +100

  let rating, bias;
  if (composite >= 40) { rating = '积极关注'; bias = 'long'; }
  else if (composite >= 15) { rating = '谨慎乐观'; bias = 'lean-long'; }
  else if (composite > -15) { rating = '中性观望'; bias = 'neutral'; }
  else if (composite > -40) { rating = '谨慎回避'; bias = 'lean-short'; }
  else { rating = '高风险回避'; bias = 'short'; }

  // 条件化操作框架
  const c = quote.price;
  const a = ind.atr14 || c * 0.03;
  const supports = [ind.swing.low20, ind.ma.ma20, ind.ma.ma60, ind.swing.low60].filter((v) => v != null && v < c * 1.005).sort((x, y) => y - x);
  const resistances = [ind.swing.high20, ind.swing.high60, ind.swing.high52w].filter((v) => v != null && v > c * 0.995).sort((x, y) => x - y);
  const s1 = supports[0] || c - 2 * a;
  const s2 = supports[1] || c - 3.5 * a;
  const r1 = resistances[0] || c + 2 * a;
  const conditions = [];
  if (bias === 'long' || bias === 'lean-long') {
    conditions.push(`若回调不破 ${f2(s1)}（近20日低点/均线支撑区）且缩量企稳，可作为低吸观察点`);
    conditions.push(`若放量突破 ${f2(r1)}（近期压力位），趋势确认可顺势加仓，突破需成交量配合（量比>1.5）`);
    conditions.push(`若跌破 ${f2(s2)}（次级支撑，约 ${((1 - s2 / c) * 100).toFixed(1)}% 幅度），趋势判断失效，应减仓控制风险`);
  } else if (bias === 'neutral') {
    conditions.push(`当前信号多空交织，建议观望等待方向选择`);
    conditions.push(`若放量站稳 ${f2(r1)} 上方，可转为积极；若跌破 ${f2(s1)}，应回避`);
    conditions.push(`仓位建议控制在半仓以内，等待趋势明朗`);
  } else {
    conditions.push(`趋势与资金面偏弱，持有者若反弹至 ${f2(r1)} 压力位附近可考虑减仓`);
    conditions.push(`若跌破 ${f2(s1)}（关键支撑），下跌空间打开，应严格止损`);
    conditions.push(`未持有者暂不建议抄底，等待企稳信号（缩量止跌 + 主力资金回流）`);
  }
  // T+1 交易制度提醒（A股硬规则，移植自 TradingAgents-astock 的风控约束）
  const isA = market && market.startsWith('A股');
  if (isA) {
    conditions.push(`T+1 提醒：A股当日买入次日才能卖出，任何买入决策都需预留隔夜风险；尾盘异动信号建议次日开盘确认后再执行`);
  }

  // 多空辩论（移植自 TradingAgents-AShare 的 Bull/Bear 对撞机制：按证据强度加权，而非论据条数表决）
  const bullPts = [], bearPts = [];
  for (const d of dims) {
    for (const s of d.signals) {
      if (s.d === 'up') bullPts.push({ dim: d.label, text: s.t });
      else if (s.d === 'down') bearPts.push({ dim: d.label, text: s.t });
    }
  }
  const debate = {
    bull: bullPts.slice(0, 5),
    bear: bearPts.slice(0, 5),
    verdict: `裁判结论：综合评分 ${composite.toFixed(1)} →「${rating}」。多方论据 ${bullPts.length} 条 / 空方论据 ${bearPts.length} 条，评级按各维度证据强度加权得出，而非简单多数表决。` +
      (isA ? 'A股 T+1 制度下"宁可错过、不可做错"，方向不明时持币观望是合法选择。' : ''),
  };

  return { composite: +composite.toFixed(1), rating, bias, dimensions: dims, conditions, debate, stopRef: f2(s2), resistRef: f2(r1) };
}

/* ---------------- 交易时段判断 ---------------- */

function sessionState(market) {
  const now = new Date(Date.now() + 8 * 3600e3); // 北京时间
  const day = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const isWeekend = day === 0 || day === 6;
  if (market.startsWith('A股') || market === '港股') {
    if (isWeekend) return '休市（周末），数据为最近交易日收盘';
    if (mins < 555) return '盘前，数据为前一交易日收盘';
    if (mins <= 690 || (mins >= 780 && mins <= 900)) return '盘中（实时数据）';
    if (mins > 900) return '盘后，数据为今日收盘';
    return '午间休市';
  }
  // 美股：粗判夏令时
  const m = now.getUTCMonth() + 1;
  const dst = m > 3 && m < 11;
  const open = dst ? 21 * 60 + 30 : 22 * 60 + 30;
  const closeM = dst ? 4 * 60 : 5 * 60;
  if (mins >= open || mins < closeM) return '盘中（实时数据，美股时段）';
  return '盘后/盘前，数据为最近交易日收盘';
}

/* ---------------- 主流程 ---------------- */

const cache = new Map(); // code -> {t, data}

async function analyze(rawCode) {
  const cand = secidCandidates(rawCode);
  if (!cand) {
    const e = new Error('无法识别的代码格式。支持：A股6位数字（如 600519）、港股5位数字（如 00700）、美股字母代码（如 AAPL）');
    e.status = 400; throw e;
  }
  const cached = cache.get(cand.code);
  if (cached && Date.now() - cached.t < 60e3) return cached.data;

  const resolved = await resolveSecid(cand);
  if (!resolved) {
    const e = new Error(`未找到 ${cand.code} 对应的上市标的，请确认代码是否正确`);
    e.status = 404; throw e;
  }

  // 分两批拉取，降低对单一数据源的瞬时并发
  const [quote, klines, flows] = await Promise.all([
    getQuote(resolved),
    getKline(resolved),
    getCapitalFlow(resolved.secid),
  ]);
  const [finData, newsItems, announcements] = await Promise.all([
    getFinancials(resolved.code, resolved.market),
    getNews(resolved.code),
    getAnnouncements(resolved.code, resolved.market),
  ]);
  const financials = finData ? finData.list : null;
  // A股特色数据（行业→板块→龙虎榜→解禁→涨跌停，港美股返回 null）
  const ashare = await getAshareExtras(resolved, quote, finData && finData.industry);
  if (!klines.length) {
    const e = new Error('K线数据缺失，无法分析');
    e.status = 502; throw e;
  }

  const ind = computeIndicators(klines);
  const analysis = analyzeAll({ quote, klines, ind, flows, financials, newsItems, ashare, market: resolved.market });

  const srcLabel = quote.source === 'tencent'
    ? '腾讯财经行情接口（主源限流，已切换备用源；PE 为腾讯口径）+ 东方财富财报/新闻'
    : '东方财富公开行情/财报/资金流/新闻接口';

  const data = {
    meta: {
      input: rawCode, code: resolved.code, name: resolved.name,
      market: resolved.market, secid: resolved.secid,
      fetchedAt: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' (北京时间)',
      session: sessionState(resolved.market),
      dataSource: srcLabel,
    },
    quote,
    kline: klines.slice(-160),
    indicators: ind,
    flows,
    financials,
    news: newsItems,
    announcements,
    ashare,
    analysis: { ...analysis, disclaimer: DISCLAIMER },
  };
  cache.set(cand.code, { t: Date.now(), data });
  return data;
}

/* ---------------- 量化选股与回测 ---------------- */
/*
 * 流程：全A快照海选（流动性/估值过滤）→ 拉日K算因子 → 综合评分
 * 因子（全部可由日K+快照计算，无前视偏差）：
 *   动量 mom60/mom20、趋势（价>MA20>MA60）、低波动、量比温和度
 * 回测：N 日定期调仓、Top10 等权、双边各千一手续费，对照沪深300
 */
const QUANT_CACHE_DIR = path.join(__dirname, 'quant-cache');
const quantMem = { universe: null, backtest: null, top10: null };

/** 全A快照（东财 clist，沪深主板+科创+创业，按总市值降序分页）。
 *  内存 10 分钟 + 落盘 6 小时兜底（变化慢，防重启后重新撞限流） */
async function fetchUniverseSnapshot() {
  if (quantMem.universe && Date.now() - quantMem.universe.t < 10 * 60e3) return quantMem.universe.list;
  const cacheFile = path.join(QUANT_CACHE_DIR, '_universe.json');
  let list = null;
  try {
    const fs0 = encodeURIComponent('m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23');
    const fields = 'f12,f14,f2,f3,f8,f9,f23,f20,f62';
    const all = [];
    for (let pn = 1; pn <= 6; pn++) {
      const j = await fetchJson(
        `https://push2.eastmoney.com/api/qt/clist/get?fs=${fs0}&fltt=2&invt=2&fields=${fields}&fid=f20&po=1&pz=1000&pn=${pn}`,
        15000
      );
      const raw = j && j.data && j.data.diff;
      const arr = Array.isArray(raw) ? raw : raw ? Object.values(raw) : null; // clist 的 diff 可能是对象而非数组
      if (!arr || !arr.length) break;
      all.push(...arr);
      if (!j.data.total || all.length >= j.data.total) break; // 东财会截断单页条数，按 total 判断翻页而非本页条数
    }
    const num = (v) => (v === '-' || v == null ? null : Number(v));
    list = all.map((d) => ({
      code: d.f12, name: d.f14, price: num(d.f2), chgPct: num(d.f3),
      turnover: num(d.f8), pe: num(d.f9), pb: num(d.f23),
      mcap: num(d.f20), mainInflow: num(d.f62),
    })).filter((s) => s.code && s.price != null);
    if (!list.length) list = null;
  } catch (e) {
    console.error('[quant] 全A快照拉取失败，尝试磁盘缓存:', e.message);
  }
  if (!list) {
    try {
      const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Date.now() - j.t < 6 * 3600e3 && j.list && j.list.length) list = j.list;
    } catch (_) { /* 无磁盘缓存 */ }
  }
  if (!list) {
    // 终极兜底：数据源全被限流时，从 K 线磁盘缓存合成股票池（仅代码，因子全靠 K 线，不影响回测/选股打分）
    try {
      const files = fs.readdirSync(QUANT_CACHE_DIR).filter((f) => /^\d{6}\.json$/.test(f));
      if (files.length) {
        list = files.map((f) => {
          const code = f.replace('.json', '');
          return { code, name: code, price: 10, chgPct: null, turnover: null, pe: null, pb: null, mcap: 1e12, mainInflow: null, synth: true };
        });
        console.log(`[quant] 数据源限流，使用本地缓存合成股票池 ${list.length} 只`);
      }
    } catch (_) { /* 无缓存目录 */ }
  } else {
    try { fs.mkdirSync(QUANT_CACHE_DIR, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ t: Date.now(), list })); } catch (_) {}
  }
  if (!list) throw new Error('全A股票列表拉取失败且无可用缓存');
  quantMem.universe = { t: Date.now(), list };
  return list;
}

/** 海选过滤：剔除 ST/退市/次新不足、低价、微盘、亏损或估值异常 */
function prefilter(list, { minMcap = 30e8, topN = 300 } = {}) {
  return list
    .filter((s) =>
      !/ST|退/.test(s.name) &&
      s.price >= 2 && s.mcap != null && s.mcap >= minMcap &&
      (s.pe == null || (s.pe > 0 && s.pe < 200)))
    .slice(0, topN)
    .map((s) => {
      const c = s.code[0];
      const secid = (c === '6' || c === '9') ? `1.${s.code}` : `0.${s.code}`;
      return { ...s, secid };
    });
}

/** 带落盘缓存的日K（供回测/选股批量调用），当日缓存当日有效；fromCache 标记供调用方做限流熔断 */
async function getKlineCached(secid, code, count = 260) {
  try { fs.mkdirSync(QUANT_CACHE_DIR, { recursive: true }); } catch (_) {}
  const file = path.join(QUANT_CACHE_DIR, `${code}.json`);
  const today = new Date().toISOString().slice(0, 10);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.date === today && j.klines && j.klines.length >= count - 10) {
      j.klines.fromCache = true;
      return j.klines;
    }
  } catch (_) { /* 无缓存 */ }
  const klines = await getKline({ secid, code, market: 'A股', txSymbol: null }, count);
  if (klines && klines.length >= 60) {
    try { fs.writeFileSync(file, JSON.stringify({ date: today, klines })); } catch (_) {}
  }
  return klines || [];
}

/** 因子计算：输入日K数组，输出各因子与分项（截至末根K线） */
function computeFactors(k) {
  if (!k || k.length < 120) return null;
  const n = k.length;
  const closes = k.map((x) => x.close);
  const ret = (d) => (n > d ? closes[n - 1] / closes[n - 1 - d] - 1 : null);
  const mom20 = ret(20), mom60 = ret(60);
  if (mom20 == null || mom60 == null) return null;
  const ma = (d) => closes.slice(n - d).reduce((a, b) => a + b, 0) / d;
  const ma20 = ma(20), ma60 = ma(60);
  const trend = (closes[n - 1] > ma20 ? 0.5 : 0) + (ma20 > ma60 ? 0.5 : 0);
  // 20 日年化波动率
  const rets = [];
  for (let i = n - 20; i < n; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol20 = Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / rets.length) * Math.sqrt(244);
  // 量比温和度：5 日均量 / 60 日均量，0.8~2.5 给满分，过冷过热衰减
  const v5 = k.slice(n - 5).reduce((a, x) => a + x.volume, 0) / 5;
  const v60 = k.slice(n - 60).reduce((a, x) => a + x.volume, 0) / 60;
  const vr = v60 > 0 ? v5 / v60 : 1;
  const volRatioScore = vr >= 0.8 && vr <= 2.5 ? 1 : vr < 0.8 ? Math.max(0, vr / 0.8) : Math.max(0, 1 - (vr - 2.5) / 2.5);
  return { mom20, mom60, trend, vol20, volRatio: vr, volRatioScore };
}

/** 截面打分：rank 归一到 0~100（升序排序后越靠后 _r 越大 = 因子值越强分越高），再加权 */
function scoreCrossSection(items) {
  const rank = (arr, key) => {
    const sorted = [...arr].sort((a, b) => a.f[key] - b.f[key]);
    sorted.forEach((it, i) => { it._r = it._r || {}; it._r[key] = sorted.length > 1 ? (i / (sorted.length - 1)) * 100 : 50; });
  };
  rank(items, 'mom60');
  rank(items, 'mom20');
  rank(items, 'vol20');
  for (const it of items) {
    const mom60s = it._r.mom60, mom20s = it._r.mom20, vols = 100 - it._r.vol20; // 波动越小分越高
    it.score = +(0.30 * mom60s + 0.25 * mom20s + 0.20 * (it.f.trend * 100) + 0.15 * vols + 0.10 * (it.f.volRatioScore * 100)).toFixed(1);
  }
  items.sort((a, b) => b.score - a.score);
  return items;
}

/** 批量拉因子（串行节流，带进度日志；连续 8 只失败判定数据源限流，熔断跳过剩余网络请求） */
async function buildFactorTable(universe) {
  const out = [];
  let failStreak = 0;
  for (let i = 0; i < universe.length; i++) {
    const s = universe[i];
    if ((i + 1) % 25 === 0) console.log(`[quant] kline ${i + 1}/${universe.length}`);
    if (failStreak >= 8) { console.log('[quant] 限流熔断，跳过剩余网络拉取'); break; }
    try {
      const k = await getKlineCached(s.secid, s.code, 260);
      const f = computeFactors(k);
      if (f) { out.push({ ...s, f }); failStreak = 0; }
      else failStreak = k.fromCache ? 0 : failStreak + 1;
    } catch (e) { failStreak++; console.error('[quant]', s.code, e.message); }
  }
  return scoreCrossSection(out);
}

/** 每日 Top10：海选 → 因子打分 → 头部名单 */
async function runTop10(topN = 300) {
  if (quantMem.top10 && Date.now() - quantMem.top10.t < 10 * 60e3) return quantMem.top10.data;
  const snap = await fetchUniverseSnapshot();
  const universe = prefilter(snap, { topN });
  const table = await buildFactorTable(universe);
  const top = table.slice(0, 10).map((s, i) => ({
    rank: i + 1, code: s.code, name: s.name, score: s.score,
    price: s.price, chgPct: s.chgPct, pe: s.pe, pb: s.pb,
    mcapYi: s.mcap != null ? +(s.mcap / 1e8).toFixed(1) : null,
    turnover: s.turnover, mainInflowWan: s.mainInflow != null ? +(s.mainInflow / 1e4).toFixed(0) : null,
    mom20Pct: +(s.f.mom20 * 100).toFixed(1), mom60Pct: +(s.f.mom60 * 100).toFixed(1),
    vol20Pct: +(s.f.vol20 * 100).toFixed(1),
    planWeightPct: 10, // 等权
  }));
  const data = {
    top,
    universeSize: universe.length,
    scored: table.length,
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    note: '因子：60/20日动量+趋势+低波动+量比温和度，等权10%/只。仅为量化规则输出，不构成投资建议。',
  };
  quantMem.top10 = { t: Date.now(), data };
  return data;
}

/** Top10 CSV（带 BOM，Excel 直接打开不乱码） */
function top10Csv(data) {
  const head = '排名,代码,名称,综合评分,最新价,今日涨跌%,PE,PB,总市值(亿),换手%,主力净流入(万),20日动量%,60日动量%,年化波动%,建议仓位%';
  const rows = data.top.map((r) => [r.rank, r.code, r.name, r.score, r.price, r.chgPct, r.pe, r.pb, r.mcapYi, r.turnover, r.mainInflowWan, r.mom20Pct, r.mom60Pct, r.vol20Pct, r.planWeightPct].join(','));
  const foot = `\n生成时间,${data.generatedAt},股票池,${data.universeSize}只,,,,,,,,,,\n说明,"${data.note}",,,,,,,,,,,,`;
  return '﻿' + head + '\n' + rows.join('\n') + foot + '\n';
}

/** 回测：rebalance 个交易日调仓一次，Top10 等权，双边各 fee 手续费 */
async function runBacktest({ universeSize = 300, days = 250, rebalance = 5, fee = 0.001 } = {}) {
  const cacheKey = `${universeSize}-${days}-${rebalance}-${fee}`;
  if (quantMem.backtest && quantMem.backtest.key === cacheKey && Date.now() - quantMem.backtest.t < 30 * 60e3) {
    return quantMem.backtest.data;
  }
  const snap = await fetchUniverseSnapshot();
  const universe = prefilter(snap, { topN: universeSize });
  // 基准：沪深300（缓存固定 260 根，与选股共用，避免缓存不一致重拉）
  const bench = await getKlineCached('1.000300', '000300', 260);
  if (bench.length < days / 2) throw new Error('基准沪深300 K线拉取失败');
  // 每只股票 K线（复用选股缓存；同样带限流熔断）
  const kmap = new Map();
  let failStreak = 0;
  for (let i = 0; i < universe.length; i++) {
    const s = universe[i];
    if ((i + 1) % 25 === 0) console.log(`[backtest] kline ${i + 1}/${universe.length}`);
    if (failStreak >= 8) { console.log('[backtest] 限流熔断，仅使用已缓存数据'); break; }
    try {
      const k = await getKlineCached(s.secid, s.code, 260);
      if (k.length >= 120) { kmap.set(s.code, k); failStreak = 0; }
      else failStreak = k.fromCache ? 0 : failStreak + 1;
    } catch (_) { failStreak++; }
  }
  // 对齐日期轴（用基准的交易日）
  const bDates = bench.map((x) => x.date);
  const bClose = new Map(bench.map((x) => [x.date, x.close]));
  const endIdx = bDates.length - 1;
  const startIdx = Math.max(120, endIdx - days + 1);
  // 每股 date->close 索引
  const idxMaps = new Map();
  for (const [code, k] of kmap) idxMaps.set(code, new Map(k.map((x) => [x.date, x.close])));
  const closesOf = (code) => kmap.get(code);
  // 逐调仓点模拟
  const curve = [], benchCurve = [];
  let equity = 1;
  const periodRets = [], benchPeriodRets = [];
  for (let t = startIdx; t <= endIdx; t += rebalance) {
    const t2 = Math.min(t + rebalance, endIdx);
    const d0 = bDates[t], d1 = bDates[t2];
    // 选股：用 t 日之前数据打分
    const items = [];
    for (const s of universe) {
      const k = closesOf(s.code);
      if (!k) continue;
      const pos = k.findIndex((x) => x.date >= d0);
      if (pos < 120) continue; // 历史不足
      const f = computeFactors(k.slice(0, pos + 1));
      if (f) items.push({ code: s.code, f });
    }
    if (!items.length) continue;
    scoreCrossSection(items);
    const picks = items.slice(0, 10);
    // 区间收益
    const rets = [];
    for (const p of picks) {
      const m = idxMaps.get(p.code);
      const c0 = m.get(d0), c1 = m.get(d1);
      if (c0 && c1) rets.push(c1 / c0 - 1);
    }
    if (!rets.length) continue;
    const portRet = rets.reduce((a, b) => a + b, 0) / rets.length - fee * 2; // 全额换仓近似
    const bRet = bClose.get(d1) / bClose.get(d0) - 1;
    equity *= 1 + portRet;
    periodRets.push(portRet);
    benchPeriodRets.push(bRet);
    curve.push({ date: d1, equity: +equity.toFixed(4) });
    benchCurve.push({ date: d1, equity: +(benchCurve.length ? benchCurve[benchCurve.length - 1].equity * (1 + bRet) : 1 + bRet).toFixed(4) });
  }
  // 统计
  const n = periodRets.length;
  const stats = (rets, totalRet) => {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length);
    const periodsPerYear = 244 / rebalance;
    const ann = Math.pow(1 + totalRet, periodsPerYear / n) - 1;
    // 最大回撤
    let peak = -Infinity, mdd = 0, run = 1;
    for (const r of rets) { run *= 1 + r; peak = Math.max(peak, run); mdd = Math.min(mdd, run / peak - 1); }
    const sharpe = sd > 0 ? (mean * periodsPerYear) / (sd * Math.sqrt(periodsPerYear)) : null;
    return { ann: +(ann * 100).toFixed(2), maxDD: +(mdd * 100).toFixed(2), sharpe: sharpe != null ? +sharpe.toFixed(2) : null };
  };
  const totalRet = equity - 1;
  const bTotal = benchCurve.length ? benchCurve[benchCurve.length - 1].equity - 1 : 0;
  const winRate = n ? +(periodRets.filter((r, i) => r > benchPeriodRets[i]).length / n * 100).toFixed(1) : null;
  const data = {
    params: { universeSize, days, rebalanceDays: rebalance, feePerSide: fee },
    strategy: { totalReturnPct: +(totalRet * 100).toFixed(2), ...stats(periodRets, totalRet) },
    benchmark: { name: '沪深300', totalReturnPct: +(bTotal * 100).toFixed(2), ...stats(benchPeriodRets, bTotal) },
    excessPct: +((totalRet - bTotal) * 100).toFixed(2),
    winRatePct: winRate, rebalances: n,
    curve, benchCurve,
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    note: '简化假设：调仓日收盘价成交、Top10等权、每次调仓近似全额换手（双边各千一）、未计冲击成本与涨跌停无法成交情形。历史回测不代表未来收益。',
  };
  quantMem.backtest = { key: cacheKey, t: Date.now(), data };
  return data;
}

/* ---------------- HTTP 服务 ---------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

/* ---- 访问令牌：所有 /api/* 须携带 x-access-token，前端验证后存 localStorage ---- */
const ACCESS_TOKEN = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'llm.config.json'), 'utf8'));
    return cfg.accessToken || null;
  } catch (_) { return null; }
})();

function checkAuth(req, res) {
  if (!ACCESS_TOKEN) return true; // 未配置令牌则开放
  if (req.headers['x-access-token'] === ACCESS_TOKEN) return true;
  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: '需要访问令牌', needAuth: true }));
  return false;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (u.pathname === '/api/auth') {
      // 令牌验证端点：前端首次输入密码时调用
      const ok = !ACCESS_TOKEN || req.headers['x-access-token'] === ACCESS_TOKEN;
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok }));
    }
    if (u.pathname.startsWith('/api/') && !checkAuth(req, res)) return;
    if (u.pathname === '/api/portfolio') {
      try {
        const data = await getPortfolio();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '读取持仓数据失败：' + e.message }));
      }
    }
    if (u.pathname === '/api/quant/top10') {
      try {
        const data = await runTop10(300);
        if ((u.searchParams.get('format') || '') === 'csv') {
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="top10-${new Date().toISOString().slice(0, 10)}.csv"`,
          });
          return res.end(top10Csv(data));
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '选股计算失败：' + e.message }));
      }
    }
    if (u.pathname === '/api/quant/backtest') {
      try {
        const p = (k, d, min, max) => Math.min(max, Math.max(min, +(u.searchParams.get(k) || d)));
        const data = await runBacktest({
          universeSize: p('universe', 300, 50, 800),
          days: p('days', 250, 60, 480),
          rebalance: p('rebalance', 5, 5, 20),
          fee: 0.001,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '回测计算失败：' + e.message }));
      }
    }
    if (u.pathname === '/api/search') {
      const q = u.searchParams.get('q') || '';
      if (!q.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '请提供搜索关键词' }));
      }
      const results = await searchStocks(q);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ results }));
    }
    if (u.pathname === '/api/analyze') {
      const code = u.searchParams.get('code') || '';
      if (!code.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '请提供股票代码' }));
      }
      const data = await analyze(code);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data));
    }
    if (u.pathname === '/api/ai-report') {
      const code = u.searchParams.get('code') || '';
      if (!code.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '请提供股票代码' }));
      }
      const data = await analyze(code); // 复用规则引擎结果与缓存
      const report = await runAiReport(data);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(report));
    }
    // 静态文件
    let fp = path.join(PUBLIC_DIR, u.pathname === '/' ? 'index.html' : u.pathname);
    if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  } catch (err) {
    const status = err.status || (err.name === 'AbortError' ? 504 : 500);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message || '服务内部错误' }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`股票智研服务已启动: http://127.0.0.1:${PORT}`);
});
