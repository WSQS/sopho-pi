/* web/generated/plugin-values.js —— **生成物，不要手改**。
 *
 * 来源（唯一真源）：pi-extensions/assistant/index.ts 里那几处**声明** —— 逐字搬过来，不发明、不换算。
 * 生成器：bin/gen-plugin-values.mjs（一键重跑 `npm run gen:pluginvalues`；重跑两次字节相同、结果确定）。
 *
 * 为什么有这一份：插件那条**缺省 bash 超时**安全网在 UI 上看不见（注入的值不落盘），
 * 工具卡上那句「未指定 timeout ⇒ 本机缺省 N s」的 N **必须只有这一个来处** ——
 * 前端（web/render.js）写死 1800 就是第二份真理，插件一改前端就撒谎。
 * 手改这一份没有意义：`npm run test:pluginvalues` 会重跑生成器并与盘上这份**逐字节**比；
 * 谁改了插件常量而忘了重新生成，那道门会红。
 */
/** 插件给「没给 timeout」的 bash 调用补的那个缺省秒数（安全网）（源码锚点：const DEFAULT_BASH_TIMEOUT_S = <数字>;） */
export const BASH_DEFAULT_TIMEOUT_S = 1800;
/** 覆盖 / 关掉那层安全网的 env 名（源码锚点：process.env.SOPHO_BASH_TIMEOUT） */
export const BASH_TIMEOUT_ENV = "SOPHO_BASH_TIMEOUT";
/** 把 env 置成这几个值之一 ⇒ **显式关掉**安全网（回到「没超时」）（源码锚点：if (/^(0|off|none|false|no)$/i.test(raw)) return null;） */
export const BASH_TIMEOUT_OFF_VALUES = ["0", "off", "none", "false", "no"];
