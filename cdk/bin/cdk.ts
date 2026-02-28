#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NextcloudAioStack } from '../lib/cdk-stack';

const app = new cdk.App();
new NextcloudAioStack(app, 'NextcloudAioStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  },
});
