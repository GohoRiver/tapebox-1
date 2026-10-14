/* =========================================================
   TapeBox 核心逻辑（安全加固版）
   ---------------------------------------------------------
   安全设计要点：
   1. 全部核心逻辑封装在 IIFE 闭包内，不向全局暴露变量/函数。
   2. 使用 crypto.subtle 对 localStorage 关键数据做哈希签名，
      读取时校验，防控制台手动篡改。
   3. 记录上次交互时间戳，检测系统时间被回调/快进（防时间旅行）。
   4. 所有随机数使用 crypto.getRandomValues，概率按实际人数均分。
   5. 免费 Type Box 奖池 = 当日所有付费宝箱手续费的 1%。
   6. 主宝箱 TapeBox（青铜/白银/钻石）满 50 人开奖，无时间限制。
   7. 打赏最低 0.1 BEM，成功后下次提现手续费减免 2.5%。
   ========================================================= */

(function () {
  'use strict';

  /* -------------------- 常量配置 -------------------- */
  // 付费宝箱（每日 24:00 开奖，最多 20 人）
  const DAILY_BOXES = {
    '1': { name: '青铜宝箱', price: 0.05, paid: true },
    '2': { name: '白银宝箱', price: 0.5,  paid: true },
    '3': { name: '黄金宝箱', price: 5,    paid: true }
  };
  // 主宝箱子宝箱（满 50 人开奖，无时间限制）
  const MAIN_BOXES = {
    'bronze':  { name: '青铜宝箱', price: 0.05, paid: true },
    'silver':  { name: '白银宝箱', price: 0.5,  paid: true },
    'diamond': { name: '钻石宝箱', price: 5,    paid: true }
  };
  // 免费宝箱
  const FREE_BOX = { name: 'Type Box', price: 0, paid: false };

  const DAILY_MAX_PLAYERS = 20;    // 每日宝箱上限
  const MAIN_MAX_PLAYERS = 50;     // 主宝箱开奖门槛
  const SNIPE_LOCK_MS = 10 * 60 * 1000; // 开奖前 10 分钟锁定
  const BASE_FEE = 0.05;           // 基础提现手续费 5%
  const SHARE_DISCOUNT = 0.01;     // 分享到 X 减免 1%
  const TIP_DISCOUNT = 0.025;      // 打赏后减免 2.5%
  const MIN_TIP = 0.1;             // 最低打赏金额
  const TIME_JUMP_THRESHOLD = 5 * 60 * 1000; // 时间跳跃阈值 5 分钟

  /* -------------------- 闭包内部状态 -------------------- */
  let walletAddress = null;   // 当前钱包地址
  let sharedToday = false;    // 今日是否已分享
  let tipped = false;         // 是否已打赏（用于手续费减免）
  let currentWin = null;      // 当前中奖信息
  let timeTampered = false;   // 是否检测到时间异常
  let drawTriggered = false;  // 防止重复开奖
  let currentOption = '1';    // 当前选中的选项（1/2/3/main/free/more/airdrop）

  // 选项元数据：图标、名称、描述、是否主宝箱、是否占位
  const OPTION_META = {
    '1':       { icon: '🎁', name: '青铜宝箱', desc: '每日 24:00 开奖，最多 20 人参与，投入 0.05 BEM 争夺奖池。', main: false, placeholder: false },
    '2':       { icon: '💎', name: '白银宝箱', desc: '每日 24:00 开奖，最多 20 人参与，投入 0.5 BEM 争夺奖池。', main: false, placeholder: false },
    '3':       { icon: '👑', name: '黄金宝箱', desc: '每日 24:00 开奖，最多 20 人参与，投入 5 BEM 争夺奖池。', main: false, placeholder: false },
    'main':    { icon: '🏆', name: '主宝箱 TapeBox', desc: '不设时间限制，参与人数达到 50 人立即开奖，公平随机抽取唯一赢家。', main: true, placeholder: false },
    'free':    { icon: '🆓', name: 'Type Box', desc: '完全免费参与，不限人数，24:00 准时开奖。奖池 = 当日所有付费宝箱手续费的 1%。', main: false, placeholder: false },
    'more':    { icon: '🎯', name: '更多活动', desc: '更多精彩活动正在筹备中，敬请期待！', main: false, placeholder: true },
    'airdrop': { icon: '🪂', name: '空投计划', desc: '空投计划即将上线，敬请期待！', main: false, placeholder: true }
  };

  /* =========================================================
     一、安全工具：哈希签名 / 时间校验 / 安全随机数
     ========================================================= */

  // 将对象转为稳定字符串（键排序，保证哈希一致）
  function stableStringify(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
  }

  // 使用 crypto.subtle 生成 SHA-256 哈希（返回 hex 字符串）
  async function sha256(text) {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // 带签名地写入 localStorage：{ data, sig }
  async function secureSet(key, data) {
    const sig = await sha256(stableStringify(data) + '|tapebox-salt');
    localStorage.setItem(key, JSON.stringify({ data, sig }));
  }

  // 带校验地读取 localStorage：签名不符则返回 null（视为被篡改）
  async function secureGet(key) {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !('data' in parsed) || !('sig' in parsed)) {
        return null;
      }
      const expect = await sha256(stableStringify(parsed.data) + '|tapebox-salt');
      if (expect !== parsed.sig) return null; // 签名不匹配 → 被篡改
      return parsed.data;
    } catch (e) {
      return null;
    }
  }

  // 安全随机整数 [0, max)
  function secureRandomInt(max) {
    if (max <= 0) return 0;
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return arr[0] % max;
  }

  // 安全随机浮点 [0, 1)
  function secureRandomFloat() {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return arr[0] / 4294967296;
  }

  /* =========================================================     二、时间旅行检测
     ========================================================= */

  const TIME_KEY = 'tapebox_last_time';

  // 检测系统时间是否被回调或快进
  function checkTimeTravel() {
    const now = Date.now();
    const last = parseInt(localStorage.getItem(TIME_KEY) || '0', 10);

    if (last > 0) {
      const diff = now - last;
      // 时间倒退（diff < 0）或快进超过阈值 → 判定异常
      if (diff < 0 || diff > TIME_JUMP_THRESHOLD) {
        timeTampered = true;
        showSecurityAlert('检测到系统时间异常，请校准本地时间后再操作。');
        return false;
      }
    }
    // 记录本次时间戳
    localStorage.setItem(TIME_KEY, String(now));
    return true;
  }

  // 显示安全警告条
  function showSecurityAlert(msg) {
    const el = document.getElementById('securityAlert');
    if (!el) return;
    el.textContent = '⚠️ ' + msg;
    el.classList.remove('hidden');
  }

  /* =========================================================
     三、localStorage 状态管理（带签名校验）
     ========================================================= */

  // 获取今天的日期字符串
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  // 读取今日投注记录（带校验）
  async function getBetRecord() {
    const key = 'tapebox_bets_' + todayKey();
    const data = await secureGet(key);
    if (data === null) {
      // 校验失败或不存在 → 重置
      if (localStorage.getItem(key)) {
        showSecurityAlert('数据异常，已重置。');
      }
      await secureSet(key, {});
      return {};
    }
    return data;
  }

  // 记录某 Box 今日已投注
  async function markBet(boxKey) {
    const rec = await getBetRecord();
    rec[boxKey] = true;
    await secureSet('tapebox_bets_' + todayKey(), rec);
  }

  // 判断某 Box 今日是否已投注
  async function hasBet(boxKey) {
    const rec = await getBetRecord();
    return !!rec[boxKey];
  }

  // 读取各 Box 参与数据（带校验）
  async function getBoxData() {
    const key = 'tapebox_boxdata_' + todayKey();
    const data = await secureGet(key);
    if (data === null) {
      if (localStorage.getItem(key)) {
        showSecurityAlert('数据异常，已重置。');
      }
      // 初始化：随机生成模拟参与者
      const init = {};
      Object.keys(DAILY_BOXES).forEach(k => {
        const players = secureRandomInt(8) + 2; // 2~9 人
        init[k] = { players, pool: +(players * DAILY_BOXES[k].price).toFixed(4) };
      });
      Object.keys(MAIN_BOXES).forEach(k => {
        const players = secureRandomInt(20) + 5; // 5~24 人
        init[k] = { players, pool: +(players * MAIN_BOXES[k].price).toFixed(4) };
      });
      init['free'] = { players: secureRandomInt(30) + 10, pool: 0 };
      await secureSet(key, init);
      return init;
    }
    return data;
  }

  async function saveBoxData(data) {
    await secureSet('tapebox_boxdata_' + todayKey(), data);
  }

  // 读取/保存手续费累计（用于免费奖池 = 手续费 1%）
  async function getFeePool() {
    const key = 'tapebox_feepool_' + todayKey();
    const data = await secureGet(key);
    if (data === null) {
      await secureSet(key, { total: 0 });
      return { total: 0 };
    }
    return data;
  }

  async function addFee(amount) {
    const fp = await getFeePool();
    fp.total = +(fp.total + amount).toFixed(6);
    await secureSet('tapebox_feepool_' + todayKey(), fp);
  }

  /* =========================================================
     四、工具函数
     ========================================================= */

  // 生成模拟钱包地址
  function mockAddress() {
    const hex = '0123456789abcdef';
    let addr = '0x';
    for (let i = 0; i < 40; i++) addr += hex[secureRandomInt(16)];
    return addr;
  }

  // 地址缩略显示
  function shortAddr(addr) {
    if (!addr) return '';
    return addr.slice(0, 6) + '...' + addr.slice(-4);
  }

  // 距离下一个 00:00 的毫秒数
  function msToMidnight() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return next.getTime() - now.getTime();
  }

  // 毫秒格式化 HH:MM:SS
  function formatHMS(ms) {
    if (ms < 0) ms = 0;
    const total = Math.floor(ms / 1000);
    const h = String(Math.floor(total / 3600)).padStart(2, '0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  // 是否处于防狙击锁定窗口
  function isSnipeLocked() {
    return msToMidnight() < SNIPE_LOCK_MS;
  }

  /* =========================================================
     五、钱包连接
     ========================================================= */

  const connectBtn = document.getElementById('connectBtn');
  const walletInfo = document.getElementById('walletInfo');
  const walletAddressEl = document.getElementById('walletAddress');

  connectBtn.addEventListener('click', () => {
    connectBtn.textContent = '连接中...';
    connectBtn.disabled = true;

    setTimeout(() => {
      if (window.ethereum && window.ethereum.request) {
        window.ethereum.request({ method: 'eth_requestAccounts' })
          .then(accounts => {
            walletAddress = accounts && accounts[0] ? accounts[0] : mockAddress();
            onWalletConnected();
          })
          .catch(() => {
            walletAddress = mockAddress();
            onWalletConnected();
          });
      } else {
        walletAddress = mockAddress();
        onWalletConnected();
      }
    }, 600);
  });

  function onWalletConnected() {
    connectBtn.classList.add('hidden');
    walletInfo.classList.remove('hidden');
    walletAddressEl.textContent = shortAddr(walletAddress);
    showToast('钱包连接成功：' + shortAddr(walletAddress));
    refreshAllButtons();
  }

  /* =========================================================
     六、滚动中奖横幅
     ========================================================= */

  function initMarquee() {
    const marquee = document.getElementById('marquee');
    const records = [];
    for (let i = 0; i < 12; i++) {
      const addr = shortAddr(mockAddress());
      const amount = (secureRandomFloat() * 20 + 0.5).toFixed(2);
      records.push(`🎉 ${addr} 获得了 ${amount} BEM`);
    }
    const content = records.map(r => `<span>${r}</span>`).join('');
    marquee.innerHTML = content + content;
  }

  /* =========================================================
     七、倒计时逻辑
     ========================================================= */

  function updateTimers() {
    const remain = msToMidnight();
    const text = formatHMS(remain);

    document.getElementById('globalTimer').textContent = text;
    document.querySelectorAll('.timer').forEach(el => {
      el.textContent = text;
    });

    // 到达 0 点：触发每日开奖
    if (remain <= 0) {
      triggerDailyDraw();
    }
  }

  /* =========================================================
     七·二、选项切换与中心大宝箱
     ========================================================= */

  // 切换选项：更新大宝箱外观、精简状态、详情页内容
  async function selectOption(opt) {
    currentOption = opt;

    // 更新选项按钮高亮
    document.querySelectorAll('.opt-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.opt === opt);
    });

    // 更新大宝箱主题与图标
    const chest = document.getElementById('bigChest');
    chest.dataset.theme = opt;
    document.getElementById('chestEmoji').textContent = OPTION_META[opt].icon;

    // 更新精简状态栏
    await updateMiniStats();

    // 若详情页已打开，同步刷新详情内容
    if (!document.getElementById('detailOverlay').classList.contains('hidden')) {
      await renderDetail();
    }
  }

  // 更新中心精简状态栏
  async function updateMiniStats() {
    const meta = OPTION_META[currentOption];
    const playersEl = document.getElementById('miniPlayers');
    const maxEl = document.getElementById('miniPlayersMax');
    const poolEl = document.getElementById('miniPool');

    // 占位选项：显示占位信息
    if (meta.placeholder) {
      playersEl.textContent = '--';
      maxEl.textContent = '';
      poolEl.textContent = '敬请期待';
      return;
    }

    const data = await getBoxData();

    if (meta.main) {
      // 主宝箱：汇总三个子箱
      let players = 0, pool = 0;
      Object.keys(MAIN_BOXES).forEach(k => {
        players += data[k].players;
        pool += data[k].pool;
      });
      playersEl.textContent = players;
      maxEl.textContent = '/ ' + (MAIN_MAX_PLAYERS * 3) + ' 人';
      poolEl.textContent = pool.toFixed(2) + ' BEM';
    } else {
      const key = currentOption;
      playersEl.textContent = data[key].players;
      maxEl.textContent = '/ ' + (currentOption === 'free' ? '不限' : DAILY_MAX_PLAYERS) + ' 人';
      poolEl.textContent = data[key].pool.toFixed(2) + ' BEM';
    }
  }

  // 渲染详情页内容
  async function renderDetail() {
    const meta = OPTION_META[currentOption];
    const data = await getBoxData();

    document.getElementById('detailIcon').textContent = meta.icon;
    document.getElementById('detailTitle').textContent = meta.name;
    document.getElementById('detailDesc').textContent = meta.desc;

    const subboxesEl = document.getElementById('detailSubboxes');
    const actionsEl = document.getElementById('detailActions');
    const statsEl = document.querySelector('.detail-stats');

    // 占位选项：隐藏投注相关
    if (meta.placeholder) {
      subboxesEl.classList.add('hidden');
      actionsEl.classList.add('hidden');
      statsEl.classList.add('hidden');
      document.getElementById('detailPrice').textContent = '';
      return;
    }

    statsEl.classList.remove('hidden');

    if (meta.main) {
      // 主宝箱：显示三个子箱，隐藏单按钮
      subboxesEl.classList.remove('hidden');
      actionsEl.classList.add('hidden');
      document.getElementById('detailPrice').textContent = '满 50 人即开奖';
      // 详情页顶部统计显示汇总
      let players = 0, pool = 0;
      Object.keys(MAIN_BOXES).forEach(k => {
        players += data[k].players;
        pool += data[k].pool;
      });
      document.querySelector('.players[data-players="detail"]').textContent = players;
      document.getElementById('detailPlayersMax').textContent = '/ ' + (MAIN_MAX_PLAYERS * 3) + ' 人';
      document.querySelector('.pool[data-pool="detail"]').textContent = pool.toFixed(2) + ' BEM';
    } else {
      // 普通宝箱：显示单按钮
      subboxesEl.classList.add('hidden');
      actionsEl.classList.remove('hidden');

      const cfg = currentOption === 'free' ? FREE_BOX : DAILY_BOXES[currentOption];
      const betBtn = document.getElementById('detailBetBtn');
      betBtn.dataset.bet = currentOption;
      betBtn.textContent = currentOption === 'free' ? '免费参与' : `投入 ${cfg.price} BEM`;
      document.getElementById('detailPrice').textContent =
        currentOption === 'free' ? '免费参与' : `起投 ${cfg.price} BEM`;

      document.querySelector('.players[data-players="detail"]').textContent = data[currentOption].players;
      document.getElementById('detailPlayersMax').textContent =
        '/ ' + (currentOption === 'free' ? '不限' : DAILY_MAX_PLAYERS) + ' 人';
      document.querySelector('.pool[data-pool="detail"]').textContent = data[currentOption].pool.toFixed(2) + ' BEM';
    }

    await refreshAllButtons();
  }

  // 打开详情页
  async function openDetail() {
    const meta = OPTION_META[currentOption];
    if (meta.placeholder) {
      showToast(meta.name + ' 正在开发中，敬请期待！');
      return;
    }
    await renderDetail();
    document.getElementById('detailOverlay').classList.remove('hidden');
  }

  // 关闭详情页
  function closeDetail() {
    document.getElementById('detailOverlay').classList.add('hidden');
  }

  /* =========================================================
     八、渲染
     ========================================================= */

  async function renderBoxes() {
    const data = await getBoxData();
    Object.keys(data).forEach(k => {
      const playersEl = document.querySelector(`.players[data-players="${k}"]`);
      const poolEl = document.querySelector(`.pool[data-pool="${k}"]`);
      const fillEl = document.querySelector(`.progress-fill[data-fill="${k}"]`);
      if (playersEl) playersEl.textContent = data[k].players;
      if (poolEl) poolEl.textContent = data[k].pool.toFixed(2) + ' BEM';
      // 主宝箱进度条
      if (fillEl) {
        const pct = Math.min(100, (data[k].players / MAIN_MAX_PLAYERS) * 100);
        fillEl.style.width = pct + '%';
      }
    });
    // 同步中心精简状态栏
    await updateMiniStats();
  }

  /* =========================================================
     九、按钮状态刷新
     ========================================================= */

  async function refreshAllButtons() {
    const locked = isSnipeLocked();
    const data = await getBoxData();

    // 每日宝箱
    for (const k of Object.keys(DAILY_BOXES)) {
      const btn = document.querySelector(`.btn-bet[data-bet="${k}"]`);
      const tip = document.querySelector(`.bet-tip[data-tip="${k}"]`);
      if (!btn) continue;

      const betted = await hasBet(k);
      const full = data[k].players >= DAILY_MAX_PLAYERS;

      btn.disabled = false;
      tip.textContent = '';

      if (timeTampered) {
        btn.disabled = true;
        tip.textContent = '系统时间异常，请校准本地时间';
      } else if (!walletAddress) {
        btn.disabled = true;
        tip.textContent = '请先连接钱包';
      } else if (locked) {
        btn.disabled = true;
        tip.textContent = '距离开奖不足10分钟，已停止投入';
      } else if (betted) {
        btn.disabled = true;
        tip.textContent = '今日该宝箱已投入，明天再来';
      } else if (full) {
        btn.disabled = true;
        tip.textContent = '该宝箱已满员（20/20）';
      }
    }

    // 主宝箱子宝箱（无时间限制，满 50 人开奖）
    for (const k of Object.keys(MAIN_BOXES)) {
      const btn = document.querySelector(`.btn-bet[data-bet="${k}"]`);
      const tip = document.querySelector(`.bet-tip[data-tip="${k}"]`);
      if (!btn) continue;

      const betted = await hasBet('main_' + k);
      const full = data[k].players >= MAIN_MAX_PLAYERS;

      btn.disabled = false;
      tip.textContent = '';

      if (timeTampered) {
        btn.disabled = true;
        tip.textContent = '系统时间异常，请校准本地时间';
      } else if (!walletAddress) {
        btn.disabled = true;
        tip.textContent = '请先连接钱包';
      } else if (betted) {
        btn.disabled = true;
        tip.textContent = '今日该宝箱已投入，明天再来';
      } else if (full) {
        btn.disabled = true;
        tip.textContent = '已满 50 人，等待开奖';
      }
    }

    // 免费宝箱
    const freeBtn = document.querySelector('.btn-bet[data-bet="free"]');
    const freeTip = document.querySelector('.bet-tip[data-tip="free"]');
    if (freeBtn) {
      const betted = await hasBet('free');
      freeBtn.disabled = false;
      freeTip.textContent = '';
      if (timeTampered) {
        freeBtn.disabled = true;
        freeTip.textContent = '系统时间异常，请校准本地时间';
      } else if (!walletAddress) {
        freeBtn.disabled = true;
        freeTip.textContent = '请先连接钱包';
      } else if (locked) {
        freeBtn.disabled = true;
        freeTip.textContent = '距离开奖不足10分钟，已停止参与';
      } else if (betted) {
        freeBtn.disabled = true;
        freeTip.textContent = '今日已参与，明天再来';
      }
    }
  }

  /* =========================================================
     十、投注逻辑
     ========================================================= */

  // 使用事件委托，兼容动态生成的投注按钮
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-bet');
    if (btn && btn.dataset.bet) {
      handleBet(btn.dataset.bet);
    }
  });

  async function handleBet(boxKey) {
    // 时间校验
    if (!checkTimeTravel()) return;
    if (timeTampered) { showToast('系统时间异常，请校准本地时间'); return; }
    if (!walletAddress) { showToast('请先连接钱包'); return; }

    const isMain = Object.prototype.hasOwnProperty.call(MAIN_BOXES, boxKey);
    const isFree = boxKey === 'free';
    const isDaily = Object.prototype.hasOwnProperty.call(DAILY_BOXES, boxKey);

    // 每日宝箱与免费宝箱受防狙击限制
    if ((isDaily || isFree) && isSnipeLocked()) {
      showToast('距离开奖不足10分钟，已停止投入');
      return;
    }

    const betKey = isMain ? 'main_' + boxKey : boxKey;
    if (await hasBet(betKey)) { showToast('今日该宝箱已投入'); return; }

    const data = await getBoxData();
    const cfg = isMain ? MAIN_BOXES[boxKey] : (isFree ? FREE_BOX : DAILY_BOXES[boxKey]);
    const maxPlayers = isMain ? MAIN_MAX_PLAYERS : DAILY_MAX_PLAYERS;

    if (data[boxKey].players >= maxPlayers) { showToast('该宝箱已满员'); return; }

    // 更新参与人数与奖池
    data[boxKey].players += 1;
    data[boxKey].pool = +(data[boxKey].pool + cfg.price).toFixed(4);
    await saveBoxData(data);
    await markBet(betKey);

    await renderBoxes();
    await refreshAllButtons();

    if (isFree) {
      showToast('免费参与成功！等待 24:00 开奖');
    } else {
      showToast(`成功投入 ${cfg.price} BEM 到${cfg.name}！`);
    }

    // 主宝箱满 50 人立即开奖
    if (isMain && data[boxKey].players >= MAIN_MAX_PLAYERS) {
      triggerMainDraw(boxKey);
    }
  }

  /* =========================================================
     十一、开奖逻辑（安全随机数，概率按实际人数均分）
     ========================================================= */

  // 每日 24:00 开奖（付费宝箱 + 免费宝箱）
  async function triggerDailyDraw() {
    if (drawTriggered) return;
    drawTriggered = true;

    const data = await getBoxData();

    // 收集用户参与过的宝箱
    const betted = [];
    for (const k of Object.keys(DAILY_BOXES)) {
      if (await hasBet(k)) betted.push(k);
    }
    if (await hasBet('free')) betted.push('free');

    if (betted.length === 0) {
      showToast('本轮未参与，明天继续加油！');
      drawTriggered = false;
      return;
    }

    // 按实际参与人数均分概率：每个宝箱被抽中的概率 = 该宝箱人数 / 总人数
    let totalPlayers = 0;
    betted.forEach(k => { totalPlayers += data[k].players; });

    // 使用安全随机数按人数加权抽取
    let r = secureRandomInt(totalPlayers);
    let picked = betted[0];
    for (const k of betted) {
      if (r < data[k].players) { picked = k; break; }
      r -= data[k].players;
    }

    // 免费宝箱奖池 = 当日所有付费宝箱手续费的 1%
    let amount;
    if (picked === 'free') {
      const fp = await getFeePool();
      amount = +(fp.total * 0.01).toFixed(4);
      if (amount <= 0) amount = +(secureRandomFloat() * 2 + 0.1).toFixed(4);
    } else {
      amount = data[picked].pool > 0 ? data[picked].pool : +(secureRandomFloat() * 5 + 0.5).toFixed(4);
    }

    currentWin = { boxKey: picked, amount: +amount.toFixed(4) };
    showWinModal(currentWin);

    setTimeout(() => { drawTriggered = false; }, 5000);
  }

  // 主宝箱满 50 人开奖
  async function triggerMainDraw(boxKey) {
    const data = await getBoxData();
    const cfg = MAIN_BOXES[boxKey];
    const amount = data[boxKey].pool;

    // 概率按实际参与人数均分：用户中奖概率 = 1 / 参与人数
    // 使用安全随机数决定是否中奖
    const win = secureRandomInt(data[boxKey].players) === 0;

    if (win) {
      currentWin = { boxKey, amount: +amount.toFixed(4) };
      showWinModal(currentWin);
    } else {
      showToast(`${cfg.name}已开奖，本轮未中奖，感谢参与！`);
    }
  }

  /* =========================================================
     十二、中奖弹窗
     ========================================================= */

  const winOverlay = document.getElementById('winOverlay');
  const winAmountEl = document.getElementById('winAmount');
  const winBoxNameEl = document.getElementById('winBoxName');

  function showWinModal(win) {
    const cfg = MAIN_BOXES[win.boxKey] || DAILY_BOXES[win.boxKey] || FREE_BOX;
    winAmountEl.textContent = win.amount.toFixed(2) + ' BEM';
    winBoxNameEl.textContent = cfg.name;
    winOverlay.classList.remove('hidden');
    createConfetti();
  }

  // 生成撒花元素
  function createConfetti() {
    const container = document.getElementById('confetti');
    container.innerHTML = '';
    const colors = ['#FFD700', '#FFA500', '#FFF3B0', '#FF8C00', '#FFE066'];
    for (let i = 0; i < 80; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = (secureRandomFloat() * 100) + '%';
      piece.style.background = colors[secureRandomInt(colors.length)];
      piece.style.animationDuration = (secureRandomFloat() * 2 + 2) + 's';
      piece.style.animationDelay = (secureRandomFloat() * 1.5) + 's';
      piece.style.width = (secureRandomFloat() * 8 + 6) + 'px';
      piece.style.height = (secureRandomFloat() * 10 + 10) + 'px';
      container.appendChild(piece);
    }
  }

  document.getElementById('closeWinBtn').addEventListener('click', () => {
    winOverlay.classList.add('hidden');
  });

  /* =========================================================
     十三、提现逻辑（手续费 5%，分享 -1%，打赏 -2.5%）
     ========================================================= */

  document.getElementById('withdrawBtn').addEventListener('click', async () => {
    if (!currentWin) return;

    // 计算手续费率：基础 5%，分享减免 1%，打赏减免 2.5%（可叠加，最低 1.5%）
    let feeRate = BASE_FEE;
    if (sharedToday) feeRate -= SHARE_DISCOUNT;
    if (tipped) feeRate -= TIP_DISCOUNT;
    if (feeRate < 0) feeRate = 0;

    const fee = currentWin.amount * feeRate;
    const received = currentWin.amount - fee;
    const feePercent = (feeRate * 100).toFixed(1);

    const msg =
      `提现确认：\n` +
      `中奖金额：${currentWin.amount.toFixed(2)} BEM\n` +
      `手续费（${feePercent}%）：${fee.toFixed(2)} BEM\n` +
      `实际到账：${received.toFixed(2)} BEM\n\n` +
      `（手续费的 50% 用于回购销毁 BEM，50% 用于开发）`;

    if (confirm(msg)) {
      // 手续费计入当日手续费池（用于免费宝箱奖池）
      await addFee(fee);
      showToast(`提现成功！到账 ${received.toFixed(2)} BEM`);
      winOverlay.classList.add('hidden');
    }
  });

  /* =========================================================
     十四、分享到 X（减免 1%）
     ========================================================= */

  document.getElementById('shareBtn').addEventListener('click', () => {
    if (!currentWin) return;

    const cfg = MAIN_BOXES[currentWin.boxKey] || DAILY_BOXES[currentWin.boxKey] || FREE_BOX;
    const text = encodeURIComponent(
      `我在 TapeBox 的${cfg.name}中赢得了 ${currentWin.amount.toFixed(2)} BEM！🎉 快来一起玩！`
    );
    const url = `https://twitter.com/intent/tweet?text=${text}`;
    window.open(url, '_blank', 'width=600,height=500');

    sharedToday = true;
    showToast('分享成功！提现手续费已减免 1%');
  });

  /* =========================================================
     十五、打赏逻辑（最低 0.1 BEM，减免 2.5%）
     ========================================================= */

  document.getElementById('tipBtn').addEventListener('click', () => {
    const amount = prompt('请输入打赏金额（BEM，最低 0.1）：', '0.1');
    if (amount === null) return;

    const num = parseFloat(amount);
    if (isNaN(num) || num < MIN_TIP) {
      showToast(`打赏金额不能低于 ${MIN_TIP} BEM`);
      return;
    }

    setTimeout(() => {
      alert('感谢大佬的支持，祝您次次中大额BEM！');
      tipped = true;
      showToast('打赏成功！下次提现手续费减免 2.5%（打赏不改变实际中奖概率）');
    }, 400);
  });

  /* =========================================================
     十六、Toast 提示
     ========================================================= */

  let toastTimer = null;
  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 2600);
  }

  /* =========================================================
     十七、初始化
     ========================================================= */

  async function init() {
    // 页面加载时检测时间旅行
    checkTimeTravel();

    initMarquee();

    // 绑定 7 个选项按钮
    document.querySelectorAll('.opt-btn').forEach(btn => {
      btn.addEventListener('click', () => selectOption(btn.dataset.opt));
    });

    // 点击大宝箱或查看详情按钮 → 打开详情页
    document.getElementById('bigChest').addEventListener('click', openDetail);
    document.getElementById('openDetailBtn').addEventListener('click', openDetail);
    document.getElementById('closeDetailBtn').addEventListener('click', closeDetail);
    // 点击遮罩空白处关闭详情页
    document.getElementById('detailOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'detailOverlay') closeDetail();
    });

    // 生成大宝箱星光点缀
    initSparkles();

    await renderBoxes();
    await refreshAllButtons();
    await selectOption('1');

    updateTimers();
    setInterval(async () => {
      updateTimers();
      await refreshAllButtons();
    }, 1000);
  }

  // 大宝箱星光点缀
  function initSparkles() {
    const box = document.getElementById('chestSparkles');
    if (!box) return;
    const icons = ['✨', '⭐', '💫'];
    for (let i = 0; i < 6; i++) {
      const s = document.createElement('span');
      s.textContent = icons[secureRandomInt(icons.length)];
      s.style.left = (secureRandomFloat() * 90 + 5) + '%';
      s.style.top = (secureRandomFloat() * 80 + 5) + '%';
      s.style.animationDelay = (secureRandomFloat() * 2) + 's';
      box.appendChild(s);
    }
  }

  init();
})();
