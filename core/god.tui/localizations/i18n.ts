// i18n.ts — 双语工具
// 默认中文。PAIMON_LANG=en 切英文（PI_LANG 兼容旧配置）。
// 用法：t("中文", "English") → 根据语言返回对应文本

const _lang = (process.env.PAIMON_LANG || process.env.PI_LANG || "zh").slice(0, 2).toLowerCase();
const _isEn = _lang === "en";

/** 双语选择：t("中文", "English") */
export function i18n(zh: string, en: string): string {
  return _isEn ? en : zh;
}

/** 当前是否英文模式 */
export function isEnglish(): boolean {
  return _isEn;
}

/** 当前语言代码 */
export function lang(): string {
  return _lang;
}
