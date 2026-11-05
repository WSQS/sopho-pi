#!/usr/bin/env node
import { copyFile, open, readFile, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

function usage() {
  console.log('用法: node bin/cutover-migrate.mjs [--dry-run] [--home <ASSIST_HOME>]');
}

function fail(message) {
  console.error(`[cutover-migrate] 错误: ${message}`);
  process.exitCode = 1;
}

function timestamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

function parseArgs(argv) {
  let dryRun = false;
  let home = process.env.ASSIST_HOME || process.env.SOPHO_AGENT_DIR || path.join(os.homedir(), '.pi', 'profiles', 'assistant');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--home') {
      home = argv[index + 1];
      index += 1;
      if (!home) throw new Error('--home 需要一个目录');
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  return { dryRun, home: path.resolve(home) };
}

function migratedEntries(value) {
  return Object.entries(value)
    .map(([cwd, record]) => {
      if (!record || typeof record !== 'object' || Array.isArray(record) || !Number.isInteger(record.at) || record.at < 0) {
        throw new Error(`对象条目 ${JSON.stringify(cwd)} 缺少非负整数 at`);
      }
      if (!path.isAbsolute(cwd)) throw new Error(`cwd 不是绝对路径: ${JSON.stringify(cwd)}`);
      return { cwd, at: record.at };
    })
    .sort((left, right) => right.at - left.at || left.cwd.localeCompare(right.cwd));
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { fail(error.message); return; }

  const source = path.join(options.home, 'cwd-recents.json');
  let raw;
  try { raw = await readFile(source, 'utf8'); } catch (error) { fail(`无法读取 ${source}: ${error.message}`); return; }

  let value;
  try { value = JSON.parse(raw.startsWith('\uFEFF') ? raw.slice(1) : raw); } catch (error) {
    fail(`${source} 不是合法 JSON；拒绝覆盖: ${error.message}`);
    return;
  }
  if (Array.isArray(value)) {
    console.log(`[cutover-migrate] 无需迁移: ${source} 已经是数组`);
    return;
  }
  if (!value || typeof value !== 'object') {
    fail(`${source} 顶层既不是对象也不是数组；拒绝覆盖`);
    return;
  }

  let next;
  try { next = migratedEntries(value); } catch (error) { fail(`${source} 形状无效；拒绝覆盖: ${error.message}`); return; }
  const backup = `${source}.v2.1-${timestamp()}.bak`;
  console.log(`[cutover-migrate] 计划: 对象 ${next.length} 项 -> 数组 ${next.length} 项`);
  console.log(`[cutover-migrate] 源文件: ${source}`);
  console.log(`[cutover-migrate] 备份: ${backup}`);
  if (options.dryRun) {
    console.log('[cutover-migrate] dry-run: 未写入任何文件');
    return;
  }

  const temp = `${source}.tmp-${process.pid}-${Date.now()}`;
  try {
    await copyFile(source, backup, 0x1); // COPYFILE_EXCL: timestamp collision must refuse.
    const [sourceStat, backupStat] = await Promise.all([stat(source), stat(backup)]);
    if (sourceStat.size !== backupStat.size) throw new Error(`备份字节数不符: source=${sourceStat.size} backup=${backupStat.size}`);
    await open(temp, 'wx').then(async (handle) => {
      try {
        await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    await rename(temp, source);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    fail(`迁移失败；原文件未被脚本主动覆盖: ${error.message}`);
    return;
  }
  console.log(`[cutover-migrate] 已迁移: ${source}`);
  console.log(`[cutover-migrate] 已保留 v2.1 回滚备份: ${backup}`);
}

await main();
