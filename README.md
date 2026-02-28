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
- **運用監視**: CloudWatch Alarms (11件)、Dashboard、ログメトリクスフィルター、Aurora Performance Insights
- **セキュリティ**: CDK Nag (AwsSolutions) 準拠、VPC Flow Log、ALB/S3 アクセスログ
- **CI/CD**: CodePipeline + CodeBuild → Step Functions による自動アップグレード

## ディレクトリ構成

```
containers/nextcloud/    Nextcloud コンテナ (Dockerfile + 設定ファイル)
cdk/                     AWS CDK プロジェクト (TypeScript)
docs/                    デプロイメントガイド
```

## upstream からの変更点

| ファイル | 変更内容 |
|---|---|
| `containers/nextcloud/Dockerfile` | `app/` 依存除去、COPY パス変更、AIO_TOKEN/AIO_URL 削除 |
| `containers/nextcloud/config/redis.config.php` | ElastiCache Serverless 用 TLS 対応追加 |
| `containers/nextcloud/entrypoint.sh` | syslog ログ出力対応 (NEXTCLOUD_LOG_TYPE) |

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

詳細は [docs/aws-deployment.md](docs/aws-deployment.md) を参照。

## バージョンアップ

CodePipeline (`nextcloud-deploy`) を実行すると自動で:
1. Docker イメージのビルド & ECR プッシュ
2. Step Functions によるローリングアップグレード（メンテナンスモード → バックアップ → アップグレード → スケールアップ）

```bash
aws codepipeline start-pipeline-execution --name nextcloud-deploy
```

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
