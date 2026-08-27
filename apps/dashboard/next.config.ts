import type { NextConfig } from 'next';

const config: NextConfig = {
  agentRules: false,
  transpilePackages: ['@acm/hosted-evaluation'],
};

export default config;
