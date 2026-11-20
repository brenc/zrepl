import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: ['soak.ts', 'testpool.ts', 'vm.ts'],
  ignoreDependencies: ['@socketsecurity/bun-security-scanner'],
  project: ['**/*.ts'],
};

export default config;
