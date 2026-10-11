# Nextcloud on AWS

Nextcloud を AWS ECS Fargate 上にデプロイするためのプロジェクト。
[Nextcloud AIO](https://github.com/nextcloud/all-in-one) のコンテナイメージをベースに、AWS マネージドサービスを活用したスケーラブルな構成を提供する。

## アーキテクチャ

```
クライアント → Route 53 → ALB (TLS/ACM)
                              │
                              ├─► ECS Fargate: Apache / Nextcloud / Notify-push / OnlyOffice
                              │
                              ├──► Aurora Serverless v2 (PostgreSQL)
                              ├──► ElastiCache Serverless (Valkey)
                              ├──► Amazon S3 (Intelligent-Tiering)
                              ├──► Amazon OpenSearch Service (全文検索、オプション)
                              └──► Amazon EFS (共有ボリューム)
```

## 主な機能

- **自動 TLS**: Route 53 ホストゾーン指定で ACM 証明書発行・DNS レコード作成を自動化
- **コスト最適化**: S3 Intelligent-Tiering、OpenSearch Service プロビジョンド
- **運用監視**: CloudWatch Alarms (11件、SNS で ALARM/OK を通知)、Dashboard、ログメトリクスフィルター、Aurora Performance Insights
- **データ保護**: AWS Backup（EFS + Aurora、日次 35 日 / 週次 90 日）、Aurora PITR 7 日、S3 バージョニング
- **セキュリティ**: AWS WAF で日本以外からのアクセスを遮断（ALB）、CDK Nag (AwsSolutions) 準拠、VPC Flow Log、ALB/S3 アクセスログ、ECR プッシュ時脆弱性スキャン
- **アップグレード自動化**: Step Functions によるローリングアップグレード（手動起動。CodePipeline による CI/CD は未実装）

## ディレクトリ構成

```
containers/nextcloud/    Nextcloud コンテナ (Dockerfile + 設定ファイル)
cdk/                     AWS CDK プロジェクト (TypeScript)
docs/                    デプロイメントガイド
```

## upstream からの変更点

| ファイル | 変更内容 |
|---|---|
| `containers/nextcloud/Dockerfile` | `app/` 依存除去、COPY パス変更、AIO_TOKEN/AIO_URL 削除、aws-cli 追加（アップグレード SFN の config.php バックアップ用）、`AIO_LOG_LEVEL` デフォルト定義、diag.php の COPY、`clear_env = no` |
| `containers/nextcloud/config/redis.config.php` | ElastiCache Serverless 用に全面書き換え（`REDIS_TLS_ENABLED` による TLS 接続、クラスタモード設定） |
| `containers/nextcloud/entrypoint.sh` | rsync に `--inplace` 付与（EFS 対応）、custom_apps 入れ子ディレクトリの自己修復（`aws_repair_custom_apps_and_upgrade` を3箇所で実行）、OpenSearch 互換パッチ（ProductCheckTrait / EndpointTrait 呼び出し無効化 / highlight `max_analyzer_offset`）、`fulltextsearch_elasticsearch:configure` の出力抑止（資格情報をログに出さない）、末尾に AWS 固有ブロック（diag.php 配置・redis セッションハンドラ除去・redis.config.php 保全・PHP-FPM 追加設定） |
| `containers/nextcloud/aws-custom-apps-repair.sh` | 独自追加。EFS 上でアプリ更新後に生じる入れ子ディレクトリの修復ライブラリ（テスト: `containers/nextcloud/tests/`） |
| `containers/nextcloud/aws-healthcheck.sh` | 独自追加。ECS 用ヘルスチェック（php-fpm の待受で正常、インストール・アップグレード中は保護。テスト: `containers/nextcloud/tests/`） |
| `containers/nextcloud/aws-trusted-proxies.sh` | 独自追加。NAT Gateway の EIP（`AWS_TRUSTED_PROXIES`）を `trusted_proxies` 20〜29 番に設定（notify_push 用。テスト: `containers/nextcloud/tests/`） |
| `containers/nextcloud/diag.php` | 独自追加（Redis 接続診断。外部からは 404） |

同期状況: Nextcloud 34.0.4 / PHP 8.4.26 / dinit。upstream AIO main `da7cf9d7`（2026-10-08）に同期済みで、上表以外のファイル（start.sh・notify*.sh・dinit.d/・config/ の大半など）は upstream と同一。以前の redis-patch.php（Redis.php の全置換）は、Nextcloud 33.0.7 以降の公式実装が SCAN + UNLINK に変わったため撤去した。

## デプロイ

```bash
cd cdk
npm install
# cdk.json の context を環境に合わせて編集
npx cdk bootstrap
npx cdk deploy
```

### 主要パラメータ (cdk.json)

| パラメータ | 説明 |
|---|---|
| `domain` | Nextcloud のドメイン名 |
| `hostedZoneId` / `hostedZoneName` | Route 53 ホストゾーン（指定時は証明書・DNS 自動設定） |
| `certificateArn` | 既存 ACM 証明書の ARN（ホストゾーン未指定時に使用） |
| `enableOnlyOffice` | OnlyOffice の有効化 |
| `enableFulltextsearch` | OpenSearch Service + 全文検索の有効化 |
| `auroraMinAcu` / `auroraMaxAcu` | Aurora Serverless v2 の ACU 範囲 |
| `alarmEmails` | アラーム通知先メール（カンマ区切り）。空なら購読なし |
| `auroraBackupRetentionDays` | Aurora 自動バックアップの保持日数（既定 7） |
| `backupDailyRetentionDays` / `backupWeeklyRetentionDays` | AWS Backup の保持日数（既定 35 / 90） |
| `ecrScanRepositories` | プッシュ時スキャン対象の ECR リポジトリ（既定 `aio-nextcloud`） |
| `wafAllowedCountries` | ALB に到達できる国（ISO 3166 alpha-2、カンマ区切り、既定 `JP`） |
| `aioImageTag` / `aioNotifyPushImageTag` | AIO 周辺イメージのタグ（notify-push は省略時 `aioImageTag` と同じ） |

詳細は [docs/aws-deployment.md](docs/aws-deployment.md) を参照。

### 開発時のチェック

```bash
cd cdk
npm run lint && npx tsc --noEmit && npm test && npx cdk diff
bash ../containers/nextcloud/tests/test-aws-custom-apps-repair.sh
```

## バージョンアップ

Step Functions ステートマシン `nextcloud-upgrade` がメンテナンスモード・サービス縮退・Aurora スナップショット・config.php バックアップを自動化する。イメージの反映（`cdk deploy`）のみ operator が実施し、タスクトークンで再開する2フェーズ方式。

1. Docker イメージをビルドして ECR にプッシュする

```bash
aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker build -t <account>.dkr.ecr.<region>.amazonaws.com/aio-nextcloud:<tag> -f containers/nextcloud/Dockerfile .
docker push <account>.dkr.ecr.<region>.amazonaws.com/aio-nextcloud:<tag>
```

2. ステートマシンを起動する（maintenance ON → サービス縮退 → スナップショット → バックアップ後、SQS でトークンを配送して待機する）

```bash
aws stepfunctions start-execution --state-machine-arn arn:aws:states:<region>:<account>:stateMachine:nextcloud-upgrade
```

3. SQS キュー（スタック出力 `UpgradeQueueUrl`）からタスクトークンを取得する

```bash
aws sqs receive-message --queue-url <UpgradeQueueUrl> --wait-time-seconds 20
```

4. `cdk.json` の `nextcloudImageUri` を新しいタグに更新し `npx cdk deploy` する（台数は 0 のまま、タスク定義だけが切り替わる。nextcloud / apache / notify-push の台数はテンプレートで指定せず、ステートマシンが管理する）

5. deploy が終わったらすぐトークンで実行を再開する。ステートマシンが新リビジョンのタスクだけを起動し、`occ upgrade` が終わって ALB ターゲットが healthy になるまで待ってから、検証 → maintenance OFF → 完了と進む

```bash
aws stepfunctions send-task-success --task-token '<taskToken>' --task-output '{}'
```

失敗時はステートマシンが desired count を復元する（ベストエフォート）。DB の復旧はスナップショット `pre-upgrade-<executionId>` から、EFS は AWS Backup の復旧ポイントから行う。アップグレードの間（33.0.7 → 33.0.9 で約 57 分、33.0.9 → 34.0.4 で約 65 分）はサービスが停止する。

## upstream の更新追従

Nextcloud AIO の `Containers/nextcloud/` ディレクトリの変更を定期的に確認し、必要なファイルを取り込む。

```bash
# upstream の差分確認
git clone --depth 1 https://github.com/nextcloud/all-in-one.git /tmp/aio
diff -r /tmp/aio/Containers/nextcloud/ containers/nextcloud/ \
  --exclude=Dockerfile
```

## ライセンス

[GNU AGPL v3](https://www.gnu.org/licenses/agpl-3.0.html) - Nextcloud AIO のライセンスに準拠。
