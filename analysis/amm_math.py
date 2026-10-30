"""
Numerical companion to the report: the mathematics behind MiniDEX.

Produces three figures in analysis/figures/ for the report:
  1. fig1_invariant_curve.png  - the curve x*y = k and one swap moving along it
  2. fig2_price_impact.png     - execution price vs trade size (slippage)
  3. fig3_impermanent_loss.png - LP value vs HODL value: 2*sqrt(r)/(1+r) - 1

It also prints a numeric check that the Python formula matches the integer
formula implemented in Solidity (MiniSwapPair.getAmountOut).

Run:  python analysis/amm_math.py      (needs numpy and matplotlib; both ship with Anaconda)
"""

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

OUT = Path(__file__).parent / "figures"
OUT.mkdir(exist_ok=True)

FEE = 0.003
GAMMA = 1 - FEE
BLUE, ORANGE = "#2a78d6", "#eb6834"
INK, MUTED, GRID = "#0b0b0b", "#52514e", "#e4e3df"

plt.rcParams.update(
    {
        "figure.dpi": 150,
        "font.size": 10,
        "axes.edgecolor": MUTED,
        "axes.labelcolor": INK,
        "axes.titlecolor": INK,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "axes.grid": True,
        "grid.color": GRID,
        "grid.linewidth": 0.8,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "lines.linewidth": 2,
    }
)


def amount_out(dx, x, y, gamma=GAMMA):
    """Real-valued swap output: dy = y * g*dx / (x + g*dx)."""
    return y * gamma * dx / (x + gamma * dx)


def amount_out_solidity(dx, x, y):
    """Bit-exact replica of MiniSwapPair.getAmountOut (integer division)."""
    with_fee = dx * 9970
    return (with_fee * y) // (x * 10000 + with_fee)


def impermanent_loss(r):
    """LP value / HODL value - 1, when the price moves by factor r."""
    return 2 * np.sqrt(r) / (1 + r) - 1


# --------------------------------------------------------------------------
# Figure 1: the invariant curve
# --------------------------------------------------------------------------
x0, y0 = 20_000.0, 10.0  # same seed as scripts/deploy.js: 20,000 mUSD / 10 mETH
k = x0 * y0
dx = 5_000.0
dy = amount_out(dx, x0, y0)
x1, y1 = x0 + dx, y0 - dy

xs = np.linspace(8_000, 45_000, 400)
fig, ax = plt.subplots(figsize=(6, 4))
ax.plot(xs, k / xs, color=BLUE, label="x · y = k")
ax.scatter([x0], [y0], s=40, color=INK, zorder=3)
ax.scatter([x1], [y1], s=40, color=ORANGE, zorder=3)
ax.annotate("before", (x0, y0), textcoords="offset points", xytext=(8, 8), color=INK)
ax.annotate(
    f"after selling {dx:,.0f} mUSD\nreceive {dy:.3f} mETH",
    (x1, y1),
    textcoords="offset points",
    xytext=(8, 8),
    color=INK,
)
# tangent at the starting point: slope -y/x is the marginal (spot) price
t = np.linspace(x0 - 6_000, x0 + 6_000, 2)
ax.plot(t, y0 - (y0 / x0) * (t - x0), color=MUTED, linewidth=1, linestyle="--", label="tangent = spot price")
ax.set_xlabel("x  (mUSD reserve)")
ax.set_ylabel("y  (mETH reserve)")
ax.set_title("Constant-product invariant: a swap slides along the curve")
ax.legend(frameon=False)
fig.tight_layout()
fig.savefig(OUT / "fig1_invariant_curve.png")
plt.close(fig)

# --------------------------------------------------------------------------
# Figure 2: price impact
# --------------------------------------------------------------------------
spot = x0 / y0  # mUSD per mETH
sizes = np.linspace(1, 0.5 * x0, 300)  # sell up to 50% of the mUSD reserve
exec_price = sizes / amount_out(sizes, x0, y0)  # mUSD paid per mETH received
impact = (exec_price / spot - 1) * 100
impact_nofee = (sizes / amount_out(sizes, x0, y0, gamma=1.0) / spot - 1) * 100

fig, ax = plt.subplots(figsize=(6, 4))
ax.plot(sizes / x0 * 100, impact, color=BLUE, label="with 0.30% fee")
ax.plot(sizes / x0 * 100, impact_nofee, color=ORANGE, label="without fee (pure curve)")
ax.set_xlabel("trade size  (% of input reserve)")
ax.set_ylabel("execution price above spot  (%)")
ax.set_title("Price impact grows with trade size: Δx/x")
ax.legend(frameon=False)
fig.tight_layout()
fig.savefig(OUT / "fig2_price_impact.png")
plt.close(fig)

# --------------------------------------------------------------------------
# Figure 3: impermanent loss
# --------------------------------------------------------------------------
r = np.logspace(np.log10(0.1), np.log10(10), 400)
fig, ax = plt.subplots(figsize=(6, 4))
ax.plot(r, impermanent_loss(r) * 100, color=BLUE)
ax.set_xscale("log")
ax.set_xticks([0.1, 0.25, 0.5, 1, 2, 4, 10])
ax.set_xticklabels(["0.1×", "0.25×", "0.5×", "1×", "2×", "4×", "10×"])
for rr in (0.5, 2, 4):
    v = impermanent_loss(rr) * 100
    ax.scatter([rr], [v], s=30, color=INK, zorder=3)
    ax.annotate(f"{v:.1f}%", (rr, v), textcoords="offset points", xytext=(6, -12), color=INK)
ax.set_xlabel("price ratio r = p_new / p_old")
ax.set_ylabel("LP value vs. holding  (%)")
ax.set_title("Impermanent loss: 2√r / (1 + r) − 1  ≤ 0  (AM–GM)")
fig.tight_layout()
fig.savefig(OUT / "fig3_impermanent_loss.png")
plt.close(fig)

# --------------------------------------------------------------------------
# Numeric checks
# --------------------------------------------------------------------------
WEI = 10**18
X, Y = 20_000 * WEI, 10 * WEI
print("Python (real) vs Solidity (integer) swap output for the deploy seed pool:")
for usd in (1, 100, 1_000, 5_000):
    real = amount_out(usd, 20_000, 10)
    sol = amount_out_solidity(usd * WEI, X, Y) / WEI
    print(f"  sell {usd:>5} mUSD -> real {real:.12f}  solidity {sol:.12f}  diff {real - sol:.2e}")

print("\nImpermanent loss at selected price moves:")
for rr in (0.25, 0.5, 1.25, 1.5, 2, 3, 4, 5):
    print(f"  r = {rr:<5} IL = {impermanent_loss(rr) * 100:6.2f}%")

print(f"\nFigures written to {OUT.resolve()}")
