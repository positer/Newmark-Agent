import type { Configuration } from 'electron-builder';

const config: Configuration = {
  afterPack: 'scripts/after-pack-win-icon.cjs',
  appId: 'ai.newmark.agent',
  productName: 'Newmark Agent',
  executableName: 'Newmark Agent',
  copyright: 'Copyright © 2025 Newmark AI',
  extraMetadata: {
    productName: 'Newmark Agent',
    homepage: 'https://github.com/positer/Newmark-Agent',
    author: {
      name: 'Newmark AI',
      email: 'support@newmark.ai',
    },
  },
  directories: {
    output: '../release',
    buildResources: 'assets',
  },
  files: [
    'dist/**/*',
    'assets/**/*',
    'config.example.json',
    'package.json',
  ],
  asarUnpack: [
    'dist/wsl-agent-host.bundle.cjs',
    'node_modules/node-pty/**/*',
  ],
  extraFiles: [
    { from: '../LICENSE', to: 'LICENSE' },
    { from: '../THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
    { from: 'Flow', to: 'Flow', filter: ['**/*'] },
  ],
  win: {
    icon: 'assets/icon.ico',
    sign: false,
    signAndEditExecutable: false,
    target: [{ target: 'msi', arch: ['x64'] }],
    artifactName: 'Newmark-Agent-${version}-${arch}.${ext}',
  },
  msi: {
    oneClick: false,
    perMachine: true,
    runAfterFinish: false,
    warningsAsErrors: false,
    artifactName: 'Newmark-Agent-${version}-${arch}.${ext}',
  },
  msiProjectCreated: './scripts/patch-msi-project.cjs',
  linux: {
    icon: 'assets/app-icon-dark.png',
    maintainer: 'Newmark AI <support@newmark.ai>',
    target: ['AppImage', 'deb'],
    category: 'Development',
    artifactName: 'Newmark-Agent-${version}-${arch}.${ext}',
  },
  mac: {
    target: ['dmg'],
    category: 'public.app-category.developer-tools',
    artifactName: 'Newmark-Agent-${version}-${arch}.${ext}',
  },
};

export default config;
