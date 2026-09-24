#!/usr/bin/env node
// github-app-token.cjs — GitHub App private key → installation token（agent 用 App 身份提交）
// 用法: node github-app-token.cjs <appId> <privateKeyPath> <installationId>
// 文档: github-app-token.cjs.SPEC
const fs = require("node:fs");
const crypto = require("node:crypto");

async function main() {
  const [appId, keyPath, installId] = process.argv.slice(2);
  if (!appId || !keyPath || !installId) {
    console.error("用法: node github-app-token.cjs <appId> <privateKeyPath> <installationId>");
    process.exit(1);
  }
  const pem = fs.readFileSync(keyPath, "utf8");
  const b64url = (buf) => Buffer.from(buf).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const sig = crypto.createSign("RSA-SHA256").update(signingInput).sign(pem);
  const jwt = `${signingInput}.${b64url(sig)}`;

  const r = await fetch(`https://api.github.com/app/installations/${installId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const j = await r.json();
  if (!r.ok || !j.token) {
    console.error("换 token 失败:", JSON.stringify(j));
    process.exit(1);
  }
  process.stdout.write(j.token);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
