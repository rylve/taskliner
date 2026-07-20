# Cloudflare Pages Functions setup

Tasklinerの同期APIは、静的Pages配信にPages Functionsを追加して動かす。タスク本文、Workspace Data Key、Discord Webhook URLをD1へ保存しない。D1にはGoogleアカウント識別子、暗号化refresh token、E2EE cutover用の非秘密メタデータだけを保存する。

## 1. D1

Cloudflare DashboardでD1 databaseを作成し、PagesプロジェクトのFunctions bindingとして次を登録する。

```text
Binding name: DB
Database: taskliner-auth
```

作成後、schemaを一度だけ実行する。

```powershell
npx wrangler d1 execute taskliner-auth --remote --file=functions/schema.sql
```

既存databaseでは同期FunctionがD1 binding経由で不足columnを確認し、同期v3の初回利用前に冪等にmigrationする。手動で先に適用する場合は次を使う。

```powershell
npx wrangler d1 execute taskliner-auth --remote --file=functions/migrations/0002_sync_v3_e2ee.sql
```

## 2. Pages variables / secrets

productionとpreviewへ、それぞれのGoogle OAuth clientを設定する。

```text
GOOGLE_CLIENT_ID=Google OAuth web client ID
GOOGLE_CLIENT_SECRET=Google OAuth web client secret
AUTH_SECRET=32 bytes以上のランダムなTaskliner署名鍵
TASKLINER_SYNC_V3=enabled
```

`GOOGLE_CLIENT_SECRET` と `AUTH_SECRET` はSecretとして登録する。`GOOGLE_CLIENT_ID` は通常のenvironment variableでよいが、ブラウザへ直接配信しない。

productionでは`TASKLINER_SYNC_V3=enabled`を設定する。`preview`はlocalhostと `*.pages.dev` だけでv3を有効にする検証用の値である。別originを許可する必要がある場合だけ、カンマ区切りの `SYNC_ALLOWED_ORIGINS` を設定する。同期のPUT・DELETEは同一originまたはこの許可リストの `Origin` を必須とする。

同期v3では `/api/sync` はDrive `appDataFolder`への暗号artifact中継だけを行う。Functionは外側schema、識別子、期限、サイズを検証し、復号・merge・projectionはブラウザで行う。移行時のv2 stateも、ブラウザの一時P-256公開鍵へ暗号化して返す。

リアルタイム通知を有効にする場合は、別Workerの `realtime-worker/wrangler.toml` をデプロイし、Pages FunctionsへDurable Object binding `SYNC_ROOM` を追加する。WebSocketには変更通知だけを送り、通知が使えない環境でも既存のHTTP pollingが同期を継続する。

PowerShellでの署名鍵生成例:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

既存のGoogle Cloud project / client:

```text
development: taskliner-development
production: taskliner-production
```

## 3. Google OAuth redirect URI

Google Cloud ConsoleのOAuth web clientに、実際に使用するPages URLのcallbackを登録する。

```text
https://taskliner.app/api/auth/callback
```

previewやWranglerローカル開発を使う場合は、そのoriginのcallbackも追加する。OAuth scopeは次の3つだけである。

```text
openid email https://www.googleapis.com/auth/drive.appdata
```

この方式ではブラウザ用GIS clientを使わないため、authorized JavaScript originsよりredirect URIと同意画面の説明を正しく設定することを優先する。

Google Cloud projectがTestingの間は、`drive.appdata` を含むrefresh tokenが7日で失効し得る。本番公開・verificationが完了するまでの開発QAでは、失効時にアカウント画面から再認可する。

通常の再接続では `prompt=select_account` を使い、Googleがrefresh tokenを返さないcallbackでもD1の既存tokenを保持する。保存済みtokenが`invalid_grant`になった場合だけ、アカウント画面から`prompt=consent`の再認可へ進む。

## 4. ローカルPages Functions

`python -m http.server` はFunctionsを実行しない。OAuthを含む確認にはWranglerのPages dev serverを使う。

```powershell
npx wrangler pages dev . --d1=DB=taskliner-auth
```

ローカルcallback:

```text
http://localhost:8788/api/auth/callback
```

本番では、Google client secretとAUTH_SECRETをrepositoryへ置かない。Cloudflare DashboardまたはWrangler Secretで登録する。

リアルタイムWorkerのデプロイ例:

```powershell
npx wrangler deploy --config realtime-worker/wrangler.toml
```
