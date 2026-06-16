# 在庫管理 + Chatwork通知システム

在庫数量を管理し、変更があった際に Chatwork へ自動通知する Node.js Web アプリケーションです。

## 機能

- 商品の在庫数量・予定数量の管理（追加・編集・削除）
- **複数商品をまとめて確定**し、Chatwork 通知を1通に集約（v1.3.0〜）
- 在庫数量の変更時に Chatwork ルームへ自動通知
- **ドラッグ＆ドロップで商品の並び替え**（PC・スマホ対応、v1.3.0〜）
- カテゴリータブによる絞り込み表示
- データストアは **PostgreSQL**（接続URLあり）と **JSON ファイル**（接続URLなし）を自動で切り替え
- ブラウザから操作できる管理 UI

## 動作環境

| 項目 | 内容 |
|------|------|
| ランタイム | Node.js v18 以上 |
| データストア | PostgreSQL（`DATABASE_URL` 設定時）/ `inventory.json`（未設定時） |
| 外部連携 | Chatwork API v2 |

## 環境変数

`.env.example` をコピーして `.env` を作成し、各値を設定してください。

```bash
cp .env.example .env
```

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `CHATWORK_API_TOKEN` | ✅ | Chatwork の個人 API トークン（[個人設定ページ](https://www.chatwork.com/service/packages/chatwork/subpackages/api/token.php)で発行） |
| `CHATWORK_ROOM_ID` | ✅ | 通知先のルームID（ルームURL `/room/XXXXXXX` の数字部分） |
| `DATABASE_URL` | ー | PostgreSQL 接続URL（未設定時は `inventory.json` で動作） |
| `PORT` | ー | サーバーポート番号（デフォルト: `3000`） |

## ローカルでの起動

```bash
# 依存パッケージのインストール
npm install

# サーバー起動
npm start

# 開発モード（ファイル変更を自動検知）
npm run dev
```

起動後、ブラウザで `http://localhost:3000` を開いてください。

同一ネットワーク内の他の端末からは `http://<ローカルIP>:3000` でアクセスできます（起動時にコンソールに表示されます）。

## Render へのデプロイ

このリポジトリには `render.yaml` が含まれており、PostgreSQL データベースと Web サービスを自動でセットアップします。

### 手順

1. [Render ダッシュボード](https://dashboard.render.com/) にログイン
2. **New** → **Blueprint** を選択
3. このリポジトリを選択
4. `CHATWORK_API_TOKEN` の入力を求められるので API トークンを入力
5. **Apply** をクリックしてデプロイ

### デプロイ構成（render.yaml）

| リソース | 設定 |
|---------|------|
| Web サービス名 | `inventory-chatwork` |
| 公開 URL | https://inventory-chatwork.onrender.com |
| ビルドコマンド | `npm install` |
| 起動コマンド | `node server.js` |
| データベース名 | `inventory-chatwork-db`（PostgreSQL・無料プラン） |
| `DATABASE_URL` | データベースの Internal URL を自動で注入 |

### Render 環境変数

| 変数名 | 設定方法 |
|--------|---------|
| `DATABASE_URL` | `render.yaml` によりデータベースから自動設定 |
| `CHATWORK_API_TOKEN` | Render ダッシュボードで手動入力 |
| `CHATWORK_ROOM_ID` | `render.yaml` に記載（`436461417`） |

## Chatwork 通知フォーマット

在庫数量が変更されると、以下の形式でルーム `436461417`（在庫管理DB（テスト））に通知されます。

### 単品変更（1商品のみ確定した場合）

```
📦 在庫数量 変更通知
【変更内容】
〇〇：10 → 15（+5）

【在庫一覧】
　商品A：20
▶ 〇〇：15
　商品C：8

合計: 43
```

### 複数商品まとめて確定した場合

```
📦 在庫数量 変更通知
【変更内容】
〇〇：10 → 15（+5）
△△：5 → 3（-2）

【在庫一覧】
　商品A：20
▶ 〇〇：15
▶ △△：3
　商品C：8

合計: 46
```

## API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/api/inventory` | 全商品一覧取得 |
| `POST` | `/api/inventory` | 商品追加 |
| `PUT` | `/api/inventory/:id` | 在庫数量・商品名更新（Chatwork通知あり） |
| `PUT` | `/api/inventory/:id/planned` | 予定数量更新（通知なし） |
| `PUT` | `/api/inventory/reorder` | 商品の並び順更新 |
| `POST` | `/api/inventory/bulk-update` | 複数商品を一括更新（Chatwork通知は1回のみ） |
| `DELETE` | `/api/inventory/:id` | 商品削除 |

## データストアの切り替え

```
DATABASE_URL が設定されている → PostgreSQL を使用
DATABASE_URL が未設定         → inventory.json をローカルファイルとして使用
```

Render 上では PostgreSQL が自動接続されます。ローカル環境では `.env` に `DATABASE_URL` を設定しない場合、`inventory.json` で動作します（データは git 管理対象外）。
