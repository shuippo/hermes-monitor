// check.js — エルメス在庫チェッカー (Google検索経由版)
const fetch = require('node-fetch');
const fs = require('fs');

const LINE_TOKEN   = process.env.LINE_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID;
const SNAPSHOT_FILE = 'snapshot.json';

const SEARCHES = [
  { id: 'all',       label: '全バッグ',     query: 'site:hermes.com/jp/ja バッグ 新着' },
  { id: 'picotin',   label: 'Picotin',      query: 'site:hermes.com/jp/ja ピコタン' },
  { id: 'evelyne',   label: 'Evelyne',      query: 'site:hermes.com/jp/ja エヴリン' },
  { id: 'constance', label: 'Constance',    query: 'site:hermes.com/jp/ja コンスタンス' },
  { id: 'lindy',     label: 'Lindy',        query: 'site:hermes.com/jp/ja リンディ' },
  { id: 'garden',    label: 'Garden Party', query: 'site:hermes.com/jp/ja ガーデンパーティ' },
  { id: 'roulis',    label: 'Roulis',       query: 'site:hermes.com/jp/ja ルーリス' },
  { id: 'intheloop', label: 'In The Loop',  query: 'site:hermes.com/jp/ja イン・ザ・ループ' },
];

function loadSnapshot() {
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveSnapshot(data) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2));
}

async function fetchHermesPage(search) {
  const query = encodeURIComponent(search.query);
  const url = `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://www.google.com/search?q=${query}&num=10`)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' },
    timeout: 20000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const items = [];
  const linkPattern = /href="(https:\/\/www\.hermes\.com\/jp\/ja[^"]+)"/g;
  const seen = new Set();
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const u = match[1];
    if (!seen.has(u) && u.length < 300) {
      seen.add(u);
      items.push({ id: u, url: u });
    }
  }
  return items;
}

function detectChanges(prevItems, newItems) {
  const prevUrls = new Set((prevItems || []).map(i => i.id));
  return newItems.filter(i => !prevUrls.has(i.id)).map(item => ({ type: 'new', item }));
}

async function sendLine(message) {
  if (!LINE_TOKEN || !LINE_USER_ID) return;
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: LINE_USER_ID, messages: [{ type: 'text', text: message }] }),
  });
  if (!res.ok) console.error('LINE送信失敗:', await res.text());
  else console.log('LINE通知送信完了');
}

async function main() {
  const snapshot = loadSnapshot();
  const newSnapshot = {};
  let totalChanges = 0;

  for (const search of SEARCHES) {
    console.log(`チェック中: ${search.label}`);
    try {
      const items = await fetchHermesPage(search);
      console.log(`  → ${items.length}件検出`);
      const changes = detectChanges(snapshot[search.id], items);
      if (changes.length > 0 && snapshot[search.id]) {
        for (const { item } of changes) {
          totalChanges++;
          await sendLine(`🛍️ HERMÈS 新着検出\n━━━━━━━━━━━━━━\n📂 ${search.label}\n🔗 ${item.url}\n━━━━━━━━━━━━━━\nエルメス公式サイトを確認してください`);
          await new Promise(r => setTimeout(r, 500));
        }
      }
      newSnapshot[search.id] = items;
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.error(`  → エラー (${search.label}):`, err.message);
    }
  }

  console.log(totalChanges === 0 ? '変化なし' : `${totalChanges}件の変化を検出`);
  saveSnapshot(newSnapshot);
  console.log('完了');
}

main().catch(err => { console.error('致命的エラー:', err); process.exit(1); });
