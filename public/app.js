/* 股票智研前端渲染逻辑 */
(function () {
  'use strict';

  var UP = '#d93636';
  var DOWN = '#0e9f58';
  var FLAT = '#8a94a6';

  var $ = function (id) { return document.getElementById(id); };
  var codeInput = $('codeInput');
  var analyzeBtn = $('analyzeBtn');
  var charts = [];

  function fmt(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toFixed(digits === undefined ? 2 : digits);
  }
  function fmtPct(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var s = Number(v) >= 0 ? '+' : '';
    return s + Number(v).toFixed(2) + '%';
  }
  function fmtYi(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v / 1e8).toFixed(digits === undefined ? 2 : digits) + '亿';
  }
  function fmtWan(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    return (v / 1e4).toFixed(0) + '万';
  }
  function cls(v) {
    if (v === null || v === undefined || isNaN(v)) return '';
    return v > 0 ? 'up' : v < 0 ? 'down' : '';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 访问令牌 ---------- */
  var TOKEN_KEY = 'stocklens_token';

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

  function authHeaders() {
    return { 'x-access-token': getToken() };
  }

  function showGate() {
    $('gateOverlay').classList.remove('hidden');
    $('gateError').classList.add('hidden');
    $('gateInput').value = '';
    setTimeout(function () { $('gateInput').focus(); }, 50);
  }

  function hideGate() { $('gateOverlay').classList.add('hidden'); }

  async function submitGate() {
    var token = $('gateInput').value.trim();
    if (!token) { $('gateError').textContent = '请输入访问令牌'; $('gateError').classList.remove('hidden'); return; }
    try {
      var resp = await fetch('/api/auth', { headers: { 'x-access-token': token } });
      var d = await resp.json();
      if (d.ok) {
        localStorage.setItem(TOKEN_KEY, token);
        hideGate();
      } else {
        $('gateError').textContent = '令牌不正确，请重试';
        $('gateError').classList.remove('hidden');
      }
    } catch (_) {
      $('gateError').textContent = '网络异常，请稍后重试';
      $('gateError').classList.remove('hidden');
    }
  }

  // 启动时校验本地缓存的令牌，失效则重新弹门
  (async function initAuth() {
    if (!getToken()) { showGate(); return; }
    try {
      var resp = await fetch('/api/auth', { headers: authHeaders() });
      var d = await resp.json();
      if (!d.ok) { localStorage.removeItem(TOKEN_KEY); showGate(); }
    } catch (_) { /* 网络异常时先放行，由首个 API 调用兜底 */ }
  })();

  $('gateBtn').addEventListener('click', submitGate);
  $('gateInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitGate();
  });

  // 任意 API 返回 401 → 清缓存重新弹门
  function handleAuthFailure(resp) {
    if (resp && resp.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      showGate();
      return true;
    }
    return false;
  }

  function setLoading(on, text) {
    $('loading').classList.toggle('hidden', !on);
    if (text) $('loadingText').textContent = text;
    analyzeBtn.disabled = on;
    analyzeBtn.textContent = on ? '分析中…' : '开始分析';
  }

  function showError(msg) {
    var box = $('errorBox');
    box.textContent = msg;
    box.classList.remove('hidden');
    $('result').classList.add('hidden');
  }

  function disposeCharts() {
    charts.forEach(function (c) { c.dispose(); });
    charts = [];
  }

  /* ---------- 渲染 ---------- */

  function renderHead(d) {
    var q = d.quote;
    $('sName').textContent = d.meta.name;
    $('sMarket').textContent = d.meta.market;
    $('sCode').textContent = d.meta.code;
    $('sSession').textContent = d.meta.session;
    var priceEl = $('sPrice');
    priceEl.textContent = fmt(q.price);
    priceEl.className = 'price ' + cls(q.changePct);
    var chEl = $('sChange');
    chEl.textContent = (q.change >= 0 ? '+' : '') + fmt(q.change) + '  ' + fmtPct(q.changePct);
    chEl.className = 'change ' + cls(q.changePct);
    $('sOhlc').textContent =
      '今开 ' + fmt(q.open) + ' · 最高 ' + fmt(q.high) + ' · 最低 ' + fmt(q.low) +
      ' · 昨收 ' + fmt(q.prevClose);
    $('sSource').textContent =
      '数据来源：' + d.meta.dataSource + ' · 拉取时间 ' + d.meta.fetchedAt;
  }

  function renderMetrics(d) {
    var q = d.quote;
    var ind = d.indicators;
    var peLabel = q.source === 'tencent' ? 'PE（腾讯口径）' : 'PE (TTM)';
    var items = [
      { label: '总市值', value: fmtYi(q.totalMcap), sub: '流通 ' + fmtYi(q.floatMcap) },
      { label: peLabel, value: q.peTtm != null ? fmt(q.peTtm) : '—', sub: q.source === 'tencent' ? '备用源口径' : '滚动市盈率' },
      { label: 'PB', value: q.pb != null ? fmt(q.pb) : '—', sub: '市净率' },
      { label: '换手率', value: q.turnoverRate != null ? fmt(q.turnoverRate) + '%' : '—', sub: '成交额 ' + fmtYi(q.amount) },
      { label: '20日涨跌', value: fmtPct(ind.ret20), sub: '60日 ' + fmtPct(ind.ret60), cls: cls(ind.ret20) },
      { label: '52周区间', value: fmt(ind.swing.low52w) + ' ~ ' + fmt(ind.swing.high52w), sub: '当前位置 ' + posOf(q.price, ind.swing) },
    ];
    $('metricsGrid').innerHTML = items.map(function (m) {
      return '<div class="metric"><div class="m-label">' + esc(m.label) + '</div>' +
        '<div class="m-value ' + (m.cls || '') + '">' + esc(m.value) + '</div>' +
        '<div class="m-sub">' + esc(m.sub) + '</div></div>';
    }).join('');
  }

  function posOf(price, swing) {
    if (!swing.high52w || !swing.low52w || swing.high52w === swing.low52w) return '—';
    return (((price - swing.low52w) / (swing.high52w - swing.low52w)) * 100).toFixed(0) + '% 分位';
  }

  function renderAnalysis(d) {
    var a = d.analysis;
    var rt = $('ratingText');
    rt.textContent = a.rating;
    rt.style.color = a.composite >= 15 ? UP : a.composite <= -15 ? DOWN : FLAT;
    $('ratingScore').textContent = '综合得分 ' + a.composite + '（区间 -100 ~ +100）';

    // 仪表盘
    var gauge = echarts.init($('gauge'));
    gauge.setOption({
      series: [{
        type: 'gauge',
        startAngle: 200, endAngle: -20,
        min: -100, max: 100,
        radius: '95%',
        center: ['50%', '62%'],
        axisLine: {
          lineStyle: {
            width: 14,
            color: [[0.35, DOWN], [0.65, '#c3cad6'], [1, UP]]
          }
        },
        pointer: { width: 4, length: '58%', itemStyle: { color: '#1a2332' } },
        axisTick: { distance: -14, length: 4, lineStyle: { color: '#fff', width: 1 } },
        splitLine: { distance: -14, length: 14, lineStyle: { color: '#fff', width: 2 } },
        axisLabel: { distance: 4, fontSize: 10, color: '#8a94a6', formatter: function (v) { return v; } },
        detail: {
          valueAnimation: true,
          fontSize: 22, fontWeight: 700, offsetCenter: [0, '40%'],
          color: a.composite >= 15 ? UP : a.composite <= -15 ? DOWN : FLAT,
          formatter: function (v) { return v.toFixed(0); }
        },
        data: [{ value: a.composite }]
      }]
    });
    charts.push(gauge);

    // 维度条
    $('dimBars').innerHTML = a.dimensions.map(function (dim) {
      var pct = ((dim.score / dim.max) * 50 + 50).toFixed(1);
      return '<div class="dim-bar-row"><span class="dim-name">' + esc(dim.label) + '</span>' +
        '<div class="dim-track"><div class="dim-marker" style="left:' + pct + '%"></div></div>' +
        '<span class="dim-val">' + dim.score.toFixed(1) + '</span></div>';
    }).join('');

    // 信号分组
    $('signalsWrap').innerHTML = a.dimensions.map(function (dim) {
      var items = dim.signals.map(function (s) {
        var dot = s.d === 'up' ? 'dot-up' : s.d === 'down' ? 'dot-down' : 'dot-flat';
        return '<div class="signal-item"><span class="signal-dot ' + dot + '"></span><span>' + esc(s.t) + '</span></div>';
      }).join('');
      return '<div class="signal-group"><h5>' + esc(dim.label) + '（' + dim.score.toFixed(1) + ' / ' + dim.max + '）</h5>' +
        (items || '<div class="signal-item"><span class="signal-dot dot-flat"></span><span>无显著信号</span></div>') + '</div>';
    }).join('');

    // 多空辩论
    var deb = a.debate || { bull: [], bear: [], verdict: '' };
    var renderSide = function (arr) {
      if (!arr.length) return '<li><span class="d-empty">该方暂无有效论据</span></li>';
      return arr.map(function (p) {
        return '<li><span class="d-dim">' + esc(p.dim) + '</span>' + esc(p.text) + '</li>';
      }).join('');
    };
    $('bullList').innerHTML = renderSide(deb.bull);
    $('bearList').innerHTML = renderSide(deb.bear);
    $('debateVerdict').textContent = deb.verdict || '';

    // 条件化操作
    $('conditionsList').innerHTML = a.conditions.map(function (c) {
      return '<li>' + esc(c) + '</li>';
    }).join('');

    $('disclaimerBox').textContent = a.disclaimer;
  }

  function renderKline(d) {
    var ks = d.kline;
    var dates = ks.map(function (k) { return k.date; });
    var ohlc = ks.map(function (k) { return [k.open, k.close, k.low, k.high]; });
    var vols = ks.map(function (k, i) {
      var upDay = k.close >= k.open;
      return { value: k.volume, itemStyle: { color: upDay ? UP : DOWN } };
    });

    function ma(n) {
      var out = [];
      for (var i = 0; i < ks.length; i++) {
        if (i < n - 1) { out.push('-'); continue; }
        var s = 0;
        for (var j = i - n + 1; j <= i; j++) s += ks[j].close;
        out.push(+(s / n).toFixed(2));
      }
      return out;
    }

    // MACD
    function ema(vals, n) {
      var k = 2 / (n + 1), out = [], prev = vals[0];
      for (var i = 0; i < vals.length; i++) {
        prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k);
        out.push(prev);
      }
      return out;
    }
    var closes = ks.map(function (k) { return k.close; });
    var e12 = ema(closes, 12), e26 = ema(closes, 26);
    var dif = closes.map(function (_, i) { return e12[i] - e26[i]; });
    var dea = ema(dif, 9);
    var hist = dif.map(function (v, i) {
      var h = 2 * (v - dea[i]);
      return { value: +h.toFixed(3), itemStyle: { color: h >= 0 ? UP : DOWN } };
    });

    var chart = echarts.init($('klineChart'));
    chart.setOption({
      animation: false,
      legend: { data: ['MA5', 'MA20', 'MA60'], top: 0, textStyle: { fontSize: 11 } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' }, textStyle: { fontSize: 12 } },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: [
        { left: 56, right: 16, top: 28, height: '52%' },
        { left: 56, right: 16, top: '64%', height: '13%' },
        { left: 56, right: 16, top: '82%', height: '14%' }
      ],
      xAxis: [
        { type: 'category', data: dates, gridIndex: 0, axisLabel: { show: false }, axisTick: { show: false } },
        { type: 'category', data: dates, gridIndex: 1, axisLabel: { show: false }, axisTick: { show: false } },
        { type: 'category', data: dates, gridIndex: 2, axisLabel: { fontSize: 10, color: '#8a94a6' }, axisTick: { show: false } }
      ],
      yAxis: [
        { scale: true, gridIndex: 0, splitLine: { lineStyle: { color: '#f0f2f7' } }, axisLabel: { fontSize: 10, color: '#8a94a6' } },
        { scale: true, gridIndex: 1, splitLine: { show: false }, axisLabel: { show: false } },
        { scale: true, gridIndex: 2, splitLine: { show: false }, axisLabel: { fontSize: 10, color: '#8a94a6' } }
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1, 2], start: 55, end: 100 },
        { type: 'slider', xAxisIndex: [0, 1, 2], bottom: 2, height: 14, start: 55, end: 100 }
      ],
      series: [
        {
          name: 'K线', type: 'candlestick', data: ohlc, xAxisIndex: 0, yAxisIndex: 0,
          itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN }
        },
        { name: 'MA5', type: 'line', data: ma(5), xAxisIndex: 0, yAxisIndex: 0, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#f0a53a' } },
        { name: 'MA20', type: 'line', data: ma(20), xAxisIndex: 0, yAxisIndex: 0, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#2563eb' } },
        { name: 'MA60', type: 'line', data: ma(60), xAxisIndex: 0, yAxisIndex: 0, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#9333ea' } },
        { name: '成交量', type: 'bar', data: vols, xAxisIndex: 1, yAxisIndex: 1 },
        { name: 'DIF', type: 'line', data: dif.map(function (v) { return +v.toFixed(3); }), xAxisIndex: 2, yAxisIndex: 2, showSymbol: false, lineStyle: { width: 1, color: '#f0a53a' } },
        { name: 'DEA', type: 'line', data: dea.map(function (v) { return +v.toFixed(3); }), xAxisIndex: 2, yAxisIndex: 2, showSymbol: false, lineStyle: { width: 1, color: '#2563eb' } },
        { name: 'MACD', type: 'bar', data: hist, xAxisIndex: 2, yAxisIndex: 2 }
      ]
    });
    charts.push(chart);
  }

  function renderAshare(d) {
    var a = d.ashare;
    if (!a) { $('ashareCard').classList.add('hidden'); return; }
    $('ashareCard').classList.remove('hidden');
    var kv = function (k, v, vcls) {
      return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v ' + (vcls || '') + '">' + esc(v) + '</span></div>';
    };

    // 涨跌停
    if (a.limitUp != null && d.quote.price != null) {
      var toUp = (a.limitUp / d.quote.price - 1) * 100;
      var toDown = (1 - a.limitDown / d.quote.price) * 100;
      $('limitInfo').innerHTML =
        kv('涨停价', fmt(a.limitUp) + '（距 ' + fmt(toUp) + '%）') +
        kv('跌停价', fmt(a.limitDown) + '（距 ' + fmt(toDown) + '%）') +
        '<div class="row-meta" style="margin-top:6px">T+1 交易制度：当日买入次日方可卖出；主板±10%、科创/创业±20%、北交所±30%、ST±5%</div>';
    } else {
      $('limitInfo').innerHTML = '<div class="muted">涨跌停价数据暂不可用；T+1 制度下当日买入次日方可卖出</div>';
    }

    // 板块
    var sec = a.sector;
    if (sec && sec.rank != null) {
      $('sectorInfo').innerHTML =
        kv('所属板块', (a.industry || sec.name) + ' → ' + sec.name) +
        kv('板块今日', fmtPct(sec.changePct), cls(sec.changePct)) +
        kv('全行业排名', '第 ' + sec.rank + ' / ' + sec.total) +
        kv('板块涨跌家数', (sec.upCount != null ? sec.upCount : '—') + ' 涨 / ' + (sec.downCount != null ? sec.downCount : '—') + ' 跌') +
        kv('板块主力净流入', fmtYi(sec.mainNetInflow), cls(sec.mainNetInflow)) +
        (sec.leader ? kv('板块领涨股', sec.leader) : '');
    } else {
      $('sectorInfo').innerHTML = '<div class="muted">所属板块：' + esc(a.industry || '未获取') + '（板块排名数据暂不可用）</div>';
    }

    // 龙虎榜
    var bb = a.billboard;
    if (bb && bb.count > 0) {
      $('billboardInfo').innerHTML =
        kv('上榜次数', bb.count + ' 次') +
        kv('席位合计净买入', fmtYi(bb.netSum), cls(bb.netSum)) +
        bb.items.slice(0, 3).map(function (it) {
          return '<div class="row-item">' + esc(it.date) + ' <b class="' + cls(it.netAmt) + '">' + fmtYi(it.netAmt) + '</b>' +
            '<div class="row-meta">' + esc(it.reason || '') + '</div></div>';
        }).join('');
    } else if (bb) {
      $('billboardInfo').innerHTML = '<div class="muted">近120日未登上龙虎榜，当前非游资热钱主攻方向</div>';
    } else {
      $('billboardInfo').innerHTML = '<div class="muted">龙虎榜数据暂不可用</div>';
    }

    // 解禁
    var un = a.unlocks;
    if (un && un.length) {
      $('unlockInfo').innerHTML = un.map(function (u) {
        return '<div class="row-item"><b>' + esc(u.date) + '</b> ' + esc(u.type || '限售股解禁') +
          '<div class="row-meta">解禁市值约 ' + fmtYi(u.mcap) +
          (u.floatRatio != null ? ' · 占流通股约 ' + u.floatRatio + '%' : '') + '</div></div>';
      }).join('');
    } else if (un) {
      $('unlockInfo').innerHTML = '<div class="muted">无已披露的未来限售解禁计划，筹码供给稳定</div>';
    } else {
      $('unlockInfo').innerHTML = '<div class="muted">解禁数据暂不可用</div>';
    }
  }

  function renderFlow(d) {
    if (!d.flows || !d.flows.series || !d.flows.series.length) {
      $('flowCard').classList.add('hidden');
      return;
    }
    $('flowCard').classList.remove('hidden');
    var f = d.flows;
    $('flowSummary').innerHTML =
      '<span>最新一日主力净流入 <b class="' + cls(f.latest.main) + '">' + fmtWan(f.latest.main) + '</b></span>' +
      '<span>近5日 <b class="' + cls(f.sum5) + '">' + fmtYi(f.sum5) + '</b></span>' +
      '<span>近10日 <b class="' + cls(f.sum10) + '">' + fmtYi(f.sum10) + '</b></span>';
    var chart = echarts.init($('flowChart'));
    chart.setOption({
      animation: false,
      tooltip: {
        trigger: 'axis', textStyle: { fontSize: 12 },
        valueFormatter: function (v) { return fmtWan(v); }
      },
      grid: { left: 64, right: 16, top: 16, bottom: 24 },
      xAxis: { type: 'category', data: f.series.map(function (r) { return r.date.slice(5); }), axisLabel: { fontSize: 10, color: '#8a94a6' } },
      yAxis: {
        type: 'value', splitLine: { lineStyle: { color: '#f0f2f7' } },
        axisLabel: { fontSize: 10, color: '#8a94a6', formatter: function (v) { return fmtWan(v); } }
      },
      series: [
        {
          name: '主力净流入', type: 'bar',
          data: f.series.map(function (r) {
            return { value: r.main, itemStyle: { color: r.main >= 0 ? UP : DOWN } };
          }),
          barWidth: '55%'
        },
        {
          name: '超大单净流入', type: 'line', smooth: true, showSymbol: false,
          data: f.series.map(function (r) { return r.superLarge; }),
          lineStyle: { width: 1.5, color: '#2563eb' }
        }
      ]
    });
    charts.push(chart);
  }

  function renderFin(d) {
    if (!d.financials || !d.financials.length) {
      $('finCard').classList.add('hidden');
      return;
    }
    $('finCard').classList.remove('hidden');
    $('finNote').textContent = '数据来源：东方财富业绩报表 · 拉取时间 ' + d.meta.fetchedAt;
    var tbody = document.querySelector('#finTable tbody');
    tbody.innerHTML = d.financials.map(function (r) {
      return '<tr><td>' + esc(r.period) + '</td>' +
        '<td>' + fmtYi(r.revenue) + '</td>' +
        '<td class="' + cls(r.revYoY) + '">' + fmtPct(r.revYoY) + '</td>' +
        '<td>' + fmtYi(r.netProfit) + '</td>' +
        '<td class="' + cls(r.npYoY) + '">' + fmtPct(r.npYoY) + '</td>' +
        '<td>' + (r.grossMargin != null ? fmt(r.grossMargin) + '%' : '—') + '</td>' +
        '<td>' + (r.netMargin != null ? fmt(r.netMargin) + '%' : '—') + '</td>' +
        '<td>' + (r.roe != null ? fmt(r.roe) + '%' : '—') + '</td></tr>';
    }).join('');
  }

  function renderNews(d) {
    var list = d.news || [];
    $('newsList').innerHTML = list.length ? list.map(function (n) {
      var sent = n.sentiment === 'positive'
        ? '<span class="sent sent-positive">利好</span>'
        : n.sentiment === 'negative'
          ? '<span class="sent sent-negative">利空</span>'
          : '<span class="sent sent-neutral">中性</span>';
      return '<li>' + sent + '<a href="' + esc(n.url) + '" target="_blank" rel="noopener">' + esc(n.title) + '</a>' +
        '<div class="news-meta">' + esc(n.media || '') + ' · ' + esc((n.date || '').slice(0, 16)) + '（非一手来源，需核实原文）</div></li>';
    }).join('') : '<li>暂未检索到相关新闻</li>';

    var anns = d.announcements || [];
    if (!anns.length) {
      $('annCard').classList.add('hidden');
      return;
    }
    $('annCard').classList.remove('hidden');
    $('annList').innerHTML = anns.map(function (a) {
      return '<li><a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.title) + '</a>' +
        '<div class="news-meta">公告日期 ' + esc(a.date) + '</div></li>';
    }).join('');
  }

  /* ---------- 名称模糊搜索（联想下拉） ---------- */

  var suggestBox = $('suggestBox');
  var suggestTimer = null;
  var suggestSeq = 0; // 防止慢响应覆盖新输入

  function isCodeLike(s) {
    return /^\d{1,6}$/.test(s) || /^[A-Za-z.]{1,6}$/.test(s);
  }

  function hideSuggest() {
    suggestBox.classList.add('hidden');
    suggestBox.innerHTML = '';
  }

  function renderSuggest(list, note) {
    if (!list.length) {
      suggestBox.innerHTML = '<div class="suggest-empty">' + esc(note || '未找到匹配的股票') + '</div>';
      suggestBox.classList.remove('hidden');
      return;
    }
    suggestBox.innerHTML = list.map(function (r, i) {
      return '<div class="suggest-item" data-i="' + i + '">' +
        '<span class="sg-name">' + esc(r.name) + '</span>' +
        '<span class="sg-code">' + esc(r.code) + '</span>' +
        '<span class="sg-market">' + esc(r.market) + '</span></div>';
    }).join('');
    suggestBox.classList.remove('hidden');
    suggestBox.querySelectorAll('.suggest-item').forEach(function (el) {
      el.addEventListener('mousedown', function (e) {
        e.preventDefault(); // 先于 input blur 触发
        var item = list[+el.getAttribute('data-i')];
        hideSuggest();
        codeInput.value = item.code + ' ' + item.name;
        analyze(item.code);
      });
    });
  }

  async function fetchSuggest(kw) {
    var seq = ++suggestSeq;
    try {
      var resp = await fetch('/api/search?q=' + encodeURIComponent(kw), { headers: authHeaders() });
      if (handleAuthFailure(resp)) return;
      var d = await resp.json();
      if (seq !== suggestSeq) return; // 已有更新的输入，丢弃旧结果
      if (!resp.ok) throw new Error(d.error || '搜索失败');
      renderSuggest(d.results || []);
    } catch (_) {
      if (seq === suggestSeq) renderSuggest([], '搜索服务暂时不可用');
    }
  }

  codeInput.addEventListener('input', function () {
    var kw = codeInput.value.trim();
    if (suggestTimer) clearTimeout(suggestTimer);
    if (kw.length < 1) { hideSuggest(); return; }
    suggestTimer = setTimeout(function () { fetchSuggest(kw); }, 250);
  });
  codeInput.addEventListener('blur', function () { setTimeout(hideSuggest, 150); });
  codeInput.addEventListener('focus', function () {
    var kw = codeInput.value.trim();
    if (kw && suggestBox.innerHTML) suggestBox.classList.remove('hidden');
  });

  /** 提交入口：代码直接分析；名称先搜索，唯一/精确匹配直接分析，多候选弹下拉 */
  async function submitQuery(raw) {
    var q = (raw || '').trim();
    if (!q) { showError('请输入股票代码或名称'); return; }
    hideSuggest();
    if (isCodeLike(q)) { analyze(q); return; }
    $('errorBox').classList.add('hidden');
    setLoading(true, '正在搜索「' + q + '」匹配的股票…');
    try {
      var resp = await fetch('/api/search?q=' + encodeURIComponent(q), { headers: authHeaders() });
      if (handleAuthFailure(resp)) return;
      var d = await resp.json();
      if (!resp.ok) throw new Error(d.error || '搜索失败');
      var list = d.results || [];
      if (!list.length) throw new Error('未找到与「' + q + '」匹配的 A股/港股/美股标的，请换个关键词或直接输入代码');
      var exact = list.filter(function (r) { return r.name === q; });
      if (list.length === 1 || exact.length === 1) {
        var pick = exact[0] || list[0];
        codeInput.value = pick.code + ' ' + pick.name;
        analyze(pick.code);
      } else {
        setLoading(false);
        renderSuggest(list, null);
        showError('找到多个匹配，请在下方候选中选择一只：');
        $('errorBox').classList.remove('hidden');
      }
    } catch (err) {
      showError(err.message || '网络异常，请稍后重试');
      setLoading(false);
    }
  }

  /* ---------- 主流程 ---------- */

  async function analyze(code) {
    code = (code || '').trim();
    if (!code) { showError('请输入股票代码'); return; }
    $('errorBox').classList.add('hidden');
    setLoading(true, '正在拉取 ' + code + ' 的实时行情、财务、资金流与要闻…');
    try {
      var resp = await fetch('/api/analyze?code=' + encodeURIComponent(code), { headers: authHeaders() });
      if (handleAuthFailure(resp)) return;
      var data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '分析失败');
      disposeCharts();
      $('result').classList.remove('hidden');
      renderHead(data);
      renderMetrics(data);
      renderAnalysis(data);
      renderAshare(data);
      renderKline(data);
      renderFlow(data);
      renderFin(data);
      renderNews(data);
      $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
      loadAiReport(code); // 规则报告先出，AI 研报异步跟上
    } catch (err) {
      showError(err.message || '网络异常，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  /* ---------- AI 深度研报（双模型，异步加载） ---------- */
  var aiTimer = null;

  function resetAiCard() {
    if (aiTimer) { clearInterval(aiTimer); aiTimer = null; }
    $('aiLoading').classList.remove('hidden');
    $('aiBody').classList.add('hidden');
    $('aiError').classList.add('hidden');
    $('aiElapsed').textContent = '（已用时 0s）';
  }

  async function loadAiReport(code) {
    resetAiCard();
    var t0 = Date.now();
    aiTimer = setInterval(function () {
      $('aiElapsed').textContent = '（已用时 ' + Math.round((Date.now() - t0) / 1000) + 's）';
    }, 1000);
    try {
      var resp = await fetch('/api/ai-report?code=' + encodeURIComponent(code), { headers: authHeaders() });
      if (handleAuthFailure(resp)) return;
      var d = await resp.json();
      if (!resp.ok) throw new Error(d.error || 'AI 研报生成失败');
      renderAiReport(d);
    } catch (err) {
      $('aiLoading').classList.add('hidden');
      $('aiError').textContent = 'AI 深度研报暂时不可用：' + (err.message || '网络异常') + '（上方规则引擎分析不受影响）';
      $('aiError').classList.remove('hidden');
    } finally {
      if (aiTimer) { clearInterval(aiTimer); aiTimer = null; }
    }
  }

  function renderAiReport(d) {
    $('aiLoading').classList.add('hidden');
    $('aiBody').classList.remove('hidden');
    var r = d.report || {};
    var kr = d.newsReading || {};

    var stance = $('aiStance');
    stance.textContent = 'AI 立场：' + (r.stance || '—');
    stance.className = 'ai-stance' +
      (r.stance === '积极' || r.stance === '谨慎乐观' ? ' s-pos' :
       r.stance === '谨慎' || r.stance === '回避' ? ' s-neg' : '');
    $('aiTime').textContent = (d.generatedAt || '') + ' ｜ 推理耗时 ' + (d.elapsedSec || '—') + 's' + (d.cached ? '（缓存）' : '');
    $('aiModels').textContent = (d.models ? d.models.news + ' 读消息面 × ' + d.models.report + ' 写研报' : '');

    $('aiCoreLogic').textContent = r.core_logic || '—';
    $('aiFundamental').textContent = r.fundamental_view || '—';
    $('aiValuation').textContent = r.valuation_view || '—';
    $('aiTechnical').textContent = r.technical_view || '—';
    $('aiCapital').textContent = r.capital_view || '—';
    $('aiConclusion').textContent = r.conclusion || '—';

    $('aiNewsSummary').textContent = kr.news_summary || '';
    $('aiPolicy').textContent = kr.policy_industry || '';
    var items = (kr.news_items || []).map(function (n) {
      var cls = n.sentiment === '利好' ? 'sent-positive' : n.sentiment === '利空' ? 'sent-negative' : 'sent-neutral';
      return '<div class="ai-news-item"><span class="sent ' + cls + '">' + esc(n.sentiment || '中性') + '</span>' +
        '<span class="t">' + esc(n.title || '') +
        '<span class="i">' + esc(n.impact || '') + '（' + esc(n.horizon || '') + '）</span></span></div>';
    }).join('');
    $('aiNewsItems').innerHTML = items;

    $('aiRisks').innerHTML = (r.risks || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
  }

  analyzeBtn.addEventListener('click', function () { submitQuery(codeInput.value); });
  codeInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitQuery(codeInput.value);
    if (e.key === 'Escape') hideSuggest();
  });
  document.querySelectorAll('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      codeInput.value = chip.getAttribute('data-code');
      analyze(chip.getAttribute('data-code'));
    });
  });
  window.addEventListener('resize', function () {
    charts.forEach(function (c) { c.resize(); });
  });

  // 深链支持：/?code=600519 直接分析（持仓页跳转用）
  (function () {
    var m = location.search.match(/[?&]code=([^&]+)/);
    if (m) {
      var c = decodeURIComponent(m[1]).split(/\s/)[0];
      codeInput.value = decodeURIComponent(m[1]);
      analyze(c);
    }
  })();
})();
