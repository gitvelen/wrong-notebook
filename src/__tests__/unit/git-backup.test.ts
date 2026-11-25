import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseBackupFile } from '@/lib/backup/format';

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/git-backup.mjs');

/** 以 --transform 模式运行备份脚本，返回剥离后的对象 */
function runTransform(input: unknown): Record<string, unknown> {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, '--transform'], {
        input: JSON.stringify(input),
        encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
}

interface TestErrorItem {
    id: string;
    originalImageUrl: string;
    figureImage?: string | null;
    questionText: string | null;
    [key: string]: unknown;
}

interface TestExamQuestion {
    questionText: string | null;
    originalImageUrl?: string | null;
    figureImage?: string | null;
}

interface TestRowWithImage {
    id: string;
    imageData: string;
    [key: string]: unknown;
}

const fixture = {
    version: 11,
    exportedAt: '2026-11-11T00:00:00.000Z',
    scope: 'all',
    user: { id: 'u1', email: 'admin@localhost', role: 'admin' },
    subjects: [],
    systemTags: [],
    customTags: [],
    errorItems: [
        {
            id: 'e1',
            userId: 'u1',
            subjectId: null,
            originalImageUrl: 'data:image/png;base64,AAAA',
            figureImage: 'data:image/png;base64,FFFF',
            figureSource: 'image',
            figureSvg: '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,HHHH"/><path d="M0 0h10v10z"/></svg>',
            ocrText: null,
            questionText: '题目内容',
            answerText: null,
            analysis: null,
            wrongAnswerText: null,
            mistakeAnalysis: null,
            mistakeStatus: null,
            knowledgePoints: null,
            source: 'image',
            errorType: null,
            userNotes: null,
            masteryLevel: 0,
            gradeSemester: null,
            paperLevel: null,
            createdAt: '2026-11-01T00:00:00.000Z',
            updatedAt: '2026-11-01T00:00:00.000Z',
            tags: [],
        },
    ] satisfies TestErrorItem[],
    reviewSchedules: [],
    practiceRecords: [
        {
            id: 'r1',
            userId: 'u1',
            subject: null,
            difficulty: null,
            isCorrect: false,
            errorItemId: 'e1',
            result: 'wrong',
            questionText: '练习题快照',
            originalImageUrl: 'data:image/jpeg;base64,EEEE',
            createdAt: '2026-11-02T00:00:00.000Z',
        },
    ],
    examPapers: [
        {
            id: 'p1',
            questions: [
                { questionText: '有原图的题', originalImageUrl: 'data:image/jpeg;base64,BBBB' },
                { questionText: '无原图字段的题' },
                { questionText: '带来源错题原配图的题', figureImage: 'data:image/png;base64,GGGG' },
            ] satisfies TestExamQuestion[],
        },
    ],
    practiceQuestions: [
        { id: 'pq1', userId: 'u1', questionText: '智能练习题', figureSvg: '<svg><image xlink:href="data:image/jpeg;base64,JJJJ"/></svg>' },
    ],
    paperGroups: [],
    ttsSpeeches: [],
    importTasks: [{ id: 't1', status: 'draft', imageData: 'data:image/png;base64,CCCC' }] satisfies TestRowWithImage[],
    importBatches: [{ id: 'b1', imageData: 'data:image/png;base64,DDDD' }] satisfies TestRowWithImage[],
    extensions: {},
};

describe('git-backup 剥离图片', () => {
    it('错题原图、试卷题目原图、导入任务与批次整页图全部置空，其余字段保留', () => {
        const output = runTransform(fixture);

        const errorItems = output.errorItems as TestErrorItem[];
        expect(errorItems[0]?.originalImageUrl).toBe('');
        // 第 17 版起导出的裁剪原配图同样剥离，导入侧回退到 AI 重绘的 SVG
        expect(errorItems[0]?.figureImage).toBeNull();
        expect(errorItems[0]?.questionText).toBe('题目内容');

        const questions = (output.examPapers as { questions: TestExamQuestion[] }[])[0]?.questions ?? [];
        expect(questions[0]?.originalImageUrl).toBeNull();
        // 备份第 19 版起试卷题目带来源错题的原配图快照，同样剥离
        expect(questions[2]?.figureImage).toBeNull();
        expect(questions[1]).not.toHaveProperty('originalImageUrl');
        expect(questions[1]).not.toHaveProperty('figureImage');

        const tasks = output.importTasks as TestRowWithImage[];
        const batches = output.importBatches as TestRowWithImage[];
        expect(tasks[0]?.imageData).toBe('');
        expect(batches[0]?.imageData).toBe('');

        const records = output.practiceRecords as { originalImageUrl?: string | null; questionText?: string | null }[];
        expect(records[0]?.originalImageUrl).toBeNull();
        expect(records[0]?.questionText).toBe('练习题快照');

        expect(output.exportedAt).toBe('');
        expect(output.version).toBe(11);
        expect(output.user).toEqual(fixture.user);
    });

    it('SVG 配图内嵌的位图只摘除数据 URI，其余内容保留；未列举的位置同样清理', () => {
        const output = runTransform(fixture);

        const errorItems = output.errorItems as TestErrorItem[];
        expect(errorItems[0]?.figureSvg).toBe('<svg xmlns="http://www.w3.org/2000/svg"><image href=""/><path d="M0 0h10v10z"/></svg>');

        const practiceQuestions = output.practiceQuestions as { figureSvg?: string }[];
        expect(practiceQuestions[0]?.figureSvg).toBe('<svg><image xlink:href=""/></svg>');
    });

    it('剥离产物不再包含任何 base64 图片数据', () => {
        const output = runTransform(fixture);
        expect(JSON.stringify(output)).not.toContain('data:image');
        expect(JSON.stringify(output)).not.toContain('base64');
    });

    it('剥离后的文件仍可通过应用的备份解析（parseBackupFile）', () => {
        const output = runTransform(fixture);
        const parsed = parseBackupFile(output);
        expect(parsed.success).toBe(true);
    });
});
