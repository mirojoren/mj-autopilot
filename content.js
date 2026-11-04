// MJ Autopilot — content script（v0.9.3）
// 在 Midjourney 网页版注入侧边自动化面板
(function () {
  'use strict';

  if (window.__mjAutopilotInjected) return;
  window.__mjAutopilotInjected = true;

  const VERSION = '0.9.3';

  // ===== 工具 =====
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // 分段睡眠：支持暂停（暂停时挂起）、停止（立即中断），并每 15 秒提示剩余时间
  async function sleepProgress(ms, label) {
    let remaining = ms;
    let lastNotified = ms;
    while (remaining > 0 && !stopFlag) {
      if (pauseFlag) { await sleep(500); continue; }
      const step = Math.min(remaining, 5000);
      await sleep(step);
      remaining -= step;
      if (lastNotified - remaining >= 15000) {
        toast(`${label}：剩余约 ${Math.round(remaining / 1000)} 秒…`);
        lastNotified = remaining;
      }
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function hasChinese(text) {
    return /[\u4e00-\u9fff]/.test(text);
  }

  function nowStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function nowTimeStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // ===== 配置 =====
  const DEFAULT_SETTINGS = {
    translateEnabled: true,
    downloadFolder: 'MJ-Autopilot',
    interval: 3,             // 基础提交间隔（秒，每条之间的固定间隔，随机关闭时用）
    maxQueued: 3,            // 允许的最大排队任务数（排队感知阈值）
    autoRetry: true,         // 失败自动重试
    autoRetryTimes: 3,       // 重试次数
    queueAware: false,       // 排队感知开关（默认关）
    batchMode: true,         // 分批发送开关（默认开，避开 MJ 排队上限）
    batchSize: 3,            // 每批最多提交多少个（保守，对齐并发运行数）
    batchWait: 180,          // 批次间等待秒数（默认 3 分钟）
    // v0.6.0 新增：串行出图确认（根治「前序未结束就继续」）
    serialConfirm: true,     // 逐条提交后等待该条出图再发下一条（串行核心开关）
    submitConfirmMs: 5000,   // 提交后轮询报错/清空输入框的时长 ms
    renderWaitMs: 180000,    // 等待单条出图的最长时间 ms（超时兜底放行）
    restEvery: 0,            // 每发送 N 条后强制休息（0=不休息）
    restSec: 60,             // 强制休息时长（秒）
    autoDownload: false,     // 自动下载新出图
    autoArchive: true,       // 自动归档（按日期建子目录）
    archiveCategory: '',     // 归档类别（空=不按类别）
    autoRename: true,        // 自动重命名（用 prompt 关键词，默认开）
    savePromptTxt: true,     // 自动保存同名 .prompt.txt（默认开）
    scheduleEnabled: false,  // 定时发送开关
    scheduleTime: '',        // 定时开始时间 HH:MM
    seedReuse: true,         // seed 复用开关（自动记忆最近 seed）
    // v0.5.0 新增
    promptPrefix: '',        // 全局提示词前缀（拼在每条 prompt 前）
    promptSuffix: '',        // 全局提示词后缀（拼在每条 prompt 后）
    randomSeed: false,       // 随机 seed（每条自动加随机 --seed）
    randomInterval: false,   // 随机发送间隔（在 interval 基础上随机浮动）
    intervalMin: 3,          // 随机间隔下限（秒）
    intervalMax: 30,         // 随机间隔上限（秒）
    randomOrder: false,      // 随机顺序发送队列（防封号）
    sendMode: 'normal',      // 发送模式预设 fast/normal/slow
    dlFormat: 'original',    // 下载图片格式 original/png/jpg/webp
  };
  let settings = { ...DEFAULT_SETTINGS };

  // ===== 状态持久化 =====
  let queue = [];       // { id, prompt, status, retries, submittedAt }
  let running = false;
  let stopFlag = false;
  let pauseFlag = false;
  let lastSeed = '';    // 最近一次使用的 seed
  let autoDlSeen = new Set(); // 自动下载去重

  function persistQueue() {
    try { chrome.storage.local.set({ mjap_queue: queue }); } catch (e) {}
  }

  function loadQueue() {
    chrome.storage.local.get('mjap_queue', (r) => {
      if (r.mjap_queue && Array.isArray(r.mjap_queue)) {
        queue = r.mjap_queue.map((q) => (q.status === 'running' ? { ...q, status: 'pending' } : q));
      }
      renderQueue();
    });
  }

  // ===== 中文翻译（词典 + 占位符保护）=====
  const DICT = [
    ['电影感', 'cinematic'], ['超现实', 'surreal'], ['超广角', 'ultra wide angle'],
    ['高清', 'high resolution'], ['写实', 'realistic'], ['特写', 'close-up'],
    ['广角', 'wide angle'], ['肖像', 'portrait'], ['照片', 'photo'],
    ['风景', 'landscape'], ['城市', 'city'], ['街道', 'street'],
    ['森林', 'forest'], ['天空', 'sky'], ['日落', 'sunset'], ['日出', 'sunrise'],
    ['夜晚', 'night'], ['清晨', 'morning'], ['黄昏', 'dusk'],
    ['女孩', 'girl'], ['男孩', 'boy'], ['女人', 'woman'], ['男人', 'man'], ['孩子', 'child'],
    ['柔和', 'soft'], ['明亮', 'bright'], ['电影', 'cinematic'], ['摄影', 'photography'],
    ['梦幻', 'dreamy'], ['唯美', 'aesthetic'], ['复古', 'retro'], ['未来', 'futuristic'],
    ['风格', 'style'], ['颜色', 'color'], ['蓝色', 'blue'], ['红色', 'red'],
    ['金色', 'golden'], ['白色', 'white'], ['黑色', 'black'], ['绿色', 'green'],
    ['紫色', 'purple'], ['粉色', 'pink'], ['细节', 'detail'],
    ['背景', 'background'], ['前景', 'foreground'], ['镜头', 'camera'], ['角度', 'angle'],
    ['服装', 'costume'], ['头发', 'hair'], ['眼睛', 'eyes'], ['表情', 'expression'],
    ['微笑', 'smiling'], ['坐着', 'sitting'], ['站着', 'standing'], ['走着', 'walking'],
    ['跳舞', 'dancing'], ['思考', 'thinking'], ['看着', 'looking at'],
    ['十分', 'extremely'], ['非常', 'very'],
    ['一个', 'a'], ['的', ''], ['在', 'in'], ['和', 'and'], ['与', 'and'], ['有', 'with'],
    ['很', 'very'], ['看', 'looking'], ['跑', 'running'], ['山', 'mountain'], ['海', 'sea'],
    ['光', 'light'], ['影', 'shadow'], ['暗', 'dark'],
  ];

  function localTranslate(text) {
    const protectedTokens = [];
    let result = text.replace(/--[a-z0-9]+[^\s]*/gi, (t) => {
      const ph = `\u0000P${protectedTokens.length}\u0000`;
      protectedTokens.push(t);
      return ph;
    });
    for (const [cn, en] of DICT) {
      result = result.split(cn).join(en);
    }
    protectedTokens.forEach((t, i) => {
      result = result.split(`\u0000P${i}\u0000`).join(t);
    });
    return result.replace(/[ \t]+/g, ' ').replace(/ ?,[ ,]+/g, ', ').trim();
  }

  // AI 翻译（使用免费 Index-Translate，失败退回本地词典）
  async function aiTranslate(text) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'translateText', text });
      if (r && r.ok && r.text) return r.text;
    } catch (e) { /* ignore */ }
    return localTranslate(text); // 兜底
  }

  // ===== seed 提取 =====
  function extractSeedFromText(text) {
    const m = String(text || '').match(/--seed\s+(\d+)/i);
    return m ? m[1] : '';
  }

  function extractSeedFromUrl(url) {
    const m = String(url || '').match(/[?&]seed=(\d+)/i);
    return m ? m[1] : '';
  }

  // ===== 发送模式预设（借鉴 Autosail 的 fast/normal/slow 三档参数）=====
  const SEND_MODES = {
    fast:   { label: '快速', intervalMin: 1,  intervalMax: 3,  batchWait: 90  },
    normal: { label: '中速', intervalMin: 3,  intervalMax: 8,  batchWait: 180 },
    slow:   { label: '慢速', intervalMin: 10, intervalMax: 30, batchWait: 300 },
  };

  // ===== MJ 8.2 公式预设库（按 MOKE 提示词工程五格模型分类：主体/景别构图/风格/光影/参数）=====
  const MJ_PRESETS = {
    // —— 艺术流派 / 风格基调 ——
    style: {
      cinematic: 'A cinematic film still from an unseen film, dramatic cinematic color grading, HDR dynamic range, anamorphic streak flare,',
      deakins: 'Roger Deakins cinematography, naturalistic motivated lighting, muted desaturated color palette, architectural framing,',
      'scifi-minimal': 'vast negative space, minimal composition, quiet and breathable, low-saturation cold palette with a single warm accent, subtle sci-fi geometry in the defocused background,',
      dystopia: 'monumental brutalist architecture, tiny figure in vast interior space, single shaft of light cutting through darkness, oppressive scale, volumetric atmospheric haze,',
      cyberpunk: 'cyberpunk aesthetic, neon-drenched night city, holographic signage, rain-soaked reflective streets,',
      fantasy: 'epic fantasy, mythical atmosphere, dramatic scale, ornate detail, cinematic lighting,',
      surreal: 'surrealist composition, dreamlike impossible geometry, symbolic imagery, ethereal atmosphere,',
      vaporwave: 'vaporwave aesthetic, retro-futuristic pastel palette, glitchy chrome, sunset gradient horizon,',
      darkacademia: 'dark academia mood, moody library atmosphere, warm candlelight, aged books and wood, scholarly melancholia,',
      solarpunk: 'solarpunk utopia, lush greenery integrated with clean architecture, bright hopeful light, renewable harmony,',
      artdeco: 'art deco style, geometric symmetry, gilded accents, bold streamlined luxury, roaring twenties elegance,',
      baroque: 'baroque composition, dramatic chiaroscuro, rich ornamentation, theatrical movement, opulent detail,',
      renaissance: 'renaissance painting style, classical proportion, soft sfumato, timeless sacred composition,',
      impressionism: 'impressionist painting, broken color, visible brushstrokes, fleeting light, plein air freshness,',
      minimalism: 'minimalist composition, vast negative space, restrained palette, quiet and breathable,',
      brutalism: 'brutalist architecture, raw concrete massing, monumental geometry, textured exposed surfaces,',
      ukiyoe: 'ukiyo-e japanese woodblock print, flat color fields, bold outlines, layered perspective,',
    },
    // —— 介质 / 质感 / 渲染方式 ——
    medium: {
      photoreal: 'ultra photorealistic, sharp focus, natural skin texture, professional photography, 8k detail,',
      film: 'analog film photograph, Kodak Portra 400, subtle film grain, organic color response, soft highlight rolloff,',
      editorial: 'editorial photography, fashion magazine aesthetic, refined color grading, clean studio styling,',
      street: 'street photography, candid documentary moment, natural available light, gritty urban texture,',
      aerial: 'aerial drone photography, sweeping top-down perspective, epic scale, crisp atmospheric clarity,',
      watercolor: 'delicate watercolor painting, soft washes of color, paper texture, flowing pigment,',
      oilpainting: 'classical oil painting, thick impasto brushstrokes, rich canvas texture, chiaroscuro lighting,',
      anime: 'anime style, clean cel shading, vibrant colors, detailed line art, studio quality illustration,',
      '3d-render': '3D render, octane render, physically based rendering, subsurface scattering, global illumination,',
      'flat-illustration': 'flat vector illustration, minimal geometric shapes, limited color palette, clean composition,',
      matte: 'matte painting, cinematic concept art, epic environmental storytelling, layered atmospheric depth,',
      pixel: 'pixel art, crisp limited palette, retro game aesthetic, clean grid resolution,',
      isometric: 'isometric design, clean geometry, precise perspective, soft ambient lighting,',
      lowpoly: 'low poly 3D, faceted geometry, stylized flat shading, playful minimalist form,',
    },
    // —— 摄影流派（机身/镜头/底片）——
    camera: {
      arri65: 'Arri 65mm camera, Cooke anamorphic lenses, analog film stock,',
      alexa: 'shot on ARRI ALEXA Mini LF with ARRI Signature Prime lens,',
      red: 'shot on RED Komodo with cinema prime lens,',
      sony: 'shot on Sony Venice with full-frame lens,',
      imax: 'shot on IMAX 65mm large-format camera,',
      vintage: 'shot on vintage 16mm film camera, natural film grain,',
    },
    // —— 景别（镜头距离）——
    shot: {
      extreme: 'extreme wide shot, epic establishing scale, tiny subject engulfed by vast environment,',
      wide: 'wide shot, full environment visible, subject in context of grand surroundings,',
      full: 'full body shot, complete figure framed, posture and gesture clearly readable,',
      medium: 'medium shot, from waist up, balanced composition,',
      closeup: 'close-up shot, face filling frame, intimate emotional detail,',
      extremecloseup: 'extreme close-up, single detail filling frame, texture and surface nuance,',
    },
    // —— 视角 ——
    angle: {
      eyelevel: 'eye-level perspective, neutral natural viewpoint,',
      low: 'low-angle shot, looking up, imposing towering presence, dramatic upward perspective,',
      high: 'high-angle shot, looking down, vulnerable or diminutive subject,',
      overhead: 'overhead top-down view, flat geometric composition, bird-eye vantage,',
      dutch: 'dutch angle, tilted horizon, unsettling dynamic tension,',
    },
    // —— 焦段（视角特性）——
    lens: {
      '18mm': 'shot on a 18mm lens, ultra-wide, extreme perspective, epic exaggerated depth,',
      '24mm': 'shot on a 24mm lens, wide angle, grand environment, strong perspective,',
      '35mm': 'shot on a 35mm lens, environmental storytelling, natural presence, slight perspective,',
      '50mm': 'shot on a 50mm lens, standard human-eye perspective, neutral and honest,',
      '85mm': 'shot on a 85mm lens, medium telephoto, pleasing compression, creamy bokeh,',
      '135mm': 'shot on a 135mm lens, telephoto, strong compression, isolated distant subject,',
    },
    // —— 景深 ——
    dof: {
      shallow: 'shallow depth of field f/1.8, creamy bokeh, subject isolated from soft background,',
      medium: 'medium depth of field, gentle background blur, subject crisp with context readable,',
      deep: 'deep depth of field, tack-sharp from foreground to background, everything in focus,',
    },
    // —— 光影 / 氛围 ——
    light: {
      golden: 'golden hour warm sunlight, long dramatic shadows, warm amber tones,',
      neon: 'neon-lit night scene, colorful backlight, wet reflective surfaces, blue-cyan glow,',
      fire: 'warm flickering firelight, single warm light source in darkness, amber and gold tones on skin,',
      overcast: 'flat diffused overcast light, soft gradients, cold gray-blue dominant tone,',
      studio: 'dramatic studio lighting, single key light, deep shadows, high contrast,',
      volumetric: 'volumetric light rays, god rays, atmospheric dust particles in light beams,',
      rembrandt: 'Rembrandt lighting, single directional key light, signature triangular cheek highlight, deep shadow falloff,',
      backlit: 'strong backlight, rim light silhouette, glowing edge highlight, atmospheric halo,',
      window: 'soft window light, gentle natural illumination, quiet indoor atmosphere,',
    },
    // —— 情绪氛围 ——
    mood: {
      serene: 'serene, tranquil, contemplative atmosphere, gentle stillness,',
      dramatic: 'dramatic, intense, high-stakes tension, charged atmosphere,',
      melancholic: 'melancholic, wistful, lonely poetic mood, muted emotional weight,',
      mysterious: 'mysterious, enigmatic, atmospheric ambiguity, veiled secrets,',
      warm: 'warm, cozy, inviting, comforting ambiance,',
      cold: 'cold, austere, detached, clinical stillness,',
    },
  };

  // 随机整数 [min, max]
  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // 生成随机 seed（1 ~ 4294967295，MJ 的 seed 范围）
  function randomSeed() {
    return String(randInt(1, 4294967295));
  }

  // 获取下一条的提交间隔（随机间隔或固定间隔）
  // 计算「批次内相邻两条之间的间隔」，返回毫秒：
  // 开启随机间隔 → 在 [intervalMin, intervalMax]（秒）内随机；否则用固定 interval（秒）。
  function nextInterval() {
    if (settings.randomInterval) {
      const minSec = Math.max(1, settings.intervalMin || 3);
      const maxSec = Math.max(minSec, settings.intervalMax || minSec);
      return randInt(minSec, maxSec) * 1000;
    }
    return Math.max(1, settings.interval || 3) * 1000;
  }

  // ===== 与 MJ 页面交互 =====
  function findPromptInput() {
    const candidates = [
      'textarea[placeholder*="imagine" i]', 'textarea[placeholder*="prompt" i]',
      'textarea[placeholder*="描述" i]', 'textarea[placeholder*="输入" i]',
      'input[placeholder*="imagine" i]', 'input[placeholder*="prompt" i]',
      'textarea', 'input[type="text"]',
    ];
    for (const sel of candidates) {
      const el = $(sel);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function submitPrompt(prompt) {
    const input = findPromptInput();
    if (!input) return { ok: false, error: '未找到输入框' };
    input.focus();
    setNativeValue(input, prompt);
    await sleep(200);

    const submitBtn =
      $('button[aria-label*="submit" i]') ||
      $('button[aria-label*="generate" i]') ||
      $('button[aria-label*="发送" i]') ||
      $('button[type="submit"]');

    if (submitBtn) submitBtn.click();
    else {
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      input.dispatchEvent(new KeyboardEvent('keydown', opts));
      input.dispatchEvent(new KeyboardEvent('keypress', opts));
      input.dispatchEvent(new KeyboardEvent('keyup', opts));
    }

    // 关键：轮询检测「排队已满」报错 —— MJ 弹窗常在提交后 1~3 秒才出现，
    // 所以不能只等一个固定短时间，要持续轮询到输入框被清空（确认提交成功）为止。
    const maxPollMs = settings.submitConfirmMs || 4000;
    const startedAt = Date.now();
    let verified = false;
    let queueFullHit = false;

    while (Date.now() - startedAt < maxPollMs) {
      // 1) 检测排队满报错
      if (detectQueueFullError()) {
        queueFullHit = true;
        break;
      }
      // 2) 输入框被清空 = 提交已成功接收
      const afterInput = findPromptInput();
      const val = afterInput ? (afterInput.value || '').trim() : '';
      if (val === '') { verified = true; break; }
      await sleep(250);
    }

    if (queueFullHit) {
      dismissErrorPopup();
      return { ok: false, error: 'queue_full', queueFull: true };
    }

    // 即使输入框未被清空，但只要没报错，也视为已提交（MJ 有时不清空输入框）
    return { ok: true, verified };
  }

  // ===== 排队感知 =====
  function readQueueCount() {
    try {
      const allText = document.body ? (document.body.innerText || '') : '';
      const mA = allText.match(/Queued\s*Jobs?\s*\(?[^:\n]{0,15}?\)?\s*[:：]?\s*(\d+)/i);
      if (mA) { const n = parseInt(mA[1], 10); if (Number.isFinite(n) && n <= 1000) return n; }
      const mB = allText.match(/(?:排队任务|排队中|排队)\s*[:：]?\s*(\d{1,3})\s*(?:个|任务)?/i);
      if (mB) { const n = parseInt(mB[1], 10); if (Number.isFinite(n) && n <= 1000) return n; }
      const mC = allText.match(/Queue\s*[:：]?\s*(\d{1,3})/i);
      if (mC) { const n = parseInt(mC[1], 10); if (Number.isFinite(n) && n <= 1000) return n; }
    } catch (e) { /* ignore */ }
    return null;
  }

  // 检测 MJ 是否弹出「排队已满」的报错（Too many queued prompts 等）
  function detectQueueFullError() {
    try {
      // MJ 报错关键词（英文 + 中文界面）
      const patterns = [
        /too many queued prompts/i,
        /too many jobs/i,
        /maximum number of (prompts|jobs)/i,
        /max(imum)? queue (size )?reached/i,
        /queue is full/i,
        /job queue full/i,
        /you can only (have|run) \d+ (jobs|prompts)/i,
        /排队任务过多|排队已满|队列已满|任务已达上限|同时.*任务.*上限|达到.*上限|排队.*上限/i,
      ];
      const bodyText = document.body ? document.body.innerText : '';
      for (const re of patterns) {
        if (re.test(bodyText)) return true;
      }
      // 也检查常见的 toast/alert 弹窗元素
      const alerts = $$('[role="alert"], .toast, [class*="error"], [class*="notification"], [class*="Toast"]');
      for (const el of alerts) {
        const t = (el.innerText || el.textContent || '').trim();
        if (!t) continue;
        for (const re of patterns) {
          if (re.test(t)) return true;
        }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // 关闭/忽略当前的报错弹窗（点击关闭按钮，避免遮挡）
  function dismissErrorPopup() {
    try {
      const closeBtns = $$('button[aria-label*="close" i], [role="alert"] button, [class*="error"] button');
      for (const b of closeBtns) {
        if (b.offsetParent !== null) { b.click(); return true; }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  async function waitForQueueSlot() {
    if (!settings.queueAware) return;
    const MAX_WAIT = 60;
    const startedAt = Date.now();
    let waited = 0;
    while (!stopFlag && !pauseFlag) {
      const n = readQueueCount();
      if (n === null) return;
      if (n < settings.maxQueued) return;
      if (waited % 4 === 0) toast(`检测到排队 ${n} 个任务，等待空位…`);
      if (Date.now() - startedAt > MAX_WAIT * 1000) { toast('排队等待超时，继续提交'); return; }
      await sleep(3000);
      waited++;
    }
  }

  // ===== 定时发送：等待到达设定时间 =====
  async function waitForSchedule() {
    if (!settings.scheduleEnabled || !settings.scheduleTime) return;
    const [h, m] = settings.scheduleTime.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    const now = new Date();
    const target = new Date();
    target.setHours(h, m, 0, 0);
    // 如果今天的时间已过，则等明天
    if (target <= now) target.setDate(target.getDate() + 1);
    const diff = target - now;
    toast(`定时发送：将在 ${settings.scheduleTime} 开始（${Math.round(diff / 60000)} 分钟后）`);
    // 分段等待，支持停止/暂停
    let remaining = diff;
    while (remaining > 0 && !stopFlag) {
      if (pauseFlag) { await sleep(500); continue; }
      await sleep(Math.min(remaining, 5000));
      remaining -= 5000;
    }
    if (!stopFlag) toast('定时时间到，开始发送');
  }

  // ===== 分批发送：检测页面图片数量 =====
  let _imgCountBaseline = 0;

  // 排队满后的等待：轮询检测页面是否出图（图片增多或网格卡片增多），最多等 maxWaitMs
  async function waitForQueueDrain(maxWaitMs) {
    const startedAt = Date.now();
    let lastCount = countPageImages();
    let lastGrid = countGridItems();
    toast('排队已满，暂停发送，等待前序任务生成…');

    while (!stopFlag) {
      // 检测图片数量或网格卡片是否增加（说明有前序任务出图/被接收）
      const cur = countPageImages();
      const grid = countGridItems();
      if (cur > lastCount || grid > lastGrid) {
        toast('检测到前序任务已出图，恢复发送');
        return true;
      }
      lastCount = Math.max(lastCount, cur);
      lastGrid = Math.max(lastGrid, grid);

      // 兜底：到点放行探测一次（避免卡死整条队列）
      if (Date.now() - startedAt > maxWaitMs) {
        return true;
      }
      await sleep(4000);
    }
    return false;
  }

  function countPageImages() {
    try {
      return $$('img[src*="cdn.midjourney.com"], img[src*="midjourney.com"]').length;
    } catch (e) { return 0; }
  }

  // 统计「正在生成/已出图」的网格项（比单纯图片计数更可靠，因为 MJ 生成中是占位卡片）
  // 判断依据：网格 item 容器（含 U1-V4 按钮或 aria-label 带序号）
  function countGridItems() {
    try {
      // MJ 生成结果卡片通常带 U1~V4 按钮；生成中也有占位卡片
      const cards = $$('button[aria-label*="upscale" i], button[aria-label*="U1" i], button[aria-label*="放大" i]');
      // 每个卡片有 4 个 upscale 按钮，除以 4 得到卡片数；不足时兜底
      return Math.max(0, Math.ceil(cards.length / 4));
    } catch (e) { return 0; }
  }

  // 等待「当前这条 prompt」真正开始生成/出图（网格卡片数 +1 或图片数 +1），
  // 串行核心：只有确认前序已接收/出图，才返回 true，否则返回 false（超时兜底）。
  // 返回 { done: true/false, reason }
  async function waitForThisPromptToRender(maxWaitMs) {
    const baseImg = countPageImages();
    const baseGrid = countGridItems();
    const startedAt = Date.now();

    while (!stopFlag) {
      const imgs = countPageImages();
      const grids = countGridItems();

      // 出图信号 1：图片数增多
      if (imgs > baseImg) return { done: true, reason: 'image' };
      // 出图信号 2：网格卡片增多（生成中占位也算「已被接收、正在生成」）
      if (grids > baseGrid) return { done: true, reason: 'grid' };

      // 超时兜底：到点即使没检测到也放行（避免卡死整个队列）
      if (Date.now() - startedAt >= maxWaitMs) {
        return { done: false, reason: 'timeout' };
      }
      await sleep(3000);
    }
    return { done: false, reason: 'stop' };
  }

  // 检测是否有新图生成（对比基准数量）
  function hasNewImagesSinceBaseline() {
    const cur = countPageImages();
    return cur > _imgCountBaseline;
  }

  // 批级出图确认：等待「本批 N 个」真正出图（图片数或网格卡片增加 target 个），
  // 用于「每批并发发 N 个 → 等这批出图 → 再发下一批」。最多等 maxWaitMs，超时兜底放行。
  async function waitForBatchToRender(target, maxWaitMs) {
    const baseImg = countPageImages();
    const baseGrid = countGridItems();
    const startedAt = Date.now();
    let lastToast = 0;

    while (!stopFlag && !pauseFlag) {
      const imgs = countPageImages();
      const grids = countGridItems();
      const gained = Math.max(0, imgs - baseImg) + Math.max(0, grids - baseGrid);

      // 新增的图片/卡片数达到本批数量 → 视为这批已出图
      if (gained >= target) {
        _imgCountBaseline = countPageImages();
        return { done: true, reason: 'batch_rendered' };
      }

      // 超时兜底：到点放行（避免卡死队列）
      if (Date.now() - startedAt >= maxWaitMs) {
        _imgCountBaseline = countPageImages();
        return { done: false, reason: 'timeout' };
      }

      // 每 20 秒提示一次进度
      const elapsed = Date.now() - startedAt;
      if (elapsed - lastToast >= 20000) {
        lastToast = elapsed;
        toast(`本批已提交，等待出图（已出 ${gained}/${target}，剩余约 ${Math.round((maxWaitMs - elapsed) / 1000)}s）…`);
      }
      await sleep(3000);
    }
    return { done: false, reason: 'stop' };
  }

  // 批次间等待：定时等待为主，检测到出图则提前放行（两者结合）
  async function waitForBatchSlot() {
    if (!settings.batchMode) return;
    const waitMs = (settings.batchWait || 180) * 1000;
    const startedAt = Date.now();
    let notified = false;

    while (!stopFlag && !pauseFlag) {
      const elapsed = Date.now() - startedAt;

      // 检测到新图（前序任务已出图），提前放行
      if (elapsed > 8000 && hasNewImagesSinceBaseline()) {
        if (!notified) { toast('检测到前序任务已出图，提前发送下一批'); notified = true; }
        _imgCountBaseline = countPageImages();
        return;
      }

      // 定时到点
      if (elapsed >= waitMs) {
        _imgCountBaseline = countPageImages();
        return;
      }

      // 周期性提示剩余时间
      if (!notified && elapsed > 3000 && Math.floor(elapsed / 30000) !== Math.floor((elapsed - 3000) / 30000)) {
        toast(`本批已提交，等待 ${Math.ceil((waitMs - elapsed) / 1000)} 秒后发下一批…`);
      }

      await sleep(3000);
    }
  }

  // ===== UI 面板 =====
  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'mj-autopilot-panel';
    host.innerHTML = `
      <div class="mjap-toggle" id="mjap-toggle" title="MJ Autopilot">⚙</div>
      <div class="mjap-body" id="mjap-body">
        <div class="mjap-header">
          <span>MJ Autopilot <small class="mjap-ver">v${VERSION}</small></span>
          <button class="mjap-close" id="mjap-close" title="关闭">×</button>
        </div>
        <div class="mjap-tabs">
          <button class="mjap-tab active" data-tab="queue">队列 <span id="mjap-queue-count" class="mjap-badge">0</span></button>
          <button class="mjap-tab" data-tab="batch">批量</button>
          <button class="mjap-tab" data-tab="pace">节奏</button>
          <button class="mjap-tab" data-tab="template">模板</button>
          <button class="mjap-tab" data-tab="download">下载</button>
          <button class="mjap-tab" data-tab="settings">设置</button>
        </div>

        <div class="mjap-tabpane active" data-pane="queue">
          <div class="mjap-actions">
            <button class="mjap-btn primary" id="mjap-run">▶ 运行</button>
            <button class="mjap-btn danger" id="mjap-stop">■ 停止</button>
            <button class="mjap-btn" id="mjap-clear">清空已完成</button>
          </div>
          <div class="mjap-actions">
            <button class="mjap-btn" id="mjap-export">导出队列</button>
            <button class="mjap-btn" id="mjap-import-queue">导入队列</button>
            <input type="file" id="mjap-queue-file" accept=".json" hidden>
          </div>
          <div class="mjap-actions">
            <button class="mjap-btn" id="mjap-clear-checked">清理已勾选</button>
            <button class="mjap-btn" id="mjap-check-all-done">勾选全部完成项</button>
          </div>
          <div class="mjap-hint" style="margin-bottom:8px">点任务行可填入输入框；勾选任务可标记完成，点「清理已勾选」批量删除。</div>
          <div class="mjap-queue-stats" id="mjap-queue-stats"></div>
          <div class="mjap-queue" id="mjap-queue"></div>
        </div>

        <div class="mjap-tabpane" data-pane="batch">
          <textarea id="mjap-batch-input" placeholder="每行一个 prompt，支持中文（自动翻译）&#10;支持格式：txt / md / markdown&#10;自动剥离 1. 2、 - 等序号和标题符号"></textarea>
          <div class="mjap-actions">
            <button class="mjap-btn primary" id="mjap-add-batch">加入队列</button>
            <button class="mjap-btn" id="mjap-import-btn">导入文件</button>
            <input type="file" id="mjap-file-import" accept=".txt,.text,.md,.markdown" hidden>
          </div>
          <div class="mjap-hint">支持 .txt / .md / .markdown，也可拖拽文件到输入框</div>
          <div class="mjap-preview" id="mjap-preview"></div>
        </div>

        <div class="mjap-tabpane" data-pane="pace">
          <div class="mjap-hint" style="margin-bottom:10px;color:#fdcb6e">控制队列的发送节奏：每批几条、间隔多久、串行出图确认等。改完点下方「保存节奏」立即生效。</div>

          <div class="mjap-section-title">发送模式预设</div>
          <select id="mjap-send-mode">
            <option value="fast">快速（间隔 1-3s，批次等待 90s）</option>
            <option value="normal" selected>中速（间隔 3-8s，批次等待 180s）</option>
            <option value="slow">慢速（间隔 10-30s，批次等待 300s）</option>
          </select>

          <div class="mjap-section-title">批次切分</div>
          <label>每批最多提交数（一批发完等前序，再发下一批）</label>
          <input type="number" id="mjap-batch-size" min="1" max="20" placeholder="3">
          <label>批次间等待秒数</label>
          <input type="number" id="mjap-batch-wait" min="10" step="10" placeholder="180">
          <label class="mjap-check">
            <input type="checkbox" id="mjap-batch-mode" checked> 启用分批发送（避开 MJ 排队上限）
          </label>

          <div class="mjap-section-title">单条发送间隔（批次内每个子任务之间的频率）</div>
          <label class="mjap-check">
            <input type="checkbox" id="mjap-random-interval"> 随机间隔（在下方区间内随机取值，防封号）
          </label>
          <label>固定间隔（秒，随机关闭时每条都等这个时长）</label>
          <input type="number" id="mjap-interval" min="1" step="1" placeholder="3">
          <label>随机间隔下限（秒）</label>
          <input type="number" id="mjap-interval-min" min="1" step="1" placeholder="3">
          <label>随机间隔上限（秒）</label>
          <input type="number" id="mjap-interval-max" min="2" step="1" placeholder="8">

          <div class="mjap-section-title">批间出图确认（根治排队超限）</div>
          <label class="mjap-check">
            <input type="checkbox" id="mjap-serial-confirm" checked> 每批出图后再发下一批（推荐开启，配合上面的「每批数量」）
          </label>
          <label>等待出图最长时间（秒，超时自动放行）</label>
          <input type="number" id="mjap-render-wait" min="30" step="30" placeholder="180">

          <div class="mjap-section-title">强制休息（双保险防封号）</div>
          <label>每发送 N 条后强制休息（0=不休息）</label>
          <input type="number" id="mjap-rest-every" min="0" max="50" placeholder="0">
          <label>休息时长（秒）</label>
          <input type="number" id="mjap-rest-sec" min="5" step="5" placeholder="60">

          <div class="mjap-pace-status" id="mjap-pace-status"></div>
          <button class="mjap-btn primary" id="mjap-save-pace" style="margin-top:12px">保存节奏</button>
          <div class="mjap-hint" style="margin-top:6px">改动后需点「保存节奏」或直接切换任意开关才生效</div>
        </div>

        <div class="mjap-tabpane" data-pane="template">
          <div class="mjap-section-title">MJ 8.2 提示词工作台</div>
          <div class="mjap-hint">流程：填主体描述 → 设定各维度（可随机）→ 生成结果 → 勾选入列。也可直接点「一键公式」快速出结果。</div>

          <div class="mjap-section-title">① 主体与全局</div>
          <label>描述提示词（主体内容，如「一只猫坐在屋顶」）</label>
          <textarea id="mjap-desc-input" placeholder="在这里输入你想画的主体描述，例如：一只猫坐在老城屋顶上"></textarea>
          <div class="mjap-grid2">
            <div>
              <label>前缀（拼在最前，可选）</label>
              <input type="text" id="mjap-prefix" placeholder="如：cinematic lighting, ">
            </div>
            <div>
              <label>后缀（拼在最后，可选）</label>
              <input type="text" id="mjap-suffix" placeholder="如： --no text">
            </div>
          </div>

          <div class="mjap-section-title" style="margin-top:12px">② 预设维度（留空=不叠加；可选「🎲 随机」）</div>
          <div class="mjap-grid2">
            <div>
              <label>景别（镜头距离）</label>
              <select id="mjap-preset-shot">
                <option value="">— 不选 —</option>
                <option value="__random__">🎲 随机</option>
                <option value="extreme">大远景（史诗尺度）</option>
                <option value="wide">全景（完整环境）</option>
                <option value="full">全身（完整人物）</option>
                <option value="medium">中景（腰部以上）</option>
                <option value="closeup">特写（面部）</option>
                <option value="extremecloseup">大特写（局部细节）</option>
              </select>
            </div>
            <div>
              <label>视角</label>
              <select id="mjap-preset-angle">
                <option value="">— 不选 —</option>
                <option value="__random__">🎲 随机</option>
                <option value="eyelevel">平视（中性）</option>
                <option value="low">低角度仰拍（威严）</option>
                <option value="high">高角度俯拍（渺小）</option>
                <option value="overhead">正俯视（几何构图）</option>
                <option value="dutch">荷兰角（紧张动态）</option>
              </select>
            </div>
          </div>
          <div class="mjap-grid2">
            <div>
              <label>镜头焦距</label>
              <select id="mjap-preset-lens">
                <option value="">— 不选 —</option>
                <option value="__random__">🎲 随机</option>
                <option value="18mm">18mm 超广角（史诗地景）</option>
                <option value="24mm">24mm 广角（大场景）</option>
                <option value="35mm">35mm 广角（环境叙事）</option>
                <option value="50mm">50mm 标准（通用叙事）</option>
                <option value="85mm">85mm 中长焦（肖像）</option>
                <option value="135mm">135mm 长焦（压缩特写）</option>
              </select>
            </div>
            <div>
              <label>景深</label>
              <select id="mjap-preset-dof">
                <option value="">— 不选 —</option>
                <option value="__random__">🎲 随机</option>
                <option value="shallow">浅景深（虚化背景）</option>
                <option value="medium">中景深（背景可辨）</option>
                <option value="deep">深景深（全景清晰）</option>
              </select>
            </div>
          </div>
          <div class="mjap-grid2">
            <div>
              <label>介质 / 质感</label>
              <select id="mjap-preset-medium">
                <option value="">— 不选 —</option>
                <option value="__random__">🎲 随机</option>
                <optgroup label="摄影">
                  <option value="photoreal">超写实摄影</option>
                  <option value="film">胶片摄影（Portra 400）</option>
                  <option value="editorial">时尚杂志摄影</option>
                  <option value="street">街头纪实摄影</option>
                  <option value="aerial">航拍无人机视角</option>
                </optgroup>
                <optgroup label="绘画 / 插画">
                  <option value="watercolor">水彩插画</option>
                  <option value="oilpainting">油画质感</option>
                  <option value="anime">动漫风</option>
                  <option value="flat-illustration">扁平插画</option>
                </optgroup>
                <optgroup label="数字 / 渲染">
                  <option value="3d-render">3D 渲染（Octane）</option>
                  <option value="matte">数字绘景 / 概念艺术</option>
                  <option value="pixel">像素艺术</option>
                  <option value="isometric">等距设计</option>
                  <option value="lowpoly">低多边形 3D</option>
                </optgroup>
              </select>
            </div>
            <div>
              <label>艺术流派 / 风格</label>
              <select id="mjap-preset-style">
                <option value="">— 不选 —</option>
                <option value="__random__">🎲 随机</option>
                <optgroup label="电影质感">
                  <option value="cinematic">电影剧照质感</option>
                  <option value="deakins">罗杰·迪金斯摄影风</option>
                  <option value="scifi-minimal">科幻浪漫极简</option>
                  <option value="dystopia">反乌托邦巨构</option>
                </optgroup>
                <optgroup label="当代美学">
                  <option value="cyberpunk">赛博朋克</option>
                  <option value="fantasy">奇幻史诗</option>
                  <option value="surreal">超现实主义</option>
                  <option value="vaporwave">蒸汽波</option>
                  <option value="darkacademia">暗黑学院风</option>
                  <option value="solarpunk">阳光朋克</option>
                  <option value="minimalism">极简主义</option>
                  <option value="brutalism">粗野主义</option>
                </optgroup>
                <optgroup label="艺术史流派">
                  <option value="artdeco">装饰艺术（Art Deco）</option>
                  <option value="baroque">巴洛克</option>
                  <option value="renaissance">文艺复兴</option>
                  <option value="impressionism">印象派</option>
                  <option value="ukiyoe">浮世绘</option>
                </optgroup>
              </select>
            </div>
          </div>
          <label>摄像机预设（机身 / 镜头 / 底片）</label>
          <select id="mjap-preset-camera">
            <option value="">— 不选 —</option>
            <option value="__random__">🎲 随机</option>
            <option value="arri65">Arri 65mm + Cooke 变形镜头 + 胶片</option>
            <option value="alexa">ARRI ALEXA Mini LF + Signature Prime</option>
            <option value="red">RED Komodo + 定焦镜头</option>
            <option value="sony">Sony Venice + 全画幅</option>
            <option value="imax">IMAX 65mm 巨幕</option>
            <option value="vintage">老式 16mm 胶片机</option>
          </select>
          <div class="mjap-grid2">
            <div>
              <label>光照 / 氛围</label>
              <select id="mjap-preset-light">
                <option value="">— 不选 —</option>
                <option value="__random__">🎲 随机</option>
                <option value="golden">黄金时刻暖光</option>
                <option value="neon">城市霓虹冷光</option>
                <option value="fire">火光 / 烛光</option>
                <option value="overcast">阴天柔光</option>
                <option value="studio">影棚戏剧光</option>
                <option value="volumetric">体积光 / 丁达尔</option>
                <option value="rembrandt">伦勃朗光（肖像）</option>
                <option value="backlit">逆光剪影</option>
                <option value="window">窗光（柔和自然）</option>
              </select>
            </div>
            <div>
              <label>情绪基调</label>
              <select id="mjap-preset-mood">
                <option value="">— 不选 —</option>
                <option value="__random__">🎲 随机</option>
                <option value="serene">宁静平和</option>
                <option value="dramatic">戏剧张力</option>
                <option value="melancholic">忧郁诗意</option>
                <option value="mysterious">神秘悬疑</option>
                <option value="warm">温暖治愈</option>
                <option value="cold">冷峻疏离</option>
              </select>
            </div>
          </div>

          <div class="mjap-section-title" style="margin-top:12px">③ 参数</div>
          <div class="mjap-grid2">
            <div>
              <label>画幅比</label>
              <select id="mjap-preset-ar">
                <option value="">— 不选 —</option>
                <option value="__random__">🎲 随机</option>
                <option value="21:9">21:9 超宽银幕</option>
                <option value="16:9" selected>16:9 宽屏</option>
                <option value="3:2">3:2 摄影</option>
                <option value="4:3">4:3 经典</option>
                <option value="1:1">1:1 方形</option>
                <option value="9:16">9:16 竖屏</option>
                <option value="2:3">2:3 竖版</option>
              </select>
            </div>
            <div>
              <label>附加参数（可选）</label>
              <input type="text" id="mjap-preset-extra" placeholder="如 --style raw --s 250 --no text">
            </div>
          </div>

          <div class="mjap-section-title" style="margin-top:12px">④ 生成控制</div>
          <div class="mjap-grid2" style="align-items:end">
            <div>
              <label>生成数量（1–10）</label>
              <input type="number" id="mjap-random-count" min="1" max="10" value="1">
            </div>
            <div>
              <button class="mjap-btn primary" id="mjap-apply-preset" style="width:100%;margin-bottom:10px">生成结果</button>
            </div>
          </div>
          <label class="mjap-check" style="margin-top:4px">
            <input type="checkbox" id="mjap-random-all"> 一键全随机（把所有维度都设为随机）
          </label>

          <div class="mjap-section-title" style="margin-top:12px">⑤ 一键公式（点击直接出结果）</div>
          <div class="mjap-hint">精选 MOKE 成片公式，点击直接生成完整提示词并加入下方结果列表，无需手动填参数。</div>
          <div class="mjap-formula-grid" id="mjap-formula-grid"></div>

          <div class="mjap-section-title" style="margin-top:14px">⑥ 结果列表</div>
          <div class="mjap-result-actions">
            <button class="mjap-btn" id="mjap-result-select-all">全选</button>
            <button class="mjap-btn" id="mjap-result-select-none">全不选</button>
            <button class="mjap-btn" id="mjap-result-del">删除选中</button>
            <button class="mjap-btn" id="mjap-clear-preset">清空全部</button>
            <button class="mjap-btn primary" id="mjap-preset-enqueue">勾选入列</button>
          </div>
          <div class="mjap-result-list" id="mjap-preset-result"></div>
          <div class="mjap-actions" style="margin-top:8px">
            <button class="mjap-btn" id="mjap-preset-fill-input">填入 MJ 输入框</button>
            <button class="mjap-btn" id="mjap-preset-copy">复制选中</button>
          </div>

          <div class="mjap-section-title" style="margin-top:16px">⑦ 模板批量生成（独立）</div>
          <div class="mjap-hint">用 {变量} 占位，配合多组变量值批量替换生成，适合「一个句式 × 多组主体」的场景。</div>
          <label>模板（用 {变量} 占位，如「一只{动物}在{场景}」）</label>
          <textarea id="mjap-template-input" placeholder="一只{动物}在{场景}，电影感，超广角 --ar 16:9"></textarea>
          <label>变量值（每行一组，按逗号分隔，对应模板里的变量顺序）</label>
          <textarea id="mjap-template-vars" placeholder="猫,屋顶&#10;狗,公园&#10;鸟,天空"></textarea>
          <div class="mjap-actions">
            <button class="mjap-btn primary" id="mjap-template-gen">生成并加入队列</button>
          </div>
          <div class="mjap-preview" id="mjap-template-preview"></div>
        </div>

        <div class="mjap-tabpane" data-pane="download">
          <button class="mjap-btn primary" id="mjap-scan-imgs">扫描页面图片</button>
          <div class="mjap-actions" style="margin-top:10px">
            <button class="mjap-btn primary" id="mjap-download-all">下载全部</button>
            <button class="mjap-btn" id="mjap-download-selected">下载选中</button>
            <button class="mjap-btn" id="mjap-select-all">全选</button>
          </div>
          <div class="mjap-actions">
            <button class="mjap-btn" id="mjap-invert-select">反选</button>
            <button class="mjap-btn" id="mjap-select-none">全不选</button>
          </div>
          <label class="mjap-check" style="margin-top:10px">
            <input type="checkbox" id="mjap-auto-dl"> 自动下载新生成的图
          </label>
          <label class="mjap-check">
            <input type="checkbox" id="mjap-auto-archive" checked> 按日期自动归档（子目录）
          </label>
          <label class="mjap-check">
            <input type="checkbox" id="mjap-auto-rename" checked> 自动重命名（用 prompt 关键词做文件名）
          </label>
          <label class="mjap-check">
            <input type="checkbox" id="mjap-save-prompt-txt" checked> 自动保存提示词（同名 .prompt.txt）
          </label>
          <div class="mjap-hint" style="color:#a29bfe">批量下载会静默保存到「设置」里的下载目录，不再逐个弹窗。若仍弹窗，请在 Chrome 设置 → 下载 里关闭「下载前询问每个文件的保存位置」。</div>
          <label>下载图片格式</label>
          <select id="mjap-dl-format">
            <option value="original" selected>原图（自动识别）</option>
            <option value="png">PNG</option>
            <option value="jpg">JPG</option>
            <option value="webp">WebP</option>
          </select>
          <label>归档类别（可选，会加在日期子目录后）</label>
          <input type="text" id="mjap-archive-cat" placeholder="如：人物 / 风景 / 项目A">
          <div class="mjap-img-count" id="mjap-img-count"></div>
          <div class="mjap-img-list" id="mjap-img-list"></div>
        </div>

        <div class="mjap-tabpane" data-pane="settings">
          <div class="mjap-hint" style="margin-bottom:10px;color:#a29bfe">已内置免费 AI（Index-Translate）：翻译中文 prompt 无需任何 Key 即可用。</div>
          <label>下载目录（相对 Chrome 下载文件夹）</label>
          <div class="mjap-folder-row">
            <input type="text" id="mjap-folder" placeholder="MJ-Autopilot">
            <button class="mjap-btn" id="mjap-pick-folder">选择目录</button>
          </div>
          <div class="mjap-hint">可直接输入子目录名（如 <code>MJ-Autopilot/风景</code>），或点「选择目录」选一个文件夹名。图片会保存到 Chrome 下载目录下的这个相对路径。</div>
          <div class="mjap-hint" style="color:#fdcb6e">发送节奏（每批数量、间隔、串行确认等）已移至「节奏」标签页统一管理。</div>
          <label class="mjap-check">
            <input type="checkbox" id="mjap-translate" checked> 自动翻译中文 prompt
          </label>
          <label class="mjap-check">
            <input type="checkbox" id="mjap-queue-aware"> 排队感知（满则等空位，实验性）
          </label>
          <label class="mjap-check">
            <input type="checkbox" id="mjap-auto-retry" checked> 失败自动重试（3 次）
          </label>
          <label class="mjap-check">
            <input type="checkbox" id="mjap-seed-reuse" checked> seed 复用（自动记忆最近 seed）
          </label>
          <label class="mjap-check">
            <input type="checkbox" id="mjap-random-seed"> 随机 seed（每条自动加随机 --seed，图不重复）
          </label>
          <label class="mjap-check">
            <input type="checkbox" id="mjap-random-order"> 随机顺序发送（防封号）
          </label>
          <div class="mjap-hint" style="color:#fdcb6e">提示词前缀 / 后缀已移至「模板」标签页管理。</div>
          <label class="mjap-check">
            <input type="checkbox" id="mjap-schedule"> 定时发送
          </label>
          <label>定时开始时间（HH:MM，如 21:30）</label>
          <input type="text" id="mjap-schedule-time" placeholder="21:30">
          <button class="mjap-btn primary" id="mjap-save">保存设置</button>
        </div>
      </div>
    `;
    document.body.appendChild(host);
    bindPanelEvents();
    renderQueue();
  }

  function switchTab(name) {
    $$('.mjap-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.mjap-tabpane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  }

  function bindPanelEvents() {
    $('#mjap-toggle').addEventListener('click', () => $('#mjap-body').classList.toggle('open'));
    $('#mjap-close').addEventListener('click', () => $('#mjap-body').classList.remove('open'));

    $$('.mjap-tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

    // 批量加入
    $('#mjap-add-batch').addEventListener('click', () => {
      const lines = parsePrompts($('#mjap-batch-input').value);
      if (lines.length === 0) { toast('未识别到有效提示词'); return; }
      const r = addManyToQueue(lines);
      $('#mjap-batch-input').value = '';
      $('#mjap-preview').innerHTML = '';
      switchTab('queue');
      toast(`已加入 ${r.added} 条${r.skipped ? `（跳过 ${r.skipped} 条重复）` : ''}`);
    });

    // 实时预览
    $('#mjap-batch-input').addEventListener('input', () => {
      const lines = parsePrompts($('#mjap-batch-input').value);
      const pv = $('#mjap-preview');
      if (lines.length > 0) {
        pv.innerHTML = `<div class="mjap-preview-title">识别到 ${lines.length} 条提示词（预览前 3 条）：</div>` +
          lines.slice(0, 3).map((l) => `<div class="mjap-preview-item">${escapeHtml(l)}</div>`).join('') +
          (lines.length > 3 ? `<div class="mjap-preview-more">…还有 ${lines.length - 3} 条</div>` : '');
      } else {
        pv.innerHTML = '';
      }
    });

    // 导入文件
    $('#mjap-import-btn').addEventListener('click', () => $('#mjap-file-import').click());
    $('#mjap-file-import').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      readFile(file, (text) => {
        const lines = parsePrompts(text);
        const r = addManyToQueue(lines);
        switchTab('queue');
        toast(`导入 ${r.added} 条提示词${r.skipped ? `（跳过 ${r.skipped} 条重复）` : ''}`);
      });
      e.target.value = '';
    });

    // 拖拽文件到输入框
    const batchInput = $('#mjap-batch-input');
    batchInput.addEventListener('dragover', (e) => e.preventDefault());
    batchInput.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && /\.(txt|text|md|markdown)$/i.test(file.name)) {
        readFile(file, (text) => {
          batchInput.value = text;
          const lines = parsePrompts(text);
          toast(`已载入 ${lines.length} 条，可预览或直接加入队列`);
        });
      }
    });

    // ===== MJ 8.2 公式预设组合器（按 MOKE 五格模型：主体→景别→构图→风格→光影→参数）=====
    // 主体描述 + 景别/视角/焦段/景深 + 介质 + 艺术风格 + 相机 + 光照 + 情绪 → 完整 MJ 8.2 prompt
    // 支持「🎲 随机」：任一维度选「__random__」时，在该维度的候选中随机取一个。
    const RANDOM_MARK = '__random__';

    // 从某个预设组随机取一个 key（不包含 __random__ 本身）
    function randomPresetKey(group) {
      const keys = Object.keys(MJ_PRESETS[group] || {});
      if (keys.length === 0) return '';
      return keys[randInt(0, keys.length - 1)];
    }

    // 读取某个 select 的值，若为「随机」则从对应组随机取一个；返回实际取值（可为空字符串）
    function resolvePreset(group, selectId) {
      const el = $('#' + selectId);
      const val = el ? el.value : '';
      if (val === RANDOM_MARK) return randomPresetKey(group);
      return val;
    }

    // 画幅比候选（随机画幅时用）
    const AR_OPTIONS = ['21:9', '16:9', '3:2', '4:3', '1:1', '9:16', '2:3'];

    function buildPresetPrompt() {
      const v = (id) => { const el = $('#' + id); return el ? el.value : ''; };
      const desc = v('mjap-desc-input').trim();
      // 各维度：支持「随机」取值
      const style = resolvePreset('style', 'mjap-preset-style');
      const medium = resolvePreset('medium', 'mjap-preset-medium');
      const camera = resolvePreset('camera', 'mjap-preset-camera');
      const shot = resolvePreset('shot', 'mjap-preset-shot');
      const angle = resolvePreset('angle', 'mjap-preset-angle');
      const lens = resolvePreset('lens', 'mjap-preset-lens');
      const dof = resolvePreset('dof', 'mjap-preset-dof');
      const light = resolvePreset('light', 'mjap-preset-light');
      const mood = resolvePreset('mood', 'mjap-preset-mood');
      let ar = v('mjap-preset-ar');
      if (ar === RANDOM_MARK) ar = AR_OPTIONS[randInt(0, AR_OPTIONS.length - 1)];
      const extra = v('mjap-preset-extra').trim();
      const prefix = v('mjap-prefix').trim();
      const suffix = v('mjap-suffix').trim();
      const parts = [];
      // 1) 前缀（可选）
      if (prefix) parts.push(prefix);
      // 2) 主体描述
      if (desc) parts.push(desc);
      // 3) 景别（镜头距离）
      if (shot && MJ_PRESETS.shot[shot]) parts.push(MJ_PRESETS.shot[shot]);
      // 4) 视角
      if (angle && MJ_PRESETS.angle[angle]) parts.push(MJ_PRESETS.angle[angle]);
      // 5) 焦段
      if (lens && MJ_PRESETS.lens[lens]) parts.push(MJ_PRESETS.lens[lens]);
      // 6) 景深
      if (dof && MJ_PRESETS.dof[dof]) parts.push(MJ_PRESETS.dof[dof]);
      // 7) 介质 / 质感
      if (medium && MJ_PRESETS.medium[medium]) parts.push(MJ_PRESETS.medium[medium]);
      // 8) 艺术流派 / 风格
      if (style && MJ_PRESETS.style[style]) parts.push(MJ_PRESETS.style[style]);
      // 9) 相机
      if (camera && MJ_PRESETS.camera[camera]) parts.push(MJ_PRESETS.camera[camera]);
      // 10) 光照
      if (light && MJ_PRESETS.light[light]) parts.push(MJ_PRESETS.light[light]);
      // 11) 情绪氛围
      if (mood && MJ_PRESETS.mood[mood]) parts.push(MJ_PRESETS.mood[mood]);
      // 参数后缀：画幅比 + 版本 + 用户自定义参数
      let suffixParams = '--v 8.2';
      if (ar) suffixParams += ` --ar ${ar}`;
      if (extra) suffixParams += ' ' + extra;
      let body = parts.join(' ').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').trim();
      if (suffix) body = body + ' ' + suffix;
      return body + ' ' + suffixParams;
    }

    // 生成结果列表（缓存多条结果，支持勾选/删除/批量入列）
    let presetResults = []; // 每个元素 { id, prompt, checked }

    function renderPresetResult() {
      const el = $('#mjap-preset-result');
      if (!el) return;
      if (presetResults.length === 0) {
        el.innerHTML = '<div class="mjap-hint">点「生成结果」后，完整提示词会逐条显示在这里，可勾选后批量入列。</div>';
        return;
      }
      el.innerHTML = presetResults.map((r, i) => `
        <div class="mjap-result-item" data-idx="${i}">
          <input type="checkbox" class="mjap-result-check" ${r.checked ? 'checked' : ''}>
          <div class="mjap-result-text">${escapeHtml(r.prompt)}</div>
          <button class="mjap-result-del-one" title="删除">×</button>
        </div>
      `).join('');
      // 勾选
      el.querySelectorAll('.mjap-result-check').forEach((cb) => {
        cb.addEventListener('change', () => {
          presetResults[parseInt(cb.closest('.mjap-result-item').dataset.idx, 10)].checked = cb.checked;
        });
      });
      // 单条删除
      el.querySelectorAll('.mjap-result-del-one').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.closest('.mjap-result-item').dataset.idx, 10);
          presetResults.splice(idx, 1);
          renderPresetResult();
        });
      });
    }

    // 追加结果（生成后累加到列表末尾，不覆盖已有）
    function appendPresetResults(prompts) {
      prompts.forEach((p) => {
        if (!p) return;
        presetResults.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), prompt: p, checked: false });
      });
      renderPresetResult();
    }

    // 一键全随机：把所有预设维度都设为「随机」
    $('#mjap-random-all').addEventListener('change', () => {
      const on = $('#mjap-random-all').checked;
      const presetIds = [
        'mjap-preset-shot', 'mjap-preset-angle', 'mjap-preset-lens', 'mjap-preset-dof',
        'mjap-preset-medium', 'mjap-preset-style', 'mjap-preset-camera',
        'mjap-preset-light', 'mjap-preset-mood', 'mjap-preset-ar',
      ];
      presetIds.forEach((id) => {
        const el = $('#' + id);
        if (el) el.value = on ? RANDOM_MARK : '';
      });
      // 全随机时若没有默认画幅，清空后画幅也随机；关闭时恢复画幅默认 16:9
      if (!on) $('#mjap-preset-ar').value = '16:9';
      toast(on ? '已开启一键全随机（所有维度随机组合）' : '已关闭全随机（各维度恢复不选）');
    });

    // 生成结果（单条或 N 条随机组合）
    $('#mjap-apply-preset').addEventListener('click', () => {
      const desc = $('#mjap-desc-input').value.trim();
      if (!desc) { toast('请先在「描述提示词」框里输入主体内容'); return; }
      // 读取生成数量（1–10）
      const cntInput = $('#mjap-random-count');
      let count = parseInt(cntInput && cntInput.value, 10);
      if (!Number.isFinite(count) || count < 1) count = 1;
      if (count > 10) count = 10;
      const prompts = [];
      for (let i = 0; i < count; i++) prompts.push(buildPresetPrompt());
      appendPresetResults(prompts);
      // 滚动到结果列表，让生成结果立即可见
      const rl = $('#mjap-preset-result');
      if (rl && rl.scrollIntoView) rl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast(count > 1 ? `已生成 ${count} 条结果（可勾选批量入列）` : '已生成 1 条结果');
    });

    // 勾选结果批量加入队列
    $('#mjap-preset-enqueue').addEventListener('click', () => {
      const selected = presetResults.filter((r) => r.checked).map((r) => r.prompt);
      if (selected.length === 0) { toast('请先勾选要加入队列的结果（或点「全选」）'); return; }
      const r = addManyToQueue(selected);
      switchTab('queue');
      toast(`已加入队列 ${r.added} 条${r.skipped ? `（跳过 ${r.skipped} 条重复）` : ''}`);
    });

    // 全选 / 全不选
    $('#mjap-result-select-all').addEventListener('click', () => {
      presetResults.forEach((r) => { r.checked = true; });
      renderPresetResult();
    });
    $('#mjap-result-select-none').addEventListener('click', () => {
      presetResults.forEach((r) => { r.checked = false; });
      renderPresetResult();
    });

    // 删除选中的结果
    $('#mjap-result-del').addEventListener('click', () => {
      const before = presetResults.length;
      presetResults = presetResults.filter((r) => !r.checked);
      const removed = before - presetResults.length;
      if (removed === 0) { toast('请先勾选要删除的结果'); return; }
      renderPresetResult();
      toast(`已删除 ${removed} 条结果`);
    });

    // 填入 MJ 输入框（取第一条勾选，或第一条结果）
    $('#mjap-preset-fill-input').addEventListener('click', () => {
      const target = presetResults.find((r) => r.checked) || presetResults[0];
      if (!target) { toast('请先生成结果'); return; }
      const input = findPromptInput();
      if (!input) { toast('未找到 MJ 输入框，请确认已打开 Midjourney 页面'); return; }
      setNativeValue(input, target.prompt);
      input.focus();
      toast('已填入 MJ 输入框');
    });

    // 清空所有预设 + 结果
    $('#mjap-clear-preset').addEventListener('click', () => {
      $('#mjap-preset-style').value = '';
      $('#mjap-preset-medium').value = '';
      $('#mjap-preset-camera').value = '';
      $('#mjap-preset-shot').value = '';
      $('#mjap-preset-angle').value = '';
      $('#mjap-preset-lens').value = '';
      $('#mjap-preset-dof').value = '';
      $('#mjap-preset-light').value = '';
      $('#mjap-preset-mood').value = '';
      $('#mjap-preset-ar').value = '16:9';
      $('#mjap-preset-extra').value = '';
      $('#mjap-prefix').value = '';
      $('#mjap-suffix').value = '';
      $('#mjap-desc-input').value = '';
      const ra = $('#mjap-random-all'); if (ra) ra.checked = false;
      presetResults = [];
      renderPresetResult();
      toast('已清空描述、预设与结果');
    });

    // 复制选中结果到剪贴板
    $('#mjap-preset-copy').addEventListener('click', async () => {
      const selected = presetResults.filter((r) => r.checked).map((r) => r.prompt);
      const text = (selected.length > 0 ? selected : presetResults.map((r) => r.prompt)).join('\n\n');
      if (!text) { toast('请先生成结果'); return; }
      try {
        await navigator.clipboard.writeText(text);
        toast(`已复制 ${selected.length > 0 ? selected.length : presetResults.length} 条结果`);
      } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); toast('已复制到剪贴板'); }
        catch (e2) { toast('复制失败，请手动复制'); }
        ta.remove();
      }
    });

    // 前缀 / 后缀（已移至模板页）：改动即自动保存，供全局队列运行时拼接使用
    ['#mjap-prefix', '#mjap-suffix'].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      el.addEventListener('change', () => {
        settings.promptPrefix = $('#mjap-prefix').value.trim();
        settings.promptSuffix = $('#mjap-suffix').value.trim();
        saveSettings();
      });
      el.addEventListener('blur', () => {
        settings.promptPrefix = $('#mjap-prefix').value.trim();
        settings.promptSuffix = $('#mjap-suffix').value.trim();
        saveSettings();
      });
    });

    // ===== 成片公式模板（MOKE 提示词工程成片公式，一键出结果）=====
    const FORMULA_TEMPLATES = [
      {
        name: '电影人像', cat: '人像',
        desc: 'a {人物}, {表情}, wearing {服装}, {景别} shot, {焦段} lens, shallow depth of field, {光照}, {背景}, contemporary editorial portrait, {情绪} mood',
        example: 'a 30-year-old woman, calm confident expression, wearing a navy blazer, close-up shot, 85mm lens, shallow depth of field, Rembrandt lighting, soft beige studio backdrop, contemporary editorial portrait, warm mood',
        presets: { shot: 'closeup', dof: 'shallow', light: 'rembrandt', mood: 'warm', ar: '4:5' },
      },
      {
        name: '产品静物', cat: '电商/产品',
        desc: 'a {产品} made of {材质}, placed on {台面}, {光照}, {背景色}, rule-of-thirds composition with negative space, {情绪} mood',
        example: 'a minimalist ceramic coffee dripper made of matte porcelain, placed on walnut wood surface, soft window light, warm beige background, rule-of-thirds composition with negative space, calm morning mood',
        presets: { medium: 'photoreal', light: 'window', mood: 'serene', ar: '1:1', extra: '--style raw --s 250' },
      },
      {
        name: '电影场景', cat: '场景',
        desc: '{场景描述} during {时刻}, {天气氛围}, slow cinematic camera feel, {色彩}, {光影}',
        example: 'a quiet Tokyo alley during early morning, light rain, slow cinematic camera feel, muted teal and amber palette, soft golden light',
        presets: { style: 'cinematic', camera: 'arri65', lens: '24mm', light: 'golden', mood: 'mysterious', ar: '21:9', extra: '--stylize 600' },
      },
      {
        name: '史诗地景', cat: '场景',
        desc: '{时刻} {地貌}, {大气条件}, epic sense of scale, {风格参考}, {色彩}',
        example: 'dawn over a vast mountain range, rolling mist, epic sense of scale, muted earth tones with gold accents',
        presets: { shot: 'extreme', lens: '18mm', light: 'volumetric', mood: 'dramatic', ar: '21:9', extra: '--s 350' },
      },
      {
        name: '风格插画', cat: '插画',
        desc: '{主体} in the style of {艺术家/流派}, {介质}, {色彩处理}, {关键视觉元素}',
        example: 'a corgi astronaut floating through a candy-colored nebula in the style of 1960s Soviet space posters, risograph print texture, limited palette of teal and coral',
        presets: { medium: 'flat-illustration', style: 'surreal', mood: 'serene', ar: '3:4', extra: '--niji 6' },
      },
      {
        name: '概念艺术', cat: '插画',
        desc: '{主体} in {奇幻设定}, epic fantasy concept art, {关键细节}, {光照}, {氛围}, highly detailed',
        example: 'a floating castle above a sea of clouds, epic fantasy concept art, intricate spires, golden sunrise light, mystical atmosphere, highly detailed',
        presets: { medium: 'matte', style: 'fantasy', lens: '35mm', light: 'fire', mood: 'dramatic', ar: '16:9', extra: '--s 400' },
      },
      {
        name: '科幻极简', cat: '风格化',
        desc: '{主体}, vast negative space, minimal composition, single subject off-center, quiet and breathable',
        example: 'a lone astronaut drifting in an endless void, vast negative space, minimal composition, single subject off-center, quiet and breathable',
        presets: { style: 'scifi-minimal', lens: '85mm', dof: 'shallow', light: 'volumetric', mood: 'cold', ar: '16:9' },
      },
      {
        name: '反乌托邦', cat: '风格化',
        desc: '{主体} in monumental brutalist architecture, tiny figure in vast interior, single shaft of light cutting through darkness',
        example: 'a lone figure in monumental brutalist architecture, tiny figure in vast interior, single shaft of light cutting through darkness',
        presets: { style: 'dystopia', shot: 'wide', angle: 'low', lens: '24mm', light: 'volumetric', mood: 'melancholic', ar: '21:9' },
      },
      {
        name: '美食摄影', cat: '电商/产品',
        desc: '{食物} on {餐具}, {光照} from {方向}, {背景}, macro detail, appetizing steam, {色彩}',
        example: 'a bowl of ramen on a ceramic plate, warm light from the left, dark wood background, macro detail, appetizing steam, rich amber tones',
        presets: { medium: 'photoreal', shot: 'closeup', dof: 'shallow', light: 'golden', mood: 'warm', ar: '1:1', extra: '--style raw' },
      },
      {
        name: '时尚街拍', cat: '人像',
        desc: '{人物} in {服装}, walking through {场景}, candid street photography, natural light, {色彩}',
        example: 'a young woman in a long coat, walking through a rain-soaked city street, candid street photography, natural light, muted teal and amber',
        presets: { medium: 'street', shot: 'full', lens: '35mm', light: 'overcast', mood: 'mysterious', ar: '3:4' },
      },
    ];

    function renderFormulaTemplates() {
      const grid = $('#mjap-formula-grid');
      if (!grid) return;
      grid.innerHTML = FORMULA_TEMPLATES.map((f, i) => `
        <div class="mjap-formula-card" data-idx="${i}">
          <div class="mjap-formula-name">${escapeHtml(f.name)}</div>
          <div class="mjap-formula-cat">${escapeHtml(f.cat)}</div>
          <div class="mjap-formula-desc">${escapeHtml(f.example || f.desc)}</div>
        </div>
      `).join('');
      grid.querySelectorAll('.mjap-formula-card').forEach((card) => {
        card.addEventListener('click', () => {
          const f = FORMULA_TEMPLATES[parseInt(card.dataset.idx, 10)];
          applyFormulaTemplate(f);
        });
      });
    }

    function applyFormulaTemplate(f) {
      // 一键公式：点击直接把「示例描述 + 预设」生成完整提示词，加入结果列表。
      // 描述框填入含 {变量} 的模板，方便用户改成自己的主体后重新「生成结果」。
      const descToUse = f.example || f.desc;
      $('#mjap-desc-input').value = descToUse;
      // 同步预设到表单（让用户看到这套公式用了哪些参数，也便于微调）
      $('#mjap-preset-style').value = f.presets.style || '';
      $('#mjap-preset-medium').value = f.presets.medium || '';
      $('#mjap-preset-camera').value = f.presets.camera || '';
      $('#mjap-preset-shot').value = f.presets.shot || '';
      $('#mjap-preset-angle').value = f.presets.angle || '';
      $('#mjap-preset-lens').value = f.presets.lens || '';
      $('#mjap-preset-dof').value = f.presets.dof || '';
      $('#mjap-preset-light').value = f.presets.light || '';
      $('#mjap-preset-mood').value = f.presets.mood || '';
      $('#mjap-preset-ar').value = f.presets.ar || '16:9';
      $('#mjap-preset-extra').value = f.presets.extra || '';
      const ra = $('#mjap-random-all'); if (ra) ra.checked = false;
      // 直接生成结果并加入列表
      const prompt = buildPresetPrompt();
      appendPresetResults([prompt]);
      // 滚动到结果列表，让生成结果立即可见
      const rl = $('#mjap-preset-result');
      if (rl && rl.scrollIntoView) rl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast(`已按「${f.name}」一键生成结果（描述框已填入示例，可修改后重新生成）`);
    }

    renderFormulaTemplates();

    // 模板生成
    $('#mjap-template-gen').addEventListener('click', () => {
      const tpl = $('#mjap-template-input').value.trim();
      const varsRaw = $('#mjap-template-vars').value.trim();
      if (!tpl) { toast('请先填写模板'); return; }
      const varSets = varsRaw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/[,，]/).map((s) => s.trim()));
      const result = [];
      if (varSets.length === 0) {
        // 无变量，模板原样
        result.push(tpl);
      } else {
        for (const set of varSets) {
          let p = tpl;
          set.forEach((val, i) => { p = p.split(`{${i}}`).join(val); });
          // 处理具名变量 {动物} 等（如果用了名字而不是索引）
          p = p.replace(/\{([^}]+)\}/g, (m, name) => {
            const idx = varSets[0].length > 1 ? varSets[0].indexOf(name) : -1;
            // 这里简化：具名变量按顺序替换
            const n = parseInt(name, 10);
            if (Number.isFinite(n) && set[n] !== undefined) return set[n];
            return set[0] || m;
          });
          result.push(p);
        }
      }
      const pv = $('#mjap-template-preview');
      pv.innerHTML = `<div class="mjap-preview-title">将生成 ${result.length} 条：</div>` +
        result.slice(0, 3).map((l) => `<div class="mjap-preview-item">${escapeHtml(l)}</div>`).join('') +
        (result.length > 3 ? `<div class="mjap-preview-more">…还有 ${result.length - 3} 条</div>` : '');
      const r = addManyToQueue(result);
      switchTab('queue');
      toast(`模板已生成 ${r.added} 条并加入队列${r.skipped ? `（跳过 ${r.skipped} 条重复）` : ''}`);
    });

    // 运行/暂停（单按钮切换）/停止/清空
    $('#mjap-run').addEventListener('click', () => {
      if (running) {
        pauseFlag = !pauseFlag;
        updateRunButton();
        toast(pauseFlag ? '⏸ 已暂停' : '▶ 已恢复运行');
      } else {
        runQueue();
      }
    });
    $('#mjap-stop').addEventListener('click', () => { stopFlag = true; });
    $('#mjap-clear').addEventListener('click', () => {
      queue = queue.filter((q) => q.status === 'pending' || q.status === 'running');
      persistQueue(); renderQueue(); toast('已清空已完成项');
    });
    // 清理已勾选的任务
    $('#mjap-clear-checked').addEventListener('click', () => {
      const checkedCount = queue.filter((q) => q.checked).length;
      if (checkedCount === 0) { toast('没有勾选的任务'); return; }
      queue = queue.filter((q) => !q.checked);
      persistQueue(); renderQueue();
      toast(`已清理 ${checkedCount} 条勾选任务`);
    });
    // 一键勾选所有「完成」项（方便统一清理）
    $('#mjap-check-all-done').addEventListener('click', () => {
      let n = 0;
      queue.forEach((q) => { if (q.status === 'done' && !q.checked) { q.checked = true; n++; } });
      persistQueue(); renderQueue();
      toast(n > 0 ? `已勾选 ${n} 条完成项` : '没有可勾选的完成项');
    });

    // 队列导出/导入
    $('#mjap-export').addEventListener('click', exportQueue);
    $('#mjap-import-queue').addEventListener('click', () => $('#mjap-queue-file').click());
    $('#mjap-queue-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) importQueue(file);
      e.target.value = '';
    });

    // 下载
    $('#mjap-scan-imgs').addEventListener('click', scanImages);
    $('#mjap-download-all').addEventListener('click', () => downloadSelected(true));
    $('#mjap-download-selected').addEventListener('click', () => downloadSelected(false));
    $('#mjap-select-all').addEventListener('click', () => $$('.mjap-img-check').forEach((cb) => (cb.checked = true)));
    $('#mjap-select-none').addEventListener('click', () => $$('.mjap-img-check').forEach((cb) => (cb.checked = false)));
    $('#mjap-invert-select').addEventListener('click', () => $$('.mjap-img-check').forEach((cb) => (cb.checked = !cb.checked)));

    // 手选下载目录
    $('#mjap-pick-folder').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.webkitdirectory = true; // 选择文件夹
      input.addEventListener('change', (e) => {
        const files = e.target.files;
        if (files && files.length > 0) {
          // 用第一个文件的 webkitRelativePath 推导目录名
          const rel = files[0].webkitRelativePath || '';
          const dirName = rel.split('/')[0] || '';
          if (dirName) {
            $('#mjap-folder').value = dirName;
            settings.downloadFolder = dirName;
            saveSettings();
            toast(`下载目录已设为「${dirName}」`);
          } else {
            toast('未能识别目录名');
          }
        }
      });
      input.click();
    });

    // 设置（翻译 / seed / 前缀后缀 / 定时 / 下载格式等，不含发送节奏）
    $('#mjap-save').addEventListener('click', () => {
      settings.downloadFolder = $('#mjap-folder').value.trim() || 'MJ-Autopilot';
      settings.translateEnabled = $('#mjap-translate').checked;
      settings.queueAware = $('#mjap-queue-aware').checked;
      settings.autoRetry = $('#mjap-auto-retry').checked;
      settings.seedReuse = $('#mjap-seed-reuse').checked;
      settings.randomSeed = $('#mjap-random-seed').checked;
      settings.randomOrder = $('#mjap-random-order').checked;
      settings.dlFormat = $('#mjap-dl-format').value;
      settings.scheduleEnabled = $('#mjap-schedule').checked;
      settings.scheduleTime = $('#mjap-schedule-time').value.trim();
      settings.autoDownload = $('#mjap-auto-dl').checked;
      settings.autoArchive = $('#mjap-auto-archive').checked;
      settings.archiveCategory = $('#mjap-archive-cat').value.trim();
      settings.autoRename = $('#mjap-auto-rename').checked;
      settings.savePromptTxt = $('#mjap-save-prompt-txt').checked;
      saveSettings();
      toggleAutoDownload();
      toast('设置已保存');
    });

    // 节奏（每批数量 / 间隔 / 串行确认 / 强制休息）
    function savePace() {
      settings.sendMode = $('#mjap-send-mode').value;
      settings.batchMode = $('#mjap-batch-mode').checked;
      const bs = parseInt($('#mjap-batch-size').value, 10);
      settings.batchSize = Number.isFinite(bs) && bs >= 1 ? bs : 3;
      const bw = parseInt($('#mjap-batch-wait').value, 10);
      settings.batchWait = Number.isFinite(bw) && bw >= 10 ? bw : 180;
      const iv = parseInt($('#mjap-interval').value, 10);
      settings.interval = Number.isFinite(iv) && iv >= 1 ? iv : 3;
      settings.randomInterval = $('#mjap-random-interval').checked;
      const imin = parseInt($('#mjap-interval-min').value, 10);
      settings.intervalMin = Number.isFinite(imin) && imin >= 1 ? imin : 3;
      const imax = parseInt($('#mjap-interval-max').value, 10);
      settings.intervalMax = Number.isFinite(imax) && imax >= imin ? imax : 8;
      settings.serialConfirm = $('#mjap-serial-confirm').checked;
      const rw = parseInt($('#mjap-render-wait').value, 10);
      settings.renderWaitMs = Number.isFinite(rw) && rw >= 10 ? rw * 1000 : 180000;
      const re = parseInt($('#mjap-rest-every').value, 10);
      settings.restEvery = Number.isFinite(re) && re >= 0 ? re : 0;
      const rs = parseInt($('#mjap-rest-sec').value, 10);
      settings.restSec = Number.isFinite(rs) && rs >= 5 ? rs : 60;
      saveSettings();
      renderPaceStatus();
      toast('节奏已保存');
    }

    // 实时显示当前生效的节奏参数（保存后更新）
    function renderPaceStatus() {
      const el = $('#mjap-pace-status');
      if (!el) return;
      const mode = (SEND_MODES[settings.sendMode] || {}).label || '—';
      const batchTxt = settings.batchMode
        ? `每批 ${settings.batchSize} 个 · 批间${settings.serialConfirm ? '等出图' : '固定等 ' + settings.batchWait + 's'}`
        : '不分批（连续发送）';
      const ivTxt = settings.randomInterval
        ? `间隔 ${settings.intervalMin}~${settings.intervalMax}s（随机）`
        : `间隔 ${settings.interval}s`;
      const restTxt = settings.restEvery > 0 ? `每 ${settings.restEvery} 条休息 ${settings.restSec}s` : '不强制休息';
      el.innerHTML = `当前：${mode} ｜ ${batchTxt} ｜ ${ivTxt} ｜ ${restTxt}`;
    }

    $('#mjap-save-pace').addEventListener('click', savePace);

    // 改动即生效：所有节奏控件在 change 时自动保存（不用必须点按钮）
    [
      '#mjap-send-mode', '#mjap-batch-mode', '#mjap-batch-size', '#mjap-batch-wait',
      '#mjap-interval', '#mjap-random-interval', '#mjap-interval-min', '#mjap-interval-max',
      '#mjap-serial-confirm', '#mjap-render-wait', '#mjap-rest-every', '#mjap-rest-sec',
    ].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      el.addEventListener('change', () => { savePace(); });
      // number/select 输入框在失焦或回车时也保存
      el.addEventListener('blur', () => { savePace(); });
    });

    // 发送模式预设：切换时自动应用整套间隔参数并立即保存
    $('#mjap-send-mode').addEventListener('change', () => {
      const mode = SEND_MODES[$('#mjap-send-mode').value];
      if (!mode) return;
      // 同步到输入框
      $('#mjap-interval-min').value = mode.intervalMin;
      $('#mjap-interval-max').value = mode.intervalMax;
      $('#mjap-batch-wait').value = mode.batchWait;
      // 固定间隔也取区间中值，保证「随机间隔」关闭时预设仍生效
      $('#mjap-interval').value = Math.round((mode.intervalMin + mode.intervalMax) / 2);
      // 立即应用并保存，无需再点「保存节奏」
      savePace();
      toast(`已切换到「${mode.label}」模式预设（已生效）`);
    });
  }

  // ===== 解析提示词 =====
  function parsePrompts(text) {
    if (window.PromptParser) {
      return window.PromptParser.parse(text);
    }
    return String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }

  function readFile(file, cb) {
    const reader = new FileReader();
    reader.onload = () => cb(String(reader.result));
    reader.onerror = () => toast('读取文件失败');
    reader.readAsText(file, 'utf-8');
  }

  // ===== 队列逻辑 =====
  function addToQueue(prompt) {
    queue.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), prompt, status: 'pending', retries: 0, checked: false });
  }

  // 批量加入：自动去重（跳过与队列中已有的完全相同、且忽略首尾空白的 prompt）
  function addManyToQueue(prompts) {
    const existing = new Set(queue.map((q) => (q.prompt || '').trim()));
    let added = 0, skipped = 0;
    prompts.forEach((p) => {
      const key = (p || '').trim();
      if (!key) return;
      if (existing.has(key)) { skipped++; return; }
      existing.add(key);
      queue.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), prompt: key, status: 'pending', retries: 0, checked: false });
      added++;
    });
    persistQueue(); renderQueue();
    return { added, skipped };
  }

  // ===== 预计完成时间估算 =====
  // 基于当前节奏配置 + 剩余任务数，估算跑完还需多久
  function estimateTotalTime() {
    const remaining = queue.filter((q) => q.status === 'pending' || q.status === 'running').length;
    if (remaining === 0) return { remaining: 0, seconds: 0, text: '—', eta: null };

    // 单条提交间隔（秒）：随机取区间中值，固定取固定值
    let avgIntervalSec;
    if (settings.randomInterval && settings.intervalMax > settings.intervalMin) {
      avgIntervalSec = (settings.intervalMin + settings.intervalMax) / 2;
    } else {
      avgIntervalSec = settings.interval;
    }

    // 每批数量
    const batchSize = settings.batchMode ? Math.max(1, settings.batchSize || 10) : remaining;

    // 批间等待（秒）：批间出图确认用 renderWaitMs 上限做最坏估算，否则用 batchWait
    const batchWaitSec = settings.serialConfirm
      ? (settings.renderWaitMs || 180000) / 1000
      : (settings.batchWait || 180);

    const batchCount = Math.ceil(remaining / batchSize);

    // 总耗时 = 批次内所有提交间隔 + 每批之间的等待 + 强制休息
    let totalSec = 0;
    totalSec += remaining * avgIntervalSec;            // 所有条目的提交间隔
    totalSec += (batchCount - 1) * batchWaitSec;        // 批间等待（第一批不用等）
    if (settings.restEvery > 0) {
      const restCount = Math.floor(remaining / settings.restEvery);
      totalSec += restCount * (settings.restSec || 60);
    }

    // 预计完成时刻
    const eta = new Date(Date.now() + totalSec * 1000);
    return { remaining, seconds: totalSec, eta };
  }

  // 把秒格式化为「Xh Ym Zs」或「Ym Zs」
  function formatDuration(sec) {
    sec = Math.round(sec);
    if (sec < 60) return `${sec} 秒`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h} 小时 ${m} 分`;
    if (m > 0) return `${m} 分 ${s} 秒`;
    return `${s} 秒`;
  }

  function renderQueue() {
    const el = $('#mjap-queue');
    const countEl = $('#mjap-queue-count');
    const statsEl = $('#mjap-queue-stats');
    if (!el) return;
    if (countEl) countEl.textContent = queue.filter((q) => q.status === 'pending' || q.status === 'running').length;
    if (statsEl) {
      const pending = queue.filter((q) => q.status === 'pending').length;
      const done = queue.filter((q) => q.status === 'done').length;
      const failed = queue.filter((q) => q.status === 'failed').length;
      const checked = queue.filter((q) => q.checked).length;
      const est = estimateTotalTime();
      let estHtml = '';
      if (est.remaining > 0) {
        const etaStr = est.eta ? `，约 ${est.eta.getHours()}:${String(est.eta.getMinutes()).padStart(2, '0')} 完成` : '';
        estHtml = `<div class="mjap-queue-eta">预计还需 ${formatDuration(est.seconds)}${etaStr}</div>`;
      }
      statsEl.innerHTML = `待执行 ${pending} · 完成 ${done} · 失败 ${failed} · 已勾选 ${checked}${estHtml}`;
    }
    el.innerHTML = '';
    if (queue.length === 0) {
      el.innerHTML = '<div class="mjap-empty">队列为空，去「批量」或「模板」页添加 prompt</div>';
      return;
    }
    const statusText = { pending: '待执行', running: '执行中', done: '完成', failed: '失败' };
    queue.forEach((item, idx) => {
      const div = document.createElement('div');
      div.className = 'mjap-queue-item ' + item.status + (item.checked ? ' checked' : '');
      div.draggable = true;
      div.dataset.idx = idx;
      const retryInfo = item.retries > 0 ? `（重试 ${item.retries}）` : '';
      const retryBtn = (item.status === 'failed' || item.status === 'done')
        ? `<button class="mjap-queue-retry" title="重新执行">↻</button>` : '';
      div.innerHTML = `
        <input type="checkbox" class="mjap-queue-check" title="标记完成/待清理" ${item.checked ? 'checked' : ''}>
        <div class="mjap-queue-prompt" title="点击填入输入框">${escapeHtml(item.prompt)}</div>
        <div class="mjap-queue-status">${statusText[item.status] || item.status}${retryInfo}</div>
        <button class="mjap-queue-fill" title="填入输入框">✎</button>
        ${retryBtn}
        <button class="mjap-queue-del" title="删除">×</button>
      `;
      // 勾选框：切换 checked 状态
      div.querySelector('.mjap-queue-check').addEventListener('change', (e) => {
        item.checked = e.target.checked;
        persistQueue(); renderQueue();
      });
      // 点击 prompt 文本 = 填入输入框
      div.querySelector('.mjap-queue-prompt').addEventListener('click', () => fillPromptToInput(item.prompt));
      // 填入按钮
      div.querySelector('.mjap-queue-fill').addEventListener('click', () => fillPromptToInput(item.prompt));
      // 删除按钮
      div.querySelector('.mjap-queue-del').addEventListener('click', () => {
        queue.splice(idx, 1);
        persistQueue(); renderQueue();
      });
      const rb = div.querySelector('.mjap-queue-retry');
      if (rb) rb.addEventListener('click', () => retrySingle(idx));
      el.appendChild(div);
    });
    attachDragSort(el);
  }

  // 把单条 prompt 填入 MJ 输入框（不自动提交，方便手动查看/微调）
  function fillPromptToInput(prompt) {
    const input = findPromptInput();
    if (!input) { toast('未找到输入框，请先打开 MJ 想象页'); return; }
    setNativeValue(input, prompt);
    input.focus();
    toast('已填入输入框（可手动修改后发送）');
  }

  // 单条重试：把某条重置为 pending 并立即执行
  function retrySingle(idx) {
    if (running) { toast('队列正在运行，请先停止'); return; }
    const item = queue[idx];
    if (!item) return;
    item.status = 'pending';
    item.retries = 0;
    persistQueue(); renderQueue();
    runQueue();
  }

  // 拖拽排序
  function attachDragSort(container) {
    let dragIdx = null;
    const items = $$('.mjap-queue-item', container);
    items.forEach((el) => {
      el.addEventListener('dragstart', (e) => {
        dragIdx = Number(el.dataset.idx);
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        dragIdx = null;
      });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const targetIdx = Number(el.dataset.idx);
        if (dragIdx !== null && dragIdx !== targetIdx) {
          const [moved] = queue.splice(dragIdx, 1);
          queue.splice(targetIdx, 0, moved);
          persistQueue(); renderQueue();
        }
      });
    });
  }

  // 导出队列为 JSON 文件
  function exportQueue() {
    if (queue.length === 0) { toast('队列为空'); return; }
    const data = JSON.stringify({ version: VERSION, exportedAt: new Date().toISOString(), queue }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mjap-queue-${nowStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('队列已导出');
  }

  // 导入队列（合并，跳过重复 prompt）
  function importQueue(file) {
    readFile(file, (text) => {
      try {
        const data = JSON.parse(text);
        const arr = data.queue || data;
        if (!Array.isArray(arr)) throw new Error('格式错误');
        let added = 0;
        const existing = new Set(queue.map((q) => q.prompt));
        for (const it of arr) {
          const p = it.prompt || it;
          if (!p || existing.has(p)) continue;
          existing.add(p);
          queue.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), prompt: p, status: 'pending', retries: 0, checked: false });
          added++;
        }
        persistQueue(); renderQueue();
        toast(`导入 ${added} 条（已跳过重复）`);
      } catch (e) {
        toast('导入失败：不是有效的队列文件');
      }
    });
  }

  // 核心：运行队列（分批发送 + 定时 + 断点续传 + seed 复用 + 防重复）
  // 更新运行/暂停按钮的状态（文案 + 样式）
  function updateRunButton() {
    const btn = $('#mjap-run');
    if (!btn) return;
    if (running) {
      btn.disabled = false;
      btn.textContent = pauseFlag ? '▶ 继续' : '⏸ 暂停';
      btn.classList.toggle('paused', pauseFlag);
    } else {
      btn.disabled = false;
      btn.textContent = '▶ 运行';
      btn.classList.remove('paused');
    }
  }

  async function runQueue() {
    if (running) { toast('队列已在运行'); return; }
    const pending = queue.filter((q) => q.status === 'pending');
    if (pending.length === 0) { toast('没有待执行的提示词'); return; }

    running = true;
    stopFlag = false;
    pauseFlag = false;
    updateRunButton();

    try {
      await runQueueCore();
    } catch (err) {
      console.error('[MJ Autopilot] runQueue 异常', err);
      toast('⚠ 运行出错：' + (err && err.message ? err.message : err));
      // 把「执行中」项重置为待执行，保证断点续传不丢任务
      queue.forEach((q) => { if (q.status === 'running') q.status = 'pending'; });
      persistQueue(); renderQueue();
    } finally {
      running = false;
      stopFlag = false;
      pauseFlag = false;
      updateRunButton();
    }
  }

  async function runQueueCore() {

    // 定时发送：等待到设定时间
    await waitForSchedule();
    if (stopFlag) return;

    // 随机顺序：打乱 pending 任务的执行顺序（防封号），done/failed 不参与
    let execOrder = queue.map((q, idx) => ({ q, idx }));
    if (settings.randomOrder) {
      const pendingIdxs = execOrder.filter((o) => o.q.status === 'pending').map((o) => o.idx);
      const shuffled = [...pendingIdxs].sort(() => Math.random() - 0.5);
      execOrder = shuffled.map((idx) => ({ q: queue[idx], idx }))
        .concat(execOrder.filter((o) => o.q.status !== 'pending'));
      toast('已开启随机顺序发送');
    }

    _imgCountBaseline = countPageImages(); // 记录批次基准图片数

    const batchSize = settings.batchMode ? Math.max(1, settings.batchSize || 10) : Infinity;
    let sentInBatch = 0; // 本批已发送数量
    let sentTotal = 0;   // 累计成功发送数量（用于「每 N 条强制休息」）

    let pos = 0;
    while (pos < execOrder.length && !stopFlag) {
      const { q: item } = execOrder[pos];
      if (item.status !== 'pending') { pos++; continue; }

      // 本批已发满 → 等待这批全部出图后再发下一批
      if (sentInBatch >= batchSize) {
        toast(`本批 ${batchSize} 个已发送，等待这批出图后再继续…`);
        if (settings.serialConfirm) {
          // 批级出图确认（推荐）：等这批出图（图片/卡片数增加 batchSize 个）
          const r = await waitForBatchToRender(batchSize, settings.renderWaitMs);
          if (stopFlag) break;
          if (!r.done) toast(`⚠ 等待出图超时（${r.reason}），继续下一批…`);
        } else {
          // 退化为固定批次间隔
          await waitForBatchSlot();
          if (stopFlag) break;
        }
        sentInBatch = 0;
        continue; // 不 pos++，从头开始发下一批
      }

      while (pauseFlag && !stopFlag) { await sleep(500); }
      if (stopFlag) break;

      await waitForQueueSlot();
      if (stopFlag) break;

      item.status = 'running';
      persistQueue(); renderQueue();

      let finalPrompt = item.prompt;
      if (settings.translateEnabled && hasChinese(item.prompt)) {
        finalPrompt = await aiTranslate(item.prompt);
      }
      // 提示词前缀/后缀拼装
      if (settings.promptPrefix) finalPrompt = settings.promptPrefix + ' ' + finalPrompt;
      if (settings.promptSuffix) finalPrompt = finalPrompt + ' ' + settings.promptSuffix;
      // seed 处理：随机 seed 优先；否则复用最近 seed
      if (settings.randomSeed) {
        if (!extractSeedFromText(finalPrompt)) {
          finalPrompt = finalPrompt + ' --seed ' + randomSeed();
        }
      } else if (settings.seedReuse && lastSeed && !extractSeedFromText(finalPrompt)) {
        finalPrompt = finalPrompt + ' --seed ' + lastSeed;
      }

      let ok = false;
      let queueFullHit = false;
      let attempt = 0;
      const maxAttempts = settings.autoRetry ? settings.autoRetryTimes + 1 : 1;

      while (attempt < maxAttempts && !stopFlag && !pauseFlag) {
        attempt++;
        const r = await submitPrompt(finalPrompt);
        if (r.ok) { ok = true; break; }
        if (r.queueFull) { queueFullHit = true; break; } // 排队满，不再重试
        item.retries = attempt;
        if (attempt < maxAttempts && !pauseFlag) {
          toast(`提交失败，重试 ${attempt}/${settings.autoRetryTimes}…`);
          await sleep(nextInterval());
        }
      }

      // 排队满：不标记失败，暂停等待前序完成后再继续
      if (queueFullHit) {
        item.status = 'pending';
        persistQueue(); renderQueue();
        toast(`⚠ 排队已满（${finalPrompt.slice(0, 20)}…），等待前序生成…`);
        const drained = await waitForQueueDrain(settings.batchWait * 1000);
        if (stopFlag) break;
        if (drained) {
          sentInBatch = 0; // 重置批次计数，重新开始一小批
          continue; // 不 pos++，重新提交这条
        }
        continue;
      }

      if (pauseFlag) {
        item.status = 'pending';
        persistQueue(); renderQueue();
        while (pauseFlag && !stopFlag) await sleep(500);
        continue;
      }

      if (ok) {
        item.status = 'done';
        item.prompt = finalPrompt;
        // 提取并记忆 seed
        const s = extractSeedFromText(finalPrompt);
        if (s) lastSeed = s;
        const progressLabel = `${sentInBatch + 1}/${batchSize === Infinity ? '—' : batchSize}`;
        toast(`✓ 已提交（${progressLabel}）：${finalPrompt.slice(0, 24)}…`);
        sentInBatch++;
        sentTotal++;

        // ===== 每 N 条强制休息（双保险防封号/防超限）=====
        if (settings.restEvery > 0 && sentTotal % settings.restEvery === 0) {
          const restSec = settings.restSec || 60;
          toast(`已连续发送 ${settings.restEvery} 条，强制休息 ${restSec} 秒…`);
          await sleepProgress(restSec * 1000, '休息中');
          if (stopFlag) break;
        }
      } else if (!stopFlag) {
        item.status = 'failed';
        toast(`✗ 提交失败：${finalPrompt.slice(0, 28)}…`);
      } else {
        item.status = 'pending';
      }
      persistQueue(); renderQueue();

      pos++;
      // 批次内：相邻两条之间按「单条提交间隔」等待（这是控制发送频率的核心）
      if (!stopFlag) {
        const gapMs = nextInterval();
        if (gapMs >= 1500) {
          toast(`⏱ 等待 ${(gapMs / 1000).toFixed(1)}s 后发送下一条…`);
        }
        await sleepProgress(gapMs, '发送间隔');
      }
    }

    toast('队列处理完成');
  }

  // ===== 下载逻辑 =====
  let scannedImages = []; // { url, fullUrl, prompt }

  // 把 URL 转成最高清版本
  function toFullResUrl(url) {
    if (!url) return url;
    let u = String(url);
    // MJ 缩略图：去掉尺寸参数，取原图
    u = u.replace(/([?&])(w|h|fit|crop)=\d+/gi, '$1');
    u = u.replace(/[?&]$/, '');
    return u;
  }

  // 从图片附近提取 prompt 文本（MJ 页面结构多版本兼容）
  function extractPromptNearImage(img) {
    // 1. 优先取 alt 属性（MJ 有时把 prompt 放 alt）
    const alt = (img.getAttribute('alt') || '').trim();
    if (alt.length > 3 && !/^https?:/.test(alt) && !/^(Image|img|图片)$/i.test(alt)) return alt;

    // 2. 向上查找容器，容器内可能有 prompt 文本
    let node = img;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      // 常见 prompt 容器特征
      const t = (node.textContent || '').trim();
      // 提取含 -- 参数或典型 prompt 关键词的那段
      if (t && t.length > 5 && t.length < 800 && /--(ar|v|seed|style|chaos|stylize)/i.test(t)) {
        return t.slice(0, 500);
      }
    }

    // 3. 兜底：找同级的 prompt 显示元素
    let sibling = img.closest('div')?.parentElement;
    if (sibling) {
      const candidates = sibling.querySelectorAll('[class*="prompt"], [class*="Prompt"], [class*="caption"], [class*="text"]');
      for (const c of candidates) {
        const t = (c.textContent || '').trim();
        if (t && t.length > 5 && t.length < 800) return t.slice(0, 500);
      }
    }
    return '';
  }

  function collectImages() {
    const imgs = $$('img[src*="cdn.midjourney.com"], img[src*="midjourney.com"], img[src*="mjcdn"], img[src*="imagine"]');
    const seen = new Set();
    const result = [];
    for (const img of imgs) {
      const src = img.currentSrc || img.src;
      if (!src || seen.has(src)) continue;
      seen.add(src);
      const fullUrl = toFullResUrl(src);
      result.push({ url: src, fullUrl, prompt: extractPromptNearImage(img) });
    }
    return result;
  }

  function scanImages() {
    scannedImages = collectImages();
    const el = $('#mjap-img-list');
    const countEl = $('#mjap-img-count');
    el.innerHTML = '';
    if (scannedImages.length === 0) {
      if (countEl) countEl.textContent = '';
      el.innerHTML = '<div class="mjap-empty">未发现图片（试试滚动加载更多）</div>';
      return;
    }
    if (countEl) countEl.textContent = `共 ${scannedImages.length} 张`;
    scannedImages.forEach((item, idx) => {
      const div = document.createElement('div');
      div.className = 'mjap-img-item';
      div.innerHTML = `<input type="checkbox" class="mjap-img-check" data-idx="${idx}" checked><img src="${escapeHtml(item.url)}" loading="lazy">`;
      el.appendChild(div);
    });
    toast(`发现 ${scannedImages.length} 张图片`);
  }

  // 生成归档子目录
  function buildSubfolder() {
    let sub = nowStr(); // 日期 YYYY-MM-DD
    if (settings.archiveCategory) sub += '-' + settings.archiveCategory;
    return sub;
  }

  // 从 prompt 提取可读关键词作为文件名片段（去参数、去标点、限长）
  function promptToFilenameSlug(prompt) {
    if (!prompt) return '';
    let s = String(prompt)
      .replace(/--[a-z]+[\s\d:.,-]*/gi, ' ')   // 去掉 --ar 16:9 等参数
      .replace(/[^\w\u4e00-\u9fa5]+/g, ' ')     // 只保留字母数字中文
      .replace(/\s+/g, ' ')
      .trim();
    const words = s.split(' ').filter(Boolean);
    if (words.length === 0) return '';
    // 取前 4 个词，拼成 slug，限长 40
    const slug = words.slice(0, 4).join('-');
    return slug.length > 40 ? slug.slice(0, 40) : slug;
  }

  function downloadSelected(all) {
    if (scannedImages.length === 0) { toast('请先扫描图片'); return; }
    let selected;
    if (all) selected = scannedImages.map((item, idx) => ({ ...item, idx }));
    else selected = $$('.mjap-img-check:checked').map((cb) => {
      const idx = Number(cb.dataset.idx);
      return { ...scannedImages[idx], idx };
    });
    if (selected.length === 0) { toast('请勾选要下载的图片'); return; }

    const ts = nowStr() + '-' + nowTimeStr().replace(/:/g, '-');
    const sub = settings.autoArchive ? buildSubfolder() : '';
    const targetFolder = sub ? `${settings.downloadFolder}/${sub}` : settings.downloadFolder;
    const fmt = settings.dlFormat || 'original';
    const saveTxt = settings.savePromptTxt !== false; // 默认开
    const items = selected.map(({ url, fullUrl, prompt, idx }) => {
      const dlUrl = fullUrl || url;
      const ext = (dlUrl.match(/\.(png|jpe?g|webp)/i)?.[1] || 'png').toLowerCase();
      // 智能命名：开启自动重命名时用「序号 + prompt 关键词 + 时间」；否则用默认序号时间
      const slug = settings.autoRename ? promptToFilenameSlug(prompt) : '';
      const filename = slug
        ? `${String(idx + 1).padStart(2, '0')}-${slug}-${ts}.${ext}`
        : `mj-${String(idx + 1).padStart(2, '0')}-${ts}.${ext}`;
      // 是否保存提示词（开关控制）
      const promptToSave = saveTxt ? (prompt || '') : '';
      return { url: dlUrl, filename, folder: targetFolder, prompt: promptToSave, format: fmt };
    });

    toast(`开始下载 ${items.length} 张${fmt !== 'original' ? `（格式：${fmt}）` : '（原图大图）'}，${saveTxt ? '自动保存同名 .prompt.txt' : '不保存提示词'}…`);
    chrome.runtime.sendMessage({ type: 'downloadImages', items }, (resp) => {
      if (resp?.ok) {
        const results = resp.results || [];
        const fail = results.filter((r) => !r.ok).length;
        if (fail > 0) {
          toast(`下载完成：${results.length - fail} 成功，${fail} 失败。可点「下载选中」重试`);
        } else {
          toast(`✓ 已下载 ${results.length} 张到「${targetFolder}」${saveTxt ? '（含提示词 txt）' : ''}`);
        }
      } else {
        toast('下载失败：' + (resp?.error || '未知错误'));
      }
    });
  }

  // ===== 自动下载：监听新出图 =====
  let autoDlObserver = null;

  function downloadSingleImage(item, folder) {
    const fullUrl = item.fullUrl || toFullResUrl(item.url);
    const ext = (fullUrl.match(/\.(png|jpe?g|webp)/i)?.[1] || 'png').toLowerCase();
    const ts = nowStr() + '-' + nowTimeStr().replace(/:/g, '-');
    const fmt = settings.dlFormat || 'original';
    // 智能命名 + 保存提示词（遵循开关）
    const slug = settings.autoRename ? promptToFilenameSlug(item.prompt) : '';
    const filename = slug ? `${slug}-${ts}.${ext}` : `mj-${ts}.${ext}`;
    const promptToSave = settings.savePromptTxt ? (item.prompt || '') : '';
    chrome.runtime.sendMessage({
      type: 'downloadImages',
      items: [{ url: fullUrl, filename, folder, prompt: promptToSave, format: fmt }],
    }, () => {});
  }

  function toggleAutoDownload() {
    if (settings.autoDownload) {
      if (autoDlObserver) return;
      autoDlObserver = new MutationObserver(() => {
        const imgs = collectImages(); // 返回 [{url, fullUrl, prompt}]
        const sub = settings.autoArchive ? buildSubfolder() : '';
        const folder = sub ? `${settings.downloadFolder}/${sub}` : settings.downloadFolder;
        for (const item of imgs) {
          const key = item.fullUrl || item.url;
          if (autoDlSeen.has(key)) continue;
          autoDlSeen.add(key);
          downloadSingleImage(item, folder);
        }
        // 限制 seen 集合大小
        if (autoDlSeen.size > 500) {
          const arr = [...autoDlSeen];
          autoDlSeen = new Set(arr.slice(-250));
        }
      });
      autoDlObserver.observe(document.body, { childList: true, subtree: true });
      toast('自动下载已开启');
    } else {
      if (autoDlObserver) { autoDlObserver.disconnect(); autoDlObserver = null; }
      toast('自动下载已关闭');
    }
  }

  // ===== 辅助 =====
  function toast(msg) {
    let t = $('#mjap-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'mjap-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2500);
  }

  function saveSettings() {
    chrome.storage.local.set({ settings });
  }

  // ===== 启动 =====
  // ===== Cloudflare Turnstile 人机验证自动处理 =====
  // MJ 网页版会不定时弹出「正在进行安全验证」页面，只需勾选「请验证您是真人」复选框即可通过。
  // 本函数持续监听页面，一旦出现该质询，自动勾选并点击，避免队列被验证页卡住。
  let cfObserver = null;

  function findTurnstileCheckbox() {
    // Turnstile 的复选框是 iframe 内的 input[type=checkbox]，外层是 .cf-turnstile 容器
    const frames = $$('iframe');
    for (const frame of frames) {
      try {
        const doc = frame.contentDocument || frame.contentWindow?.document;
        if (!doc) continue;
        const cb = doc.querySelector('input[type="checkbox"]');
        const label = (doc.body?.innerText || '').toLowerCase();
        if (cb && /验证|真人|verify|human|确认.*人|i am human/i.test(label)) {
          return { cb, doc, frame };
        }
      } catch (e) { /* 跨域 iframe 无法访问，跳过 */ }
    }
    // 兜底：有些 Turnstile 实现不是 iframe，直接在主文档里
    const direct = $$('input[type="checkbox"]');
    const bodyText = (document.body?.innerText || '').toLowerCase();
    if (/验证|真人|verify|human|请验证/.test(bodyText)) {
      for (const cb of direct) {
        const near = (cb.closest('div')?.innerText || '').toLowerCase();
        if (/验证|真人|verify|human/.test(near)) return { cb, doc: document, frame: null };
      }
    }
    return null;
  }

  function isChallengeVisible() {
    const bodyText = (document.body?.innerText || '').toLowerCase();
    // 命中 Cloudflare 挑战页的关键特征文案
    return /正在进行安全验证|请验证您是真人|正在验证|verifying you are human|verify you are human|security verification/i.test(bodyText);
  }

  function trySolveChallenge() {
    if (!isChallengeVisible()) return;
    const found = findTurnstileCheckbox();
    if (!found) return;
    try {
      if (found.cb && !found.cb.checked) {
        // 原生点击，触发 Turnstile 的交互检测
        found.cb.click();
      }
      // 有些实现需要点一下 label 或容器
      const root = found.doc || document;
      const btn = root.querySelector('.ctp-checkbox-label, label, [role="checkbox"]');
      if (btn && btn !== found.cb) btn.click();
      if (typeof toast === 'function') toast('✓ 已自动通过人机验证');
    } catch (e) { /* ignore */ }
  }

  function startCloudflareWatcher() {
    if (cfObserver) return;
    cfObserver = new MutationObserver(() => {
      trySolveChallenge();
    });
    cfObserver.observe(document.body, { childList: true, subtree: true });
    // 立即尝试一次（页面加载时可能已经有验证）
    setTimeout(trySolveChallenge, 1200);
    setTimeout(trySolveChallenge, 4000);
  }

  function init() {
    buildPanel();
    startCloudflareWatcher();
    chrome.storage.local.get('settings', (r) => {
      if (r.settings) settings = { ...DEFAULT_SETTINGS, ...r.settings };
      // 迁移：旧版间隔单位是毫秒（值 > 100），v0.7.2 起改为秒。检测到旧值自动 /1000。
      if (settings.interval > 100) settings.interval = Math.round(settings.interval / 1000);
      if (settings.intervalMin > 100) settings.intervalMin = Math.round(settings.intervalMin / 1000);
      if (settings.intervalMax > 100) settings.intervalMax = Math.round(settings.intervalMax / 1000);
      settings.interval = Math.max(1, settings.interval || 3);
      settings.intervalMin = Math.max(1, settings.intervalMin || 3);
      settings.intervalMax = Math.max(settings.intervalMin, settings.intervalMax || 8);
      saveSettings(); // 回写迁移后的值
      const f = {
        '#mjap-folder': settings.downloadFolder,
        '#mjap-interval': String(settings.interval),
        '#mjap-schedule-time': settings.scheduleTime,
        '#mjap-archive-cat': settings.archiveCategory,
        '#mjap-batch-size': String(settings.batchSize),
        '#mjap-batch-wait': String(settings.batchWait),
        '#mjap-render-wait': String(Math.round((settings.renderWaitMs || 180000) / 1000)),
        '#mjap-rest-every': String(settings.restEvery || 0),
        '#mjap-rest-sec': String(settings.restSec || 60),
        '#mjap-prefix': settings.promptPrefix,
        '#mjap-suffix': settings.promptSuffix,
        '#mjap-interval-min': String(settings.intervalMin),
        '#mjap-interval-max': String(settings.intervalMax),
        '#mjap-send-mode': settings.sendMode,
        '#mjap-dl-format': settings.dlFormat,
      };
      for (const [sel, val] of Object.entries(f)) {
        const el = $(sel);
        if (el) el.value = val;
      }
      const tr = $('#mjap-translate'); if (tr) tr.checked = settings.translateEnabled;
      const qa = $('#mjap-queue-aware'); if (qa) qa.checked = settings.queueAware;
      const bm = $('#mjap-batch-mode'); if (bm) bm.checked = settings.batchMode;
      const scf = $('#mjap-serial-confirm'); if (scf) scf.checked = settings.serialConfirm;
      const ar = $('#mjap-auto-retry'); if (ar) ar.checked = settings.autoRetry;
      const sr = $('#mjap-seed-reuse'); if (sr) sr.checked = settings.seedReuse;
      const rs = $('#mjap-random-seed'); if (rs) rs.checked = settings.randomSeed;
      const ro = $('#mjap-random-order'); if (ro) ro.checked = settings.randomOrder;
      const ri = $('#mjap-random-interval'); if (ri) ri.checked = settings.randomInterval;
      const sc = $('#mjap-schedule'); if (sc) sc.checked = settings.scheduleEnabled;
      const ad = $('#mjap-auto-dl'); if (ad) ad.checked = settings.autoDownload;
      const aa = $('#mjap-auto-archive'); if (aa) aa.checked = settings.autoArchive;
      const arn = $('#mjap-auto-rename'); if (arn) arn.checked = settings.autoRename !== false;
      const spt = $('#mjap-save-prompt-txt'); if (spt) spt.checked = settings.savePromptTxt !== false;
      toggleAutoDownload();

      // 初始化节奏状态提示（与 savePace 里的 renderPaceStatus 逻辑一致）
      const ps = $('#mjap-pace-status');
      if (ps) {
        const mode = (SEND_MODES[settings.sendMode] || {}).label || '—';
        const batchTxt = settings.batchMode
          ? `每批 ${settings.batchSize} 个 · 批间${settings.serialConfirm ? '等出图' : '固定等 ' + settings.batchWait + 's'}`
          : '不分批（连续发送）';
        const ivTxt = settings.randomInterval
          ? `间隔 ${settings.intervalMin}~${settings.intervalMax}s（随机）`
          : `间隔 ${settings.interval}s`;
        const restTxt = settings.restEvery > 0 ? `每 ${settings.restEvery} 条休息 ${settings.restSec}s` : '不强制休息';
        ps.innerHTML = `当前：${mode} ｜ ${batchTxt} ｜ ${ivTxt} ｜ ${restTxt}`;
      }
    });
    loadQueue();
    console.log(`[MJ Autopilot] v${VERSION} 已注入`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
