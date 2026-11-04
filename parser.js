// MJ Autopilot — 提示词解析器
// 支持 txt / md / markdown，智能识别段落，剥离序号和 markdown 符号，防污染

const PromptParser = (function () {
  'use strict';

  // 序号模式：1. 1、 1) ① 一、 1: 1． 等
  const NUMBER_PREFIX = /^[\s]*((?:\d{1,3})[\.、\)．:：]|(?:[一二三四五六七八九十百]+)[、\.]|[-*•◦▪▫]\s+)[\s]*/;

  // 中文圈数字字符（避免正则范围报错，用字符串匹配）
  const CIRCLED_NUMBERS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑⒒⒓⒔⒕⒖⒗⒘⒙⒚⒛';

  function isCircledNumber(ch) {
    return CIRCLED_NUMBERS.indexOf(ch) >= 0;
  }

  // markdown 标题 / 列表符号
  const MD_PREFIX = /^[\s]*(#{1,6}\s+|>\s*|\|\s*)/;

  // 判断一行是否是「纯分隔/装饰」行（空行、分隔线、纯符号）
  function isSeparatorLine(line) {
    const t = line.trim();
    if (!t) return true;
    // 分隔线：--- *** === ___ 等
    if (/^[-=_*]{3,}$/.test(t)) return true;
    return false;
  }

  // 判断一行是否是「标题/分类」行（不应该是提示词本身）
  function isHeadingLine(line) {
    const t = line.trim();
    // markdown 标题
    if (/^#{1,6}\s+/.test(t)) return true;
    return false;
  }

  // 剥离一行的序号前缀，返回干净的提示词
  function stripNumberPrefix(line) {
    let t = line.trim();
    // 剥离 markdown 列表符号（- * + 开头，后跟空格）
    t = t.replace(/^[-*+]\s+/, '');
    // 剥离数字/中文序号
    t = t.replace(/^((?:\d{1,3})[\.、\)．:：]\s*|(?:[一二三四五六七八九十百]+)[、\.]\s*)/, '');
    // 剥离圈数字序号 ①②③
    if (isCircledNumber(t.charAt(0))) t = t.slice(1);
    // 再剥离一次 md 标题符号（可能 "# 1. xxx"）
    t = t.replace(/^#{1,6}\s+/, '');
    return t.trim();
  }

  // 核心：把一段原始文本解析成提示词数组
  // 策略：
  //  1. 先按行拆分
  //  2. 识别「标题行」（markdown # 或纯分类行），标题后面的内容作为一个段落
  //  3. 识别「序号行」（1. 2、 等），每个序号行 + 后续续行 = 一个提示词
  //  4. 普通非空行按段落聚合
  function parse(text) {
    // 去 BOM
    text = String(text).replace(/^\uFEFF/, '');

    // 统一换行
    const rawLines = text.split(/\r?\n/);

    const prompts = [];
    let current = [];          // 当前正在聚合的提示词行
    let inNumberedList = false; // 是否处于「序号列表」模式

    function flush() {
      const p = current.map((l) => l.trim()).filter(Boolean).join(' ').trim();
      if (p) prompts.push(p);
      current = [];
    }

    // 判断一行是否有前导缩进（续行标志）
    function isIndented(raw) {
      return /^[\s]{2,}/.test(raw) || /^\t/.test(raw);
    }

    for (const raw of rawLines) {
      const line = raw.trim();

      // 空行 / 分隔线 → 段落结束
      if (!line || isSeparatorLine(line)) {
        flush();
        inNumberedList = false;
        continue;
      }

      // markdown 标题行 → 段落结束（标题本身不进提示词）
      if (isHeadingLine(line)) {
        flush();
        inNumberedList = false;
        continue;
      }

      // 序号行（1. 2、 - ① 等）
      const numbered = NUMBER_PREFIX.test(line) || MD_PREFIX.test(line) || isCircledNumber(line.charAt(0));
      const clean = stripNumberPrefix(line);

      if (numbered) {
        // 遇到新序号 → 结束上一个，开始新的
        flush();
        inNumberedList = true;
        if (clean) current.push(clean);
        continue;
      }

      // 非序号行：
      if (inNumberedList) {
        // 处于序号列表模式：
        // 有缩进 = 上一条的续行；无缩进 = 新的独立提示词（flush 后重开）
        if (isIndented(raw) && current.length > 0) {
          current.push(line);
        } else {
          flush();
          inNumberedList = false;
          current.push(line);
        }
      } else {
        // 非列表模式：有缩进且已有内容 → 续行；否则每条独立
        if (isIndented(raw) && current.length > 0) {
          current.push(line);
        } else {
          flush();
          current.push(line);
        }
      }
    }
    flush();

    // 后处理：过滤掉过短/无效的提示词（比如纯数字、纯符号）
    return prompts.filter((p) => {
      if (p.length < 2) return false;
      if (/^[\d\.、\):：\s]+$/.test(p)) return false; // 纯序号残留
      return true;
    });
  }

  return { parse, stripNumberPrefix };
})();
