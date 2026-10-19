# AI Avatar 聊天模擬

和多個 AI avatar 一對一或在群組裡聊天、交流、談戀愛的模擬聊天遊戲（WebApp，docker compose 部署）。

設計見 [設計文件](docs/design.md)。目前完成 **第 1～7 階段**：

- docker compose：`web`（nginx + 前端）、`api`、`worker`、`postgres`（pgvector）、`redis`，選用 `ollama`
- 四欄介面：圖示欄、聊天列表、聊天畫面、資訊面板；淺色／深色主題、手機寬度
- 設定頁：LLM 設定檔（供應商、模型、API key、參數預設值、取得模型清單、測試連線）、一般設定、系統狀態
- avatar：名字、簡介、頭像上傳或 AI 生成、**綁定 LLM 設定檔並覆寫參數**；建立時自動產生一對一聊天
- **avatar creator**：59 個人格欄位（說話方式、五大人格、思考方式、價值觀、行為準則、好惡、感情觀、作息…），可以從一句話產生、AI 補完空白欄位、逐欄或逐區重新產生、鎖定不想被改的欄位、一致性檢查
- **一對一聊天**：avatar 依自己綁定的 LLM 回覆，有已讀、「輸入中…」、拆成多則送出；連續傳的訊息會合併回覆，打字途中插話會重新回應
- **你的 profile**：第一次使用時引導填寫「關於你」問卷與三份心理學量表（Mini-IPIP 五大人格、ECR-RS 依附風格、PVQ-21 價值觀），結果用圖表呈現，並整理成給 avatar 的摘要
- **記憶與關係**：avatar 會從對話整理出記得的事，回覆時想起相關的記憶；每天整理一次對你的印象；有自己的心情；好感、信任與關係階段（陌生 → 認識 → 朋友 → 好友 → 曖昧 → 戀人，也可能變冷淡）會隨互動變化，戀愛的發展需要真的發生、而且關係夠深才會成立
- **擬真時間**：avatar 依作息決定多久才看到訊息（上班時可能拖很久、睡覺時到起床才看到）；一直傳訊息會讓它提早看，甚至被吵醒；有空時會主動找你聊（避開勿擾時段、每天有上限），話題來自它每天的生活日誌。聊天列表與標題列顯示它現在在線、忙碌還是睡覺。不想等的話，在「設定 → 一般 → 聊天」把回覆節奏改成「輕鬆」或「即時」
- **群組聊天**：聊天列表「群組」旁的 ＋ 建立；avatar 會依話題、個性、和你的關係與現在忙不忙決定要不要回，不一定每個人都回，也可能互相接話、@ 彼此；@名字 可以點名；私訊裡聽到的事會依它的口風決定說不說；久沒人說話時也會有人開話題
- **監控**（左側的 📈）：即時的事件 log、每次 LLM 呼叫送出的完整 context 與回應、工作佇列與排程（可以手動立刻執行）、Prompt 預覽、記憶檢索測試、用量統計
- 未讀數、失敗時可以重試、可選擇顯示 avatar 的內心想法（設定 → 一般 → 聊天）

## 啟動

需求：Docker（含 Compose v2）。

```sh
cp .env.example .env
# 編輯 .env：APP_SECRET 填一串隨機字串（例如 openssl rand -base64 32 的結果），並改掉 POSTGRES_PASSWORD
docker compose up -d --build
```

打開 <http://localhost:8080>。第一次使用會先請你填「關於你」問卷和心理測驗（量表可以跳過，之後到「我的 profile」補做）。接著：

1. **設定 → LLM 設定檔 → 新增**：例如名稱「Gemini Flash」、供應商選 Google Gemini、貼上 API key，按「取得模型清單」選模型，再按「測試連線」。
2. **設定 → 一般**：「系統工具模型」選剛才的設定檔（補完角色設定、整理記憶要用）；「記憶」選同一個 Google 設定檔，嵌入模型用 `gemini-embedding-001`；想用 AI 生成頭像的話，在「頭像生成」選設定檔並填圖片模型（例如 `gemini-2.5-flash-image`）。
3. **Avatar → +**：在「人格設定」輸入一句話描述，按「產生角色」，檢查、修改（改過的欄位會自動鎖定），需要時按「一致性檢查」；在「大腦」選設定檔，按「建立」。
4. 在「基本資料」上傳或生成頭像，按「聊天」進入一對一聊天。

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

開發時可以用環境變數 `MEMORY_IDLE_MS`（worker）縮短「對話停下多久後整理記憶」的等待時間，預設 600000（10 分鐘）。
