# AI Avatar 聊天模擬

和多個 AI avatar 一對一或在群組裡聊天、交流、談戀愛的模擬聊天遊戲（WebApp，docker compose 部署）。

設計見 [設計文件](docs/design.md)。目前完成 **第 1、2 階段**：

- docker compose：`web`（nginx + 前端）、`api`、`worker`、`postgres`（pgvector）、`redis`，選用 `ollama`
- 四欄介面：圖示欄、聊天列表、聊天畫面、資訊面板；淺色／深色主題、手機寬度
- 設定頁：LLM 設定檔（供應商、模型、API key、參數預設值、取得模型清單、測試連線）、一般設定、系統狀態
- avatar：名字、簡介、頭像上傳、**綁定 LLM 設定檔並覆寫參數**；建立時自動產生一對一聊天
- **一對一聊天**：avatar 依自己綁定的 LLM 回覆，有已讀、「輸入中…」、拆成多則送出；連續傳的訊息會合併回覆，打字途中插話會重新回應
- 未讀數、失敗時可以重試、可選擇顯示 avatar 的內心想法（設定 → 一般 → 聊天）

## 啟動

需求：Docker（含 Compose v2）。

```sh
cp .env.example .env
# 編輯 .env：APP_SECRET 填一串隨機字串（例如 openssl rand -base64 32 的結果），並改掉 POSTGRES_PASSWORD
docker compose up -d --build
```

打開 <http://localhost:8080>：

1. **設定 → LLM 設定檔 → 新增**：例如名稱「Gemini Flash」、供應商選 Google Gemini、貼上 API key，按「取得模型清單」選模型，再按「測試連線」。
2. **Avatar → +**：填名字、簡介，在「大腦」選剛才的設定檔，需要時勾選要覆寫的參數（例如 temperature）。
3. 建立後可以上傳頭像，按「聊天」進入一對一聊天。

- 預設只開放本機連線；要讓區網其他裝置連線，把 `.env` 的 `WEB_BIND` 改成 `0.0.0.0`（目前沒有登入機制，請只在信任的網路這樣做）。
- `APP_SECRET` 用來加密 API key；**改掉之後已存的 key 會解不開**，要重新輸入。
- 本機模型：`docker compose --profile local up -d` 會多啟動 Ollama；LLM 設定檔選「OpenAI 相容端點」，Base URL 填 `http://ollama:11434/v1`。
- 資料在 Docker volume（`pgdata`、`redisdata`、`media`）；`docker compose down` 不會刪除，`down -v` 才會。

## 開發

需求：Node.js ≥ 22.13。

```sh
npm install
cp .env.example .env    # 填 APP_SECRET；開發用的 DATABASE_URL 等已經寫好
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres redis
npm run dev:api         # http://localhost:3000（啟動時自動跑 migration）
npm run dev:worker
npm run dev:web         # http://localhost:5173（/api、/ws、/media 轉給 api）
```

| 目錄 | 內容 |
| --- | --- |
| `packages/shared` | 前後端共用的 zod schema 與型別（LLM 設定檔／綁定、設定、avatar、訊息、事件） |
| `apps/backend/src/llm` | LLM adapter：Gemini、Anthropic、OpenAI、OpenAI 相容端點 |
| `apps/backend/src/routes` | REST API |
| `apps/backend/src/api.ts`、`worker.ts` | 兩個進入點（同一個映像） |
| `apps/backend/drizzle` | SQL migration（改 `src/db/schema.ts` 後執行 `npm -w @acc/backend run db:generate`） |
| `apps/frontend/src` | React 前端 |
| `docker/` | Dockerfile、nginx 設定 |

## 測試

```sh
npm run typecheck
npm test                 # 單元測試；API 測試需要資料庫，沒設定時自動略過
docker run -d --name acc-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=acc_test -p 55432:5432 pgvector/pgvector:pg17
TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/acc_test npm test
```

LLM 的測試都用假的 fetch，不需要任何 API key。
