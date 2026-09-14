# SMM SuperAmplitude

Plataforma SMM para **https://smm.superamplitude.com**, com portal público, área do cliente, carteira, pedidos, Mercado Pago, PayPal, painel administrativo e uma camada central de gestão por IA.

## Princípios da IA

A IA atua como núcleo de análise e operação: recomenda serviços, classifica risco de pedidos, produz briefings operacionais e registra cada decisão para auditoria. Ações sensíveis — saldo, pagamentos, reembolsos, bloqueios e alterações financeiras — continuam protegidas por regras determinísticas e controle administrativo.

O catálogo é voltado a marketing digital legítimo: conteúdo, design, planejamento editorial, gestão de campanhas, gestão de perfis e analytics. O núcleo de IA é instruído a bloquear/revisar manipulação artificial de métricas, contas falsas, bots de engajamento, spam e outras práticas enganosas.

## Stack

- Node.js 20+
- Express
- MySQL/MariaDB
- JWT + bcrypt
- Mercado Pago Checkout
- PayPal Checkout + captura + webhook verificado
- IA via endpoint compatível com `/chat/completions`
- Nginx reverse proxy
- systemd
- GitHub Actions com runner self-hosted na VPS

## Recursos principais

- Cadastro, login e perfis cliente/admin
- Catálogo de serviços por unidade/pacote
- Recomendações estratégicas por IA
- Triagem de risco por IA em cada pedido
- Carteira com extrato auditável
- Crédito somente após confirmação do gateway
- Débito transacional na criação do pedido
- Devolução idempotente em cancelamento/reembolso
- Mercado Pago e PayPal
- Auditoria de ações e decisões da IA
- Briefing operacional administrativo gerado por IA
- Scheduler periódico da IA
- Rate limit em autenticação e endpoints de IA
- Deploy com backup, validação, restart e health check

## Bootstrap da VPS

Na VPS, execute uma vez usando o mesmo usuário que hospedará o runner:

```bash
curl -fsSL https://raw.githubusercontent.com/superamplitude/Smm/main/deploy/bootstrap-vps.sh | sudo SMM_RUNNER_USER="$USER" bash
```

O bootstrap prepara Node.js, MariaDB quando necessário, Nginx quando necessário, banco, usuário de aplicação, `.env`, systemd, permissões do deploy e o proxy para `smm.superamplitude.com`.

## Registrar o runner

Na pasta do GitHub Actions Runner, use **um token novo de registro** gerado em `Settings > Actions > Runners > New self-hosted runner`:

```bash
./config.sh --url https://github.com/superamplitude/Smm --token <NOVO_TOKEN> --name smm-production --unattended
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

Assim que o runner ficar online, o workflow `.github/workflows/deploy.yml` valida o código e publica a branch `main` diretamente na VPS.

## Configuração de produção

Arquivo protegido na VPS:

```text
/home/superamplitude-smm/htdocs/smm.superamplitude.com/.env
```

Preencha as credenciais reais sem colocá-las no Git:

```env
AI_ENABLED=true
AI_API_BASE_URL=
AI_API_KEY=
AI_MODEL=
AI_OPS_INTERVAL_MINUTES=60

MERCADOPAGO_ACCESS_TOKEN=
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_WEBHOOK_ID=
PAYPAL_MODE=live
```

### Webhooks

Mercado Pago:

```text
https://smm.superamplitude.com/api/webhooks/mercadopago
```

PayPal:

```text
https://smm.superamplitude.com/api/webhooks/paypal
```

## Deploy automático

Cada `push` na `main` executa:

1. syntax check do backend e frontend;
2. smoke tests;
3. montagem de release;
4. preservação do `.env`;
5. instalação de dependências de produção;
6. backup da versão anterior;
7. publicação;
8. reinício do serviço;
9. health check em `127.0.0.1:3008/health`.

## DNS

Crie/apontе `smm.superamplitude.com` para o IP público da VPS. O repositório não armazena credenciais de DNS ou Cloudflare.
