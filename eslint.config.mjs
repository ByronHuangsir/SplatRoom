import playcanvasConfig from '@playcanvas/eslint-config';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
    ...playcanvasConfig,
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsParser,
            globals: {
                ...globals.browser,
                ...globals.serviceworker,
                BlobPart: 'readonly'
            }
        },
        plugins: {
            '@typescript-eslint': tsPlugin
        },
        settings: {
            'import/resolver': {
                typescript: {}
            }
        },
        rules: {
            ...tsPlugin.configs.recommended.rules,
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            // 项目大量使用"延迟闭包"模式：回调/事件处理器内引用文件后文声明的
            // const（注册时并不执行，运行时才调用），no-use-before-define 无法
            // 识别这种模式，会产生大量误报。未定义检查由 tsc 负责。
            'no-use-before-define': 'off',
            // TS 项目：未定义标识符由 TypeScript 编译器检查（typescript-eslint 官方推荐）
            'no-undef': 'off',
            // 允许 `void expr;` 作为语句（有意忽略 promise 返回值），仍禁止其它用法
            'no-void': ['error', { allowAsStatement: true }],
            // 项目风格统一为 getter 在前、setter 在后
            'grouped-accessor-pairs': ['error', 'anyOrder'],
            'jsdoc/require-param': 'off',
            'jsdoc/require-param-type': 'off',
            'jsdoc/require-returns': 'off',
            'jsdoc/require-returns-type': 'off',
            'jsdoc/check-tag-names': 'off',
            'lines-between-class-members': 'off',
            'no-await-in-loop': 'off',
            'require-atomic-updates': 'off'
        }
    }, {
        files: ['**/*.mjs'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        rules: {
            'import/no-unresolved': 'off'
        }
    }
];
