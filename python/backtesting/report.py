"""
Backtest results reporting: console + HTML.
"""
from __future__ import annotations

from backtesting.engine import BacktestResult


# ─── Console report ──────────────────────────────────────────────────────────

def print_report(result: BacktestResult, strategy: str, token: str) -> None:
    G  = lambda s: f"\033[32m{s}\033[0m"
    R  = lambda s: f"\033[31m{s}\033[0m"
    Y  = lambda s: f"\033[33m{s}\033[0m"
    B  = lambda s: f"\033[1m{s}\033[0m"

    ret_color = G if result.total_return_pct >= 0 else R
    dd_color  = G if result.max_drawdown_pct <= 10 else Y if result.max_drawdown_pct <= 20 else R

    print(f"\n{B('─' * 52)}")
    print(f"{B(f'  {strategy.upper()} / {token}  Backtest Results')}")
    print(f"{B('─' * 52)}")
    print(f"  Bars tested:        {result.bars_tested}")
    print(f"  Initial capital:    ${result.initial_capital:.2f}")
    print(f"  Final capital:      ${result.final_capital:.2f}")
    print(f"  Total return:       {ret_color(f'{result.total_return_pct:+.2f}%')}")
    print(f"  Max drawdown:       {dd_color(f'{result.max_drawdown_pct:.2f}%')}")
    print(f"  Sharpe ratio:       {result.sharpe_ratio:.3f}")
    print(f"  Total trades:       {result.total_trades}  (buy+sell combined)")
    print(f"  Closed P&L trades:  W={result.win_trades}  L={result.loss_trades}  "
          f"WR={result.win_rate*100:.1f}%")
    print(f"  Avg trade P&L:      ${result.avg_trade_pnl:+.2f}")
    print(f"  Best / Worst:       ${result.best_trade_pnl:+.2f} / ${result.worst_trade_pnl:+.2f}")
    print(f"  Total fees paid:    ${result.total_fees_usd:.2f}")
    print(f"  Signals generated:  {result.signals_generated}")
    print(f"  Signals vetoed:     {result.signals_vetoed}")

    if result.trades:
        print(f"\n  {B('Last 5 trades:')}")
        for t in result.trades[-5:]:
            tag = G("BUY") if t.action == "BUY" else R("SELL")
            print(f"    [{t.timestamp[:16]}] {tag}  {t.quantity:.4f} {token} "
                  f"@ ${t.price:.2f}  fee=${t.fee_usd:.3f}  conf={t.signal_conf:.2f}")
    print(f"{B('─' * 52)}\n")


# ─── HTML report ─────────────────────────────────────────────────────────────

def save_report(result: BacktestResult, strategy: str, token: str, path: str) -> None:
    """Generate a minimal self-contained HTML report with an equity chart."""

    # Build JS arrays for chart
    labels = [str(i) for i in range(len(result.equity_curve))]
    equity_js = ", ".join(f"{e:.2f}" for e in result.equity_curve)

    buy_bars  = [t.bar - 50 for t in result.trades if t.action == "BUY"]   # offset warmup
    sell_bars = [t.bar - 50 for t in result.trades if t.action == "SELL"]
    buy_prices  = [t.price for t in result.trades if t.action == "BUY"]
    sell_prices = [t.price for t in result.trades if t.action == "SELL"]

    ret_color = "#22c55e" if result.total_return_pct >= 0 else "#ef4444"

    trades_rows = "".join(
        f"<tr><td>{t.timestamp[:16]}</td>"
        f"<td style='color:{'#22c55e' if t.action=='BUY' else '#ef4444'}'>{t.action}</td>"
        f"<td>{t.quantity:.4f}</td>"
        f"<td>${t.price:.2f}</td>"
        f"<td>${t.amount_usd:.2f}</td>"
        f"<td>${t.fee_usd:.4f}</td>"
        f"<td>{t.signal_conf:.2f}</td>"
        f"<td style='font-size:0.75em;color:#94a3b8'>{t.rationale[:60]}…</td></tr>"
        for t in result.trades
    )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Backtest: {strategy} / {token}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
  body {{ font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }}
  h1   {{ color: #f8fafc; }} h2 {{ color: #94a3b8; margin-top: 2rem; }}
  .grid {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin: 1.5rem 0; }}
  .card {{ background: #1e293b; border-radius: 8px; padding: 1rem; }}
  .card .label {{ font-size: 0.8rem; color: #64748b; }}
  .card .value {{ font-size: 1.4rem; font-weight: 700; margin-top: 0.2rem; }}
  .canvas-wrap {{ background: #1e293b; border-radius: 8px; padding: 1rem; margin-bottom: 2rem; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 0.85rem; }}
  th  {{ text-align: left; padding: 0.5rem; background: #1e293b; color: #64748b; }}
  td  {{ padding: 0.4rem 0.5rem; border-bottom: 1px solid #1e293b; }}
  tr:hover td {{ background: #1e293b55; }}
</style>
</head>
<body>
<h1>Backtest Report: {strategy.upper()} / {token}</h1>

<div class="grid">
  <div class="card">
    <div class="label">Total Return</div>
    <div class="value" style="color:{ret_color}">{result.total_return_pct:+.2f}%</div>
  </div>
  <div class="card">
    <div class="label">Sharpe Ratio</div>
    <div class="value">{result.sharpe_ratio:.3f}</div>
  </div>
  <div class="card">
    <div class="label">Max Drawdown</div>
    <div class="value" style="color:#f59e0b">{result.max_drawdown_pct:.2f}%</div>
  </div>
  <div class="card">
    <div class="label">Win Rate</div>
    <div class="value">{result.win_rate*100:.1f}%</div>
  </div>
  <div class="card">
    <div class="label">Trades</div>
    <div class="value">{result.total_trades}</div>
  </div>
  <div class="card">
    <div class="label">Final Capital</div>
    <div class="value" style="color:{ret_color}">${result.final_capital:.2f}</div>
  </div>
  <div class="card">
    <div class="label">Total Fees</div>
    <div class="value">${result.total_fees_usd:.2f}</div>
  </div>
  <div class="card">
    <div class="label">Bars Tested</div>
    <div class="value">{result.bars_tested}</div>
  </div>
</div>

<div class="canvas-wrap">
  <h2>Equity Curve</h2>
  <canvas id="equity" height="80"></canvas>
</div>

<h2>Trade Log ({result.total_trades} trades)</h2>
<table>
  <thead><tr>
    <th>Time</th><th>Action</th><th>Qty</th><th>Price</th>
    <th>Amount</th><th>Fee</th><th>Conf</th><th>Rationale</th>
  </tr></thead>
  <tbody>{trades_rows}</tbody>
</table>

<script>
const ctx = document.getElementById('equity').getContext('2d');
new Chart(ctx, {{
  type: 'line',
  data: {{
    labels: [{', '.join(f'"{l}"' for l in labels[::max(1, len(labels)//200)])}],
    datasets: [{{
      label: 'Portfolio Value ($)',
      data: [{', '.join(f'{e:.2f}' for e in result.equity_curve[::max(1, len(result.equity_curve)//200)])}],
      borderColor: '{ret_color}',
      backgroundColor: '{ret_color}22',
      fill: true,
      tension: 0.1,
      pointRadius: 0,
      borderWidth: 2,
    }}]
  }},
  options: {{
    responsive: true,
    plugins: {{ legend: {{ labels: {{ color: '#e2e8f0' }} }} }},
    scales: {{
      x: {{ ticks: {{ color: '#64748b', maxTicksLimit: 10 }}, grid: {{ color: '#1e293b' }} }},
      y: {{ ticks: {{ color: '#64748b' }}, grid: {{ color: '#334155' }} }}
    }}
  }}
}});
</script>
</body>
</html>"""

    from pathlib import Path
    Path(path).write_text(html, encoding="utf-8")
