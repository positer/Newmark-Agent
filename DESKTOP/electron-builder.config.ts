import type { Configuration } from 'electron-builder';

const config: Configuration = {
  appId: 'ai.newmark.agent',
  productName: 'Newmark Agent',
  copyright: 'Copyright © 2025 Newmark AI',
  directories: {
    output: '../release',
    buildResources: 'assets',
  },
  files: [
    'dist/**/*',
    'assets/**/*',
    'package.json',
  ],
  extraResources: [
    { from: 'node_modules', to: 'node_modules', filter: ['**/*'] },
  ],
  win: {
    icon: null,
    target: [
      { target: 'portable', arch: ['x64'] },
      { target: 'nsis', arch: ['x64'] },
    ],
    artifactName: 'Newmark-Agent-${version}-${arch}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
  },
  portable: {
    splashImage: null,
    artifactName: 'Newmark-Agent-${version}-portable-${arch}.exe',
  },
  linux: {
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
