/**
 * web-ext config for Firefox build.
 * Excludes dev/build artifacts that can trigger "appears to be corrupt" on install.
 * @see https://extensionworkshop.com/documentation/develop/web-ext-command-reference/
 */
module.exports = {
  ignoreFiles: [
    '**/*.pem',
    '**/*.crx',
    'package.json',
    'package-lock.json',
    'create-icons.html',
    'generate-icons.js',
    'README.md',
    '**/*.webp',
    'icons/README.txt',
    'web-ext-artifacts',
    'web-ext-artifacts/**',
    '.git',
    '.gitignore',
    'web-ext-config.cjs',
    'manifest.firefox.json',
    '.manifest.chrome.bak',
  ],
};
