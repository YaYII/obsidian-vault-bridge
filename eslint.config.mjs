import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

/**
 * 使用 Obsidian 官方的推荐配置。
 *
 * 它把 ESLint core、typescript-eslint 的类型感知规则与 Obsidian 专有规则
 * （no-unsupported-api / no-manual-html-headings / prefer-create-el 等）打包在一起，
 * 正是社区目录审核所依据的那一套，因此本地就能提前暴露审核会挑出的问题。
 *
 * parserOptions.projectService 是必需的：类型感知规则需要 TypeScript 工程信息，
 * allowDefaultProject 让不属于 tsconfig 的文件（配置自身、开发脚本）也能被检查。
 */
export default defineConfig([
  {
    ignores: ['main.js', 'node_modules/**', '.code-review/**', 'coverage/**', 'vault-bridge-plugin.zip'],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs', 'esbuild.config.mjs', 'tools/*.mjs'],
        },
      },
    },
    rules: {
      // 本插件界面为中文。该规则面向英文文案，实测会把 URL 当成普通单词改写
      // （http:// → HTTP://），对中文项目产生的全是噪音，故关闭。
      'obsidianmd/ui/sentence-case': 'off',
    },
  },
  {
    // Node 侧代码：服务端运行在 Electron renderer（具备 Node 能力）。
    // 这些文件只在桌面端执行，移动端不会走到，见 src/server/node-modules.ts。
    files: ['src/server/**/*.ts', 'tools/**/*.mjs', 'tests/**/*.ts'],
    languageOptions: {
      globals: {
        require: 'readonly',
        Buffer: 'readonly',
        NodeJS: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
]);
