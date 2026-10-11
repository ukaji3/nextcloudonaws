# Nextcloud AIO - AWS ECS Fargate デプロイメントガイド

Nextcloud AIO のコンテナイメージを AWS ECS Fargate 上でデプロイするためのガイド。
マネージドサービス（Aurora Serverless v2、ElastiCache Serverless for Valkey、S3）を活用し、スケーラブルな構成を実現する。

## アーキテクチャ

```
クライアント → Route 53 → ALB (TLS終端, ACM証明書)
                              │
                              ├─► [ECS Service] Apache (Caddy)
                              │       ├─► [ECS Service] Nextcloud PHP-FPM
                              │       ├─► [ECS Service] Notify-push (※無効)
                              │       ├─► [ECS Service] OnlyOffice (オプション)
                              │       ├─► [ECS Service] Talk (オプション)
                              │       └─► [ECS Service] Imaginary (オプション)
                              │
                              ├──► Aurora Serverless v2 (PostgreSQL 16.4)
                              ├──► ElastiCache Serverless (Valkey)
                              ├──► Amazon S3 (Intelligent-Tiering)
                              ├──► Amazon OpenSearch Service (全文検索、オプション)
                              └──► Amazon EFS (共有ボリューム)
```

### 設計方針

- **CloudFront は使用しない** — Nextcloud は WebDAV プロトコル（PROPFIND, MKCOL, MOVE, LOCK 等）を使用するが、CloudFront はこれらの HTTP メソッドをサポートしていない
- **Collabora は使用しない** — `CAP_SYS_ADMIN` / `SYS_CHROOT` が必要だが Fargate は非対応。代わりに OnlyOffice を使用する
- **notify_push は Nextcloud の config.php を共有して動く** — notify-push コンテナは `/var/www/html`（EFS）を読み取り専用でマウントし、DB と Redis（クラスタモード・TLS）の設定を config.php から読む。資格情報は環境変数で渡さない
- **DB/Redis/ファイルストレージは全て AWS マネージドサービスに外部化** — コンテナをステートレスにし、水平スケーリングを可能にする
- **シークレットは Secrets Manager で管理** — DB パスワード、OpenSearch パスワード、OnlyOffice JWT シークレット等は全て Secrets Manager に格納し、ECS タスク定義から参照する

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

Nextcloud の `fulltextsearch_elasticsearch` アプリは Elasticsearch PHP クライアントを使用するが、OpenSearch との間に以下の互換性問題がある。entrypoint.sh で起動時に自動パッチを適用して解決している。

| 問題 | 原因 | パッチ |
|---|---|---|
| `ProductCheckException` | クライアントが `X-Elastic-Product` ヘッダーを検証し、OpenSearch を拒否 | `ProductCheckTrait.php` の throw 前に return を挿入 |
| `406 Not Acceptable` | クライアントが `Content-Type: application/vnd.elasticsearch+json; compatible-with=9` を送信、OpenSearch が非対応 | `EndpointTrait.php` の `buildCompatibilityHeaders` を無効化 |
| 検索結果0件 | ハイライトの `max_analyzed_offset` パラメータが OpenSearch では `max_analyzer_offset` | sed で一括置換 |

### 9.2 OpenSearch Service の構成

```
エンジン:              OpenSearch 2.17
インスタンスタイプ:      t3.medium.search (2 vCPU, 4GB RAM)
データノード数:          2 (Zone Awareness 有効)
暗号化:                ノード間暗号化 + 保存時暗号化
HTTPS:                 強制
認証:                  Fine-Grained Access Control (master user)
ネットワーク:           VPC (Private サブネット)
```

> **注意**: `t3.small.search` (JVM ヒープ 1GB) では GC オーバーヘッドでクラスタがダウンする。`t3.medium.search` 以上を推奨。

マスターユーザーのパスワードは Secrets Manager で管理される。パスワードには URL 安全な文字のみを使用する（`excludeCharacters: '&<>"\'/\\@#%{}|^~\`[]'`）。

### 9.3 Nextcloud タスク定義の環境変数

```json
{ "name": "FULLTEXTSEARCH_ENABLED",  "value": "yes" },
{ "name": "FULLTEXTSEARCH_HOST",     "value": "<OpenSearch ドメインエンドポイント>" },
{ "name": "FULLTEXTSEARCH_PORT",     "value": "443" },
{ "name": "FULLTEXTSEARCH_PROTOCOL", "value": "https" },
{ "name": "FULLTEXTSEARCH_USER",     "value": "admin" },
{ "name": "FULLTEXTSEARCH_PASSWORD", "valueFrom": "<Secrets Manager ARN>:password::" },
{ "name": "FULLTEXTSEARCH_INDEX",    "value": "nextcloud-aio" }
```

`FULLTEXTSEARCH_PASSWORD` は ECS Secret として Secrets Manager から注入される。

### 9.4 セキュリティグループ

| リソース | インバウンド | ソース |
|---|---|---|
| OpenSearch Service | 443/tcp | ECS タスク SG |

### 9.5 全文検索の利用方法

- **Unified Search（ヘッダーバーの虫眼鏡アイコン）** から検索すると、ファイル内容を含む全文検索結果が表示される
- Files アプリ内の検索バーはファイル名検索のみ（DAV SEARCH）で、全文検索は使用されない
- PDF、Office ドキュメント、Markdown、テキストファイルの内容がインデックスされる

### 9.6 スケーリング

| 方法 | 操作 | ダウンタイム |
|---|---|---|
| スケールアップ | インスタンスタイプ変更 (t3.medium → r6g.large) | なし (Blue/Green) |
| スケールアウト | データノード数を増加 (2 → 3) | なし |
| ストレージ拡張 | EBS サイズ変更 | なし |

---

## 10. ソースコード変更ファイル一覧

| ファイル | 変更種別 | 内容 |
|---|---|---|
| `containers/nextcloud/config/redis.config.php` | 修正 | ElastiCache Serverless 用 TLS + RedisCluster 対応（セクション 4.1 参照） |
| `containers/nextcloud/entrypoint.sh` | 修正 | 下記の変更を含む |
| `containers/nextcloud/aws-custom-apps-repair.sh` | 追加 | custom_apps 入れ子ディレクトリの修復ライブラリ（10.2 参照） |
| `containers/nextcloud/tests/test-aws-custom-apps-repair.sh` | 追加 | 上記ライブラリのテスト（`bash containers/nextcloud/tests/test-aws-custom-apps-repair.sh`） |
| `containers/nextcloud/Dockerfile` | 修正 | aws-cli 追加、`clear_env = no`、diag.php の COPY（upstream AIO main に同期済み。PHP 8.4 / dinit / su-exec） |
| `containers/nextcloud/aws-healthcheck.sh` | 追加 | ECS 用ヘルスチェック（15 章参照、テスト: `tests/test-aws-healthcheck.sh`） |

### 10.1 entrypoint.sh の変更内容

| 変更 | 理由 |
|---|---|
| `redis-session.ini` の削除 | ElastiCache Serverless (TLS/クラスタモード) と非互換な `session.save_handler=redis` 設定を除去。セッションはファイルベースに変更 |
| `redis.config.php` の保持 | 環境変数から Redis 設定を自動構成するファイル。誤削除を防止 |
| custom_apps 入れ子修復（3箇所） | 10.2 参照。Imaginary ブロック後・全文検索アプリ更新後・スクリプト末尾で実行し、修復した場合は `occ upgrade` も実行 |
| `fulltextsearch_elasticsearch:configure` の出力抑止 | 出力に `elastic_host`（OpenSearch の admin パスワードを含む）が出るため、CloudWatch Logs には成否のみ出力 |
| OpenSearch 互換パッチ (ProductCheckTrait) | `X-Elastic-Product` ヘッダーチェックをスキップ |
| OpenSearch 互換パッチ (EndpointTrait) | 互換ヘッダー付与（`vnd.elasticsearch+json`）の呼び出し行を無効化。適用できない場合は WARNING を出力 |
| OpenSearch 互換パッチ (max_analyzed_offset) | ハイライトフィールド名を OpenSearch 互換に置換 |
| ログ出力対応 (`NEXTCLOUD_LOG_TYPE`) | `errorlog` 指定で PHP stderr に出力 → CloudWatch Logs に転送 |

### 10.2 custom_apps 入れ子ディレクトリ問題

Nextcloud のアプリ更新処理（`lib/private/Installer.php`）は旧ディレクトリを `\OCP\Files::rmdirr()` で削除してから新版をコピーする。EFS (NFSv4.1) 上ではこの削除がファイルを1つ取りこぼすことがあり（実機で再現確認済み）、削除失敗が無視された結果 `custom_apps/<app>/<app>/appinfo/info.xml` という入れ子構造になる。この状態ではアプリが認識されず（`Could not find <app>`）、全文検索などが黙って停止する。

`aws-custom-apps-repair.sh` は次の手順で修復する:

1. `appinfo/info.xml` が無く、`<app>/<app>/appinfo/info.xml` があるディレクトリを検出
2. 内側のアプリを退避 → 壊れた外側ディレクトリを rename で脇へ移動 → 内側を正位置へ移動（rename のみのため、削除に失敗してもアプリは失われない）
3. 脇へ移した残骸を再試行付きで削除（残った場合は次回起動時に再削除）
4. 自動無効化されていたアプリを再有効化

正常なアプリには触れないため、何度実行しても結果は同じ（冪等）。

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
    "certificateArn": "",
    "hostedZoneId": "Z1234567890ABC",
    "hostedZoneName": "example.com",
    "aioImageTag": "20260929_105435",
    "nextcloudImageUri": "<ACCOUNT_ID>.dkr.ecr.ap-northeast-1.amazonaws.com/aio-nextcloud:nc34.0.4-<timestamp>",
    "apachePort": 11000,
    "enableOnlyOffice": "true",
    "enableTalk": "true",
    "enableFulltextsearch": "true",
    "enableImaginary": "true",
    "enableClamav": "false",
    "auroraMinAcu": 0.5,
    "auroraMaxAcu": 16,
    "alarmEmails": "ops@example.com",
    "auroraBackupRetentionDays": 7,
    "backupDailyRetentionDays": 35,
    "backupWeeklyRetentionDays": 90,
    "ecrScanRepositories": "aio-nextcloud",
    "githubOwner": "<your-github-user>",
    "githubRepo": "nextcloudonaws",
    "githubBranch": "main"
  }
}
```

| パラメータ | 説明 |
|---|---|
| `domain` | Nextcloud のドメイン名 |
| `certificateArn` | ACM 証明書の ARN（空の場合、`hostedZoneId` 指定時は自動発行） |
| `hostedZoneId` | Route 53 ホストゾーン ID（指定時は DNS レコード自動作成） |
| `hostedZoneName` | Route 53 ホストゾーン名（例: `example.com`） |
| `aioImageTag` | AIO イメージ（apache / onlyoffice / imaginary / talk）のタグ |
| `aioNotifyPushImageTag` | notify-push イメージのタグ（省略時は `aioImageTag` と同じ）。notify-push だけ別の版に固定したい場合に使う |
| `nextcloudImageUri` | カスタムビルドした Nextcloud イメージの URI（空の場合は公式イメージ） |
| `enableOnlyOffice` | OnlyOffice の有効化 |
| `enableTalk` | Talk (TURN/シグナリング) の有効化 |
| `enableFulltextsearch` | OpenSearch Service + 全文検索の有効化 |
| `enableImaginary` | Imaginary (画像処理) の有効化 |
| `auroraMinAcu` / `auroraMaxAcu` | Aurora Serverless v2 の ACU 範囲 |
| `alarmEmails` | アラーム通知先のメールアドレス（カンマ区切り）。空なら購読なしで SNS トピックだけ作成。購読は各アドレスに届く確認メールで有効化される |
| `auroraBackupRetentionDays` | Aurora 自動バックアップ（PITR）の保持日数（既定 7） |
| `backupDailyRetentionDays` / `backupWeeklyRetentionDays` | AWS Backup の日次 / 週次リカバリポイントの保持日数（既定 35 / 90） |
| `ecrScanRepositories` | プッシュ時に脆弱性スキャンする ECR リポジトリ名（カンマ区切り、既定 `aio-nextcloud`）。レジストリスキャン設定はアカウント・リージョンで1つのため、同じ環境の他スタックでは定義しないこと |
| `githubOwner` / `githubRepo` / `githubBranch` | CI/CD パイプラインのソースリポジトリ（パイプラインは現在未作成） |

### 12.3 デプロイ

```bash
npx cdk bootstrap   # 初回のみ
npm run lint        # ESLint（エラー 0 必須）
npx tsc --noEmit    # 型チェック
npm test            # jest（CloudFormation テンプレートの回帰テスト）
npx cdk diff        # 変更内容の確認（データ系リソースの replace が無いこと）
npx cdk deploy
```

コンテナ側の修復ロジックのテスト:

```bash
bash containers/nextcloud/tests/test-aws-custom-apps-repair.sh
```

### 12.4 作成されるリソース

- VPC (2 AZ, Public/Private/Isolated サブネット)
- EFS + アクセスポイント
- Aurora Serverless v2 (PostgreSQL、自動バックアップ 7 日)
- ElastiCache Serverless (Valkey)
- S3 バケット（Intelligent-Tiering + バージョニング + アクセスログバケット）
- OpenSearch Service ドメイン（enableFulltextsearch 時）
- ECS Fargate クラスター + Cloud Map 名前空間
- ECS Service: Nextcloud, Apache, Notify-push, OnlyOffice / Imaginary / Talk（オプション）
- ALB + HTTPS リスナー
- Auto Scaling (Nextcloud: 1-10, Apache: 2-5)
- ACM 証明書 + Route 53 Alias レコード（hostedZoneId 指定時）
- CloudWatch Alarms / Dashboard / ログメトリクスフィルター
- SNS トピック（KMS 暗号化、アラーム通知用）
- AWS Backup（KMS 暗号化 Vault、日次・週次プラン、対象 EFS + Aurora）
- ECR レジストリスキャン設定（プッシュ時スキャン）
- Step Functions ステートマシン（バージョンアップ自動化）+ SQS 承認キュー

ECR リポジトリ `aio-nextcloud` はスタック外で作成済みのものを使う（スタックでは作成しない）。

### 12.5 CDK コードの構成

| ファイル | 内容 |
|---|---|
| `lib/cdk-stack.ts` | スタック本体（各ビルダーを呼び出して組み立てるだけ） |
| `lib/stack/config.ts` | context の型付き読み取り |
| `lib/stack/network.ts` / `storage.ts` / `database.ts` | VPC・SG / EFS・S3 / Aurora・ElastiCache |
| `lib/stack/feature-secrets.ts` | オプション機能のシークレットと OpenSearch |
| `lib/stack/iam-and-logging.ts` | タスクロール・実行ロール・ログ・監査ログ転送 |
| `lib/stack/nextcloud-task.ts` / `web-tier.ts` | Nextcloud タスク定義 / Apache・notify-push・OnlyOffice・Imaginary・Talk |
| `lib/stack/load-balancer.ts` | ALB・証明書・DNS |
| `lib/stack/upgrade-state-machine.ts` | アップグレード用 Step Functions |
| `lib/stack/monitoring.ts` | アラーム・ダッシュボード |
| `lib/stack/nag-suppressions.ts` | cdk-nag の抑止（理由付き） |
| `lib/constructs/` | AlarmNotifications / DataBackup / ImageScanning |

ビルダーはすべてスタックを scope に取るため、CloudFormation の論理 ID は分割前と同じ。

---

## 13. バージョンアップフロー

CDK に Step Functions ステートマシン `nextcloud-upgrade` を含めている。メンテナンスモード・サービス縮退・Aurora スナップショット・config.php バックアップは自動で行い、新イメージの反映（`cdk deploy`）だけを operator が行う 2 フェーズ方式。operator はタスクトークンで処理を再開する。

### 13.1 フロー

```
[Phase 1: 準備（自動）]
  ExtractExecutionId     実行名をスナップショット名に使用
  MaintenanceOn          one-off タスクで occ maintenance:mode --on（ExitCode 検査）
  ScaleDownAll           Nextcloud / Apache / Notify-push → 0
  CheckTasksStopped      RunningCount = 0 になるまで 15 秒間隔でポーリング
  CreateSnapshot         Aurora スナップショット pre-upgrade-<実行名>
  CheckSnapshotStatus    available になるまで 30 秒間隔でポーリング
  BackupConfig           config.php を EFS（/mnt/ncdata）と S3 にコピー
  WaitForDeploy          SQS にタスクトークンを送って待機（最大 3 時間）

[operator]
  cdk.json の nextcloudImageUri を更新 → npx cdk deploy（台数 0 のままタスク定義だけ切り替わる）
  → deploy 完了後すぐ aws stepfunctions send-task-success でトークンを返す

[Phase 2: 起動・検証・復帰（自動）]
  RestoreBaseline        desired count を基準値に戻す → 新リビジョンのタスクだけが起動し、
                         entrypoint.sh が occ upgrade を実行
  CheckTargetsHealthy    ALB ターゲットが healthy になるまで 20 秒間隔でポーリング
                         （php-fpm は entrypoint.sh の完了後に起動するので、healthy ＝ アップグレード完了）
  VerifyUpgrade          occ status（ExitCode 検査）
  MaintenanceOffFinal    occ maintenance:mode --off
  UpgradeSucceeded

※ どのステップで失敗しても RollbackScaleUp → MaintenanceOffRollback → UpgradeFailed
```

### 13.2 実行手順

```bash
# 1. イメージをビルドして ECR にプッシュ（プッシュ時に脆弱性スキャンが走る）
aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker build -t <account>.dkr.ecr.<region>.amazonaws.com/aio-nextcloud:<tag> -f containers/nextcloud/Dockerfile .
docker push <account>.dkr.ecr.<region>.amazonaws.com/aio-nextcloud:<tag>
aws ecr describe-image-scan-findings --repository-name aio-nextcloud --image-id imageTag=<tag>

# 2. ステートマシンを起動
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:<region>:<account>:stateMachine:nextcloud-upgrade \
  --name upgrade-<version>-<yyyymmddhhmm>

# 3. WaitForDeploy に到達したらタスクトークンを受け取る（スタック出力 UpgradeQueueUrl）
aws sqs receive-message --queue-url <UpgradeQueueUrl> --wait-time-seconds 20

# 4. cdk.json の nextcloudImageUri を <tag> に更新してデプロイ（台数 0 のまま、タスクは起動しない）
cd cdk && npx cdk diff && npx cdk deploy

# 5. deploy が終わったらすぐ再開（以降のタスク起動・アップグレード完了待ちはステートマシンが行う）
aws stepfunctions send-task-success --task-token '<taskToken>' --task-output '{}'

# 中止する場合
aws stepfunctions send-task-failure --task-token '<taskToken>'
```

所要時間の目安（2026-10-11 実績）: 33.0.7 → 33.0.9 で約 57 分、33.0.9 → 34.0.4（メジャー更新）で約 65 分。Phase 1 が約 15 分、新タスクの起動とアップグレード（rsync・`occ upgrade` 2 回・code integrity check）が約 30 分。この間サービスは停止する。

メジャー更新前には AWS Backup のオンデマンドバックアップ（EFS と Aurora）も取っておく。また、メジャー更新では entrypoint.sh がアプリを一旦無効化し、更新後に元へ戻す。戻せなかったアプリは管理者に通知されるので、完了後に `occ app:list` で確認する。

### 13.3 ロールバック

ステートマシンが途中で失敗した場合、自動的に:
1. 全サービスを元のタスク数に復元
2. `maintenance:mode --off` を実行
3. ステートマシンが `Failed` 状態で終了

このロールバックはベストエフォート。新イメージのデプロイ後に失敗した場合、EFS 上の Nextcloud コードは新版に置き換わっているため、タスク数を戻しても旧版には戻らない。旧版へ戻すには、`nextcloudImageUri` を旧タグに戻したうえで DB と EFS を復元する。

Aurora スナップショットからの DB 復元:

```bash
aws rds restore-db-cluster-from-snapshot \
  --db-cluster-identifier nextcloud-db-restored \
  --snapshot-identifier pre-upgrade-<execution-name> \
  --engine aurora-postgresql
```

EFS（config.php・アプリ）は AWS Backup の復旧ポイント（14.4.1）から復元する。config.php だけなら `/mnt/ncdata/config.php.backup.<timestamp>` または `s3://<DataBucket>/backups/` にもある。

### 13.4 メンテナンス操作の実行方法

バージョンアップ以外の `occ` コマンドも `run-task` で実行する。occ は config.php の所有者（www-data）で実行する:

```bash
# 例: ファイルスキャン
aws ecs run-task \
  --cluster <Cluster> \
  --task-definition <NextcloudTd family> \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"nextcloud","command":["su-exec","www-data","php","/var/www/html/occ","files:scan","--all"]}]}'
```

`command` の上書きで置き換わるのは CMD だけで、ENTRYPOINT の `/start.sh` は残る。そのためワンショットタスクでも entrypoint.sh（初期化・アプリ更新・修復）が先に一通り実行され、その後に指定コマンドが動く。調査目的の読み取り操作は、稼働中タスクへの `execute-command`（15 章の TTY 割り当て方法を参照）の方が速い。

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

全アラームは ALARM と OK の遷移を SNS トピック（KMS 暗号化）に通知する。通知先は context `alarmEmails` で指定し、各アドレスに届く確認メールで購読が有効になる。

欠損データの扱い（TreatMissingData）はアラームごとに明示している:

| 扱い | 対象 | 理由 |
|---|---|---|
| `notBreaching` | Alb5xx / Target5xx / ResponseTime / UnhealthyTargets / ErrorLog | アクセスが無いとデータポイント自体が出ない。以前は ResponseTime が OK と INSUFFICIENT_DATA を1日に十数回行き来していた |
| `missing` | ECS / Aurora の CPU・メモリ・容量 | 稼働中は常に出るため、欠損は異常として扱う |

### 14.4.1 バックアップ

| 対象 | 方式 | 保持 |
|---|---|---|
| Aurora | 自動バックアップ（PITR） | `auroraBackupRetentionDays`（既定 7 日） |
| Aurora + EFS | AWS Backup（日次 03:00 JST） | `backupDailyRetentionDays`（既定 35 日） |
| Aurora + EFS | AWS Backup（週次 日曜 03:00 JST） | `backupWeeklyRetentionDays`（既定 90 日） |
| S3 | バージョニング | 無期限（旧バージョンも Intelligent-Tiering） |
| config.php | アップグレード時に EFS と S3 へコピー | 無期限 |

Backup Vault と暗号化キーはスタック削除時も保持される（RETAIN）。

### 14.4.2 イメージの脆弱性スキャン

ECR のレジストリスキャン（BASIC、プッシュ時）を `ecrScanRepositories` のリポジトリに適用する。結果は `aws ecr describe-image-scan-findings` で確認する。

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

## 15. 既知の制約事項

| 制約 | 影響 | 回避策 |
|---|---|---|
| notify_push と trusted proxy | push server は公開 URL 経由で Nextcloud に接続するため、Nextcloud には送信元として NAT Gateway の EIP が見える | CDK が NAT Gateway の EIP を `AWS_TRUSTED_PROXIES` で渡し、entrypoint.sh が `trusted_proxies` の 20〜29 番に毎回書き直す（`aws-trusted-proxies.sh`、テスト: `tests/test-aws-trusted-proxies.sh`）。NAT Gateway を作り直しても古い IP は残らない |
| Nextcloud コンテナのヘルスチェック | `aws-healthcheck.sh` は php-fpm が待受を始めた時点で正常とする。インストール・アップグレード中（メンテナンスモード、`occ upgrade` / rsync 実行中）も正常扱いにして、途中で入れ替えられないようにしている。起動に時間がかかっても、新タスクが正常になるまで旧タスクが応答を続ける（2026-10-11 の検証で 10 秒間隔の監視 84 回中 83 回 200） | アップグレードを伴うイメージ更新は引き続き 13 章の手順で行う |
| アプリ更新で custom_apps が入れ子になる | 該当アプリが認識されず停止する | entrypoint.sh が起動時に自動修復する（10.2 参照） |
| Collabora 非対応 | ドキュメント編集に Collabora を使用できない | OnlyOffice を使用 |
| `ecs execute-command` の出力制限 | 擬似 TTY が無いと出力が取れない | `script -qec "aws ecs execute-command ... --interactive --command '...'" /dev/null` で TTY を割り当てる |
| mail アプリ | vendor ディレクトリが欠損しインストール不可 | `occ app:install mail` で再インストール |

## 16. Collabora に関する制約事項

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
