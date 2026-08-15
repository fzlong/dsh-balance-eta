// dsh-balance-eta — 余额状态胶囊：余额 + 今日消耗 + 可用时长预测 + 低余额告警
//
// DeepSeek Harness (DSH) Web GUI 的极简余额插件。与其他 dsh-plugin 生态中
// "余额/费用"类插件的核心区别：不读 token、不维护价格表、不做按模型计价，
// 只观察官方余额随时间的变化，直接回答"余额还能撑多久"。
//
// 极简数据流（只依赖两个信号）：
//   1. 官方余额 GET https://api.deepseek.com/user/balance
//      （key 经 credentials/env 解析，全程只在服务端使用，绝不落浏览器）
//   2. 今日余额差（当日 opening − 当前余额）+ 当日时间进度
//      → 今日日均消耗 = 今日已消耗 ÷ 今日已过时间占比（安装当天即可出预测）
//
// 价格无关性（本插件的核心卖点）：官方调价（含峰谷时段、涨价/降价）不需要
// 更新本插件——消耗速率直接反映在余额下降速度上，预测自动跟随，永久免维护。
//
// 数据流：
//   GET /api/dsh-balance-eta
//     -> 官方 /user/balance
//     -> 读/写 $DSH_HOME/storages/balance-eta.json
//     -> 返回 { ok, total, currency, todayConsumed, dailyRate, daysLeft,
//               seeded, level, levelReason }
//
// 配置（cordis.patch.yml 的 config，均可选）：
//   apiKeyEnv      凭据 ref，默认 DEEPSEEK_API_KEY
//   refreshMs      客户端刷新间隔毫秒，默认 60000
//   lowBalanceCny  低余额告警阈值（元），默认 5
//   warnDaysLeft   可用天数告警阈值（天），默认 3
//   notify         余额过低时浏览器通知，默认 true

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export const name = "dsh-balance-eta-window";
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

/** 金额按分取整，消除浮点噪声（0.2600000000000007 → 0.26）。 */
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

/**
 * 组合余额状态：返回 { todayConsumed, dailyRate, daysLeft, seeded }。
 * - todayConsumed：当日 opening − 当前（余额上升视为 0）。
 * - dailyRate（预测核心）：滑动窗口速率——取「今日 + 最近若干日」的余额快照，
 *   用首尾差额 ÷ 实际时间跨度算出每 24 小时平均消耗。
 *   相比"今日消耗 ÷ 今日已过时间占比"，窗口法没有日内漂移（早上不会虚高、
 *   晚上不会虚低），且天然平滑（窗口内有多个点）。
 *   窗口取最近 7 个快照（含今天），至少需要 2 个点才有速率。
 * - daysLeft = 余额 ÷ dailyRate。
 */
function analyze(state, total, nowMs) {
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

	// 滑动窗口速率：取最近 7 个快照（含今天），首尾差额 ÷ 实际时间跨度。
	// 时间跨度用首快照当天 0 点 -> 现在，避免把整天外的空档算进消耗。
	const window = days.slice(-7);
	let dailyRate = null;
	if (window.length >= 2) {
		const first = window[0];
		const spanMs = nowMs - new Date(first.date + "T00:00:00").getTime();
		const spanDays = Math.max(1, spanMs / DAY_MS);
		const consumed = first.balance - total;
		if (consumed > 0.001) dailyRate = consumed / spanDays;
	}

	const seeded = dailyRate !== null && (state?.days ?? []).length < 2;
	const daysLeft = dailyRate !== null && total > 0 ? total / dailyRate : null;

	writeState(statePath(), { days, opening, last: { t: nowMs, balance: total } });
	return { todayConsumed, dailyRate, daysLeft, seeded };
}

export function apply(ctx, config = {}) {
	const apiKeyEnv = config.apiKeyEnv ?? "DEEPSEEK_API_KEY";
	const refreshMs = config.refreshMs ?? 60000;
	const lowBalanceCny = config.lowBalanceCny ?? 5;
	const warnDaysLeft = config.warnDaysLeft ?? 3;
	const notify = config.notify !== false;

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
					// 非 CNY 账户：如实报告可用币种，不伪造 ¥0.00。
					const currencies = (data.balance_infos ?? []).map((b) => b.currency).join(", ");
					json(res, 200, { ok: false, error: `账户没有人民币余额行（可用币种: ${currencies || "未知"}），本插件仅支持 CNY` });
					return;
				}
				const total = Number(cny.total_balance ?? 0);
				const nowMs = Date.now();

				const state = readState(statePath());
				const { todayConsumed, dailyRate, daysLeft, seeded } = analyze(state, total, nowMs);

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
			if (j.daysLeft !== null) {
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
