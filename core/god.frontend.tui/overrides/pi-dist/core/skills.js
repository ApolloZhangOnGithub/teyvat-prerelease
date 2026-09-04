// god.frontend.tui/overrides/pi-dist/core/skills.js
// teyvat: 完全禁用 skill 注入——不加载、不格式化、不写 prompt。

export function loadSkills(_options) {
    return { skills: [], diagnostics: [] };
}

export function loadSkillsFromDir(_options) {
    return { skills: [], diagnostics: [] };
}

export function formatSkillsForPrompt(_skills) {
    return "";
}
