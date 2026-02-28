# Nextcloud AIO - AWS ECS Fargate デプロイメントガイド

Nextcloud AIO のコンテナイメージを AWS ECS Fargate 上でデプロイするためのガイド。
マネージドサービス（Aurora Serverless v2、ElastiCache Serverless for Valkey、S3）を活用し、スケーラブルな構成を実現する。

## アーキテクチャ

```
クライアント → ALB (TLS終端 + WAF)
                  │
                  ├─► [ECS Service] Apache (Caddy)
                  │       ├─► [ECS Service] Nextcloud PHP-FPM × N (Auto Scaling)
                  │       ├─► [ECS Service] Notify-push
                  │       ├─► [ECS Service] OnlyOffice (オプション)
                  │       ├─► [ECS Service] Talk (オプション)
                  │       ├─► [ECS Service] Whiteboard (オプション)
                  │       └─► [ECS Service] その他オプション
                  │
                  ├──► Aurora Serverless v2 (PostgreSQL)
                  ├──► ElastiCache Serverless (Valkey)
                  ├──► Amazon S3 (ファイルストレージ)
                  ├──► Amazon OpenSearch Serverless (全文検索、オプション)
                  └──► Amazon EFS (共有 /var/www/html)
```

### 設計方針

- **CloudFront は使用しない** — Nextcloud は WebDAV プロトコル（PROPFIND, MKCOL, MOVE, LOCK 等）を使用するが、CloudFront はこれらの HTTP メソッドをサポートしていない
- **Collabora は使用しない** — `CAP_SYS_ADMIN` / `SYS_CHROOT` が必要だが Fargate は非対応。代わりに OnlyOffice を使用する
- **DB/Redis/ファイルストレージは全て AWS マネージドサービスに外部化** — コンテナをステートレスにし、水平スケーリングを可能にする

---

## 1. ネットワーク構成

### 1.1 VPC 設計

```
VPC (10.0.0.0/16)
├── Public Subnet  × 2 AZ  — ALB
├── Private Subnet × 2 AZ  — ECS Fargate タスク
└── Isolated Subnet × 2 AZ — Aurora, ElastiCache
```

### 1.2 セキュリティグループ

| リソース | インバウンド | ソース |
|---|---|---|
| ALB | 443/tcp | 0.0.0.0/0 |
| ECS タスク (Apache) | 11000/tcp | ALB SG |
| ECS タスク (Nextcloud) | 9000/tcp, 9001/tcp | Apache SG |
| ECS タスク (OnlyOffice) | 80/tcp | Apache SG |
| ECS タスク (Talk) | 8081/tcp | Apache SG |
| ECS タスク (Notify-push) | 7867/tcp | Apache SG |
| ECS タスク (Whiteboard) | 3002/tcp | Apache SG |
| Aurora | 5432/tcp | ECS タスク SG |
| ElastiCache | 6379/tcp | ECS タスク SG |
| EFS | 2049/tcp | ECS タスク SG |

### 1.3 サービスディスカバリ (AWS Cloud Map)

各 ECS Service に Cloud Map の DNS 名を割り当て、コンテナ間通信に使用する。

| ECS Service | Cloud Map DNS 名 | ポート |
|---|---|---|
| apache | `nextcloud-aio-apache.nextcloud.local` | 11000 |
| nextcloud | `nextcloud-aio-nextcloud.nextcloud.local` | 9000 |
| onlyoffice | `nextcloud-aio-onlyoffice.nextcloud.local` | 80 |
| talk | `nextcloud-aio-talk.nextcloud.local` | 8081, 3478 |
| notify-push | `nextcloud-aio-notify-push.nextcloud.local` | 7867 |
| whiteboard | `nextcloud-aio-whiteboard.nextcloud.local` | 3002 |

Apache コンテナの環境変数でこれらの DNS 名を指定する。

---

## 2. ストレージ: Amazon S3

Nextcloud のファイルデータを S3 に格納する。コンテナの `s3.config.php` が既に対応済み。

### 2.1 ストレージクラス

S3 Intelligent-Tiering を使用し、アクセスパターンに応じて自動的にコスト最適化する。

- ライフサイクルルールにより、新規・既存オブジェクトを即時 Intelligent-Tiering に遷移
- 自動ティア（Frequent / Infrequent / Archive Instant Access）のみ使用。Archive Access / Deep Archive Access は無効（Nextcloud が `RestoreObject` を呼ばないため）
- 非現行バージョンも同様に Intelligent-Tiering に遷移

### 2.2 Nextcloud タスク定義への環境変数

```json
{
  "name": "OBJECTSTORE_S3_BUCKET",     "value": "<バケット名>"
},
{
  "name": "OBJECTSTORE_S3_REGION",     "value": "ap-northeast-1"
},
{
  "name": "OBJECTSTORE_S3_SSL",        "value": "true"
},
{
  "name": "OBJECTSTORE_S3_AUTOCREATE", "value": "true"
},
{
  "name": "OBJECTSTORE_S3_USEPATH_STYLE", "value": "false"
}
```

IRSA 相当の仕組みとして、ECS タスクロールに S3 権限を付与する。`OBJECTSTORE_S3_KEY` / `OBJECTSTORE_S3_SECRET` は空にする。

### 2.3 ECS タスクロール IAM ポリシー

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:CreateBucket"
      ],
      "Resource": [
        "arn:aws:s3:::<BUCKET_NAME>",
        "arn:aws:s3:::<BUCKET_NAME>/*"
      ]
    }
  ]
}
```

---

## 3. データベース: Aurora Serverless v2

### 3.1 Aurora 設定

```
エンジン:          Aurora PostgreSQL 互換
インスタンスクラス:  db.serverless
最小 ACU:          0.5 (開発) / 2 (本番)
最大 ACU:          16 (小規模) / 64 (大規模)
Multi-AZ:          有効 (本番)
```

### 3.2 Nextcloud タスク定義への環境変数

```json
{
  "name": "POSTGRES_HOST",     "value": "<cluster>.cluster-xxxxx.ap-northeast-1.rds.amazonaws.com"
},
{
  "name": "POSTGRES_PORT",     "value": "5432"
},
{
  "name": "POSTGRES_DB",       "value": "nextcloud_database"
},
{
  "name": "POSTGRES_USER",     "value": "nextcloud"
},
{
  "name": "POSTGRES_PASSWORD", "value": "<password>"
}
```

SSL 接続を有効にする場合、追加:

```json
{
  "name": "NEXTCLOUD_TRUSTED_CERTIFICATES_POSTGRES", "value": "true"
}
```

コード変更は不要。Nextcloud コンテナの `postgres.config.php` が既に SSL 対応済み。

---

## 4. キャッシュ: ElastiCache Serverless for Valkey

### 4.1 redis.config.php の TLS 対応修正

ElastiCache Serverless は TLS 必須。現在の `redis.config.php` は TLS 未対応のため修正が必要。

`Containers/nextcloud/config/redis.config.php` を以下に置き換える:

```php
<?php
if (getenv('REDIS_MODE') !== 'rediscluster') {
  $CONFIG = array(
    'memcache.distributed' => '\OC\Memcache\Redis',
    'memcache.locking' => '\OC\Memcache\Redis',
  );

  $redis_config = array();

  if (getenv('REDIS_HOST')) {
    $redis_config['host'] = (string) getenv('REDIS_HOST');
  }
  if (getenv('REDIS_HOST_PASSWORD')) {
    $redis_config['password'] = (string) getenv('REDIS_HOST_PASSWORD');
  }
  if (getenv('REDIS_PORT')) {
    $redis_config['port'] = (int) getenv('REDIS_PORT');
  }
  if (getenv('REDIS_DB_INDEX')) {
    $redis_config['dbindex'] = (int) getenv('REDIS_DB_INDEX');
  }
  if (getenv('REDIS_USER_AUTH')) {
    $redis_config['user'] = str_replace("&auth[]=", "", getenv('REDIS_USER_AUTH'));
  }
  if (getenv('REDIS_TLS_ENABLED') === 'true') {
    $redis_config['host'] = 'tls://' . $redis_config['host'];
    $redis_config['ssl'] = array('verify_peer' => true, 'verify_peer_name' => true);
  }

  $CONFIG['redis'] = $redis_config;

} else {
  $seeds = array_values(array_filter(array(
    (getenv('REDIS_HOST') && getenv('REDIS_PORT')) ? (getenv('REDIS_HOST') . ':' . (string)getenv('REDIS_PORT')) : null,
    (getenv('REDIS_HOST_2') && getenv('REDIS_PORT_2')) ? (getenv('REDIS_HOST_2') . ':' . (string)getenv('REDIS_PORT_2')) : null,
    (getenv('REDIS_HOST_3') && getenv('REDIS_PORT_3')) ? (getenv('REDIS_HOST_3') . ':' . (string)getenv('REDIS_PORT_3')) : null,
    (getenv('REDIS_HOST_4') && getenv('REDIS_PORT_4')) ? (getenv('REDIS_HOST_4') . ':' . (string)getenv('REDIS_PORT_4')) : null,
    (getenv('REDIS_HOST_5') && getenv('REDIS_PORT_5')) ? (getenv('REDIS_HOST_5') . ':' . (string)getenv('REDIS_PORT_5')) : null,
    (getenv('REDIS_HOST_6') && getenv('REDIS_PORT_6')) ? (getenv('REDIS_HOST_6') . ':' . (string)getenv('REDIS_PORT_6')) : null,
    (getenv('REDIS_HOST_7') && getenv('REDIS_PORT_7')) ? (getenv('REDIS_HOST_7') . ':' . (string)getenv('REDIS_PORT_7')) : null,
    (getenv('REDIS_HOST_8') && getenv('REDIS_PORT_8')) ? (getenv('REDIS_HOST_8') . ':' . (string)getenv('REDIS_PORT_8')) : null,
    (getenv('REDIS_HOST_9') && getenv('REDIS_PORT_9')) ? (getenv('REDIS_HOST_9') . ':' . (string)getenv('REDIS_PORT_9')) : null,
  )));

  if (getenv('REDIS_TLS_ENABLED') === 'true') {
    $seeds = array_map(function($seed) { return 'tls://' . $seed; }, $seeds);
  }

  $cluster_config = array(
    'timeout' => 0.0,
    'read_timeout' => 0.0,
    'failover_mode' => \RedisCluster::FAILOVER_ERROR,
    'seeds' => $seeds,
  );

  if (getenv('REDIS_TLS_ENABLED') === 'true') {
    $cluster_config['ssl'] = array('verify_peer' => true, 'verify_peer_name' => true);
  }
  if (getenv('REDIS_HOST_PASSWORD')) {
    $cluster_config['password'] = (string) getenv('REDIS_HOST_PASSWORD');
  }
  if (getenv('REDIS_USER_AUTH')) {
    $cluster_config['user'] = str_replace("&auth[]=", "", getenv('REDIS_USER_AUTH'));
  }

  $CONFIG = array(
    'memcache.distributed' => '\OC\Memcache\Redis',
    'memcache.locking' => '\OC\Memcache\Redis',
    'redis.cluster' => $cluster_config,
  );
}
```

### 4.2 Nextcloud タスク定義への環境変数

```json
{
  "name": "REDIS_HOST",          "value": "<cache>.serverless.ap-northeast-1.cache.amazonaws.com"
},
{
  "name": "REDIS_PORT",          "value": "6379"
},
{
  "name": "REDIS_HOST_PASSWORD", "value": "<auth-token>"
},
{
  "name": "REDIS_TLS_ENABLED",  "value": "true"
},
{
  "name": "REDIS_MODE",         "value": "rediscluster"
}
```

---

## 5. 共有ボリューム: Amazon EFS

Apache、Nextcloud、Notify-push が `/var/www/html` を共有する必要がある。EFS で実現する。

### 5.1 EFS 構成

```
EFS ファイルシステム
├── アクセスポイント: nextcloud-html
│   ├── パス: /nextcloud-html
│   ├── POSIX UID: 33 (www-data)
│   └── POSIX GID: 33
├── アクセスポイント: apache-data
│   ├── パス: /apache-data
│   ├── POSIX UID: 33
│   └── POSIX GID: 33
└── アクセスポイント: onlyoffice-data (オプション)
    ├── パス: /onlyoffice-data
    └── POSIX UID: 104
```

### 5.2 タスク定義でのボリュームマウント

各タスク定義の `volumes` セクション:

```json
"volumes": [
  {
    "name": "nextcloud-html",
    "efsVolumeConfiguration": {
      "fileSystemId": "fs-xxxxxxxxx",
      "transitEncryption": "ENABLED",
      "authorizationConfig": {
        "accessPointId": "fsap-xxxxxxxxx"
      }
    }
  }
]
```

| タスク | マウントパス | 読み書き | EFS アクセスポイント |
|---|---|---|---|
| Nextcloud | `/var/www/html` | RW | nextcloud-html |
| Apache | `/var/www/html` | RO | nextcloud-html |
| Notify-push | `/var/www/html` | RO | nextcloud-html |
| Apache | `/mnt/data` | RW | apache-data |
| OnlyOffice | `/var/lib/onlyoffice` | RW | onlyoffice-data |

---

## 6. ECS タスク定義

### 6.1 Nextcloud (PHP-FPM)

```json
{
  "family": "nextcloud-aio-nextcloud",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "<execution-role-arn>",
  "taskRoleArn": "<task-role-arn>",
  "containerDefinitions": [
    {
      "name": "nextcloud",
      "image": "ghcr.io/nextcloud-releases/aio-nextcloud:20260218_123804",
      "essential": true,
      "portMappings": [
        { "containerPort": 9000, "protocol": "tcp" },
        { "containerPort": 9001, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "POSTGRES_HOST",     "value": "<aurora-endpoint>" },
        { "name": "POSTGRES_PORT",     "value": "5432" },
        { "name": "POSTGRES_DB",       "value": "nextcloud_database" },
        { "name": "POSTGRES_USER",     "value": "nextcloud" },
        { "name": "POSTGRES_PASSWORD", "value": "<password>" },
        { "name": "REDIS_HOST",        "value": "<elasticache-endpoint>" },
        { "name": "REDIS_PORT",        "value": "6379" },
        { "name": "REDIS_HOST_PASSWORD", "value": "<auth-token>" },
        { "name": "REDIS_TLS_ENABLED", "value": "true" },
        { "name": "REDIS_MODE",        "value": "rediscluster" },
        { "name": "NC_DOMAIN",         "value": "cloud.example.com" },
        { "name": "OVERWRITEPROTOCOL", "value": "https" },
        { "name": "APACHE_HOST",       "value": "nextcloud-aio-apache.nextcloud.local" },
        { "name": "APACHE_PORT",       "value": "11000" },
        { "name": "NEXTCLOUD_HOST",    "value": "nextcloud-aio-nextcloud.nextcloud.local" },
        { "name": "ADMIN_USER",        "value": "admin" },
        { "name": "ADMIN_PASSWORD",    "value": "<admin-password>" },
        { "name": "OBJECTSTORE_S3_BUCKET",     "value": "<bucket-name>" },
        { "name": "OBJECTSTORE_S3_REGION",     "value": "ap-northeast-1" },
        { "name": "OBJECTSTORE_S3_SSL",        "value": "true" },
        { "name": "OBJECTSTORE_S3_AUTOCREATE", "value": "true" },
        { "name": "OBJECTSTORE_S3_USEPATH_STYLE", "value": "false" },
        { "name": "PHP_MEMORY_LIMIT",  "value": "512M" },
        { "name": "PHP_UPLOAD_LIMIT",  "value": "16G" },
        { "name": "PHP_MAX_TIME",      "value": "3600" },
        { "name": "TZ",               "value": "Asia/Tokyo" },
        { "name": "ONLYOFFICE_ENABLED", "value": "yes" },
        { "name": "ONLYOFFICE_HOST",   "value": "nextcloud-aio-onlyoffice.nextcloud.local" },
        { "name": "ONLYOFFICE_SECRET", "value": "<onlyoffice-secret>" },
        { "name": "TALK_ENABLED",      "value": "no" },
        { "name": "CLAMAV_ENABLED",    "value": "no" },
        { "name": "COLLABORA_ENABLED", "value": "no" },
        { "name": "IMAGINARY_ENABLED", "value": "no" },
        { "name": "FULLTEXTSEARCH_ENABLED", "value": "no" },
        { "name": "WHITEBOARD_ENABLED", "value": "no" },
        { "name": "STARTUP_APPS",      "value": "deck twofactor_totp tasks calendar contacts notes drawio mail forms groupfolders user_saml files_accesscontrol suspicious_login" },
        { "name": "UPDATE_NEXTCLOUD_APPS", "value": "no" },
        { "name": "REMOVE_DISABLED_APPS",  "value": "yes" }
      ],
      "mountPoints": [
        { "sourceVolume": "nextcloud-html", "containerPath": "/var/www/html" }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "/healthcheck.sh"],
        "interval": 30,
        "timeout": 30,
        "retries": 3,
        "startPeriod": 120
      },
      "user": "33:33",
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/nextcloud-aio-nextcloud",
          "awslogs-region": "ap-northeast-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ],
  "volumes": [
    {
      "name": "nextcloud-html",
      "efsVolumeConfiguration": {
        "fileSystemId": "fs-xxxxxxxxx",
        "transitEncryption": "ENABLED",
        "authorizationConfig": { "accessPointId": "fsap-nextcloud-html" }
      }
    }
  ]
}
```

### 6.2 Apache (Caddy + httpd)

```json
{
  "family": "nextcloud-aio-apache",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "containerDefinitions": [
    {
      "name": "apache",
      "image": "ghcr.io/nextcloud-releases/aio-apache:20260218_123804",
      "essential": true,
      "portMappings": [
        { "containerPort": 11000, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "APACHE_PORT",     "value": "11000" },
        { "name": "APACHE_MAX_SIZE", "value": "17179869184" },
        { "name": "APACHE_MAX_TIME", "value": "3600" },
        { "name": "NC_DOMAIN",       "value": "cloud.example.com" },
        { "name": "APACHE_HOST",     "value": "nextcloud-aio-apache.nextcloud.local" },
        { "name": "NEXTCLOUD_HOST",  "value": "nextcloud-aio-nextcloud.nextcloud.local" },
        { "name": "COLLABORA_HOST",  "value": "localhost" },
        { "name": "NOTIFY_PUSH_HOST","value": "nextcloud-aio-notify-push.nextcloud.local" },
        { "name": "ONLYOFFICE_HOST", "value": "nextcloud-aio-onlyoffice.nextcloud.local" },
        { "name": "TALK_HOST",       "value": "nextcloud-aio-talk.nextcloud.local" },
        { "name": "WHITEBOARD_HOST", "value": "nextcloud-aio-whiteboard.nextcloud.local" },
        { "name": "HARP_HOST",       "value": "localhost" },
        { "name": "TZ",             "value": "Asia/Tokyo" }
      ],
      "mountPoints": [
        { "sourceVolume": "nextcloud-html", "containerPath": "/var/www/html", "readOnly": true },
        { "sourceVolume": "apache-data",    "containerPath": "/mnt/data" }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "/healthcheck.sh"],
        "interval": 30,
        "timeout": 30,
        "retries": 3,
        "startPeriod": 60
      },
      "user": "33:33",
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/nextcloud-aio-apache",
          "awslogs-region": "ap-northeast-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ],
  "volumes": [
    {
      "name": "nextcloud-html",
      "efsVolumeConfiguration": {
        "fileSystemId": "fs-xxxxxxxxx",
        "transitEncryption": "ENABLED",
        "authorizationConfig": { "accessPointId": "fsap-nextcloud-html" }
      }
    },
    {
      "name": "apache-data",
      "efsVolumeConfiguration": {
        "fileSystemId": "fs-xxxxxxxxx",
        "transitEncryption": "ENABLED",
        "authorizationConfig": { "accessPointId": "fsap-apache-data" }
      }
    }
  ]
}
```

### 6.3 OnlyOffice (オプション)

```json
{
  "family": "nextcloud-aio-onlyoffice",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "2048",
  "memory": "4096",
  "containerDefinitions": [
    {
      "name": "init-volumes",
      "image": "ghcr.io/nextcloud-releases/aio-alpine:20260218_123804",
      "essential": false,
      "command": ["chmod", "777", "/nextcloud-aio-onlyoffice"],
      "mountPoints": [
        { "sourceVolume": "onlyoffice-data", "containerPath": "/nextcloud-aio-onlyoffice" }
      ]
    },
    {
      "name": "onlyoffice",
      "image": "ghcr.io/nextcloud-releases/aio-onlyoffice:20260218_123804",
      "essential": true,
      "dependsOn": [
        { "containerName": "init-volumes", "condition": "SUCCESS" }
      ],
      "portMappings": [
        { "containerPort": 80, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "JWT_ENABLED", "value": "true" },
        { "name": "JWT_HEADER",  "value": "AuthorizationJwt" },
        { "name": "JWT_SECRET",  "value": "<onlyoffice-secret>" },
        { "name": "TZ",         "value": "Asia/Tokyo" }
      ],
      "mountPoints": [
        { "sourceVolume": "onlyoffice-data", "containerPath": "/var/lib/onlyoffice" }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "/healthcheck.sh"],
        "interval": 30,
        "timeout": 30,
        "retries": 9,
        "startPeriod": 120
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/nextcloud-aio-onlyoffice",
          "awslogs-region": "ap-northeast-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ],
  "volumes": [
    {
      "name": "onlyoffice-data",
      "efsVolumeConfiguration": {
        "fileSystemId": "fs-xxxxxxxxx",
        "transitEncryption": "ENABLED",
        "authorizationConfig": { "accessPointId": "fsap-onlyoffice-data" }
      }
    }
  ]
}
```

> **注意**: Collabora は `CAP_SYS_ADMIN` / `SYS_CHROOT` を必要とするため Fargate では動作しない。ドキュメント編集機能には OnlyOffice を使用する。

---

## 7. ALB 構成

### 7.1 ALB 設定

```
スキーム:           internet-facing
リスナー:           HTTPS:443 (ACM 証明書)
SSL ポリシー:       ELBSecurityPolicy-TLS13-1-2-2021-06
ターゲットグループ:  Apache ECS Service (ポート 11000)
ヘルスチェック:      HTTP:11000/status.php
スティッキーセッション: 有効 (3600秒)
```

### 7.2 独自ドメイン + TLS 設定

`cdk.json` の context パラメータで設定する。Route 53 ホストゾーンを指定すると、ACM 証明書の発行・DNS 検証・Alias レコード作成が全て自動化される。

| 設定パターン | 動作 |
|---|---|
| `hostedZoneId` + `hostedZoneName` を指定 | ACM 証明書を自動発行 + DNS 検証 + Alias レコード作成 |
| `certificateArn` を指定 | 既存証明書を使用 + Alias レコード作成（ゾーン指定時） |
| どちらも未指定 | HTTP:80 で起動（TLS なし） |

```json
{
  "context": {
    "domain": "cloud.example.com",
    "hostedZoneId": "Z1234567890ABC",
    "hostedZoneName": "example.com"
  }
}
```

ホストゾーン ID の確認:

```bash
aws route53 list-hosted-zones --query 'HostedZones[?Name==`example.com.`].Id' --output text
```

### 7.3 Talk 用 NLB (オプション)

Talk の TURN サーバーは UDP を使用するため、NLB が必要:

```
スキーム:           internet-facing
リスナー:           TCP/UDP:3478
ターゲットグループ:  Talk ECS Service (ポート 3478)
```

---

## 8. ECS Service Auto Scaling

Kubernetes の HPA に相当する機能。

### 8.1 Nextcloud Service

```json
{
  "ServiceNamespace": "ecs",
  "ResourceId": "service/nextcloud-cluster/nextcloud-aio-nextcloud",
  "ScalableDimension": "ecs:service:DesiredCount",
  "MinCapacity": 2,
  "MaxCapacity": 10
}
```

スケーリングポリシー:

```json
{
  "PolicyName": "nextcloud-cpu-scaling",
  "PolicyType": "TargetTrackingScaling",
  "TargetTrackingScalingPolicyConfiguration": {
    "TargetValue": 70.0,
    "PredefinedMetricSpecification": {
      "PredefinedMetricType": "ECSServiceAverageCPUUtilization"
    },
    "ScaleInCooldown": 300,
    "ScaleOutCooldown": 60
  }
}
```

### 8.2 各 Service の推奨タスク数

| Service | 最小 | 最大 | Auto Scaling |
|---|---|---|---|
| Nextcloud | 2 | 10 | CPU 70% |
| Apache | 2 | 5 | CPU 70% |
| OnlyOffice | 1 | 3 | CPU 70% |
| Notify-push | 1 | 2 | - |
| Talk | 1 | 3 | CPU 70% |

---

## 9. 全文検索: Amazon OpenSearch Service

### 9.1 課題と解決策

Nextcloud の `fulltextsearch_elasticsearch` アプリは Basic 認証（`https://user:password@host:port`）で接続する。OpenSearch Service の Fine-Grained Access Control（FGAC）を使用することで、Basic 認証で直接接続できる。

```
Nextcloud (Basic Auth over HTTPS)
    │
    ▼ OpenSearch ドメインエンドポイント:443
OpenSearch Service (t3.small.search)
```

### 9.2 OpenSearch Service の構成

```
エンジン:              OpenSearch 2.17
インスタンスタイプ:      t3.small.search (2 vCPU, 2GB RAM)
データノード数:          1
EBS:                   gp3 20GB
暗号化:                ノード間暗号化 + 保存時暗号化
HTTPS:                 強制
認証:                  Fine-Grained Access Control (master user)
ネットワーク:           VPC (Isolated サブネット)
```

マスターユーザーのパスワードは Secrets Manager で管理される。

### 9.3 Nextcloud タスク定義の環境変数

SigV4 プロキシは不要。Nextcloud から OpenSearch Service に HTTPS + Basic 認証で直接接続する。

```json
{ "name": "FULLTEXTSEARCH_ENABLED",  "value": "yes" },
{ "name": "FULLTEXTSEARCH_HOST",     "value": "<OpenSearch ドメインエンドポイント>" },
{ "name": "FULLTEXTSEARCH_PORT",     "value": "443" },
{ "name": "FULLTEXTSEARCH_PROTOCOL", "value": "https" },
{ "name": "FULLTEXTSEARCH_USER",     "value": "admin" },
{ "name": "FULLTEXTSEARCH_PASSWORD", "value": "<Secrets Manager から注入>" },
{ "name": "FULLTEXTSEARCH_INDEX",    "value": "nextcloud-aio" }
```

`FULLTEXTSEARCH_PASSWORD` は ECS Secret として Secrets Manager から注入される。

### 9.4 セキュリティグループ

| リソース | インバウンド | ソース |
|---|---|---|
| OpenSearch Service | 443/tcp | ECS タスク SG |

### 9.5 スケーリング

負荷増加時は CDK のパラメータを変更して `cdk deploy` で対応する。

| 方法 | 操作 | ダウンタイム |
|---|---|---|
| スケールアップ | インスタンスタイプ変更 (t3.small → t3.medium → r6g.large) | なし (Blue/Green) |
| スケールアウト | データノード数を増加 (1 → 2 → 3) | なし |
| ストレージ拡張 | EBS サイズ変更 (20GB → 100GB) | なし |

---

## 10. ソースコード変更ファイル一覧

| ファイル | 変更種別 | 内容 |
|---|---|---|
| `Containers/nextcloud/config/redis.config.php` | 修正 | TLS 対応追加（セクション 4.1 参照） |
| `Containers/nextcloud/entrypoint.sh` | 修正 | syslog ログ出力対応（セクション 10.1 参照） |

上記 2 ファイルの変更を含む Nextcloud コンテナイメージのリビルドが必要。他のコンテナは公式イメージをそのまま使用可能。

### 10.1 entrypoint.sh のログ出力変更

複数 Fargate タスクから EFS 上の同一ログファイルへの同時書き込みを回避するため、`NEXTCLOUD_LOG_TYPE=syslog` 環境変数で syslog 出力に切り替え可能にする。syslog に出力されたログは Fargate の `awslogs` ドライバー経由で CloudWatch Logs に転送される。

Nextcloud タスク定義への環境変数追加:

```json
{ "name": "NEXTCLOUD_LOG_TYPE", "value": "syslog" }
```

`NEXTCLOUD_LOG_TYPE` が未設定の場合は従来通りファイル出力（後方互換性維持）。

---

## 11. AWS リソース作成手順

### 11.1 前提条件

- AWS CLI 設定済み
- VPC、サブネット作成済み
- ACM 証明書発行済み

### 11.2 作成順序

```
1. EFS ファイルシステム + アクセスポイント
2. Aurora Serverless v2 クラスター
3. ElastiCache Serverless (Valkey)
4. S3 バケット
5. OpenSearch Serverless コレクション + VPC エンドポイント (オプション)
6. Cloud Map 名前空間 (nextcloud.local)
7. ECS クラスター
8. タスク定義 (Nextcloud, Apache, オプションサービス)
9. ALB + ターゲットグループ
10. ECS Service (Nextcloud → Apache → オプションの順)
11. Auto Scaling 設定
12. Route 53 レコード (ALB の CNAME/Alias)
```

### 10.3 ECS クラスター作成

```bash
aws ecs create-cluster \
  --cluster-name nextcloud-cluster \
  --capacity-providers FARGATE \
  --default-capacity-provider-strategy capacityProvider=FARGATE,weight=1
```

### 10.4 Cloud Map 名前空間作成

```bash
aws servicediscovery create-private-dns-namespace \
  --name nextcloud.local \
  --vpc <vpc-id>
```

### 10.5 ECS Service 作成例 (Nextcloud)

```bash
aws ecs create-service \
  --cluster nextcloud-cluster \
  --service-name nextcloud-aio-nextcloud \
  --task-definition nextcloud-aio-nextcloud \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx,subnet-yyy],securityGroups=[sg-xxx],assignPublicIp=DISABLED}" \
  --service-registries "registryArn=<cloud-map-service-arn>,containerName=nextcloud,containerPort=9000"
```

---

## 12. CDK によるデプロイ

`cdk/` ディレクトリに AWS CDK (TypeScript) プロジェクトを用意している。

### 12.1 セットアップ

```bash
cd cdk
npm install
```

### 12.2 パラメータ設定

`cdk.json` の `context` を環境に合わせて編集する:

```json
{
  "context": {
    "domain": "cloud.example.com",
    "certificateArn": "arn:aws:acm:ap-northeast-1:123456789012:certificate/xxxxx",
    "hostedZoneId": "Z1234567890ABC",
    "hostedZoneName": "example.com",
    "aioImageTag": "20260218_123804",
    "nextcloudImageUri": "<ACCOUNT_ID>.dkr.ecr.ap-northeast-1.amazonaws.com/aio-nextcloud:custom",
    "apachePort": 11000,
    "enableOnlyOffice": "true",
    "enableTalk": "false",
    "enableFulltextsearch": "false",
    "enableImaginary": "false",
    "enableClamav": "false",
    "auroraMinAcu": 0.5,
    "auroraMaxAcu": 16
  }
}
```

| パラメータ | 説明 |
|---|---|
| `domain` | Nextcloud のドメイン名 |
| `certificateArn` | ACM 証明書の ARN（空の場合、`hostedZoneId` 指定時は自動発行） |
| `hostedZoneId` | Route 53 ホストゾーン ID（指定時は DNS レコード自動作成） |
| `hostedZoneName` | Route 53 ホストゾーン名（例: `example.com`） |
| `nextcloudImageUri` | カスタムビルドした Nextcloud イメージの URI（空の場合は公式イメージ） |
| `enableOnlyOffice` | OnlyOffice の有効化 |
| `enableFulltextsearch` | OpenSearch Service + 全文検索の有効化 |
| `auroraMinAcu` / `auroraMaxAcu` | Aurora Serverless v2 の ACU 範囲 |

### 12.3 デプロイ

```bash
npx cdk bootstrap   # 初回のみ
npx cdk deploy
```

### 12.4 作成されるリソース

- VPC (2 AZ, Public/Private/Isolated サブネット)
- EFS + アクセスポイント
- Aurora Serverless v2 (PostgreSQL)
- ElastiCache Serverless (Valkey)
- S3 バケット（Intelligent-Tiering + アクセスログバケット）
- OpenSearch Service ドメイン（enableFulltextsearch 時）
- ECS Fargate クラスター + Cloud Map 名前空間
- ECS Service: Nextcloud, Apache, Notify-push, OnlyOffice（オプション）
- ALB + HTTPS リスナー
- Auto Scaling (Nextcloud: 2-10, Apache: 2-5)
- ACM 証明書 + Route 53 Alias レコード（hostedZoneId 指定時）
- CloudWatch Alarms / Dashboard / ログメトリクスフィルター
- Step Functions ステートマシン（バージョンアップ自動化）
- CodePipeline + CodeBuild（CI/CD パイプライン）
- ECR リポジトリ（Nextcloud カスタムイメージ）

---

## 13. バージョンアップフロー

CDK に Step Functions ステートマシン (`nextcloud-upgrade`) を含めている。新しいコンテナイメージをビルド・プッシュした後、このステートマシンを実行するとバージョンアップが自動で行われる。

### 13.1 フロー

```
[1] ExtractExecutionId
    └── 実行名をスナップショット名に使用

[2] MaintenanceOn (run-task)
    └── php occ maintenance:mode --on
        EFS 上の config/config.php を更新 → 全タスクに即時反映

[3] WaitDrain (30秒)
    └── インフライトリクエストの排出待ち

[4] ScaleDownAll (並列)
    ├── Nextcloud → 0
    ├── Apache → 0
    └── Notify-push → 0

[5] WaitScaleDown (60秒)
    └── 全タスク停止待ち

[6] CreateSnapshot
    └── Aurora スナップショット取得

[7] BackupConfig (run-task)
    └── config/config.php を S3 にコピー

[8] ScaleUpNextcloudOne
    └── Nextcloud → 1 (新イメージで起動、entrypoint.sh がアップグレード実行)

[9] WaitUpgrade (180秒)
    └── DB マイグレーション完了待ち

[10] CheckHealth → IsHealthy
    └── RunningCount >= 1 になるまでポーリング

[11] ScaleUpAll (並列)
    ├── Nextcloud → 2
    ├── Apache → 2
    └── Notify-push → 1

[12] UpgradeSuccess

※ 失敗時は自動ロールバック:
    → 全サービスを元のスケールに復元
    → maintenance:mode --off
    → UpgradeFailed
```

### 13.2 CI/CD パイプライン

CDK に CodePipeline + CodeBuild を含めている。ビルドからアップグレードまで全自動で実行される。

```
GitHub (Fork リポジトリ)
    │ パイプライン手動実行 or Release タグ
    ▼
CodePipeline (nextcloud-deploy)
    │
    ├─► Source: GitHub からソース取得
    │
    └─► BuildAndDeploy (CodeBuild):
          1. ECR ログイン
          2. Docker ビルド (Containers/nextcloud/Dockerfile)
          3. ECR プッシュ (:commit-hash + :latest)
          4. ECS タスク定義を新イメージで更新
          5. Step Functions (nextcloud-upgrade) を実行
              → メンテナンスモード → 縮退 → バックアップ → アップグレード → スケールアップ
```

#### 事前準備

1. GitHub Personal Access Token を Secrets Manager に登録:

```bash
aws secretsmanager create-secret \
  --name github-token \
  --secret-string "<your-github-pat>"
```

2. `cdk.json` の GitHub 設定を確認:

```json
{
  "githubOwner": "ukaji3",
  "githubRepo": "nextcloud-all-in-one",
  "githubBranch": "main"
}
```

#### 実行方法

```bash
# パイプラインを手動実行
aws codepipeline start-pipeline-execution --name nextcloud-deploy
```

AWS コンソールの CodePipeline 画面から「変更をリリースする」でも実行可能。

#### 処理の流れ

1. CodeBuild が GitHub からソースを取得
2. `Containers/nextcloud/Dockerfile` でイメージをビルド
3. ECR にプッシュ（タグ: コミットハッシュ先頭8文字 + latest）
4. ECS タスク定義の新リビジョンを登録（イメージ URI を差し替え）
5. Step Functions `nextcloud-upgrade` を自動実行
6. Step Functions がメンテナンスモード → 縮退 → バックアップ → アップグレード → スケールアップを実行

### 13.3 ロールバック

ステートマシンが途中で失敗した場合、自動的に:
1. 全サービスを元のタスク数に復元
2. `maintenance:mode --off` を実行
3. ステートマシンが `Failed` 状態で終了

Aurora スナップショットからの DB 復元が必要な場合は手動で実施:

```bash
aws rds restore-db-cluster-from-snapshot \
  --db-cluster-identifier nextcloud-db-restored \
  --snapshot-identifier pre-upgrade-<execution-name> \
  --engine aurora-postgresql
```

### 13.4 メンテナンス操作の実行方法

バージョンアップ以外の `occ` コマンドも `run-task` で実行する:

```bash
# 例: ファイルスキャン
aws ecs run-task \
  --cluster nextcloud-cluster \
  --task-definition nextcloud-aio-nextcloud \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"nextcloud","command":["php","/var/www/html/occ","files:scan","--all"]}]}'
```

稼働中のタスクに `execute-command` で入るのではなく、常にワンショットタスクを使用する。

---

## 14. 運用監視

CDK スタックに以下の監視設定が含まれている。

### 14.1 ログ収集

| ソース | 出力先 | 保持期間 |
|---|---|---|
| ECS 全コンテナ (Nextcloud, Apache, Notify-push, OnlyOffice) | CloudWatch Logs (`EcsLogs`) | 30日 |
| 監査ログ (admin_audit: ファイルアクセス、ログイン等) | CloudWatch Logs (`AuditLogs`) | 365日 |
| VPC Flow Log | CloudWatch Logs (`VpcFlowLogGroup`) | 30日 |
| ALB アクセスログ | S3 (`AccessLogBucket/alb/`) | 無期限 |
| S3 DataBucket アクセスログ | S3 (`AccessLogBucket/data-bucket/`) | 無期限 |
| Step Functions 実行ログ | CloudWatch Logs (ALL レベル) | 30日 |

監査ログは ECS ログから `admin_audit` を含むエントリを Subscription Filter + Lambda で `AuditLogs` ロググループに転送している。CloudWatch Logs Insights で検索可能:

```
fields @timestamp, @message
| filter @message like /admin_audit/
| sort @timestamp desc
| limit 50
```

### 14.2 ログメトリクスフィルター

ECS ログから `ERROR` / `CRITICAL` / `Fatal` を含む行を抽出し、カスタムメトリクスとして発行する。

| メトリクス名 | 名前空間 | 内容 |
|---|---|---|
| `ErrorCount` | `Nextcloud` | アプリケーションエラーログの件数 |

### 14.3 Aurora モニタリング

| 機能 | 設定 |
|---|---|
| Performance Insights | 有効（7日間保持） |
| Enhanced Monitoring | 有効（60秒間隔） |
| IAM データベース認証 | 有効 |

### 14.4 CloudWatch Alarms

| アラーム | メトリクス | 条件 |
|---|---|---|
| NextcloudCpuAlarm | ECS Nextcloud CPU | > 80% が 15分継続 |
| NextcloudMemoryAlarm | ECS Nextcloud Memory | > 85% が 15分継続 |
| ApacheCpuAlarm | ECS Apache CPU | > 80% が 15分継続 |
| Alb5xxAlarm | ALB 5xx エラー数 | > 10回/5分 が 10分継続 |
| Target5xxAlarm | ターゲット 5xx エラー数 | > 10回/5分 が 10分継続 |
| ResponseTimeAlarm | ALB p95 レスポンスタイム | > 5秒 が 15分継続 |
| UnhealthyTargetsAlarm | ALB Unhealthy Host 数 | ≥ 1台 が 3分継続 |
| AuroraCpuAlarm | Aurora CPU 使用率 | > 80% が 15分継続 |
| AuroraCapacityAlarm | Aurora Serverless ACU | > 最大ACUの80% が 15分継続 |
| AuroraMemoryAlarm | Aurora 空きメモリ | < 256MB が 15分継続 |
| ErrorLogAlarm | アプリケーションエラーログ数 | > 50件/10分 |

> **注意**: アラームに SNS トピックは未設定。通知が必要な場合は SNS トピックを作成し、各アラームに `addAlarmAction()` で接続する。

### 14.5 CloudWatch Dashboard

ダッシュボード名: `Nextcloud-Monitoring`

| 行 | ウィジェット | 内容 |
|---|---|---|
| 1 | ECS CPU Utilization | Nextcloud / Apache / Notify-push の CPU 使用率 |
| 1 | ECS Memory Utilization | Nextcloud / Apache / Notify-push のメモリ使用率 |
| 2 | ALB Request Count & Errors | リクエスト数、5xx エラー数 |
| 2 | ALB Response Time | p50 / p95 / p99 レスポンスタイム |
| 3 | Aurora CPU & Capacity | CPU 使用率、Serverless ACU |
| 3 | Aurora Connections & Latency | 接続数、Read/Write レイテンシ |
| 4 | Application Error Logs | エラーログ件数の推移 |
| 4 | Running Tasks | ECS タスクの稼働状況 |

### 14.6 トレーシング

| リソース | 設定 |
|---|---|
| Step Functions | X-Ray トレース有効 |
| ECS Container Insights | CPU / メモリ / ネットワーク / ストレージメトリクス |

### 14.7 デバッグ

全 ECS Service で `enableExecuteCommand: true` が設定されている。稼働中のタスクに接続可能:

```bash
aws ecs execute-command \
  --cluster NextcloudAioStack-Cluster \
  --task <task-id> \
  --container nextcloud \
  --interactive \
  --command "/bin/bash"
```

---

## 15. Collabora に関する制約事項

Fargate は以下の Linux Capability の追加をサポートしていない:

- `CAP_SYS_ADMIN` — Collabora がプロセスのサンドボックス化（mount namespace）に使用
- `SYS_CHROOT` — Collabora がプロセスのルートディレクトリ隔離に使用

Fargate で追加可能な Capability は `SYS_PTRACE` のみ。

### 代替案

| 方法 | 説明 |
|---|---|
| OnlyOffice を使用（推奨） | 特権 Capability 不要。`ONLYOFFICE_ENABLED=yes` で切り替え |
| Collabora を EC2 で稼働 | ECS Service を EC2 起動タイプで作成し、Fargate の Nextcloud から接続 |
| Collabora クラウドサービス | Nextcloud Office アプリから外部 Collabora サーバーを指定 |
