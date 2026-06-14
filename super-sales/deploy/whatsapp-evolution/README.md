# WhatsApp 闭环（第三方网关 Evolution API）

不走 Meta 官方 Cloud API，用开源网关 **Evolution API**（基于 Baileys，扫码登录一个普通 WhatsApp 号即可收发，无需企业资质）。
项目：https://github.com/EvolutionAPI/evolution-api

整套链路：
```
客户 WhatsApp ⇄ Evolution API 网关 ⇄ (webhook) 我们的后端 /api/webhooks/whatsapp
                                          └ closer.decide → apply_decision → 经网关 sendText 自动回发
                                          └ 付款/合同/重大让步 → 强制转人工
```

## 1. 起网关
```bash
export AUTHENTICATION_API_KEY=$(openssl rand -hex 16)   # 记下它 = WA_GATEWAY_API_KEY
docker compose up -d
echo "API KEY = $AUTHENTICATION_API_KEY"
```

## 2. 建实例并扫码登录
```bash
BASE=http://localhost:8080
KEY=$AUTHENTICATION_API_KEY
# 建一个实例（instance 名自取，例如 closer）
curl -s -X POST "$BASE/instance/create" -H "apikey: $KEY" -H 'Content-Type: application/json' \
  -d '{"instanceName":"closer","integration":"WHATSAPP-BAILEYS","qrcode":true}'
# 取二维码（base64），用手机 WhatsApp → 已连接的设备 → 扫码
curl -s "$BASE/instance/connect/closer" -H "apikey: $KEY"
```

## 3. 把网关 webhook 指向后端
后端需有公网 HTTPS 地址（本地可用 cloudflared / ngrok 暴露）。
```bash
curl -s -X POST "$BASE/webhook/set/closer" -H "apikey: $KEY" -H 'Content-Type: application/json' \
  -d '{"webhook":{"enabled":true,"url":"https://<你的公网域名>/api/webhooks/whatsapp","events":["MESSAGES_UPSERT"]}}'
```

## 4. 配置后端 env
在 `backend/.env`：
```
WA_GATEWAY_BASE=http://localhost:8080
WA_GATEWAY_API_KEY=<上面的 API KEY>
WA_GATEWAY_INSTANCE=closer
# 可选：若想校验入站，给 webhook 带上同样的 apikey 头并设此值
WA_GATEWAY_WEBHOOK_TOKEN=
```
新建客户时 `platform=whatsapp`、`external_id=<对方手机号(国际格式,纯数字)>`；之后该号来消息会自动按号码路由到同一客户、AI 多轮推进、命中红线转人工。
