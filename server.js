/**
 * 家具 AI 辨識 — 後端服務
 * 部署：Render Web Service（Node 18+）
 * 環境變數：OPENAI_API_KEY（必填）、OPENAI_MODEL（選填，預設 gpt-4o）、OPENAI_BASE_URL（選填）
 */
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

app.use(cors({ origin: true }));
app.use(express.json({ limit: '12mb' }));
app.use(express.static(__dirname));

const PROMPT = [
  '你是家具檢測 AI。請綜合全部照片判斷，只回傳一個嚴格 JSON 物件，不要任何說明文字、不要 markdown 圍欄。',
  '若畫面中有 A4 紙（21cm × 29.7cm），請以它為比例尺推算家具實際尺寸；若無 A4 紙，依常見家具尺寸估計，並在 description 註明「未見比例尺，尺寸為估計」。',
  '欄位規則：',
  'furnitureType：只能選 [沙發、桌子、衣櫃、床架、櫃體、其他]',
  'length、width、height：數字（公分，只填數字，不帶單位）',
  'material：只能選 [實木、木質板材、金屬、布料、皮革、不清楚]',
  'defect：只能選 [無、刮傷、鬆動、破裂、缺件、發霉/蟲蛀]',
  'overall：只能選 [可正常使用、部分需修復、已無法使用]',
  'description：繁體中文，40 字以內說明瑕疵與外觀狀況',
  '範例：',
  '{"furnitureType":"桌子","length":120,"width":60,"height":75,"material":"實木","defect":"刮傷","overall":"可正常使用","description":"桌面淺刮痕，結構穩定無鬆動"}'
].join('\n');

app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasKey: Boolean(OPENAI_KEY), model: OPENAI_MODEL });
});

app.post('/api/scan', async (req, res) => {
  const images = req.body && req.body.images;

  if (!OPENAI_KEY) {
    return res.status(500).json({ msg: '伺服器尚未設定 OPENAI_API_KEY，請到 Render 的 Environment 加上環境變數後重新部署。' });
  }
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ msg: '請至少提供 1 張照片' });
  }
  if (images.length > 4) {
    return res.status(400).json({ msg: '最多 4 張照片' });
  }
  const bad = images.find((u) => typeof u !== 'string' || !/^data:image\//.test(u));
  if (bad !== undefined) {
    return res.status(400).json({ msg: '照片格式錯誤，需為 base64 data URL' });
  }

  const content = [{ type: 'text', text: PROMPT }];
  images.forEach((url) => content.push({ type: 'image_url', image_url: { url, detail: 'high' } }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);

  try {
    const upstream = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content }],
        temperature: 0.2,
        max_tokens: 400,
      }),
      signal: controller.signal,
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      let detail = text;
      try { detail = JSON.parse(text).error?.message || text; } catch (_) {}
      console.error('[openai]', upstream.status, detail);
      return res.status(upstream.status === 401 ? 401 : 502).json({ msg: `AI 辨識失敗：${detail}` });
    }

    let payload;
    try { payload = JSON.parse(text); } catch (_) {
      return res.status(502).json({ msg: 'AI 回傳格式異常' });
    }

    const raw = payload.choices?.[0]?.message?.content ?? '';
    let parsed;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch (_) {
      console.error('[parse]', raw);
      return res.status(502).json({ msg: 'AI 沒有回傳可解析的 JSON，請重試' });
    }

    return res.json(parsed);
  } catch (err) {
    const isAbort = err.name === 'AbortError';
    console.error('[scan]', err);
    return res.status(504).json({
      msg: isAbort ? 'AI 回應逾時，請減少張數或縮小照片' : `AI 辨識失敗：${err.message}`,
    });
  } finally {
    clearTimeout(timer);
  }
});

function extractJson(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no json');
  return s.slice(start, end + 1);
}

// 單頁應用：其他路徑都回 index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (model: ${OPENAI_MODEL}, key: ${OPENAI_KEY ? 'set' : 'missing'})`);
});
