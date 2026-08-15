// dsh-balance-eta — 余额状态胶囊：余额 + 今日消耗 + 可用时长预测（区间）+ 低余额告警
//
// DeepSeek Harness (DSH) Web GUI 的极简余额插件。与其他 dsh-plugin 生态中
// "余额/费用"类插件的核心区别：不读 token、不维护价格表、不做按模型计价，
// 只观察官方余额随时间的变化，直接回答"余额还能撑多久"。
//
// 极简数据流（只依赖两个信号）：
//   1. 官方余额 GET https://api.deepseek.com/user/balance
//      （key 经 credentials/env 解析，全程只在服务端使用，绝不落浏览器）
//   2. 每日余额快照序列（当日 opening、历史每日余额）
//
// 预测算法（参考 claudectl-core forecast：#370 的成本 burn-rate 预测）：
//   - mid 速率：滑动窗口法——最近 N 个快照首尾差额 ÷ 实际时间跨度，
//     无日内漂移、天然平滑（已实测：一天内任意时刻结果一致）。
//   - ETA 区间：因为消耗分布是重尾的（一次大任务会 spike），单点预测会误导，
//     所以用窗口内相邻快照的"每日消耗样本"取 p90/p10 百分位：
//       etaLow  = 余额 ÷ p90 速率（保守，最早耗尽）
//       etaHigh = 余额 ÷ p10 速率（乐观，最晚耗尽）
//     样本不足时退化为单点 mid。
//
// 数据流：
//   GET /api/dsh-balance-eta
//     -> 官方 /user/balance
//     -> 读/写 $DSH_HOME/storages/balance-eta.json
//     -> 返回 { ok, total, currency, todayConsumed, dailyRate, daysLeft,
//               etaLow, etaHigh, seeded, level, levelReason }
//
// 配置（cordis.patch.yml 的 config，均可选）：
//   apiKeyEnv      凭据 ref，默认 DEEPSEEK_API_KEY
//   refreshMs      客户端刷新间隔毫秒，默认 60000
//   lowBalanceCny  低余额告警阈值（元），默认 5
//   warnDaysLeft   可用天数告警阈值（天），默认 3（按 mid 判断）
//   notify         余额过低时浏览器通知，默认 true
//   windowDays     速率窗口快照数（含今天），默认 7

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export const name = "dsh-balance-eta-band";
export const inject = ["webServer"];

const STATE_FILE_NAME = "balance-eta.json";
const BALANCE_ROUTE = "/api/dsh-balance-eta";
const PUBLIC_BASE_URL = "https://api.deepseek.com";
const DAY_MS = 86400000;

function statePath() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "storages", STATE_FILE_NAME);
}

function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

async function resolveKey(ctx, ref) {
	const credentials = ctx.get("credentials");
	if (credentials !== void 0) {
		try {
			const hit = await credentials.resolve(ref);
			if (hit !== void 0 && typeof hit.value === "string" && hit.value.length > 0) return hit.value;
		} catch { /* fall through to env */ }
	}
	const ambient = process.env[ref];
	if (typeof ambient === "string" && ambient.length > 0) return ambient;
	return void 0;
}

function readState(path) {
	try {
		if (!existsSync(path)) return null;
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function writeState(path, state) {
	try {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify(state));
	} catch (error) {
		console.warn("dsh-balance-eta: failed to persist state:", error?.message ?? error);
	}
}

/** 金额按分取整，消除浮点噪声。 */
function toCents(n) {
	return Math.round((Number(n) ?? 0) * 100) / 100;
}

/** 返回 { today }：今日日期（YYYY-MM-DD）。 */
function dayInfo(nowMs) {
	const d = new Date(nowMs);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return { today: `${y}-${m}-${day}` };
}

/** 线性插值百分位（claudectl percentile 同款）：p in 0..1，空数组返回 null。 */
function percentile(sorted, p) {
	if (sorted.length === 0) return null;
	if (sorted.length === 1) return sorted[0];
	const pos = p * (sorted.length - 1);
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 组合余额状态：返回 { todayConsumed, dailyRate, daysLeft, etaLow, etaHigh, seeded }。
 * - todayConsumed：当日 opening − 当前（余额上升视为 0）。
 * - dailyRate（mid）：滑动窗口速率——最近 windowDays 个快照首尾差额 ÷ 实际时间跨度。
 *   无日内漂移、天然平滑。
 * - etaLow / etaHigh：重尾分布的保守/乐观 ETA。用窗口内相邻快照的"每日消耗样本"
 *   取 p90 / p10 百分位速率，再算 余额 ÷ 速率。样本 < 3 时退化为单点。
 * - daysLeft = 余额 ÷ dailyRate（mid，供告警判断）。
 */
function analyze(state, total, nowMs, windowDays) {
	const { today } = dayInfo(nowMs);

	// 当日 opening：跨天或首次 -> 当前余额为基准。
	let opening = state?.opening ?? null;
	if (opening === null || opening.date !== today) {
		opening = { date: today, balance: total };
	}

	const todayConsumed = total < opening.balance - 0.001 ? opening.balance - total : 0;

	// 每日快照（显式按日期排序，保留最近 30 天）。
	const prevDays = (state?.days ?? [])
		.filter((d) => d && typeof d.date === "string" && d.date !== today && Number.isFinite(d.balance))
		.sort((a, b) => (a.date < b.date ? -1 : 1))
		.slice(-30);
	const days = [...prevDays, { date: today, balance: total }];

	// 充值检测：当前余额高于最早快照 -> 重置今日 opening（余额回归，速率锚点同步重置）。
	if (days.length >= 2 && total > days[0].balance + 0.001) {
		opening = { date: today, balance: total };
	}

	// mid 速率：滑动窗口（最近 windowDays 个快照），首尾差额 ÷ 实际时间跨度。
	const window = days.slice(-windowDays);
	let dailyRate = null;
	if (window.length >= 2) {
		const first = window[0];
		const spanMs = nowMs - new Date(first.date + "T00:00:00").getTime();
		const spanDays = Math.max(1, spanMs / DAY_MS);
		const consumed = first.balance - total;
		if (consumed > 0.001) dailyRate = consumed / spanDays;
	}

	// 每日消耗样本：相邻快照间的消耗速率（重尾分布百分位用）。
	// 对每对相邻快照 (a, b)：consumed = a.balance − b.balance，天数 = 日历差。
	const samples = [];
	for (let i = 0; i + 1 < window.length; i++) {
		const a = window[i];
		const b = window[i + 1];
		const spanMs = new Date(b.date + "T00:00:00").getTime() - new Date(a.date + "T00:00:00").getTime();
		const spanDays = Math.max(1, spanMs / DAY_MS);
		const consumed = a.balance - b.balance;
		if (consumed > 0.001) samples.push(consumed / spanDays);
	}

	let etaLow = null;
	let etaHigh = null;
	if (samples.length >= 3) {
		const sorted = [...samples].sort((a, b) => a - b);
		const p10 = percentile(sorted, 0.1);
		const p90 = percentile(sorted, 0.9);
		if (p10 !== null && p90 !== null && p10 > 0 && p90 > 0) {
			if (total > 0) {
				etaHigh = total / p10; // p10 慢消耗 -> 最晚耗尽（乐观上界）
				etaLow = total / p90; // p90 快消耗 -> 最早耗尽（保守下界）
			}
			if (etaLow !== null && etaHigh !== null && etaHigh < etaLow) [etaLow, etaHigh] = [etaHigh, etaLow];
		}
	}

	const seeded = dailyRate !== null && (state?.days ?? []).length < 2;
	const daysLeft = dailyRate !== null && total > 0 ? total / dailyRate : null;

	writeState(statePath(), { days, opening, last: { t: nowMs, balance: total } });
	return { todayConsumed, dailyRate, daysLeft, etaLow, etaHigh, seeded };
}

export function apply(ctx, config = {}) {
	const apiKeyEnv = config.apiKeyEnv ?? "DEEPSEEK_API_KEY";
	const refreshMs = config.refreshMs ?? 60000;
	const lowBalanceCny = config.lowBalanceCny ?? 5;
	const warnDaysLeft = config.warnDaysLeft ?? 3;
	const notify = config.notify !== false;
	const windowDays = Number.isInteger(config.windowDays) ? Math.min(30, Math.max(2, config.windowDays)) : 7;

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: BALANCE_ROUTE,
		handler: async (req, res) => {
			let key;
			try {
				key = await resolveKey(ctx, apiKeyEnv);
			} catch (error) {
				json(res, 500, { ok: false, error: String(error?.message ?? error) });
				return;
			}
			if (key === void 0) {
				json(res, 500, { ok: false, error: `未找到凭据 ${apiKeyEnv}（请在 DSH 设置里配置或导出环境变量）` });
				return;
			}
			try {
				const upstream = await fetch(`${PUBLIC_BASE_URL}/user/balance`, {
					headers: { authorization: `Bearer ${key}` },
					signal: AbortSignal.timeout(15000)
				});
				const data = await upstream.json();
				if (!upstream.ok) {
					json(res, upstream.status, { ok: false, error: data?.error?.message ?? `HTTP ${upstream.status}` });
					return;
				}
				const cny = (data.balance_infos ?? []).find((b) => b.currency === "CNY");
				if (cny === void 0) {
					const currencies = (data.balance_infos ?? []).map((b) => b.currency).join(", ");
					json(res, 200, { ok: false, error: `账户没有人民币余额行（可用币种: ${currencies || "未知"}），本插件仅支持 CNY` });
					return;
				}
				const total = Number(cny.total_balance ?? 0);
				const nowMs = Date.now();

				const state = readState(statePath());
				const { todayConsumed, dailyRate, daysLeft, etaLow, etaHigh, seeded } = analyze(state, total, nowMs, windowDays);

				let level = "ok";
				let levelReason = "";
				if (total < lowBalanceCny) {
					level = "low";
					levelReason = `余额不足 ${lowBalanceCny} 元`;
				} else if (daysLeft !== null && daysLeft < warnDaysLeft) {
					level = "warn";
					levelReason = `按当前速率可用不足 ${warnDaysLeft} 天`;
				}

				json(res, 200, {
					ok: true,
					isAvailable: data.is_available === true,
					currency: "CNY",
					total: toCents(total),
					granted: toCents(cny.granted_balance),
					toppedUp: toCents(cny.topped_up_balance),
					todayConsumed: toCents(todayConsumed),
					dailyRate: dailyRate === null ? null : toCents(dailyRate),
					daysLeft: daysLeft === null ? null : toCents(daysLeft),
					etaLow: etaLow === null ? null : toCents(etaLow),
					etaHigh: etaHigh === null ? null : toCents(etaHigh),
					seeded,
					level,
					levelReason
				});
			} catch (error) {
				json(res, 502, { ok: false, error: String(error?.message ?? error) });
			}
		}
	}), "dsh-balance-eta: balance route");

	const script = `
<script>
(() => {
	const CFG = ${JSON.stringify({ refreshMs, notify })};
	let host;
	try { host = new URL("/api/dsh-balance-eta", location.href).href; } catch { return; }

	document.getElementById("dsh-balance-footer")?.remove();

	const el = document.createElement("div");
	el.id = "dsh-balance-footer";
	el.style.cssText = [
		"position:fixed", "left:50%", "transform:translateX(-50%)", "top:8px",
		"z-index:2147483000", "background:rgba(15,17,21,.88)", "color:#e6e8eb",
		"font:12px/1.5 -apple-system,'Segoe UI',sans-serif", "padding:4px 12px",
		"border-radius:999px", "box-shadow:0 2px 10px rgba(0,0,0,.35)",
		"backdrop-filter:blur(4px)", "pointer-events:auto", "user-select:text",
		"white-space:nowrap", "max-width:92vw", "overflow:hidden", "text-overflow:ellipsis",
		"transition:background .3s ease", "cursor:pointer"
	].join(";");
	el.title = "点击立即刷新";
	el.textContent = "余额加载中…";
	el.addEventListener("click", refresh);
	document.body?.appendChild(el);

	const fmt = (n) => "¥" + (Number(n) ?? 0).toFixed(2);
	const fmtDur = (days) => {
		if (days >= 1) return "约可用 " + days.toFixed(1) + " 天";
		const hours = days * 24;
		if (hours >= 1) return "约可用 " + hours.toFixed(0) + " 小时";
		return "约可用 " + Math.max(0, Math.floor(days * 24 * 60)) + " 分钟";
	};
	// 区间格式：两个值都有 -> "约可用 a~b"，否则单点。
	const fmtBand = (lo, hi) => {
		if (lo === null || hi === null) return lo !== null ? fmtDur(lo) : null;
		const a = lo >= 1 ? lo.toFixed(1) + " 天" : (lo * 24 >= 1 ? (lo * 24).toFixed(0) + " 小时" : Math.max(1, Math.floor(lo * 24 * 60)) + " 分钟");
		const b = hi >= 1 ? hi.toFixed(1) + " 天" : (hi * 24 >= 1 ? (hi * 24).toFixed(0) + " 小时" : Math.max(1, Math.floor(hi * 24 * 60)) + " 分钟");
		return "约可用 " + a + "~" + b;
	};

	const BG = { ok: "rgba(15,17,21,.88)", warn: "rgba(140,105,0,.92)", low: "rgba(150,35,35,.94)" };

	async function refresh() {
		let text = "—";
		let level = "ok";
		try {
			const r = await fetch(host, { cache: "no-store" });
			const j = await r.json();
			if (!j.ok) throw new Error(j.error || "balance failed");
			level = j.level || "ok";
			text = "DeepSeek 余额 " + fmt(j.total) + " " + (j.currency || "CNY");
			if (j.todayConsumed !== null) text += " · 今日 " + fmt(j.todayConsumed);
			const band = fmtBand(j.etaLow, j.etaHigh);
			if (band !== null) {
				text += " · " + band;
				if (j.seeded) text += "（首估）";
			} else if (j.daysLeft !== null) {
				text += " · " + fmtDur(j.daysLeft);
				if (j.seeded) text += "（首估）";
			}
			if (j.dailyRate !== null) text += "（日均 " + fmt(j.dailyRate) + "）";
			if (j.level !== "ok" && j.levelReason) text = "⚠️ " + text + "（" + j.levelReason + "）";
			if (CFG.notify && j.level !== "ok") {
				const fired = localStorage.getItem("dsh-balance-alerted");
				if (fired !== "1") {
					localStorage.setItem("dsh-balance-alerted", "1");
					try {
						if (typeof Notification !== "undefined" && Notification.permission === "granted") {
							new Notification("DeepSeek 余额告警", { body: text });
						}
					} catch { /* notifications unavailable */ }
				}
			} else if (j.level === "ok") {
				localStorage.removeItem("dsh-balance-alerted");
			}
		} catch (e) {
			text = "余额获取失败";
		}
		el.textContent = text;
		el.style.background = BG[level] ?? BG.ok;
	}

	refresh();
	setInterval(refresh, Math.max(5000, CFG.refreshMs));
})();
</script>
`;

	ctx.effect(() => ctx.webServer.tapIndex((html) => {
		if (html.includes('data-dsh-balance-eta="1"')) return html;
		const tagged = script.replace("<script>", '<script data-dsh-balance-eta="1">');
		if (html.includes("</body>")) return html.replace("</body>", tagged + "</body>");
		return html + tagged;
	}), "dsh-balance-eta: index tap");
}
