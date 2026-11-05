/**
 * 页面侧的假后端 —— 由 web/test-scroll.mjs 在页面脚本之前注入
 * （CDP 的 Page.addScriptToEvaluateOnNewDocument）。
 *
 * 只做一件事：把 /api/* 与 EventSource 换成内存里的实现。
 * 于是滚动测试用的是**真的** index.html / app.mjs / app.css，
 * 但一个真请求都不发 —— 不 ensure 会话、不开真 SSE、不写任何会话文件，
 * 因此完全不碰会话基底 A 的池子。
 *
 * 左栏用假树，但刻意造齐了三种节点，好把「存档箱」和「分支折叠」都验到：
 *   · 活的根（撑满左栏，几何断言才有意义）
 *   · 无父的已存档   → 收进底部「存档 ▸ N」
 *   · 挂在某支下的已存档 → 挂成父节点上的「▸N」
 */
(() => {
	const LIVE_ROOT = 'aaaabbbb-1111-2222-3333-444455556666';
	const sid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
	const now = Date.now();
	const nodes = [];
	const add = (id, parent, name, archived, age = 0, extra = {}) =>
		nodes.push({ id, parent, name, cwd: '/tmp/mock', archived, streaming: false, lastActivity: now - age, ...extra });

	// ── 主会话（滚动测试点开的那个）──
	add(LIVE_ROOT, null, '主会话', false, 0);
	add(sid(1), LIVE_ROOT, '活的子会话', false, 1);
	// 挂在主会话这一支下面的已存档：10 个子 + 1 个孙 = 折叠标记应显示 ▸11
	const ARCHIVED_CHILDREN = 10;
	for (let i = 0; i < ARCHIVED_CHILDREN; i++) add(sid(10 + i), LIVE_ROOT, `存档子会话 ${i}`, true, 10 + i);
	add(sid(30), sid(10), '存档孙会话', true, 30);
	const FOLDED_UNDER_LIVE_ROOT = ARCHIVED_CHILDREN + 1;

	// ── 嵌套折叠（回归：展开父不该顺手展开「活子会话」自己的归档支）──
	// 只在 ?nestedfold=1 时加进树 → 老测试的行数/几何一行不动。
	// 形状（照抄真树上那条：01a090ea → 01a09376 → 01a09a14）：
	//   NF_P（非归档，根）── 下面既有归档孩子，也有一个**非归档的活子** NF_C
	//   NF_C（非归档，活）── 它自己也有归档孩子 NF_A3（所以它自己也带折叠标记）
	// 期望：点 NF_P 的标记只掀开 NF_P 那一层该露的归档（NF_A1/NF_A2）；
	//       NF_C 自己的标记该保持 ▸1，NF_A3 不该冒出来（用户没点过 NF_C）。
	const NESTED = new URLSearchParams(location.search).get('nestedfold');
	const NF_P = sid(500);
	const NF_C = sid(501);
	const NF_A1 = sid(502);
	const NF_A2 = sid(503);
	const NF_A3 = sid(504);
	// 再一条形状（同样只在 ?nestedfold=1 时）：**归档支里夹着一个活节点**。
	//   LA_P（非归档，根）── LA_A（归档）── LA_L（非归档活）── LA_G（归档）
	// 盯的是「祖先的掀开只沿归档节点下传」在**这一层**上的正脸：掀开 LA_P 之后
	// LA_A 与夹在它支里的活节点 LA_L 会一起露（LA_L 本来就该可见），
	// 但 LA_L 自己那个标记（▸1）管的 LA_G 不该跟着露 —— 它在 LA_L 还没说过话的时候归 LA_L。
	// 另一个根（不挂在 NF_P 下）→ NF_P 那一支的计数/行数一行不受影响。
	const LA_P = sid(510);
	const LA_A = sid(511);
	const LA_L = sid(512);
	const LA_G = sid(513);
	if (NESTED) {
		add(NF_P, null, '嵌套折叠·父（活）', false, 6);
		add(NF_C, NF_P, '嵌套折叠·活子（活）', false, 7);
		add(NF_A1, NF_P, '嵌套折叠·父的存档 1', true, 8);
		add(NF_A2, NF_P, '嵌套折叠·父的存档 2', true, 9);
		add(NF_A3, NF_C, '嵌套折叠·活子自己的存档', true, 60);
		add(LA_P, null, '归档支里的活节点·根（活）', false, 6);
		add(LA_A, LA_P, '归档支里的活节点·归档父', true, 7);
		add(LA_L, LA_A, '归档支里的活节点·活子', false, 8);
		add(LA_G, LA_L, '归档支里的活节点·活子自己的存档', true, 9);
	}

	// ── 「未读」：mock 在这里扮 A（真的那份在 $ASSIST_HOME/{settled,seen}.json 两个 sidecar 里）──
	// 判据（与 A 一致）：unread = **最后一次落定 > 我最后一次 seen**，且没归档；
	// 「被归档祖先藏住」的整支静音（hiddenByArchive）、也不计入树顶那个数字。
	// 这份状态**必须跨页面 reload 存活** —— 否则「刷新后红点仍在」就成了自己跟自己说话；
	// 所以放 sessionStorage：那是**mock 这个假服务端**的家，不是前端在用 localStorage
	//（前端只走 /api；测试里另有断言盯着 localStorage 必须是空的）。
	// 场景只在 `?unread=<名>` 时生效 → 老测试的树几何/行数一行不动。
	const SCENARIO = new URLSearchParams(location.search).get('unread');
	const STORE_KEY = 'mockUnreadState';
	// storeIsNew：这个场景的时间戳**只在头一次**写成 —— 否则每次 reload 都把「我看过」重置，
	// 「刷新后红点仍在」就成了自己跟自己说话。要重来一遍就 forgetUnread()（见 test-scroll 的 HELPERS）。
	const [store, storeIsNew] = (() => {
		try {
			const s = JSON.parse(sessionStorage.getItem(STORE_KEY));
			if (s && s.scenario === SCENARIO) return [s, false];
		} catch {}
		return [{ scenario: SCENARIO, seen: {}, settled: {} }, true];
	})();
	const saveStore = () => sessionStorage.setItem(STORE_KEY, JSON.stringify(store));

	// 场景用的五个会话（**只在 ?unread=... 时加进树**）：造齐「未读 / 已读 / 未读+在跑 / 藏住」四种情形
	const U_OLD = sid(400); // 未读：落定最久 → 树顶那一行该跳它
	const U_NEW = sid(401); // 未读：落定较新
	const U_RUN = sid(402); // 未读 **且**在跑 —— 同一时刻只画**一个**点：红点优先，脉冲环让位
	const R_READ = sid(403); // 已读：我上次看它比它落定晚
	const H_LIVE = sid(404); // 活子会话，但父（sid(10)）是归档的 → 藏住：不亮、不计数
	if (SCENARIO) {
		add(U_OLD, LIVE_ROOT, '未读·旧', false, 40);
		add(U_NEW, LIVE_ROOT, '未读·新', false, 5);
		add(U_RUN, LIVE_ROOT, '未读·在跑', false, 1, { streaming: true });
		add(R_READ, LIVE_ROOT, '已读', false, 50);
		add(H_LIVE, sid(10), '藏住的活子会话', false, 20);
		const t = Date.now();
		if (SCENARIO === '1' && storeIsNew) {
			// 服务端的两个时间戳（ms）。sid(10) 是「已归档 + 有新落定」→ 不该算未读。
			store.settled = {
				[U_OLD]: t - 3_600_000,
				[U_NEW]: t - 120_000,
				[U_RUN]: t - 60_000,
				[R_READ]: t - 300_000,
				[sid(10)]: t - 30_000,
				[H_LIVE]: t - 45_000,
			};
			store.seen = { [R_READ]: t - 200_000 }; // 只看过「已读」那个
		}
		saveStore();
	}

	// 被 `__gone` 拿掉的会话（模拟「会话被删 / 换掉」）—— 连同后代一起从假树里消失，
	// 用来验前端那份**内存态**（expanded / collapsed）会把这种 id 剔掉。
	const gone = new Set();

	/** 按 A 的口径算一遍：每个节点的 unread/settledAt/seenAt/hiddenByArchive + 汇总。
	 *  每次请求现算（store 会变）—— 前端只负责画，不自己推导。 */
	const treeWithUnread = () => {
		const goneWithKids = new Set();
		{
			const byId0 = new Map(nodes.map((n) => [n.id, n]));
			const underGone = (n) => {
				const seen = new Set([n.id]);
				for (let p = n.parent ? byId0.get(n.parent) : null; p && !seen.has(p.id); p = p.parent ? byId0.get(p.parent) : null) {
					if (gone.has(p.id)) return true;
					seen.add(p.id);
				}
				return false;
			};
			for (const n of nodes) if (gone.has(n.id) || underGone(n)) goneWithKids.add(n.id);
		}
		const alive = nodes.filter((n) => !goneWithKids.has(n.id));
		const byId = new Map(alive.map((n) => [n.id, n]));
		const hiddenByArchive = (n) => {
			const visited = new Set([n.id]);
			let p = n.parent ? byId.get(n.parent) : null;
			while (p && !visited.has(p.id)) {
				if (p.archived) return true;
				visited.add(p.id);
				p = p.parent ? byId.get(p.parent) : null;
			}
			return false;
		};
		const out = alive.map((n) => {
			const settledAt = store.settled[n.id] ?? null;
			const seenAt = store.seen[n.id] ?? null;
			return { ...n, settledAt, seenAt, unread: !n.archived && (settledAt ?? 0) > (seenAt ?? 0), hiddenByArchive: hiddenByArchive(n) };
		});
		const vis = out
			.filter((n) => n.unread && !n.hiddenByArchive)
			.sort((a, b) => a.settledAt - b.settledAt || String(a.id).localeCompare(String(b.id)));
		const head = vis[0];
		return { nodes: out, unread: { count: vis.length, oldestId: head?.id ?? null, oldestName: head?.name ?? null, oldestAt: head?.settledAt ?? null } };
	};

	// ── 一堆活的根：让左栏高过一屏（否则「贴底、不随树滚」是白测）──
	const LIVE_ROOTS = 40;
	for (let i = 0; i < LIVE_ROOTS; i++) add(sid(100 + i), null, `根会话 ${i}`, false, 100 + i);

	// ── 无父的已存档：底部「存档 ▸ N」就是数它们的 ──
	const ARCHIVED_ROOTS = 3;
	for (let i = 0; i < ARCHIVED_ROOTS; i++) add(sid(200 + i), null, `存档根 ${i}`, true, 200 + i);

	// ── 斜杠命令（假数据，形状/字段对齐真实 GET /sessions/{id}/commands）──
	// 真清单 = pi 的内置命令（BUILTIN_SLASH_COMMANDS，每条带 runnable/reason/tag/via）
	//         + 扩展命令 + 提示模板 + 技能命令。这里造一份覆盖三种情形的：
	//   · via:"compact"/"model"  → webui 真的能执行（走自己的路由）
	//   · runnable:false          → 内置但 webui 没接（标出来、点了要解释）
	//   · source:extension/prompt/skill → 经 session.prompt 执行
	const builtin = (name, description, extra = {}) => ({
		name, description, source: 'builtin', argumentHint: null, path: null, builtin: true,
		runnable: false, reason: `TUI 专用（${name}）`, tag: 'TUI 专用', via: null, hint: null, shadowed: null, ...extra,
	});
	const COMMANDS = [
		builtin('compact', 'Manually compact the session context', { runnable: true, reason: null, tag: null, via: 'compact', hint: '点上下文用量那行的「压缩」，或发 /compact（有损，会先二次确认）' }),
		builtin('model', 'Select model (opens selector UI)', { argumentHint: '<provider/model>', runnable: true, reason: null, tag: null, via: 'model', hint: '发 /model <provider/model>' }),
		builtin('tree', 'Navigate session tree (switch branches)', { reason: 'webui 用左栏的会话树（点节点就切）', tag: '看左栏树' }),
		builtin('new', 'Start a new session', { reason: 'webui 用左栏的「＋ 新会话」', tag: '用＋新会话' }),
		{ name: 'review', description: '审阅改动', source: 'prompt', argumentHint: '<path>', path: '/mock/review.md', builtin: false, runnable: true, reason: null, tag: null, via: 'prompt', hint: null, shadowed: null },
		{ name: 'skill:on-write', description: 'Write-phase skill.', source: 'skill', argumentHint: null, path: '/mock/on-write/SKILL.md', builtin: false, runnable: true, reason: null, tag: null, via: 'prompt', hint: null, shadowed: null },
		{ name: 'skill:on-submit', description: 'Submit-phase skill.', source: 'skill', argumentHint: null, path: '/mock/on-submit/SKILL.md', builtin: false, runnable: true, reason: null, tag: null, via: 'prompt', hint: null, shadowed: null },
	];

	// ── 可用模型（假数据，形状对齐 GET /sessions/{id}/models）──
	const MODELS = [
		{ provider: 'litellm', id: 'deepseek-flash', name: 'DeepSeek Flash', ref: 'litellm/deepseek-flash', reasoning: false, contextWindow: 900000, current: true },
		{ provider: 'litellm', id: 'gpt-6-astra', name: 'GPT-6 Astra', ref: 'litellm/gpt-6-astra', reasoning: true, contextWindow: 400000, current: false },
		{ provider: 'litellm', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', ref: 'litellm/gpt-5.6-sol', reasoning: true, contextWindow: 200000, current: false },
	];

	window.__fixture = {
		id: LIVE_ROOT,
		child: sid(1), // 活的子会话（标题实时性那一段改的就是它 —— 改一个**没打开**的会话的标题）
		archivedRoots: ARCHIVED_ROOTS,
		foldedUnderLiveRoot: FOLDED_UNDER_LIVE_ROOT,
		// 主会话那一支里的**归档**孩子（它自己还带一个归档孩子）：掀开主会话之后，
		// 这两个会一起露出来 —— 用来盯「归档节点被祖先掀开，标记却还写 ▸1」那个空开关。
		// 三态之后它该是 ▾1（生效=开），点它一次就是真收起。
		archChild: sid(10),
		archGrandchild: sid(30),
		// 命令面板用的**假**清单：形状对齐真实 GET /sessions/{id}/commands，
		// 但内容是造的（真清单是那个 agent dir 的内置命令 + 技能/模板/扩展命令，见 README）。
		commands: COMMANDS.map((c) => c.name),
		runnableCommands: COMMANDS.filter((c) => c.runnable).map((c) => c.name),
		deadCommands: COMMANDS.filter((c) => !c.runnable).map((c) => c.name),
		models: MODELS.map((m) => m.ref),
		currentModel: 'litellm/deepseek-flash',
		// 「未读」场景里的五个会话（只在 ?unread=... 时存在）+ 期望的数字。
		// archivedChild（sid(10)）是树上那个**已归档**的孩子：它有新落定，但不该算未读。
		unread: SCENARIO
			? { old: U_OLD, new: U_NEW, running: U_RUN, read: R_READ, hiddenLive: H_LIVE, archivedChild: sid(10), count: 3 }
			: null,
		// 嵌套折叠那条形状（只在 ?nestedfold=1 时存在）。分两个「点它露出几个」的口径：
		//   pFoldNow = ① 之前那个宽口径会算出的数（把活子那一支的归档也数进来）—— 只用在失败信息里；
		//   pFoldRight = 点它**该**露出几个（只有 NF_P 自己那一层：NF_A1/NF_A2）。
		// NF_C 自己的归档（NF_A3）属于 NF_C 自己的标记管。
		nested: NESTED
			? {
					p: NF_P,
					c: NF_C,
					a1: NF_A1,
					a2: NF_A2,
					a3: NF_A3,
					pFoldNow: 3,
					pFoldRight: 2,
					cFold: 1,
					// 归档支里夹着活节点那条（LA_P → LA_A → LA_L → LA_G）：
					// pFold = 掀开 LA_P 能露出的**存档**行数（LA_A 1 个；里面那个活节点不记账），
					// pOpenRows = 它点开后树上真会多几行（存档父 + 夹在里面的活节点）。
					liveArch: { p: LA_P, a: LA_A, l: LA_L, g: LA_G, pFold: 1, pOpenRows: 2, lFold: 1 },
				}
			: null,
	};

	/** 「落定」发生了一下（= 插件 agent_settled → POST /sessions/{id}/settled 那一瞬）。
	 *  测试用它模拟「后台会话落定了」—— 要不要重画由 /tree 的说法决定。 */
	window.__settle = (id, at) => {
		store.settled[id] = at ?? Date.now();
		saveStore();
	};
	/** 看 mock 这个假服务端的账（大致对应 A 的 settled.json + seen.json）。 */
	window.__unreadState = () => JSON.parse(JSON.stringify(store));
	/** 把某个会话（连它的后代）从假树里拿掉 / 放回来 —— 「会话被删 / 换掉」那种事。
	 *  拿来验前端那份内存态（expanded / collapsed）会把这种 id 剔掉：不剔的话，
	 *  同一个 id 再出现时会凭空开合（脏 expanded = 自己开着；脏 collapsed = 被按成
	 *  「显式关」而看着像「点了没反应」）。见 G5 那一段。 */
	window.__gone = (id, yes = true) => {
		const before = gone.size;
		yes ? gone.add(id) : gone.delete(id);
		return { changed: gone.size !== before, now: [...gone] };
	};

	// ── 正文：足够长，保证消息区真的能滚 ──
	const long = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} 第 ${i} 行：` + '中文内容占位'.repeat(3)).join('\n');
	const HISTORY = [
		{ role: 'user', text: '这是第一条用户消息' },
		{ role: 'assistant', text: long(60, '历史回复') },
		{ role: 'user', text: '再问一句' },
		{ role: 'assistant', text: long(40, '历史回复二') },
		// 交错 parts：数据层本来就是 thinking→text→tool→thinking→tool。
		// 渲染必须原样保留这个顺序（Bug 1 的历史路径）。
		{
			role: 'assistant',
			parts: [
				{ type: 'thinking', text: '历史思考 甲' },
				{ type: 'text', text: '历史正文' },
				{ type: 'tool', id: 'h1', name: 'bash', args: { command: 'ls' }, result: 'ok' },
				{ type: 'thinking', text: '历史思考 乙' },
				{ type: 'tool', id: 'h2', name: 'read', args: { path: '/tmp/x' }, result: 'ok' },
			],
		},
	];

	const J = (o, code = 200) => new Response(JSON.stringify(o), { status: code, headers: { 'Content-Type': 'application/json' } });

	window.__net = [];
	window.__bodies = [];
	// 上下文用量默认值（测试可改 window.__ctx：数字 / 窗满 / 未知 / null）
	window.__ctx = { tokens: 543754, contextWindow: 900000, percent: 60.41711111111111, reserveTokens: 16384, compactAt: 883616, freeTokens: 339862, autoCompact: true, keepRecentTokens: 20000 };
	// 压过一次之后：用量变 null（等下一次 LLM 响应）+ 正文变短 —— 测「压完真的刷新了」
	window.__compacted = false;
	window.fetch = async (url, init) => {
		const u = String(url);
		window.__net.push((init?.method ?? 'GET') + ' ' + u);
		if (init?.body) window.__bodies.push({ url: u, method: init.method ?? 'GET', body: init.body });
		if (u.includes('/api/tree')) return J(treeWithUnread());
		// 「我看过了」（= POST /sessions/{id}/seen）：记在服务端，时间用服务端的 now
		if (u.includes('/seen')) {
			const id = u.split('/sessions/')[1].split('/')[0];
			store.seen[id] = Date.now();
			saveStore();
			return J({ ok: true, id, seenAt: store.seen[id], unread: false });
		}
		// 上下文用量：形状对齐真实路由（id / hot / streaming / compacting / context）
		if (u.includes('/context'))
			return location.search.includes('ctxNull')
				? J({ id: LIVE_ROOT, hot: true, streaming: false, compacting: false, context: null })
				: J({ id: LIVE_ROOT, hot: true, streaming: false, compacting: false, context: window.__compacted ? { ...window.__ctx, tokens: null, percent: null, freeTokens: null } : window.__ctx });
		// 模型清单：形状对齐真实路由（id / hot / current / source / models）
		if (u.includes('/models'))
			return J({ id: LIVE_ROOT, hot: true, current: window.__model ?? 'litellm/deepseek-flash', source: 'available', models: MODELS.map((m) => ({ ...m, current: m.ref === (window.__model ?? 'litellm/deepseek-flash') })), error: null });
		// 手动压缩：形状对齐真实路由（成功 → tokensBefore/estimatedTokensAfter/freed；失败 → code + error）
		if (u.endsWith('/compact')) {
			if (location.search.includes('compactNone'))
				return J({ ok: false, code: 'nothing-to-compact', error: '没有可压缩的东西 —— 这个会话要么太短（还没超出保留预算），要么刚压过。pi 的原话：Nothing to compact (session too small)' }, 409);
			if (location.search.includes('compactFail')) return J({ ok: false, code: 'failed', error: '压缩失败：boom' }, 500);
			if (location.search.includes('compactBusy')) return J({ ok: false, code: 'streaming', error: '会话正在跑 —— pi 的手动压缩会先 abort 掉当前这一轮，所以这里不硬来：等这一轮跑完再压。' }, 409);
			window.__compacted = true;
			return J({ ok: true, id: LIVE_ROOT, code: 'compacted', tokensBefore: 543754, estimatedTokensAfter: 12345, freed: 531409, summaryChars: 900, context: null });
		}
		// 切模型：形状对齐真实路由（成功 → model；失败 → code + error）
		if (u.endsWith('/model')) {
			const want = (() => { try { return JSON.parse(init.body).model; } catch { return null; } })();
			if (location.search.includes('modelBad')) return J({ ok: false, code: 'model-not-found', error: `这个会话的可选模型里没有「${want}」` }, 404);
			window.__model = want;
			return J({ ok: true, id: LIVE_ROOT, model: want, matched: 'provider/id', source: 'available', persist: false, status: { model: want } });
		}
		// 命令清单：形状对齐真实路由（id / streaming / compacting / canRun / commands / builtinError / builtinHow）。
		// streaming 用 URL query 开关（mock 每次导航重新注入）。
		if (u.includes('/commands'))
			return J({
				id: LIVE_ROOT,
				streaming: location.search.includes('cmdsStreaming'),
				compacting: false,
				canRun: !location.search.includes('cmdsStreaming'),
				commands: location.search.includes('cmdsEmpty') ? [] : COMMANDS,
				builtinError: null,
				builtinHow: '/mock/slash-commands.js',
			});
		if (u.includes('/messages'))
			return J({
				messages: location.search.includes('cut')
					? JSON.parse(JSON.stringify(HISTORY))
					: window.__compacted
						? [{ role: 'user', text: '（压缩后的摘要）' }, { role: 'assistant', text: '压缩之后的回复' }]
						: JSON.parse(JSON.stringify(HISTORY)),
				// 压缩边界：形状对齐真实路由（firstKeptEntryId / atIndex / tokensBefore / summary / at）。
				// 没压过 → null。压完 → atIndex=0（前面的全被摘要替了）。?cut=1 → 边界落在中间（第 3 条）。
				compaction: location.search.includes('cut')
					? { firstKeptEntryId: 'h3', atIndex: 2, tokensBefore: 543754, summary: '## Goal\n（合成摘要）把前两条提成了一段总结。', at: '2026-01-01T00:00:00.000Z' }
					: window.__compacted
						? { firstKeptEntryId: 'k1', atIndex: 0, tokensBefore: 543754, summary: '## Goal\n（合成摘要）压缩前的 4 条已不在上下文里。', at: '2026-01-01T00:00:00.000Z' }
						: null,
			});
		if (u.includes('/message')) return J({ ok: true, status: { streaming: true } });
		if (u.includes('/api/sessions')) return J({ id: LIVE_ROOT });
		return J({ ok: true });
	};

	/** 假 SSE：测试用 __es._emit() 手动喂事件，走的是和真 SSE 同一条
	 *  onmessage → handle() → mark() → flush() 路径。
	 *  ⚠️ 两条流要分开记：树级（/api/events）与会话级（/api/sessions/{id}/stream）。
	 *  老测试用的 `window.__es` 必须**永远只指会话那条** —— `__h.emit()` 往它上面喂流式 delta；
	 *  树级那条放 `window.__treeES`（用 `window.__titleEvent()` 喂标题）。 */
	class FakeES {
		constructor(url) {
			this.url = url;
			this.readyState = 1;
			if (String(url).includes('/events')) window.__treeES = this;
			else window.__es = this;
			setTimeout(() => {
				this.onopen && this.onopen();
				if (this.onmessage) this._emit({ t: 'hello', status: { streaming: false } });
			}, 0);
		}
		_emit(o) {
			this.onmessage && this.onmessage({ data: JSON.stringify(o) });
		}
		close() {
			this.closed = true;
			if (window.__es === this) window.__es = null;
			if (window.__treeES === this) window.__treeES = null;
		}
	}
	window.EventSource = FakeES;
	/** 树级事件：某个会话的标题变了（= A 的 GET /events 推的 `{t:"title"}`）。
	 *  **不改 mock 的 /tree** —— 名字只能从这条事件进到页面里，测试才验得到「实时」。 */
	window.__titleEvent = (id, name, source = 'auto') => {
		if (!window.__treeES) return false;
		window.__treeES._emit({ t: 'title', id, name, source, at: Date.now() });
		return true;
	};
	window.__ID = LIVE_ROOT;
})();
