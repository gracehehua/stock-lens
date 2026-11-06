/* 量化选股页逻辑 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pctCls(v) { return v > 0 ? 'up' : v < 0 ? 'down' : ''; }
  function fmtPct(v) { return v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
  function authHeaders() { return { 'x-access-token': localStorage.getItem('stocklens_token') || '' }; }

  /* ---------- 回测 ---------- */
  async function runBacktest() {
    $('btBtn').disabled = true;
    $('btLoading').classList.remove('hidden');
    $('btBody').classList.add('hidden');
    $('btError').classList.add('hidden');
    try {
      var resp = await fetch('/api/quant/backtest', { headers: authHeaders() });
      if (resp.status === 401) { location.href = 'index.html'; return; }
      var d = await resp.json();
      if (!resp.ok) throw new Error(d.error || '回测失败');
      renderBacktest(d);
    } catch (e) {
      $('btError').textContent = e.message || '网络异常';
      $('btError').classList.remove('hidden');
    } finally {
      $('btLoading').classList.add('hidden');
      $('btBtn').disabled = false;
    }
  }

  function renderBacktest(d) {
    $('btBody').classList.remove('hidden');
    var s = d.strategy, b = d.benchmark;
    var cards = [
      ['策略总收益', fmtPct(s.totalReturnPct), pctCls(s.totalReturnPct)],
      ['沪深300', fmtPct(b.totalReturnPct), pctCls(b.totalReturnPct)],
      ['超额收益', fmtPct(d.excessPct), pctCls(d.excessPct)],
      ['年化收益', fmtPct(s.ann), pctCls(s.ann)],
      ['最大回撤', fmtPct(s.maxDD), 'down'],
      ['夏普比率', s.sharpe == null ? '—' : s.sharpe, ''],
      ['调仓胜率', d.winRatePct == null ? '—' : d.winRatePct + '%', ''],
      ['调仓次数', d.rebalances + ' 次', ''],
    ];
    $('btStats').innerHTML = cards.map(function (c) {
      return '<div class="pf-card"><div class="k">' + c[0] + '</div><div class="v ' + c[2] + '">' + c[1] + '</div></div>';
    }).join('');

    var chart = echarts.init($('btChart'));
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, data: ['本策略', '沪深300'] },
      grid: { left: 50, right: 20, top: 20, bottom: 46 },
      xAxis: { type: 'category', data: d.curve.map(function (p) { return p.date; }), axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', name: '净值', min: 'dataMin' },
      series: [
        { name: '本策略', type: 'line', data: d.curve.map(function (p) { return p.equity; }), showSymbol: false, lineStyle: { width: 2, color: '#d93636' }, itemStyle: { color: '#d93636' } },
        { name: '沪深300', type: 'line', data: d.benchCurve.map(function (p) { return p.equity; }), showSymbol: false, lineStyle: { width: 2, color: '#8a94a6' }, itemStyle: { color: '#8a94a6' } },
      ],
    });
    window.addEventListener('resize', function () { chart.resize(); });
    $('btNote').textContent = '股票池' + d.params.universeSize + '只 · 近' + d.params.days + '个交易日 · 每' + d.params.rebalanceDays + '日调仓 · ' + d.generatedAt;
    $('btCaveat').textContent = d.note;
  }

  /* ---------- Top10 ---------- */
  async function runTop10() {
    $('t10Btn').disabled = true;
    $('t10Loading').classList.remove('hidden');
    $('t10Body').classList.add('hidden');
    $('t10Error').classList.add('hidden');
    try {
      var resp = await fetch('/api/quant/top10', { headers: authHeaders() });
      if (resp.status === 401) { location.href = 'index.html'; return; }
      var d = await resp.json();
      if (!resp.ok) throw new Error(d.error || '选股失败');
      renderTop10(d);
    } catch (e) {
      $('t10Error').textContent = e.message || '网络异常';
      $('t10Error').classList.remove('hidden');
    } finally {
      $('t10Loading').classList.add('hidden');
      $('t10Btn').disabled = false;
    }
  }

  function renderTop10(d) {
    $('t10Body').classList.remove('hidden');
    $('csvBtn').classList.remove('hidden');
    $('t10Table').querySelector('tbody').innerHTML = d.top.map(function (r) {
      return '<tr>' +
        '<td>' + r.rank + '</td>' +
        '<td class="l"><a class="pname pname-link" href="index.html?code=' + r.code + '">' + esc(r.name) + '</a><br><span class="pcode">' + r.code + '</span></td>' +
        '<td><b>' + r.score + '</b></td>' +
        '<td class="' + pctCls(r.chgPct) + '">' + r.price + '</td>' +
        '<td>' + (r.pe == null ? '—' : r.pe) + '</td>' +
        '<td class="' + pctCls(r.mom20Pct) + '">' + fmtPct(r.mom20Pct) + '</td>' +
        '<td class="' + pctCls(r.mom60Pct) + '">' + fmtPct(r.mom60Pct) + '</td>' +
        '<td>' + r.mcapYi + '</td>' +
        '<td>' + r.planWeightPct + '%</td>' +
        '<td><a class="pf-analyze-link" href="index.html?code=' + r.code + '">深度分析</a></td>' +
        '</tr>';
    }).join('');
    $('t10Note').textContent = '股票池 ' + d.universeSize + ' 只 · 有效打分 ' + d.scored + ' 只 · ' + d.generatedAt;
    $('t10Caveat').textContent = d.note;
  }

  $('btBtn').addEventListener('click', runBacktest);
  $('t10Btn').addEventListener('click', runTop10);
})();
