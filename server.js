require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DATA_FILE = path.join(__dirname, "inventory.json");
const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN;
const CHATWORK_ROOM_ID = process.env.CHATWORK_ROOM_ID;

// --- データ読み書き ---

function loadInventory() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function saveInventory(items) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2), "utf-8");
}

// --- Chatwork通知 ---

function sendChatwork(message) {
  if (!CHATWORK_API_TOKEN || !CHATWORK_ROOM_ID) {
    console.warn("[Chatwork] APIトークンまたはルームIDが未設定のため通知をスキップします");
    return;
  }
  const body = `body=${encodeURIComponent(message)}`;
  const options = {
    hostname: "api.chatwork.com",
    path: `/v2/rooms/${CHATWORK_ROOM_ID}/messages`,
    method: "POST",
    headers: {
      "X-ChatWorkToken": CHATWORK_API_TOKEN,
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
  };
  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      if (res.statusCode === 200) {
        console.log(`[Chatwork] 通知送信完了: ${message.slice(0, 40)}...`);
      } else {
        console.error(`[Chatwork] 送信失敗 (${res.statusCode}): ${data}`);
      }
    });
  });
  req.on("error", (e) => console.error("[Chatwork] 接続エラー:", e.message));
  req.write(body);
  req.end();
}

function buildChangeMessage(changedItem, oldQty, newQty, allItems) {
  const diff = newQty - oldQty;
  const diffStr = diff > 0 ? `+${diff}` : `${diff}`;
  const totalQty = allItems.reduce((s, i) => s + i.quantity, 0);

  const rows = allItems
    .map((i) => {
      const marker = i.id === changedItem.id ? "▶ " : "　";
      return `${marker}${i.name}：${i.quantity}`;
    })
    .join("\n");

  return (
    `[info][title]📦 在庫数量 変更通知[/title]` +
    `【変更内容】\n` +
    `商品名: ${changedItem.name}\n` +
    `変更前: ${oldQty} → 変更後: ${newQty}（${diffStr}）\n\n` +
    `【在庫一覧】\n` +
    `${rows}\n\n` +
    `合計: ${totalQty}[/info]`
  );
}

// --- REST API ---

// 一覧取得
app.get("/api/inventory", (req, res) => {
  res.json(loadInventory());
});

// 商品追加
app.post("/api/inventory", (req, res) => {
  const { name, quantity } = req.body;
  if (!name || quantity === undefined) {
    return res.status(400).json({ error: "name と quantity は必須です" });
  }
  const items = loadInventory();
  const newItem = {
    id: Date.now(),
    name: String(name).trim(),
    quantity: Number(quantity),
  };
  items.push(newItem);
  saveInventory(items);
  res.status(201).json(newItem);
});

// 数量更新（Chatwork通知あり）
app.put("/api/inventory/:id", (req, res) => {
  const id = Number(req.params.id);
  const { name, quantity } = req.body;
  const items = loadInventory();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return res.status(404).json({ error: "商品が見つかりません" });

  const oldQty = items[idx].quantity;
  if (name !== undefined) items[idx].name = String(name).trim();
  if (quantity !== undefined) items[idx].quantity = Number(quantity);
  saveInventory(items);

  // 数量が変わった場合のみ通知
  if (quantity !== undefined && Number(quantity) !== oldQty) {
    const msg = buildChangeMessage(items[idx], oldQty, Number(quantity), items);
    sendChatwork(msg);
  }

  res.json(items[idx]);
});

// 予定数量更新（Chatwork通知なし）
app.put("/api/inventory/:id/planned", (req, res) => {
  const id = Number(req.params.id);
  const { planned } = req.body;
  const items = loadInventory();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return res.status(404).json({ error: "商品が見つかりません" });
  items[idx].planned = Number(planned) || 0;
  saveInventory(items);
  res.json(items[idx]);
});

// 商品削除
app.delete("/api/inventory/:id", (req, res) => {
  const id = Number(req.params.id);
  const items = loadInventory();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return res.status(404).json({ error: "商品が見つかりません" });
  items.splice(idx, 1);
  saveInventory(items);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`サーバー起動中: http://localhost:${PORT}`);
  console.log(`他のPCからのアクセス: http://192.168.1.185:${PORT}`);
  console.log(`Chatwork ルームID: ${CHATWORK_ROOM_ID || "未設定"}`);
});
