require("dotenv").config();
const express = require("express");
const path = require("path");
const https = require("https");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN;
const CHATWORK_ROOM_ID   = process.env.CHATWORK_ROOM_ID;

// --- PostgreSQL接続 ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// テーブルが存在しない場合は自動作成
async function initDB() {
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
  const result = await pool.query("SELECT * FROM inventory ORDER BY id");
  res.json(result.rows);
});

// 商品追加
app.post("/api/inventory", async (req, res) => {
  const { name, quantity } = req.body;
  if (!name || quantity === undefined) {
    return res.status(400).json({ error: "name と quantity は必須です" });
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

  const current = await pool.query("SELECT * FROM inventory WHERE id = $1", [id]);
  if (current.rows.length === 0) return res.status(404).json({ error: "商品が見つかりません" });

  const oldItem  = current.rows[0];
  const newName  = name     !== undefined ? String(name).trim() : oldItem.name;
  const newQty   = quantity !== undefined ? Number(quantity)    : oldItem.quantity;

  const updated = await pool.query(
    "UPDATE inventory SET name = $1, quantity = $2 WHERE id = $3 RETURNING *",
    [newName, newQty, id]
  );

  // 数量が変わった場合のみ通知
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
  const result = await pool.query("DELETE FROM inventory WHERE id = $1 RETURNING *", [id]);
  if (result.rows.length === 0) return res.status(404).json({ error: "商品が見つかりません" });
  res.json({ ok: true });
});

// --- 起動 ---
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`サーバー起動中: http://localhost:${PORT}`);
    console.log(`Chatwork ルームID: ${CHATWORK_ROOM_ID || "未設定"}`);
  });
}).catch((err) => {
  console.error("DB初期化失敗:", err);
  process.exit(1);
});
