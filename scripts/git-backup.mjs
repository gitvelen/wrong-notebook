#!/usr/bin/env node
/**
 * 每日数据备份：以管理员身份调用生产实例的导出接口（全部用户），剥离图片
 * （base64 数据 URL）后提交到 fork 的 data-backup 分支。备份在独立 worktree
 * 中提交，不影响 main 工作区；仅在数据变化时产生提交。
 *
 * 用法：
 *   node scripts/git-backup.mjs [--no-push]   完整流程：导出 → 剥离 → 提交 → 推送
 *   node scripts/git-backup.mjs --transform   转换模式：stdin 读备份 JSON，剥离后写 stdout
 *
 * 环境变量（均可省略，默认为本机部署值）：
 *   BASE_URL              实例地址，默认 https://note.velen.ltd
 *   ADMIN_EMAIL           管理员邮箱，默认 admin@localhost
 *   ADMIN_PASSWORD_FILE   密码文件路径，默认 /opt/wrong-notebook/admin-password.txt
 *   WORKTREE              备份专用 git worktree，默认 /opt/wrong-notebook-git-backup
 *   BACKUP_BRANCH         备份分支，默认 data-backup
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

/** 备份文件在仓库中的路径（相对 worktree 根） */
const BACKUP_FILE = 'data-backup/backup.json';

/**
 * 剥离备份对象中的图片数据，保持结构不变：
 * - 错题原图（originalImageUrl，base64 data URL）置空字符串
 * - 试卷题目与练习记录快照中的原题截图置 null（导入侧这两处可空）
 * - 识别导入任务/多题批次的整页图片（imageData）置空字符串
 * - exportedAt 清零：变更检测基于实际数据，避免每天生成仅时间戳不同的提交
 */
export function stripBackupImages(backup) {
    const out = structuredClone(backup);
    out.exportedAt = '';
    if (Array.isArray(out.errorItems)) {
        for (const item of out.errorItems) {
            if (item && typeof item === 'object' && 'originalImageUrl' in item) item.originalImageUrl = '';
        }
    }
    for (const key of ['practiceRecords', 'examPapers']) {
        const rows = Array.isArray(out[key]) ? out[key] : [];
        const field = key === 'practiceRecords' ? rows : rows.flatMap((paper) => (paper && typeof paper === 'object' && Array.isArray(paper.questions)) ? paper.questions : []);
        for (const row of field) {
            if (row && typeof row === 'object' && 'originalImageUrl' in row) row.originalImageUrl = null;
        }
    }
    for (const key of ['importTasks', 'importBatches']) {
        if (!Array.isArray(out[key])) continue;
        for (const row of out[key]) {
            if (row && typeof row === 'object' && 'imageData' in row) row.imageData = '';
        }
    }
    return out;
}

/** 汇总响应中的 Set-Cookie 为请求用的 Cookie 头 */
function cookiesOf(response) {
    return response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .filter(Boolean)
        .join('; ');
}

/** 以管理员身份登录并导出全部用户数据 */
async function exportAllData({ baseUrl, email, password }) {
    const csrfRes = await fetch(new URL('/api/auth/csrf', baseUrl));
    if (!csrfRes.ok) throw new Error(`获取 CSRF 令牌失败（HTTP ${csrfRes.status}）`);
    const { csrfToken } = await csrfRes.json();

    const loginRes = await fetch(new URL('/api/auth/callback/credentials', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookiesOf(csrfRes) },
        body: new URLSearchParams({ csrfToken, email, password, callbackUrl: baseUrl, json: 'true' }),
        redirect: 'manual',
    });
    const cookie = [cookiesOf(csrfRes), cookiesOf(loginRes)].filter(Boolean).join('; ');

    const exportRes = await fetch(new URL('/api/export?all=true', baseUrl), { headers: { cookie } });
    if (exportRes.status === 401) throw new Error('登录失败：请检查管理员邮箱与密码');
    if (!exportRes.ok) throw new Error(`导出失败（HTTP ${exportRes.status}）`);
    return exportRes.json();
}

/** 在 worktree 中执行 git 命令，非零退出即抛错 */
function git(worktree, args) {
    const result = spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} 失败：${(result.stderr || result.stdout).trim()}`);
    }
    return result;
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--transform')) {
        const input = JSON.parse(readFileSync(0, 'utf8'));
        process.stdout.write(`${JSON.stringify(stripBackupImages(input), null, 2)}\n`);
        return;
    }

    const log = (message) => console.log(`[git-backup] ${message}`);
    const baseUrl = process.env.BASE_URL ?? 'https://note.velen.ltd';
    const email = process.env.ADMIN_EMAIL ?? 'admin@localhost';
    const passwordFile = process.env.ADMIN_PASSWORD_FILE ?? '/opt/wrong-notebook/admin-password.txt';
    const worktree = process.env.WORKTREE ?? '/opt/wrong-notebook-git-backup';
    const branch = process.env.BACKUP_BRANCH ?? 'data-backup';

    // 安全检查：worktree 必须位于备份分支，防止误写 main
    const currentBranch = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    if (currentBranch !== branch) {
        throw new Error(`worktree ${worktree} 当前在 ${currentBranch} 分支，预期 ${branch}，中止`);
    }

    log(`从 ${baseUrl} 导出全部用户数据…`);
    const password = (await readFile(passwordFile, 'utf8')).trim();
    const backup = await exportAllData({ baseUrl, email, password });

    const target = `${worktree}/${BACKUP_FILE}`;
    const serialized = JSON.stringify(stripBackupImages(backup), null, 2);
    // 保险：上游格式升版若新增图片字段，这里直接失败而不是把图片提交进公开仓库
    if (serialized.includes('data:image')) {
        throw new Error('剥离后仍检测到 data:image 数据：备份格式可能有新增图片字段，请更新 stripBackupImages');
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${serialized}\n`);
    log(`剥离图片后的备份已写入 ${target}`);

    git(worktree, ['add', '--', BACKUP_FILE]);
    const hasChange = spawnSync('git', ['-C', worktree, 'diff', '--cached', '--quiet']).status !== 0;
    if (!hasChange) {
        log('数据无变化，无需提交');
        return;
    }

    const date = new Date().toISOString().slice(0, 10);
    git(worktree, ['commit', '-m', `chore: 数据备份 ${date}`, '--', BACKUP_FILE]);
    log('已创建提交');

    if (argv.includes('--no-push')) {
        log('按 --no-push 跳过推送');
        return;
    }
    git(worktree, ['push', 'github', branch]);
    log(`已推送到 github/${branch}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    main().catch((error) => {
        console.error(`[git-backup] 失败：${error instanceof Error ? error.message : error}`);
        process.exit(1);
    });
}
