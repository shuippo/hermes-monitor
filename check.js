// check.js — エルメス在庫チェッカー
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');

const LINE_TOKEN   = process.env.LINE_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID;
const SNAPSHOT_FILE = 'snapshot.json';

const TARGETS = [
  { id: 'all',       label: '全バッグ',     url: 'https://www.hermes.com/jp/ja/category/women/bags-and-small-leather-goods/bags-and-clutches/' },
  { id: 'picotin',   label: 'Picotin',      url: 'https://www.hermes.com/jp/ja/category/women/bags-and-small-leather-goods/bags-and-clutches/?facets=Family_en-US_s%3APicotin' },
  { id: 'evelyne',   label: 'Evelyne',      url: 'https://www.hermes.com/jp/ja/category/women/bags-and-small-leather-goods/bags-and-clutches/?facets=Family_en-US_s%3AEvelyne' },
  { id: 'constance', label: 'Constance',    url: 'https://www.hermes.com/jp/ja/category/women/bags-and-small-leather-goods/bags-and-clutches/?facets=Family_en-US_s%3AConstance' },
  { id: 'lindy',     label: 'Lindy',        url: 'https://www.hermes.com/jp/ja/category/women/bags-and-small-leather-goods/bags-and-clutches/?facets=Family_en-US_s%3ALindy' },
  { id: 'garden',    label: 'Garden Party', url: 'https://www.hermes.com/jp/ja/category/women/bags-and-small-leather-goods/bags-and-clutches/?facets=Family_en-US_s%3AGarden+Party' },
  { id: 'roulis',    label: 'Roulis',       url: 'https://www.hermes.com/jp/ja/category/women/bags-and-small-leather-goods/bags-and-clutches/?facets=Family_en-US_s%3ARoulis' },
  { id: 'intheloop', label: 'In The Loop',  url: 'https://www.hermes.com/jp/ja/category/women/bags-and-small-leather-goods/bags-and-clutches/?facets=Family_en-US_s%3AIn+The+Loop' },
];

// ── スナップショット読み込み ──────────────────────────────
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

// ── エルメスサイトを取得・解析 ────────────────────────────
async function fetchProducts(target) {
  const res = await fetch(target.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Accept-Language': 'ja-JP,ja;q=0.9',
      'Accept': 'text/html,application/xhtml+xml',
    },
    timeout: 20000,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const items = [];

  // 商品カードを複数セレクターで探索
  const selectors = [
    '[class*="product-item"]',
    '[class*="ProductItem"]',
    'article[class*="product"]',
    '[data-component="ProductItem"]',
  ];

  let cards = $([]);
  for (const sel of selectors) {
    cards = $(sel);
    if (cards.length > 0) break;
  }

  // フォールバック: /product/ へのリンク
  if (cards.length === 0) {
    $('a[href*="/product/"]').each((_, el) => {
      const parent = $(el).closest('li, article, div[class]');
      if (parent.length) cards = cards.add(parent);
    });
  }

  cards.slice(0, 50).each((i, card) => {
    try {
      const $card = $(card);
      const link  = $card.find('a[href*="/product/"]').first();
      const href  = link.attr('href') || '';
      if (!href) return;

      const productId = href.match(/\/product\/([^/?#]+)/)?.[1] || `${target.id}-${i}`;
      const url = href.startsWith('http') ? href : 'https://www.hermes.com' + href;

      const name = (
        $card.find('[class*="name"],[class*="title"],h2,h3').first().text() ||
        productId
      ).trim().slice(0, 80);

      const price = $card.find('[class*="price"],[class*="Price"]').first().text().trim().slice(0, 30);

      const isOut = $card.find('[class*="out-of-stock"],[class*="sold-out"],[class*="unavailable"]').length > 0
        || /out.?of.?stock|売切|在庫なし/i.test($card.text());

      items.push({ id: productId, name, price, url, inStock: !isOut });
    } catch {}
  });

  return items;
}

// ── 変化検知 ─────────────────────────────────────────────
function detectChanges(prevItems, newItems) {
  const prevMap = {};
  (prevItems || []).forEach(i => prevMap[i.id] = i);

  const changes = [];
  for (const item of newItems) {
    const prev = prevMap[item.id];
    if (!prev && item.inStock) {
      changes.push({ type: 'new', item });
    } else if (prev && !prev.inStock && item.inStock) {
      changes.push({ type: 'restock', item });
    }
  }
  return changes;
}

// ── LINE通知 ─────────────────────────────────────────────
async function sendLine(message) {
  if (!LINE_TOKEN || !LINE_USER_ID) {
    console.log('LINE設定なし、スキップ');
    return;
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: LINE_USER_ID,
      messages: [{ type: 'text', text: message }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('LINE送信失敗:', err);
  } else {
    console.log('LINE通知送信完了');
  }
}

// ── メイン ───────────────────────────────────────────────
async function main() {
  const snapshot = loadSnapshot();
  const newSnapshot = {};
  const allChanges = [];

  for (const target of TARGETS) {
    console.log(`チェック中: ${target.label}`);
    try {
      const items = await fetchProducts(target);
      console.log(`  → ${items.length}件検出`);

      const changes = detectChanges(snapshot[target.id], items);
      if (changes.length > 0) {
        console.log(`  → 変化検知: ${changes.map(c => c.item.name).join(', ')}`);
        allChanges.push({ target, changes });
      }

      newSnapshot[target.id] = items;

      // サーバー負荷軽減
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`  → エラー (${target.label}):`, err.message);
    }
  }

  // 変化があればLINE通知
  if (allChanges.length > 0) {
    for (const { target, changes } of allChanges) {
      for (const { type, item } of changes) {
        const typeLabel = type === 'new' ? '🆕 新入荷' : '✅ 在庫復活';
        const msg = [
          `🛍️ HERMÈS ${typeLabel}`,
          `━━━━━━━━━━━━━━`,
          `${item.name}`,
          item.price ? `💴 ${item.price}` : '',
          `📂 ${target.label}`,
          `━━━━━━━━━━━━━━`,
          item.url ? `🔗 ${item.url}` : '',
        ].filter(Boolean).join('\n');

        await sendLine(msg);
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } else {
    console.log('変化なし');
  }

  // スナップショット更新
  saveSnapshot(newSnapshot);
  console.log('完了');
}

main().catch(err => {
  console.error('致命的エラー:', err);
  process.exit(1);
});
