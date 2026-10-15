/**
 * 双模型 AI 深度研报管线
 * 架构：规则引擎负责"算数"（数据真实），LLM 负责"解读"（语言与推理）
 *   第 1 棒 Kimi k2.6     —— 通读全部新闻与公告，逐条判断利好/利空与影响（长文本强项）
 *   第 2 棒 DeepSeek V4-Pro —— 拿到数据包 + 规则引擎结论 + Kimi 消息面解读，做首席分析师级综合推理
 * 两个模型都被明确要求：只解读给定数据，不得编造数据中没有的数字与事件。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG_PATH = path.join(__dirname, 'llm.config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** OpenAI 兼容的 chat/completions 调用（经典 https 模块，长超时适配推理模型） */
function chatCompletion({ baseUrl, apiKey, model, messages, maxTokens = 16000, timeoutMs = 240000 }) {
  const body = JSON.stringify({ model, messages, max_tokens: maxTokens });
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error(`${model} HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        }
        try {
          const j = JSON.parse(text);
          const msg = j.choices && j.choices[0] && j.choices[0].message;
          if (!msg || !msg.content) return reject(new Error(`${model} 返回为空（可能被推理耗尽 token）`));
          resolve({ content: msg.content, usage: j.usage });
        } catch (e) {
          reject(new Error(`${model} 响应解析失败`));
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`${model} 请求超时`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 防御式 JSON 解析：剥 markdown 围栏、截取首个完整 JSON 对象 */
function parseJsonLoose(text) {
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON');
  return JSON.parse(t.slice(start, end + 1));
}

const num = (v, d = 2) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(d));
const yi = (v) => (v == null ? '—' : (v / 1e8).toFixed(2) + '亿');

/** 把规则引擎的全部产出压缩成一份文本数据包，喂给模型 */
function buildDataPack(data) {
  const { meta, quote, indicators: ind, flows, financials, news, announcements, ashare, analysis } = data;
  const L = [];
  L.push(`【标的】${meta.name}（${meta.code}，${meta.market}）｜数据时间：${meta.fetchedAt}｜${meta.session}`);
  L.push(`【行情】现价 ${num(quote.price)}｜涨跌幅 ${num(quote.changePct)}%｜今开 ${num(quote.open)}｜最高 ${num(quote.high)}｜最低 ${num(quote.low)}｜昨收 ${num(quote.prevClose)}`);
  L.push(`【估值】PE ${num(quote.peTtm)}（${quote.source === 'tencent' ? '腾讯口径' : 'TTM'}）｜PB ${num(quote.pb)}｜总市值 ${yi(quote.totalMcap)}｜流通市值 ${yi(quote.floatMcap)}｜换手率 ${num(quote.turnoverRate)}%`);
  if (ind) {
    const ma = ind.ma || {};
    L.push(`【技术指标】MA5 ${num(ma.ma5)} / MA20 ${num(ma.ma20)} / MA60 ${num(ma.ma60)}｜RSI14 ${num(ind.rsi14, 1)}｜MACD DIF ${num(ind.macd && ind.macd.dif)} DEA ${num(ind.macd && ind.macd.dea)} 柱 ${num(ind.macd && ind.macd.hist)}｜布林 上${num(ind.boll && ind.boll.upper)}/中${num(ind.boll && ind.boll.mid)}/下${num(ind.boll && ind.boll.lower)}｜量比 ${num(ind.volRatio)}｜ATR14 ${num(ind.atr14)}`);
  }
  if (flows) {
    L.push(`【资金流】当日主力净额 ${yi(flows.latest && flows.latest.main)}｜近5日累计 ${yi(flows.sum5)}｜近10日累计 ${yi(flows.sum10)}`);
  }
  if (financials && financials.length) {
    L.push('【财报（近几期）】');
    financials.slice(0, 4).forEach((f) => {
      L.push(`  ${f.period}：营收 ${yi(f.revenue)}（同比 ${num(f.revYoY, 1)}%）｜净利 ${yi(f.netProfit)}（同比 ${num(f.npYoY, 1)}%）｜毛利率 ${num(f.grossMargin, 1)}%｜净利率 ${num(f.netMargin, 1)}%｜ROE ${num(f.roe, 1)}%`);
    });
  }
  if (ashare) {
    const a = ashare;
    const sec = a.sector || {};
    L.push(`【A股特色】行业：${a.industry || '—'}｜板块轮动：${sec.rank ? `${sec.name} 全行业涨幅第${sec.rank}/${sec.total}，板块涨${num(sec.changePct)}%，主力净流入 ${yi(sec.mainNetInflow)}，领涨股 ${sec.leader || '—'}` : '—'}`);
    L.push(`  涨跌停价：${num(a.limitUp)} / ${num(a.limitDown)}｜龙虎榜：${a.billboard ? `近120天上榜${a.billboard.count}次，席位净买入 ${yi(a.billboard.netSum)}` : '近120天未上榜'}｜解禁：${a.unlocks && a.unlocks.length ? a.unlocks.map((u) => `${u.date} ${u.type} ${yi(u.mcap)}(占流通${num(u.ratio, 1)}%)`).join('；') : '未来一年无解禁'}`);
  }
  if (news && news.length) {
    L.push('【近期要闻】');
    news.slice(0, 10).forEach((n, i) => L.push(`  ${i + 1}. [${n.time || ''}] ${n.title}`));
  }
  if (announcements && announcements.length) {
    L.push('【公司公告】');
    announcements.slice(0, 8).forEach((n, i) => L.push(`  ${i + 1}. [${n.time || ''}] ${n.title}`));
  }
  L.push(`【规则引擎结论】综合评分 ${analysis.composite}（-100~+100）→ ${analysis.rating}`);
  analysis.dimensions.forEach((d) => {
    L.push(`  ${d.label}（${d.score.toFixed(1)}/${d.max}）：${d.signals.map((s) => s.t).join('；') || '无显著信号'}`);
  });
  L.push(`【规则引擎操作参考】${analysis.conditions.join('；')}`);
  return L.join('\n');
}

const NO_FABRICATION = '铁律：只能解读我提供的数据，严禁编造数据中没有的数字、事件、研报观点或日期。引用数字必须来自数据包原文。';

/** 第 1 棒：Kimi 通读新闻公告 */
async function kimiNewsReading(cfg, dataPack, meta) {
  const messages = [
    { role: 'system', content: `你是 A 股资深消息面分析师，擅长读懂中文财经新闻、公告和政策语境（如"新质生产力""两重两新"等小作文语境）。${NO_FABRICATION} 输出必须是合法 JSON。` },
    { role: 'user', content: `以下是 ${meta.name}（${meta.code}）的完整数据包：\n\n${dataPack}\n\n请通读其中【近期要闻】和【公司公告】（结合全文其他数据理解背景），输出 JSON：\n{\n  "news_items": [{"title": "原文标题", "sentiment": "利好|利空|中性", "impact": "一句话说清对公司/股价的影响机制", "horizon": "短期|中期|长期"}],\n  "news_summary": "消息面整体总结（100字内，说清主线矛盾）",\n  "policy_industry": "相关政策与产业环境解读（80字内，无相关内容则写'近期无重大政策变量'）"\n}\n注意：news_items 只覆盖数据包中真实出现的条目，最多 8 条。` },
  ];
  const r = await chatCompletion({ ...cfg.kimi, messages, maxTokens: 12000 });
  return parseJsonLoose(r.content);
}

/** 第 2 棒：DeepSeek V4-Pro 首席分析师综合研报（与 Kimi 并行，数据包已含原始新闻） */
async function deepseekReport(cfg, dataPack, meta) {
  const messages = [
    { role: 'system', content: `你是管理百亿规模公募基金的首席分析师，同时精通基本面估值、技术面择时与 A 股资金面博弈（游资/龙虎榜/板块轮动/T+1 规则）。${NO_FABRICATION} 输出必须是合法 JSON，所有文字用中文。` },
    { role: 'user', content: `以下是 ${meta.name}（${meta.code}，${meta.market}）的完整数据包（含近期要闻与公司公告原文标题）：\n\n${dataPack}\n\n请输出一份深度研报，JSON 格式：\n{\n  "stance": "积极|谨慎乐观|中性|谨慎|回避",\n  "core_logic": "核心投资逻辑（150字内：这只股票当下最关键的多空矛盾是什么）",\n  "fundamental_view": "基本面解读（120字内：营收/利润/ROE趋势与质量）",\n  "valuation_view": "估值判断（100字内：PE/PB 与业绩增速是否匹配）",\n  "technical_view": "技术面解读（100字内：趋势/均线/MACD/支撑压力）",\n  "capital_view": "资金面解读（100字内：主力资金/龙虎榜/板块轮动位置）",\n  "risks": ["风险1", "风险2", "风险3"],\n  "conclusion": "结论与操作参考（150字内：给出条件化的可执行框架，如'若回调不破X可低吸，若跌破Y应止损'，并提示 T+1/涨跌停等交易制度约束）"\n}\n要求：观点必须落在数据包的具体数字上；与规则引擎结论不一致时要说明理由。` },
  ];
  const r = await chatCompletion({ ...cfg.deepseek, messages, maxTokens: 10000 });
  return parseJsonLoose(r.content);
}

const reportCache = new Map(); // code -> {t, report}

/** 管线入口：Kimi → DeepSeek，任一棒失败则整体报错（前端降级提示） */
async function runAiReport(data) {
  const cfg = loadConfig();
  if (!cfg || !cfg.deepseek || !cfg.kimi) throw new Error('LLM 未配置');

  const hit = reportCache.get(data.meta.code);
  if (hit && Date.now() - hit.t < 30 * 60e3) return { ...hit.report, cached: true };

  const dataPack = buildDataPack(data);
  const t0 = Date.now();
  // 双模型并行：Kimi 读消息面，DeepSeek 独立出研报（两者视角互为印证）
  const [kimiOut, report] = await Promise.all([
    kimiNewsReading(cfg, dataPack, data.meta),
    deepseekReport(cfg, dataPack, data.meta),
  ]);

  const out = {
    generatedAt: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' (北京时间)',
    elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
    models: { news: `Kimi ${cfg.kimi.model}`, report: `DeepSeek ${cfg.deepseek.model}` },
    newsReading: kimiOut,
    report,
  };
  reportCache.set(data.meta.code, { t: Date.now(), report: out });
  return out;
}

module.exports = { runAiReport };
