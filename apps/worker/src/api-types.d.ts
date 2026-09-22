// worker 程序编译包含 api/src（共享服务模块），其 auth.ts 依赖
// @fastify/cookie 的类型增强；在此显式激活。
import "@fastify/cookie";
