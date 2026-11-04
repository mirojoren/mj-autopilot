// MJ Autopilot — background service worker
// 职责：下载图片（取原图大图、保存提示词）、转发翻译 API 请求（规避 CORS）

// 免费翻译模型端点（Index-Translate，OpenAI 兼容，免 Key）
const FREE_API = 'https://index-translate.bilibili.com/v1';
const FREE_TEXT_MODEL = 'Index-Translate-35B-A3B';

// 把 MJ 图片 URL 转成最高清版本
function toFullResUrl(url) {
  if (!url) return url;
  // MJ 缩略图常见参数：?w=xxx&h=xxx 或 _384_384 等后缀，去掉尺寸限制取原图
  let u = String(url);
  // 去掉尺寸查询参数
  u = u.replace(/([?&])(w|h|fit|crop)=\d+/gi, '$1');
  // 清理末尾残留的空参数
  u = u.replace(/[?&]$/, '');
  return u;
}

// 下载图片到本地，可指定子目录；可选保存提示词文本；可选格式转换（png/jpg/webp）
async function downloadImage(url, filename, folder, promptText, format) {
  try {
    let downloadUrl = url;
    let finalName = filename;

    // 格式转换：png/jpg/webp（original 或未指定则直接用原 URL）
    if (format && format !== 'original') {
      const converted = await convertImageFormat(url, format);
      if (converted.ok) {
        downloadUrl = converted.dataUrl;
        finalName = filename.replace(/\.[^.]+$/, '') + '.' + format;
      }
      // 转换失败则退回原图
    }

    const fullName = folder ? `${folder}/${finalName}` : finalName;
    const id = await chrome.downloads.download({ url: downloadUrl, filename: fullName, saveAs: false });

    // 若带提示词，则同时保存一个同名 .txt
    if (promptText) {
      const txtName = fullName.replace(/\.[^.]+$/, '') + '.prompt.txt';
      const txtUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(promptText);
      await chrome.downloads.download({ url: txtUrl, filename: txtName, saveAs: false });
    }

    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// 图片格式转换：fetch → 画到 canvas → 转 dataURL（Service Worker 里用 OffscreenCanvas）
async function convertImageFormat(url, format) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    let canvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    } else {
      return { ok: false, error: 'OffscreenCanvas 不可用' };
    }
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const mime = format === 'jpg' ? 'image/jpeg' : `image/${format}`;
    const quality = format === 'jpg' ? 0.92 : undefined;
    const blobOut = await canvas.convertToBlob({ type: mime, quality });
    const dataUrl = await blobToDataURL(blobOut);
    return { ok: true, dataUrl };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('blob 转 dataURL 失败'));
    fr.readAsDataURL(blob);
  });
}

// 批量下载（带进度反馈、失败重试信息）
async function downloadImages(items) {
  const results = [];
  for (const it of items) {
    const r = await downloadImage(it.url, it.filename, it.folder, it.prompt, it.format);
    results.push({ ...it, ...r });
  }
  return { results, total: items.length, ok: results.every((r) => r.ok) };
}

// 转发「翻译」请求（优先免费 Index-Translate，失败返回错误由 content 兜底到本地词典）
async function translateText({ text }) {
  const url = `${FREE_API}/chat/completions`;
  const m = FREE_TEXT_MODEL;

  const body = {
    model: m,
    messages: [{
      role: 'user',
      content: `Translate the following Chinese text into an English Midjourney prompt. Keep parameters like --ar, --v, --seed unchanged. Output ONLY the English prompt, no extra words:\n${text}`,
    }],
    max_tokens: 300,
  };

  const headers = { 'Content-Type': 'application/json' };

  try {
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await resp.json();
    if (!resp.ok) {
      return { ok: false, error: data?.error?.message || `HTTP ${resp.status}` };
    }
    const textOut = data?.choices?.[0]?.message?.content || '';
    return { ok: true, text: textOut.trim() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// 消息路由
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'downloadImages') {
        const r = await downloadImages(msg.items);
        sendResponse({ ok: true, ...r });
      } else if (msg.type === 'translateText') {
        const r = await translateText(msg);
        sendResponse(r);
      } else if (msg.type === 'notify') {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon-128.png',
          title: msg.title || 'MJ Autopilot',
          message: msg.message || '',
        });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'unknown type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // 保持异步通道
});
