import { configDefaults, defineConfig } from 'vitest/config'

// .edgeone/ 是 edgeone CLI 的构建产物（含仓库文件的副本），不要当成测试跑
export default defineConfig({ test: { exclude: [...configDefaults.exclude, '.edgeone/**'] } })
