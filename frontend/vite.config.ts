import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import VueRouter from 'vue-router/vite'
import { VueRouterAutoImports } from 'vue-router/unplugin'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import Icons from 'unplugin-icons/vite'
import IconsResolver from 'unplugin-icons/resolver'
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers'
import vueDevTools from 'vite-plugin-vue-devtools'
import tailwindcss from '@tailwindcss/vite'
import ideByebye from 'ide-byebye'
import { authCallbackMessages } from './src/locales/auth-callback.ts'

// 开发服务器把 /api 转发到后端，使浏览器侧保持同源。
// local 模式的后端只放行自身端口的 CORS 来源，缺少该代理时前端无法自动完成服务探测。
// 可用 LINGUAFLOW_API_TARGET 覆盖后端地址。
const apiProxyTarget = process.env.LINGUAFLOW_API_TARGET ?? 'http://127.0.0.1:18080'

// Vite 默认只放行 localhost 与 IP 直连（防 DNS rebinding）。
// 经 SSH 端口转发用自定义主机名访问时，用 LINGUAFLOW_DEV_HOSTS 放行，逗号分隔。
const devAllowedHosts = (process.env.LINGUAFLOW_DEV_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean)

// devframe 实例注册表默认写在 $HOME/.devframe/instances，开发沙箱不允许写 HOME。
// 改写到项目内的 .tooling 目录（已被 git 忽略），让 `vue-devtools-agent connect` 能自动发现本实例。
process.env.DEVFRAME_INSTANCES_DIR ??= fileURLToPath(
  new URL('../.tooling/devframe/instances', import.meta.url),
)

// https://vite.dev/config/
export default defineConfig({
  // 启用 Vite DevTools 宿主（仅开发期）。Vue DevTools v9 与其 MCP 端点（/__devtools/__mcp）
  // 都由该宿主提供，AI 智能体据此读取运行中应用的组件树、状态、Pinia 与路由。
  devtools: {
    apply: 'serve',
  },
  server: {
    ...(devAllowedHosts.length > 0 ? { allowedHosts: devAllowedHosts } : {}),
    proxy: {
      '/api': { target: apiProxyTarget },
    },
  },
  build: {
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'auth-callback',
              test: /\/src\/(?:auth\/(?:callback-entry|callback-shell|connection-test-relay)|locales\/auth-callback)\.ts$/,
              priority: 40,
            },
            {
              name: 'auth-exchange',
              test: /\/src\/auth\/callback-exchange\.ts$/,
              priority: 30,
            },
          ],
        },
      },
    },
  },
  plugins: [
    // ide-byebye：⌘/Ctrl + 点击元素即选中源码位置，把「改哪里」直接交给 AI 智能体。
    // 需放在框架插件之前。
    ideByebye(),
    {
      name: 'auth-completion-headers',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          return html.replace(/%AUTH_CALLBACK_(\w+)%/g, (_match, key: string) => {
            if (!(key in authCallbackMessages)) throw new Error(`Unknown callback message: ${key}`)
            return authCallbackMessages[key as keyof typeof authCallbackMessages]
          })
        },
      },
      generateBundle(_options, bundle) {
        const chunks = Object.values(bundle).filter((item) => item.type === 'chunk')
        const seen = new Set<string>()
        const visit = (chunk: (typeof chunks)[number]) => {
          if (seen.has(chunk.fileName)) return
          seen.add(chunk.fileName)
          for (const id of chunk.moduleIds) {
            const path = id.replaceAll('\\', '/')
            if (
              /\/src\/(?:main\.ts|i18n\.ts|App\.vue|api\/session-context\.ts|locales\/(?:index|zh-Hans)\.ts)(?:\?|$)|\/node_modules\/(?:vue|@vue|naive-ui|pinia|vue-i18n)\//.test(
                path,
              )
            )
              this.error(`Heavy dependency in auth callback: ${path}`)
          }
          for (const name of chunk.imports) {
            const dependency = bundle[name]
            if (dependency?.type === 'chunk') visit(dependency)
          }
        }
        for (const chunk of chunks) {
          if (
            chunk.moduleIds.some((id) =>
              /\/src\/(?:entry|auth\/callback-entry|auth\/callback-exchange)\.ts$/.test(
                id.replaceAll('\\', '/'),
              ),
            )
          )
            visit(chunk)
        }
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split('?')[0] === '/auth/complete') {
            res.setHeader('Cache-Control', 'no-store')
            res.setHeader('Referrer-Policy', 'no-referrer')
          }
          next()
        })
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split('?')[0] === '/auth/complete') {
            res.setHeader('Cache-Control', 'no-store')
            res.setHeader('Referrer-Policy', 'no-referrer')
          }
          next()
        })
      },
    },
    VueRouter({
      routesFolder: 'src/pages',
      dts: 'src/typed-router.d.ts',
    }),
    vue(),
    vueJsx(),
    AutoImport({
      imports: ['vue', VueRouterAutoImports, 'pinia'],
      dts: 'src/auto-imports.d.ts',
    }),
    Components({
      resolvers: [
        NaiveUiResolver(),
        IconsResolver({
          prefix: 'Icon',
          enabledCollections: ['carbon'],
        }),
      ],
      dts: 'src/components.d.ts',
      // Keep declarations available while parallel transforms discover their component imports.
      // Repeated prune/rewrite cycles can overlap file reads and writes on Windows.
      syncMode: 'append',
    }),
    Icons({
      autoInstall: true,
    }),
    tailwindcss(),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
