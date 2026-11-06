/* 持仓组合页渲染逻辑 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var charts = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtMoney(v) {
    if (v == null || isNaN(v)) return '—';
    return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtSigned(v, digits) {
    if (v == null || isNaN(v)) return '—';
    return (v > 0 ? '+' : '') + Number(v).toLocaleString('zh-CN', { minimumFractionDigits: digits == null ? 2 : digits, maximumFractionDigits: digits == null ? 2 : digits });
  }
  function fmtPct(v) {
    if (v == null || isNaN(v)) return '—';
    return (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
  }
  function cls(v) { return v > 0 ? 'up' : v < 0 ? 'down' : ''; }
  function authHeaders() { return { 'x-access-token': localStorage.getItem('stocklens_token') || '' }; }

  async function load() {
    try {
      var resp = await fetch('/api/portfolio', { headers: authHeaders() });
      if (resp.status === 401) { location.href = 'index.html'; return; }
      var d = await resp.json();
      if (!resp.ok) throw new Error(d.error || '加载失败');
      render(d);
    } catch (e) {
      $('pfLoading').classList.add('hidden');
      $('pfError').textContent = e.message || '网络异常';
      $('pfError').classList.remove('hidden');
    }
  }

  function render(d) {
    $('pfLoading').classList.add('hidden');
    $('pfBody').classList.remove('hidden');
    $('pfHeaderSub').textContent = d.broker + '账户 ' + d.account + ' · 快照 ' + d.snapshotTime;

    /* 总览卡 */
    var pnlCls = d.totalPnl >= 0 ? 'up' : 'down';
    $('pfCards').innerHTML = [
      ['人民币总资产', fmtMoney(d.totalAsset), ''],
      ['股票市值', fmtMoney(d.stockValue), ''],
      ['可用资金', fmtMoney(d.cashAvailable), ''],
      ['仓位', d.positionRatio + '%', ''],
      ['持仓盈亏', fmtSigned(d.totalPnl), pnlCls],
      ['持仓只数', d.holdings.length + ' 只', ''],
    ].map(function (c) {
      return '<div class="pf-card"><div class="k">' + c[0] + '</div><div class="v ' + c[2] + '">' + c[1] + '</div></div>';
    }).join('');

    /* 权重环形图 */
    var wChart = echarts.init($('weightChart'));
    charts.push(wChart);
    wChart.setOption({
      tooltip: { trigger: 'item', formatter: '{b}<br/>市值 {c} 元（{d}%）' },
      legend: { type: 'scroll', bottom: 0, textStyle: { fontSize: 11 } },
      series: [{
        type: 'pie', radius: ['42%', '68%'], center: ['50%', '44%'],
        label: { formatter: '{b} {d}%', fontSize: 11 },
        data: d.holdings.map(function (h) { return { name: h.name, value: h.value }; }),
      }],
    });

    /* 板块分布（柱+盈亏） */
    var sChart = echarts.init($('sectorChart'));
    charts.push(sChart);
    sChart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, textStyle: { fontSize: 11 } },
      grid: { left: 50, right: 50, top: 24, bottom: 50 },
      xAxis: { type: 'category', data: d.sectors.map(function (s) { return s.sector; }), axisLabel: { fontSize: 11 } },
      yAxis: [
        { type: 'value', name: '占比%', axisLabel: { formatter: '{value}%' } },
        { type: 'value', name: '盈亏(元)' },
      ],
      series: [
        { name: '市值占比', type: 'bar', data: d.sectors.map(function (s) { return s.weight; }), itemStyle: { color: '#1565c0' }, barMaxWidth: 34 },
        { name: '板块盈亏', type: 'bar', yAxisIndex: 1, barMaxWidth: 34,
          data: d.sectors.map(function (s) {
            return { value: +s.pnl.toFixed(2), itemStyle: { color: s.pnl >= 0 ? '#d93636' : '#0e9f58' } };
          }) },
      ],
    });

    /* 组合洞察 */
    var ins = d.insights;
    var brokerConc = null;
    d.sectors.forEach(function (s) { if (s.sector === '券商') brokerConc = s; });
    var html = '';
    if (ins.best) {
      html += '<div class="pf-insight">最大盈利贡献<br><b>' + esc(ins.best.name) + '</b> <span class="up">' + fmtSigned(ins.best.pnl) + ' 元（' + fmtPct(ins.best.pnlPct) + '）</span><br>贡献了组合绝大部分正收益</div>';
    }
    if (ins.worst) {
      html += '<div class="pf-insight">最大亏损来源<br><b>' + esc(ins.worst.name) + '</b> <span class="down">' + fmtSigned(ins.worst.pnl) + ' 元（' + fmtPct(ins.worst.pnlPct) + '）</span><br>浮亏幅度全场最大，需重点复盘</div>';
    }
    html += '<div class="pf-insight">集中度<br>前三大持仓占股票市值 <b>' + ins.top3Weight + '%</b><br>仓位 ' + d.positionRatio + '%，现金缓冲较薄</div>';
    html += '<div class="pf-insight">盈亏结构<br><b>' + ins.winners + '</b> 只盈利 / <b>' + ins.losers + '</b> 只亏损<br>' +
      (brokerConc ? '券商板块合计占比 <b>' + brokerConc.weight + '%</b>，单一行业暴露偏高' : '') + '</div>';
    $('pfInsights').innerHTML = html;

    /* 明细表 */
    var rows = d.holdings.map(function (h) {
      var live = h.quoteOk
        ? '<span class="' + cls(h.liveChangePct) + '">' + h.livePrice + '</span><br><span style="font-size:11px" class="' + cls(h.liveChangePct) + '">' + fmtPct(h.liveChangePct) + '</span>'
        : '—';
      var barW = Math.max(4, Math.round(h.weight / d.holdings[0].weight * 90));
      return '<tr>' +
        '<td class="l"><a class="pname pname-link" href="index.html?code=' + h.code + '">' + esc(h.name) + '</a><br><span class="pcode">' + h.code + (h.currency === 'HKD' ? ' · 港股' : '') + '</span></td>' +
        '<td class="l">' + esc(h.sector) + '</td>' +
        '<td>' + h.qty + '</td>' +
        '<td>' + h.cost + '</td>' +
        '<td>' + h.snapshotPrice + '</td>' +
        '<td>' + live + '</td>' +
        '<td>' + fmtMoney(h.value) + '</td>' +
        '<td class="l bar-cell"><span class="wbar" style="width:' + barW + 'px"></span><span class="wtxt">' + h.weight + '%</span></td>' +
        '<td class="' + cls(h.pnl) + '">' + fmtSigned(h.pnl) + '</td>' +
        '<td class="' + cls(h.pnl) + '">' + fmtPct(h.pnlPct) + '</td>' +
        '<td><a class="pf-analyze-link" href="index.html?code=' + h.code + '">深度分析</a></td>' +
        '</tr>';
    }).join('');
    $('pfTable').querySelector('tbody').innerHTML = rows;
    $('pfTableNote').textContent = '行情更新于 ' + new Date(d.fetchedAt).toLocaleString('zh-CN') + '（最新价列按接口实时值，与快照价可能存在交易日间隔差异）';
    $('pfNote').textContent = '注：蓝思科技(H) 的成本与价格为港元，市值与盈亏为券商折算人民币口径；其余均为人民币。数据源自持仓截图，盈亏以券商 App 为准。';
  }

  window.addEventListener('resize', function () { charts.forEach(function (c) { c.resize(); }); });
  load();
})();
