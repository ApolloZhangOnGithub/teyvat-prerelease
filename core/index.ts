// teyvat 扩展入口。
// 真正的装配在 kernel（kernel.core/core.ts）。这里只 re-export —— kernel 文件随便移,只改 package.json 的 "#kernel_core" 一行。
export { default } from "#kernel_core";
