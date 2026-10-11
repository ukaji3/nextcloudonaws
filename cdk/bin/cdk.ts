#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { NextcloudAioStack } from '../lib/cdk-stack';

const app = new cdk.App();
// An empty CDK_DEFAULT_REGION also falls back to Tokyo.
const envRegion = process.env.CDK_DEFAULT_REGION;
new NextcloudAioStack(app, 'NextcloudAioStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: envRegion !== undefined && envRegion !== '' ? envRegion : 'ap-northeast-1',
  },
});
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
