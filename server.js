require("dotenv").config();
const express = require("express");
const path = require("path");
const https = require("https");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN;
const CHATWORK_ROOM_ID   = process.env.CHATWORK_ROOM_ID;
const USE_DB = !!process.env.DATABASE_URL;

// --- JSONファイルストレージ（DATABASE_URL未設定時） ---
const JSON_FILE = path.join(__dirname, "inventory.json");

function loadJSON() {
  if (!fs.existsSync(JSON_FILE)) fs.writeFileSync(JSON_FILE, "[]");
  return JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
}
function saveJSON(data) {
  fs.writeFileSync(JSON_FILE, JSON.stringify(data, null, 2));
}

// --- PostgreSQL接続（DATABASE_URL設定時のみ） ---
let pool;
if (USE_DB) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

async function initDB() {
  if (!USE_DB) {
    console.log("データベース初期化完了（JSONファイルモード）");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id        SERIAL PRIMARY KEY,
      name      TEXT    NOT NULL,
      quantity  INTEGER NOT NULL DEFAULT 0,
      planned   INTEGER NOT NULL DEFAULT 0
    )
  `);
  console.log("データベース初期化完了");
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
        console.log(`[Chatwork] 通知送信完了`);
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
  const diff    = newQty - oldQty;
  const diffStr = diff > 0 ? `+${diff}` : `${diff}`;
  const totalQty = allItems.reduce((s, i) => s + i.quantity, 0);
  const rows = allItems
    .map((i) => `${i.id === changedItem.id ? "▶ " : "　"}${i.name}：${i.quantity}`)
    .join("\n");

  return (
    `[info][title]📦 在庫数量 変更通知[/title]` +
    `【変更内容】\n商品名: ${changedItem.name}\n変更前: ${oldQty} → 変更後: ${newQty}（${diffStr}）\n\n` +
    `【在庫一覧】\n${rows}\n\n合計: ${totalQty}[/info]`
  );
}

// --- REST API ---

// 一覧取得
app.get("/api/inventory", async (req, res) => {
  if (!USE_DB) {
    return res.json(loadJSON());
  }
  const result = await pool.query("SELECT * FROM inventory ORDER BY id");
  res.json(result.rows);
});

// 商品追加
app.post("/api/inventory", async (req, res) => {
  const { name, quantity } = req.body;
  if (!name || quantity === undefined) {
    return res.status(400).json({ error: "name と quantity は必須です" });
  }
  if (!USE_DB) {
    const data = loadJSON();
    const newId = data.length > 0 ? Math.max(...data.map(i => i.id)) + 1 : 1;
    const item = { id: newId, name: String(name).trim(), quantity: Number(quantity), planned: 0 };
    data.push(item);
    saveJSON(data);
    return res.status(201).json(item);
  }
  const result = await pool.query(
    "INSERT INTO inventory (name, quantity, planned) VALUES ($1, $2, 0) RETURNING *",
    [String(name).trim(), Number(quantity)]
  );
  res.status(201).json(result.rows[0]);
});

// 数量更新（Chatwork通知あり）
app.put("/api/inventory/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { name, quantity } = req.body;

  if (!USE_DB) {
    const data = loadJSON();
    const idx = data.findIndex(i => i.id === id);
    if (idx === -1) return res.status(404).json({ error: "商品が見つかりません" });
    const oldItem = data[idx];
    const newName = name     !== undefined ? String(name).trim() : oldItem.name;
    const newQty  = quantity !== undefined ? Number(quantity)    : oldItem.quantity;
    data[idx] = { ...oldItem, name: newName, quantity: newQty };
    saveJSON(data);
    if (quantity !== undefined && newQty !== oldItem.quantity) {
      const msg = buildChangeMessage(data[idx], oldItem.quantity, newQty, data);
      sendChatwork(msg);
    }
    return res.json(data[idx]);
  }

  const current = await pool.query("SELECT * FROM inventory WHERE id = $1", [id]);
  if (current.rows.length === 0) return res.status(404).json({ error: "商品が見つかりません" });

  const oldItem  = current.rows[0];
  const newName  = name     !== undefined ? String(name).trim() : oldItem.name;
  const newQty   = quantity !== undefined ? Number(quantity)    : oldItem.quantity;

  const updated = await pool.query(
    "UPDATE inventory SET name = $1, quantity = $2 WHERE id = $3 RETURNING *",
    [newName, newQty, id]
  );

  if (quantity !== undefined && newQty !== oldItem.quantity) {
    const all = await pool.query("SELECT * FROM inventory ORDER BY id");
    const msg = buildChangeMessage(updated.rows[0], oldItem.quantity, newQty, all.rows);
    sendChatwork(msg);
  }

  res.json(updated.rows[0]);
});

// 予定数量更新（Chatwork通知なし）
app.put("/api/inventory/:id/planned", async (req, res) => {
  const id      = Number(req.params.id);
  const planned = Number(req.body.planned) || 0;

  if (!USE_DB) {
    const data = loadJSON();
    const idx = data.findIndex(i => i.id === id);
    if (idx === -1) return res.status(404).json({ error: "商品が見つかりません" });
    data[idx] = { ...data[idx], planned };
    saveJSON(data);
    return res.json(data[idx]);
  }

  const result  = await pool.query(
    "UPDATE inventory SET planned = $1 WHERE id = $2 RETURNING *",
    [planned, id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "商品が見つかりません" });
  res.json(result.rows[0]);
});

// 商品削除
app.delete("/api/inventory/:id", async (req, res) => {
  const id = Number(req.params.id);

  if (!USE_DB) {
    const data = loadJSON();
    const idx = data.findIndex(i => i.id === id);
    if (idx === -1) return res.status(404).json({ error: "商品が見つかりません" });
    const [removed] = data.splice(idx, 1);
    saveJSON(data);
    return res.json({ ok: true });
  }

  const result = await pool.query("DELETE FROM inventory WHERE id = $1 RETURNING *", [id]);
  if (result.rows.length === 0) return res.status(404).json({ error: "商品が見つかりません" });
  res.json({ ok: true });
});

// --- 起動 ---
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    const interfaces = require("os").networkInterfaces();
    const localIP = Object.values(interfaces).flat().find(i => i.family === "IPv4" && !i.internal)?.address;
    console.log(`サーバー起動中: http://localhost:${PORT}`);
    if (localIP) console.log(`他のPCからのアクセス: http://${localIP}:${PORT}`);
    console.log(`Chatwork ルームID: ${CHATWORK_ROOM_ID || "未設定"}`);
    console.log(`データストア: ${USE_DB ? "PostgreSQL" : "inventory.json"}`);
  });
}).catch((err) => {
  console.error("DB初期化失敗:", err);
  process.exit(1);
});
