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
