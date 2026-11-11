/**
 * `gateway/local/repositories` 聚合出口。
 *
 * Repository 只依赖 Dexie 与纯函数：零 DOM、零网络、零 fetch。
 * 路由层（`../routes/`）负责把行转成与后端一致的响应，并做 HTTP 错误映射。
 */
export * from './errors'
export * from './glossary'
export * from './projects'
export * from './resources'
export * from './segments'
export * from './tm'
