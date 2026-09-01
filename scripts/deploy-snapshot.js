#!/usr/bin/env node
/**
 * 本地快照部署脚本：把生成的 snapshot.json 推送到 GitHub Pages 仓库
 * =================================================
 * 配合 Windows 计划任务每天 12:00 / 15:15（工作日）运行：
 *   1. scripts/fetch-snapshot.js   抓取并生成 snapshot.json
 *   2. scripts/deploy-snapshot.js  上传 snapshot.json 到仓库（Contents API）
 *
 * token 通过环境变量 GH_TOKEN 提供（不写入本文件，避免 GitHub secret scanning 拦截）：
 *   首次设置：setx GH_TOKEN "ghp_你的token"
 * 仅需 token 的 repo 权限（snapshot.json 不在 .github/workflows 路径下）。
 */
"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.GH_TOKEN;
const OWNER = "chenyihui0514";
const REPO = "a-share-dashboard";
const BRANCH = "main";
const FILE = path.join(__dirname, "..", "snapshot.json");

if(!TOKEN){
  console.error("缺少 GH_TOKEN 环境变量。请先执行：setx GH_TOKEN \"ghp_你的token\"，然后重开终端再运行。");
  process.exit(1);
}

function api(method, apiPath, body){
  return new Promise((resolve, reject)=>{
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({host:"api.github.com", path: apiPath, method, headers:{
      "User-Agent":"deploy-snapshot",
      "Authorization":"token " + TOKEN,
      "Accept":"application/vnd.github+json",
      ...(data ? {"Content-Type":"application/json","Content-Length":Buffer.byteLength(data)} : {})
    }}, res=>{
      let d = ""; res.on("data", c => d += c);
      res.on("end", ()=>{
        let j = null; try{ j = JSON.parse(d); }catch(e){}
        if(res.statusCode >= 400) reject(new Error(method + " " + apiPath + " -> " + res.statusCode + " " + String(j || d).slice(0,200)));
        else resolve(j);
      });
    });
    req.on("error", reject);
    if(data) req.write(data);
    req.end();
  });
}

(async()=>{
  if(!fs.existsSync(FILE)){
    console.error("snapshot.json 不存在，请先运行 scripts/fetch-snapshot.js");
    process.exit(1);
  }
  const content = fs.readFileSync(FILE, "utf8");
  let meta = null;
  try{ meta = JSON.parse(content).meta; }catch(e){}
  console.log("上传 snapshot.json（" + content.length + " bytes）" + (meta ? " snap=" + meta.snap : ""));

  let sha = null;
  try{ sha = (await api("GET", "/repos/" + OWNER + "/" + REPO + "/contents/snapshot.json")).sha; }catch(e){}
  const body = {
    message: "snapshot: " + (meta ? meta.snap : Date.now()) + " (auto by local task)",
    content: Buffer.from(content).toString("base64"),
    branch: BRANCH
  };
  if(sha) body.sha = sha;
  const r = await api("PUT", "/repos/" + OWNER + "/" + REPO + "/contents/snapshot.json", body);
  console.log("部署成功 commit:", r.commit.sha.slice(0,7), "| sha:", r.content.sha.slice(0,7));
  console.log("线上生效约 1-2 分钟（Pages 构建），页面 Ctrl+F5 刷新即可看到新快照");
})().catch(e=>{ console.error("DEPLOY FAIL:", e.message); process.exit(1); });
