import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import Icons from 'unplugin-icons/vite'

export default defineConfig({
  // 图标以 `~icons/carbon/*` 虚拟模块引入（与 vite.config.ts 一致），
  // 单元测试直接引用导航等含图标的模块时需要同样的解析能力。
  plugins: [Icons({ autoInstall: false })],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
})
